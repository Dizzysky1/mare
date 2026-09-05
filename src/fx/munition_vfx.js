import * as THREE from 'three';
import { PlumeGrid, relaxVelocity } from './plume_flow.js';
import { makeParticlePool, makeSoftDot, makeSurfaceDisc, smooth01 } from './blast.js';

/* ────────────────────────────────────────────────────────────────
   Persistent ground hazards: `fire` (napalm's ~78s burning footprint)
   and `cloud` (gas's ~135s drifting area-denial volume). These are not
   one-shot detonations like Blast — they are long-lived, continuously
   emitting effects that a hazard-tracking module feeds in every frame.

   The interface shared with strikes.js and munition_effects.js:

     hazards = [{
       type: 'fire' | 'cloud',
       point: {x, y, z},   // world position (fire: on/near the water; cloud: burst centre)
       radius: number,     // metres — fire's footprint radius, cloud's eventual denial radius
       age: number,        // seconds since this hazard started (0 at creation, counts up)
       ttl: number,        // total lifetime in seconds (napalm ~78, gas ~135 — see munitions.js)
       intensity: 1,       // 0..1, scales emission/brightness; lets a hazard weaken before it expires
     }, ...]
     new HazardFX(scene, field).update(dt, hazards, camPos, wind)

   CONTRACT the caller must keep: reuse the SAME object reference for a
   given hazard across frames (mutate `age` in place; push a new object
   only when the hazard is actually new). HazardFX keys its per-hazard
   state — emission accumulators, flicker phase — off object identity,
   so a hazard that gets replaced wholesale every frame would look like
   a new hazard every frame and never accumulate smoke properly. Drop a
   hazard from the array the frame after `age >= ttl`.

   `wind` is a world-space horizontal wind vector in m/s — {x, z} (y is
   ignored), i.e. `speed * (cos(windDir), 0, sin(windDir))` in the
   convention weather.js already uses. Pass null/undefined for no wind.

   Everything is pooled exactly like blast.js: fixed particle/light/disc
   arrays allocated in the constructor, round-robin recycled, nothing
   allocates in update(). spawnFire/spawnCloud are a side door for
   testing this file stand-alone before the real hazard tracker exists —
   they just add an internally-owned hazard object that update() ages
   and expires the same way as a caller-supplied one.
   ──────────────────────────────────────────────────────────────── */

function makeHazParticle(){
  return {
    p: new THREE.Vector3(), v: new THREE.Vector3(),
    life: 0, maxLife: 1, age: 0,
    rot:0, rotV:0, cell:0, aspect:1, heat:0, cooling:0, mixing:0.3, flow:null, flowVersion:0,
    size: 1, sizeGrowth: 0, fadeIn: 0.2, fadeOutFrac: 0.4,
    r: 1, g: 1, b: 1, jit: 1,
    grav: 0, drag: 0.3, hug: 0, turb: 0, tPhase: 0, windK: 1,
  };
}

export class HazardFX {
  constructor(scene, field, opts = {}){
    this.scene = scene;
    this.field = field;
    const sizeScale = opts.sizeScale || 520;

    // ── fire: flame (additive, hot core) + smoke (normal blend, mass) ──
    this.flameN = opts.flameParticles || 2000;
    this.smokeN = opts.smokeParticles || 3000;
    this.flamePts = makeParticlePool(this.flameN, THREE.AdditiveBlending, sizeScale);
    this.smokePts = makeParticlePool(this.smokeN, THREE.NormalBlending, sizeScale);
    this.flamePts.material.uniforms.uFire.value = 1;
    this._time = 0;
    this.flamePts.renderOrder = 5;
    this.smokePts.renderOrder = 4;
    scene.add(this.flamePts, this.smokePts);
    this.flame = []; for(let i = 0; i < this.flameN; i++) this.flame.push(makeHazParticle());
    this.smoke = []; for(let i = 0; i < this.smokeN; i++) this.smoke.push(makeHazParticle());
    this._flameCursor = 0; this._smokeCursor = 0;

    // ── cloud: cold, even, hugs the surface — a separate pool so its
    //    look (colour, blend weight, motion) never leans on smoke's ──
    this.cloudN = opts.cloudParticles || 3600;
    this.cloudPts = makeParticlePool(this.cloudN, THREE.NormalBlending, sizeScale);
    this.cloudPts.renderOrder = 3;
    scene.add(this.cloudPts);
    this.cloud = []; for(let i = 0; i < this.cloudN; i++) this.cloud.push(makeHazParticle());
    this._cloudCursor = 0;

    // ── fire footprint: a soft additive glow sitting on the water,
    //    the "burning on water" read that sells it from a distance ──
    this.dotTex = makeSoftDot();
    this.footMat = new THREE.MeshBasicMaterial({
      map: this.dotTex, color: 0xff8a2a, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    const FN = opts.fireSlots || 8;
    this.footprints = [];
    for(let i = 0; i < FN; i++){
      const surface = makeSurfaceDisc();
      const mesh = new THREE.Mesh(surface.geometry, this.footMat.clone());
      mesh.visible = false; mesh.frustumCulled = false; mesh.renderOrder = 2;
      scene.add(mesh);
      this.footprints.push({ mesh, ux: surface.ux, uz: surface.uz, hazard: null });
    }

    // ── fire light: a real light source so a burn is visible a long way
    //    off at night — only the nearest few active fires get one, the
    //    rest just don't glow past the particles. Pooled, never created
    //    per-fire (an unbounded number of lights is not "a fixed cost"). ──
    const LN = opts.fireLights || 4;
    this.lights = [];
    for(let i = 0; i < LN; i++){
      const light = new THREE.PointLight(0xff7020, 0, 140, 2);
      scene.add(light);
      this.lights.push({ light, phase: Math.random()*Math.PI*2 });
    }
    // scratch for the nearest-N selection in _assignLights — preallocated
    // so picking which fires get a light doesn't allocate every frame.
    this._lightDist = new Float32Array(LN);
    this._lightHaz = new Array(LN).fill(null);

    // per-hazard bookkeeping (emission accumulators, footprint ownership) —
    // a fixed pool of slots matched by object identity, not a Map, so a
    // hazard appearing/expiring never allocates inside update().
    const HN = opts.hazardSlots || 24;
    this._stateSlots = [];
    for(let i = 0; i < HN; i++) this._stateSlots.push({ owner: null, flow:new PlumeGrid(), flameAcc: 0, smokeAcc: 0, cloudAcc: 0, footprint: null });
    this._manual = [];         // hazards created via spawnFire/spawnCloud
    this._external = null;
    this._flow = {x:0,y:0,z:0};
  }

  /* ── test-only direct spawners (see file header) ─────────────── */
  spawnFire(point, opts = {}){
    const h = { type:'fire', point: { x:point.x, y:point.y, z:point.z },
      radius: opts.radius ?? 14, age: 0, ttl: opts.ttl ?? 78, intensity: opts.intensity ?? 1 };
    this._manual.push(h);
    return h;
  }
  spawnCloud(point, opts = {}){
    const h = { type:'cloud', point: { x:point.x, y:point.y, z:point.z },
      radius: opts.radius ?? 58, age: 0, ttl: opts.ttl ?? 135, intensity: opts.intensity ?? 1 };
    this._manual.push(h);
    return h;
  }

  /* ── per-frame ──────────────────────────────────────────────── */
  update(dt, hazards, camPos, wind){
    if(!Number.isFinite(dt) || dt <= 0) return;
    this._time += dt;
    this.flamePts.material.uniforms.uTime.value = this._time;
    const windX = (wind && Number.isFinite(wind.x)) ? wind.x : 0;
    const windZ = (wind && Number.isFinite(wind.z)) ? wind.z : 0;

    // age and expire the manual (spawnFire/spawnCloud) hazards in place —
    // same lifecycle a real hazard tracker would apply.
    for(let i = this._manual.length - 1; i >= 0; i--){
      const h = this._manual[i];
      h.age += dt;
      if(h.age >= h.ttl){
        for(let j=i;j<this._manual.length-1;j++) this._manual[j]=this._manual[j+1];
        this._manual.length--;
      }
    }

    this._external = hazards;
    for(const slot of this._stateSlots) if(slot.owner && !this._hasHazard(slot.owner)) slot.owner = null;

    // reset the nearest-fire scratch before scanning
    for(let i = 0; i < this._lightHaz.length; i++){ this._lightHaz[i] = null; this._lightDist[i] = Infinity; }

    if(hazards) for(const h of hazards) this._stepHazard(h, dt, windX, windZ, camPos);
    for(const h of this._manual) this._stepHazard(h, dt, windX, windZ, camPos);

    // Continue advecting residual smoke after its source expires.
    for(const slot of this._stateSlots){
      const h=slot.owner;
      if(h)slot.flow.moveSource(h.point);
      slot.flow.advance(dt,h?.type || 'fire',h ? (h.intensity ?? 1)*Math.min(1,h.age) : 0,windX,windZ);
    }
    this._assignLights(dt);
    this._updateFootprints(dt);

    this._updateParticles(this.flame, this.flamePts, dt, windX, windZ);
    this._updateParticles(this.smoke, this.smokePts, dt, windX, windZ);
    this._updateParticles(this.cloud, this.cloudPts, dt, windX, windZ);
  }

  _hasHazard(h){
    return (this._external && this._external.includes(h)) || this._manual.includes(h);
  }

  /* Linear scan over a small fixed pool (default 24 concurrent hazards) —
     matches by object identity, claims a free slot for a hazard seen for
     the first time. If every slot is taken (far more live hazards than
     the pool allows) the last slot is shared/reused as a fallback so a
     stray extra hazard degrades instead of crashing. */
  _getState(h){
    let free = null;
    for(const slot of this._stateSlots){
      if(slot.owner === h) return slot;
      if(!free && !slot.owner) free = slot;
    }
    const slot = free || this._stateSlots[this._stateSlots.length - 1];
    slot.flow.reset(h.point,h.radius);
    slot.owner = h; slot.flameAcc = 0; slot.smokeAcc = 0; slot.cloudAcc = 0; slot.footprint = null;
    return slot;
  }

  _stepHazard(h, dt, windX, windZ, camPos){
    if(!h || !h.point || !Number.isFinite(h.point.x + h.point.y + h.point.z)) return;
    // fade the whole hazard in over its first second and out over its last
    // couple of seconds so it doesn't pop into/out of existence.
    const fade = Math.min(1, h.age/1.0) * smooth01(THREE.MathUtils.clamp((h.ttl - h.age)/2.5, 0, 1));
    const intensity = (Number.isFinite(h.intensity) ? h.intensity : 1) * fade;
    if(intensity <= 0.002) return;
    const s = this._getState(h);

    if(h.type === 'fire') this._stepFire(h, s, intensity, dt, windX, windZ);
    else if(h.type === 'cloud') this._stepCloud(h, s, intensity, dt, windX, windZ);

    if(h.type === 'fire' && camPos){
      const dx = h.point.x - camPos.x, dy = h.point.y - camPos.y, dz = h.point.z - camPos.z;
      const d2 = dx*dx + dy*dy + dz*dz;
      // insertion into the fixed-size nearest-N scratch — O(LN) per fire,
      // never allocates.
      for(let i = 0; i < this._lightHaz.length; i++){
        if(d2 < this._lightDist[i]){
          for(let j = this._lightHaz.length - 1; j > i; j--){ this._lightDist[j] = this._lightDist[j-1]; this._lightHaz[j] = this._lightHaz[j-1]; }
          this._lightDist[i] = d2; this._lightHaz[i] = h;
          break;
        }
      }
    }
  }

  /* Fire: flame licking along the footprint, heavy smoke rising and
     shearing downwind, and (elsewhere) a footprint glow + a real light.
     A burning napalm footprint is long and thin in the real munition
     (spread.length/width) but this interface only carries one radius,
     so it's treated as a circular footprint — close enough to be
     unmistakable at the distances this needs to read from. */
  _stepFire(h, s, intensity, dt, windX, windZ){
    const r = h.radius;
    // flame: fast emission, short life, additive — the flicker itself
    // is what reads, so keep them small and numerous rather than big.
    s.flameAcc += dt * (70 + 100*intensity) * (0.4 + r/14);
    let nFlame = Math.floor(s.flameAcc); s.flameAcc -= nFlame;
    for(; nFlame > 0; nFlame--){
      const q = this.flame[this._flameCursor];
      this._flameCursor = (this._flameCursor + 1) % this.flame.length;
      const a = Math.random()*Math.PI*2, rr = Math.pow(Math.random(), 0.5)*r;
      const wy = this.field.height(h.point.x + Math.cos(a)*rr, h.point.z + Math.sin(a)*rr);
      q.p.set(h.point.x + Math.cos(a)*rr, wy + 0.2, h.point.z + Math.sin(a)*rr);
      q.v.set((Math.random()-0.5)*3.5, 1.5 + Math.random()*2.5, (Math.random()-0.5)*3.5);
      q.flow=s.flow; q.flowVersion=s.flow.version;
      q.age = 0; q.life = q.maxLife = 0.55 + Math.random()*0.55;
      q.fadeIn = 0.05; q.fadeOutFrac = 0.6;
      q.size = (3.0 + Math.random()*3.0) * (0.5 + intensity*0.5);
      q.sizeGrowth = -0.3;
      q.jit = 0.45 + Math.random()*0.3;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*2.2; q.cell = 1; q.aspect = 0.7;
      q.heat = 1100; q.cooling = 1.8; q.mixing = 0.65;
      q.grav = 0; q.drag = 0.8; q.hug = 0; q.turb = 3; q.tPhase = Math.random()*Math.PI*2; q.windK = 0.15;
      const hot = Math.random();
      q.r = 1.0; q.g = 0.35 + hot*0.45; q.b = 0.06 + hot*0.12;
    }

    // smoke: slower emission, long life, buoyant, sheared harder by
    // wind the higher it climbs — cheap stand-in for real wind shear.
    s.smokeAcc += dt * (7 + 10*intensity) * (0.4 + r/14);
    let nSmoke = Math.floor(s.smokeAcc); s.smokeAcc -= nSmoke;
    for(; nSmoke > 0; nSmoke--){
      const q = this.smoke[this._smokeCursor];
      this._smokeCursor = (this._smokeCursor + 1) % this.smoke.length;
      const a = Math.random()*Math.PI*2, rr = Math.random()*r*0.7;
      const wy = this.field.height(h.point.x + Math.cos(a)*rr, h.point.z + Math.sin(a)*rr);
      q.p.set(h.point.x + Math.cos(a)*rr, wy + 1.0, h.point.z + Math.sin(a)*rr);
      q.v.set(windX*0.3, 3.5 + Math.random()*2.5, windZ*0.3);
      q.flow=s.flow; q.flowVersion=s.flow.version;
      q.age = 0; q.life = q.maxLife = 7 + Math.random()*5;
      q.fadeIn = 0.8; q.fadeOutFrac = 0.5;
      q.size = (4 + Math.random()*4) * (0.6 + intensity*0.4);
      q.sizeGrowth = 0.19;
      q.jit = 0.45 + Math.random()*0.3;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*0.35; q.cell = Math.random()<0.65 ? 0 : 1; q.aspect = 0.9;
      q.heat = 180 + Math.random()*120; q.cooling = 0.26; q.mixing = 0.85;
      q.grav = 0; q.drag = 0.6; q.hug = 0; q.turb = 0.7; q.tPhase = Math.random()*Math.PI*2; q.windK = 1;
      const shade = 0.06 + Math.random()*0.10;
      q.r = shade; q.g = shade*0.95; q.b = shade*0.92;
    }

    if(!s.footprint){
      for(const f of this.footprints) if(!f.hazard){ f.hazard = h; f.mesh.visible = true; s.footprint = f; break; }
    }
  }

  /* Cloud: cold, even, low — spreads outward to fill its radius over the
     first ~20s rather than appearing at full size, drifts on the wind,
     and stays flat against the water instead of rising like smoke does. */
  _stepCloud(h, s, intensity, dt, windX, windZ){
    const grown = Math.min(1, h.age/20);           // fills its radius gradually
    const r = h.radius * (0.25 + 0.75*grown);
    // Tuned for a bounded steady-state population, not just "more radius,
    // more particles": at the ~13s average particle life below, this
    // settles near ~550 concurrent particles for a fully-grown 58m gas
    // cloud (munitions.js) — comfortably inside cloudN with several
    // clouds alive at once, not a number that grows without limit.
    s.cloudAcc += dt * (10 + 14*intensity) * (0.4 + r/40);
    let n = Math.floor(s.cloudAcc); s.cloudAcc -= n;
    for(; n > 0; n--){
      const q = this.cloud[this._cloudCursor];
      this._cloudCursor = (this._cloudCursor + 1) % this.cloud.length;
      const a = Math.random()*Math.PI*2, rr = Math.pow(Math.random(), 0.6)*r;
      const px = h.point.x + Math.cos(a)*rr, pz = h.point.z + Math.sin(a)*rr;
      const wy = this.field.height(px, pz);
      q.p.set(px, wy + 0.6 + Math.random()*1.2, pz);
      // near-zero fall speed and a slow radial push (fills the footprint)
      // on top of full wind advection — this is what keeps it "hugging
      // and spreading" instead of billowing upward like smoke.
      const out = 0.15 + Math.random()*0.4;
      q.v.set(windX*0.85 + Math.cos(a)*out, 0.05, windZ*0.85 + Math.sin(a)*out);
      q.flow=s.flow; q.flowVersion=s.flow.version;
      q.age = 0; q.life = q.maxLife = 10 + Math.random()*6;
      q.fadeIn = 1.2; q.fadeOutFrac = 0.4;
      q.size = (10 + Math.random()*8) * (0.7 + intensity*0.3);
      q.sizeGrowth = 0.06;
      // capped alpha jitter — a chemical haze you can still navigate near,
      // not a wall; NormalBlending keeps overlap from washing to solid.
      q.jit = (0.65 + Math.random()*0.30) * (0.5 + 0.5*intensity);
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*0.1; q.cell = Math.random()<0.6 ? 1 : 2; q.aspect = 0.28 + Math.random()*0.16;
      q.heat = 0; q.cooling = 0; q.mixing = 0.18;
      q.grav = 0.12; q.drag = 0.6; q.hug = 1; q.turb = 0.5; q.tPhase = Math.random()*Math.PI*2; q.windK = 1;
      const shade = 0.68 + Math.random()*0.14;
      q.r = shade*0.86; q.g = shade; q.b = shade*0.80;   // sickly, cold, desaturated green-grey
    }
  }

  _assignLights(dt){
    for(let i = 0; i < this.lights.length; i++){
      const L = this.lights[i], h = this._lightHaz[i];
      if(!h){ L.light.intensity = 0; continue; }
      L.phase += dt*11;
      const flicker = 0.82 + 0.18*Math.sin(L.phase) + 0.06*Math.sin(L.phase*3.7);
      const fade = Math.min(1, h.age/1.0) * smooth01(THREE.MathUtils.clamp((h.ttl - h.age)/2.5, 0, 1));
      L.light.position.set(h.point.x, h.point.y + 2.5, h.point.z);
      L.light.intensity = 220 * (h.intensity ?? 1) * fade * flicker * (0.5 + h.radius/14*0.5);
    }
  }

  _updateFootprints(dt){
    for(const f of this.footprints){
      if(!f.hazard) continue;
      const h = f.hazard;
      if(!this._hasHazard(h)){ f.hazard = null; f.mesh.visible = false; continue; }
      const fade = Math.min(1, h.age/1.0) * smooth01(THREE.MathUtils.clamp((h.ttl - h.age)/2.5, 0, 1));
      const pulse = 0.85 + 0.15*Math.sin(h.age*9);
      const attr = f.mesh.geometry.attributes.position;
      const arr = attr.array, ux = f.ux, uz = f.uz;
      for(let i = 0; i < ux.length; i++){
        const x = ux[i]*h.radius, z = uz[i]*h.radius, o = i*3;
        arr[o] = x; arr[o+2] = z;
        arr[o+1] = this.field.height(h.point.x + x, h.point.z + z) + 0.12;
      }
      attr.needsUpdate = true;
      f.mesh.position.set(h.point.x, 0, h.point.z);
      f.mesh.material.opacity = 0.55 * fade * pulse * (h.intensity ?? 1);
    }
  }

  /* windX/windZ are the CURRENT wind, applied continuously (not just baked
     in at spawn) so a smoke plume or gas cloud already in flight bends
     when the wind shifts, instead of every particle locking in the wind
     from the instant it was born. windK is per-particle: 0 for flame
     (barely affected, it's tethered to the fire), ~1 for smoke/cloud. */
  _updateParticles(list, points, dt, windX, windZ){
    const arr = points.geometry.attributes.position.array;
    const sizeArr = points.geometry.attributes.aSize.array;
    const colArr = points.geometry.attributes.aColor.array;
    const rotArr = points.geometry.attributes.aRot.array;
    const floorArr = points.geometry.attributes.aFloor.array;
    const aspectArr = points.geometry.attributes.aAspect.array;
    for(let i = 0; i < list.length; i++){
      const q = list[i], o3 = i*3, o4 = i*4;
      if(q.life > 0){
        q.life -= dt; q.age += dt; q.rot += q.rotV*dt;
        // Sample the pressure-projected velocity field at this particle.
        // Cooling removes buoyancy continuously: rho_hot/rho_ambient =
        // T_ambient/T_hot under pressure equilibrium (ideal gas law).
        q.heat *= Math.exp(-q.cooling*dt);
        const sampled=q.flow && q.flow.version===q.flowVersion && q.flow.sample(q.p.x,q.p.y,q.p.z,this._flow);
        if(!sampled){this._flow.x=windX;this._flow.y=0;this._flow.z=windZ;}
        else q.heat=relaxVelocity(q.heat,this._flow.heat,0.8,dt);
        const flow = this._flow, drag = q.drag;
        const buoyancy = 9.81*q.heat/(288.15+q.heat) - q.grav;
        const vx=q.v.x, vy=q.v.y, vz=q.v.z;
        q.v.x = relaxVelocity(vx, flow.x*q.windK, 1.2, dt);
        q.v.z = relaxVelocity(vz, flow.z*q.windK, 1.2, dt);
        q.v.y = relaxVelocity(vy, sampled ? flow.y : buoyancy/drag, drag, dt);
        // Trapezoidal transport avoids first-order distance bias as frame
        // time changes while the exponential response stays stable.
        q.p.x += (vx+q.v.x)*0.5*dt;
        q.p.y += (vy+q.v.y)*0.5*dt;
        q.p.z += (vz+q.v.z)*0.5*dt;
        if(q.hug){
          const wy = this.field.height(q.p.x, q.p.z);
          if(q.p.y < wy + 0.4) q.p.y = wy + 0.4;
        }
        if(!Number.isFinite(q.p.x + q.p.y + q.p.z)) q.life = 0;
      }
      if(q.life > 0){
        arr[o3]=q.p.x; arr[o3+1]=q.p.y; arr[o3+2]=q.p.z;
        const fadeIn = q.fadeIn > 0 ? smooth01(q.age/q.fadeIn) : 1;
        const fadeOut = smooth01(q.life/(q.maxLife*q.fadeOutFrac));
        // Diffusive spread: variance grows linearly with time, so radius
        // grows as sqrt(time), rather than an ever-accelerating smoke blob.
        const growth = Math.sqrt(Math.max(0.15, 1 + 2*q.sizeGrowth*q.age));
        sizeArr[i] = q.size*growth;
        rotArr[i*2] = q.rot; rotArr[i*2+1] = q.cell;
        aspectArr[i] = q.aspect;
        // Fade the density into its local free surface before depth testing
        // clips it. This resolves hard water/quad intersection seams.
        floorArr[i] = this.field.height(q.p.x,q.p.z);
        colArr[o4]=q.r; colArr[o4+1]=q.g; colArr[o4+2]=q.b;
        colArr[o4+3] = fadeIn*fadeOut*q.jit;
      } else {
        arr[o3]=0; arr[o3+1]=-9999; arr[o3+2]=0;
      }
    }
    points.geometry.attributes.position.needsUpdate = true;
    points.geometry.attributes.aSize.needsUpdate = true;
    points.geometry.attributes.aColor.needsUpdate = true;
    points.geometry.attributes.aRot.needsUpdate = true;
    points.geometry.attributes.aAspect.needsUpdate = true;
    points.geometry.attributes.aFloor.needsUpdate = true;
  }

  clear(){
    this._manual.length=0;this._external=null;
    for(const slot of this._stateSlots){slot.owner=null;slot.footprint=null;slot.flow.remaining=0;}
    for(const q of this.flame)q.life=0;
    for(const q of this.smoke)q.life=0;
    for(const q of this.cloud)q.life=0;
    for(const f of this.footprints){f.hazard=null;f.mesh.visible=false;}
    for(const L of this.lights)L.light.intensity=0;
    this._updateParticles(this.flame,this.flamePts,0,0,0);
    this._updateParticles(this.smoke,this.smokePts,0,0,0);
    this._updateParticles(this.cloud,this.cloudPts,0,0,0);
  }

  dispose(){
    this.scene.remove(this.flamePts, this.smokePts, this.cloudPts);
    this.flamePts.geometry.dispose(); this.flamePts.material.dispose();
    this.smokePts.geometry.dispose(); this.smokePts.material.dispose();
    this.cloudPts.geometry.dispose(); this.cloudPts.material.dispose();
    for(const f of this.footprints){ this.scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose(); }
    this.footMat.dispose(); this.dotTex.dispose();
    for(const L of this.lights) this.scene.remove(L.light);
  }
}
