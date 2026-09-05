import * as THREE from 'three';
import { ClusterSystem } from './fx/cluster.js';
import { Flyover } from './fx/flyover.js';
import { buildBomb, setFins } from './fx/ordnance.js';
import { Blast } from './fx/blast.js';
import { HazardFX } from './fx/munition_vfx.js';
import { munition, loadoutForWave } from './fx/munitions.js';
import { MunitionEffects } from './fx/munition_effects.js';
import { stream } from './rng.js';
import { Minigun } from './fx/minigun.js';
import { NuclearFX } from './fx/nuclear.js';

/* Contested waters. Flight, stores and blast visuals live in focused
   modules; this is the gameplay seam that schedules runs, integrates
   released bombs, marks the water and applies consequences. */

const G = 9.81;
const FORWARD = new THREE.Vector3(0, 0, 1);
// A near-surface cloud is carried at roughly two thirds of the wind
// measured at mast height — it drags on the water it sits on.
const CLOUD_DRIFT = 0.66;

export class Strikes {
  constructor(scene, field, audio, cb = {}){
    this.scene = scene; this.field = field; this.audio = audio; this.cb = cb;
    this.active = false;
    this.timer = 55;
    this.interval = 95;
    this.wave = 0;
    this.bombs = [];
    this.gun = new Minigun(scene,field,cb);
    this.nuclear = new NuclearFX(scene,field);
    // Replaced each sortie by loadoutForWave(); this is only the opener.
    this.storeKinds = loadoutForWave(1).slice();
    // Set to an array to pin the next sortie's load (creative mode does
    // this); left null, each sortie picks its own for the wave.
    this.forceKinds = null;
    this.releaseKinds = [];
    this.flash = 0;

    this.blast = new Blast(scene, field);
    // Hazards outlive the store that made them: fire has to be steered
    // around and a cloud has to be got upwind of, long after the bang.
    this.hazardFX = new HazardFX(scene, field);
    this.hazards = [];
    // Fire and cloud are drawn by HazardFX and made consequential here.
    this.effects = new MunitionEffects({
      toast: (t, k) => this.cb.toast?.(t, k),
      damage: (n, why) => this.cb.damage?.(n, why),
    });
    this._wind = new THREE.Vector3();
    this._allHaz = [];
    this.flyover = new Flyover(scene, {
      audio,
      makeStore: (index) => {
        const store = buildBomb(this.storeKinds[index] || 'mk83');
        setFins(store, 0);
        return store;
      },
    });
    this.flyover.onRelease = (pos, vel, index) => this.release(pos, vel, index);
    this.flyover.onPass = () => this.cb.toast?.('The engines split the sky overhead.', 'bad');

    // The painted aiming rings are the player's fair warning. They follow
    // the moving wave surface until the corresponding store arrives.
    this.markerGeo = new THREE.RingGeometry(9.0, 10.6, 48);
    this.markers = [];
    for(let i = 0; i < 6; i++){
      const mat = new THREE.MeshBasicMaterial({
        color:0xff5a3c, transparent:true, opacity:0,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.markerGeo, mat);
      mesh.rotation.x = -Math.PI/2;
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.markers.push({ mesh, impact:null, live:false, released:false, t:0 });
    }

    /* ── the reason you can see it coming ──────────────────────
       A store is released about 2.7 km out (that is not a choice — it
       falls for ten seconds from 550 m at 250 m/s, so the geometry puts
       it there) and it is three metres long. At that range it subtends
       about a sixteenth of a degree: three pixels, dark grey, against a
       dark storm sky. You cannot see it, and players reported exactly
       that. The store is not the thing the eye can catch at that range —
       its wake is. A fast store drags a thin turbulent wake of
       condensation behind it through humid marine air, and that is both
       real and, at a couple of hundred metres long, actually visible.
       One pooled draw call for every store in the air. */
    this.TRAIL_PTS = 26;
    const trailN = this.markers.length*this.TRAIL_PTS;
    const tg = new THREE.BufferGeometry();
    this._trailPos = new Float32Array(trailN*3);
    this._trailAge = new Float32Array(trailN);
    tg.setAttribute('position', new THREE.BufferAttribute(this._trailPos, 3));
    tg.setAttribute('aAge', new THREE.BufferAttribute(this._trailAge, 1));
    this.trailGeo = tg;
    this.trailMat = new THREE.ShaderMaterial({
      transparent:true, depthWrite:false, blending:THREE.AdditiveBlending,
      uniforms:{ uSize:{ value: 26.0 } },
      vertexShader:`
        attribute float aAge;
        varying float vA;
        uniform float uSize;
        void main(){
          vA = aAge;
          vec4 mv = modelViewMatrix*vec4(position,1.0);
          // hold a floor on screen size: the wake has to stay legible at
          // two or three kilometres, which is the entire point of it
          gl_PointSize = max(2.0, uSize*(0.35+0.65*aAge)*(300.0/max(60.0,-mv.z)));
          gl_Position = projectionMatrix*mv;
        }`,
      fragmentShader:`
        varying float vA;
        void main(){
          vec2 d = gl_PointCoord-0.5;
          float r = dot(d,d);
          if(r > 0.25) discard;
          float soft = smoothstep(0.25,0.0,r);
          gl_FragColor = vec4(vec3(0.86,0.89,0.94), soft*vA*0.5);
        }`,
    });
    this.trails = new THREE.Points(tg, this.trailMat);
    this.trails.frustumCulled = false;
    this.trails.renderOrder = 4;
    scene.add(this.trails);
    this._trailCursor = new Int32Array(this.markers.length);

    this._dir = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._impact = new THREE.Vector3();
    this._clusterPoint = new THREE.Vector3();
    this._clusterShip = null;this._clusterPlayer = null;
    this.clusters = new ClusterSystem(scene, (x,z,t) => cb.surfaceHeight
      ? cb.surfaceHeight(x,z,t) : field.height(x,z,t), {
      burst: parent => {
        this.blast.airburst(parent.p,0.16);
        this.cb.toast?.('The carrier opened — multiple objects falling.', 'bad');
      },
      impact: (body,inert) => {
        if(inert)return;
        this._clusterPoint.set(body.p.x,body.p.y,body.p.z);
        this.detonate(this._clusterPoint,this._clusterShip,this._clusterPlayer,body.kind);
      },
    });
  }

  arm(on, interval = 95){
    this.active = !!on;
    this.gun.clear(); this.nuclear.clear();
    this.interval = interval;
    this.timer = on ? 48 : 1e9;
    this.wave = 0;
    this.flyover.abort();
    this.clusters.reset();
    for(const b of this.bombs) this.scene.remove(b.mesh);
    this.bombs.length = 0;
    this.releaseKinds.length = 0;
    this.hazards.length = 0;
    this.hazardFX.clear();
    this.effects.reset();
    if(this._trailAge){ this._trailAge.fill(0); this._trailCursor.fill(0); }
    for(const m of this.markers){
      m.live = false; m.released = false; m.impact = null;
      m.mesh.visible = false;
    }
  }

  launch(target, ship){
    this.wave++;
    const rng = stream('strikes');
    const count = Math.min(5, 1 + Math.floor(this.wave/2) + (rng.chance(0.4) ? 1 : 0));
    const heading = rng.next()*Math.PI*2;
    // What this aircraft is carrying today. Later waves reach for the
    // stores that leave something behind, so reading which one is coming
    // down — and it looks different falling — starts to matter.
    this.storeKinds = (this.forceKinds && this.forceKinds.length)
      ? this.forceKinds.slice()
      : loadoutForWave(this.wave, () => rng.next()).slice();

    // Lead modestly. The long visible run-in is warning, not a perfect
    // prediction of a manoeuvring boat, so moving promptly still matters.
    this._aim.copy(target);
    if(ship) this._aim.addScaledVector(ship.vel, 5.5);
    this._aim.y = 0;
    this.releaseKinds = this.storeKinds.slice(0, count);

    this.flyover.start({
      target:this._aim,
      count,
      spacing:42 + rng.next()*18,
      heading,
      // A lower, slower run-in. The release range is fixed by the fall
      // time, so bringing the aircraft down from 550 m to ~400 m pulls the
      // release in from 2.7 km to about 2.0 km and puts the aircraft
      // itself within range of being seen and heard properly.
      altitude:355 + rng.next()*115,
      speed:205 + rng.next()*30,
    });

    for(let i = 0; i < this.markers.length; i++){
      const m = this.markers[i];
      const p = this.flyover.plannedImpacts[i];
      m.live = !!p; m.released = false; m.t = 0; m.impact = p || null;
      m.mesh.visible = !!p;
      if(p){
        m.mesh.position.set(p.x, this.field.height(p.x,p.z)+0.12, p.z);
        m.mesh.scale.setScalar(1);
        m.mesh.material.opacity = 0.12;
      }
    }

    this.cb.toast?.('Aircraft — high, fast, unmarked. It has seen you.', 'bad');
  }

  release(pos, vel, index){
    const kind = this.releaseKinds[index] || this.storeKinds[index] || 'mk83';
    if(munition(kind).cluster){
      const released=this.clusters.spawn(kind,pos,vel,{windX:this._wind.x,windZ:this._wind.z,simTime:this.field.time});
      const m=this.markers[index];if(m){m.live=false;m.mesh.visible=false;}
      return released;
    }
    const mesh = buildBomb(kind);
    mesh.position.copy(pos);
    setFins(mesh, 0);
    this.scene.add(mesh);
    const bombVel = vel.clone();
    const planned = this.flyover.plannedImpacts[index];
    if(planned){
      // Aim at the wave height expected when the store arrives. The correction
      // is tiny, but keeps a high crest from moving the hit outside its marker.
      const flatT = Math.sqrt(2*Math.max(0.1, pos.y)/G);
      const at = (Number.isFinite(this.field.time) ? this.field.time : 0) + flatT;
      const seaY = this.field.height(planned.x, planned.z, at);
      const fallT = Math.sqrt(2*Math.max(0.1, pos.y-seaY)/G);
      bombVel.x = (planned.x-pos.x)/fallT;
      bombVel.z = (planned.z-pos.z)/fallT;
    }
    this.bombs.push({ mesh, vel:bombVel, impact:planned ? planned.clone() : null,
                      index, age:0, kind, slot:this._takeSlot() });
    if(this.markers[index]) this.markers[index].released = true;
    if(this.bombs.length === 1)
      this.cb.toast?.('Something is coming down. Get out from under it.', 'bad');
  }

  /* A store released by a human pilot on the other end of the wire.
     Both clients call this with the same release conditions and both
     integrate it the same way, so both see it fall in the same place —
     but only the sailor's client is authoritative for what it does when
     it lands, because the sailor is the one who can see that. */
  dropStore(kind, pos, vel, env = {}){
    if(this.bombs.length >= 16) return false;
    if(munition(kind).cluster)return this.clusters.spawn(kind,pos,vel,env);
    const mesh = buildBomb(kind);
    mesh.position.set(pos.x, pos.y, pos.z);
    setFins(mesh, 0);
    this.scene.add(mesh);
    this.bombs.push({
      mesh, vel: new THREE.Vector3(vel.x, vel.y, vel.z),
      impact: null, index: -1, age: 0, kind, slot: this._takeSlot(),
    });
    return true;
  }

  update(dt, target, ship, playerPos, wind, env = {}){
    this.blast.update(dt, playerPos);
    this.nuclear.update(dt,playerPos);
    this.gun.update(dt,ship,playerPos);
    this.updateHazards(dt, playerPos, wind);
    // Anything spawned straight into HazardFX (creative mode) is just as
    // dangerous as anything a bomb left — one list, no special cases.
    this._allHaz.length = 0;
    for(const h of this.hazards) this._allHaz.push(h);
    for(const h of this.hazardFX._manual) this._allHaz.push(h);
    this.effects.update(dt, {
      hazards: this._allHaz, playerPos, ship, wind,
      submerged: !!env.submerged, rain: env.rain || 0, washing: env.washing || 0,
    });
    this.flash = Math.max(this.blast.flash,this.nuclear.flash);
    this.updateMarkers(dt);

    // Residual effects finish while disarmed; arm() clears any live stores.
    this._clusterShip=ship;this._clusterPlayer=playerPos;
    this.clusters.update(dt);
    this.updateBombs(dt, ship, playerPos);
    this.updateTrails(dt);
    if(!this.active) return;

    this.flyover.update(dt, playerPos);
    if(!this.flyover.active && this.bombs.length === 0 && this.clusters.live === 0){
      this.timer -= dt;
      if(this.timer <= 0){
        this.timer = this.interval*(0.65 + stream('strikes').next()*0.7)/(1 + this.wave*0.05);
        this.launch(target, ship);
      }
    }
  }

  /* Hazards age in place — HazardFX keys its state off object identity. */
  updateHazards(dt, playerPos, wind){
    for(let i = this.hazards.length-1; i >= 0; i--){
      const h = this.hazards[i];
      h.age += dt;
      if(h.age >= h.ttl) this.hazards.splice(i, 1);
    }
    if(wind) this._wind.set(wind.x, 0, wind.z);
    // The cloud goes where the wind goes; the fire is on the water and
    // stays put. This is what makes "get upwind of it" a real answer.
    for(const h of this.hazards){
      if(h.type !== 'cloud') continue;
      h.point.x += this._wind.x*CLOUD_DRIFT*dt;
      h.point.z += this._wind.z*CLOUD_DRIFT*dt;
    }
    this.hazardFX.update(dt, this.hazards, playerPos, this._wind);
  }

  updateMarkers(dt){
    for(const m of this.markers){
      if(!m.live || !m.impact) continue;
      m.t += dt;
      m.mesh.position.y = this.field.height(m.impact.x, m.impact.z) + 0.12;
      const rate = m.released ? 11 : 3.2;
      const pulse = 0.5 + 0.5*Math.abs(Math.sin(m.t*rate));
      m.mesh.material.opacity = (m.released ? 0.62 : 0.28)*(0.45 + pulse*0.55);
      m.mesh.scale.setScalar(m.released ? 0.82 + pulse*0.18 : 1);
    }
  }

  /* One wake slot per store in the air. Slots are reused, so the buffer
     never grows and nothing is allocated once the game is running. */
  _takeSlot(){
    const used = new Set(this.bombs.map(b => b.slot));
    for(let i = 0; i < this.markers.length; i++) if(!used.has(i)) return i;
    return 0;
  }

  /* Lay down one wake sample per store per frame and age the rest out.
     Written straight into the pooled attribute arrays; no allocation. */
  updateTrails(dt){
    const N = this.TRAIL_PTS, age = this._trailAge, pos = this._trailPos;
    for(let i = 0; i < age.length; i++){
      if(age[i] > 0) age[i] = Math.max(0, age[i] - dt*0.55);
    }
    for(const b of this.bombs){
      if(b.slot == null) continue;
      // Condensation needs a moment to form behind the store, so a store
      // just off the pylon has no wake yet.
      if(b.age < 0.25) continue;
      const c = this._trailCursor[b.slot] % N;
      const o = (b.slot*N + c)*3;
      pos[o] = b.mesh.position.x; pos[o+1] = b.mesh.position.y; pos[o+2] = b.mesh.position.z;
      age[b.slot*N + c] = 1;
      this._trailCursor[b.slot] = (c + 1) % N;
    }
    this.trailGeo.attributes.position.needsUpdate = true;
    this.trailGeo.attributes.aAge.needsUpdate = true;
  }

  updateBombs(dt, ship, playerPos){
    for(let i = this.bombs.length-1; i >= 0; i--){
      const b = this.bombs[i];
      b.age += dt;
      const x0 = b.mesh.position.x, y0 = b.mesh.position.y, z0 = b.mesh.position.z;
      const sea0 = this.field.height(x0, z0);
      b.mesh.position.addScaledVector(b.vel, dt);
      b.mesh.position.y -= 0.5*G*dt*dt;
      b.vel.y -= G*dt;
      setFins(b.mesh, Math.min(1, b.age*3.5));

      this._dir.copy(b.vel);
      if(this._dir.lengthSq() > 1e-6){
        this._dir.normalize();
        b.mesh.quaternion.setFromUnitVectors(FORWARD, this._dir);
      }

      const spec = munition(b.kind);
      const seaY = this.field.height(b.mesh.position.x, b.mesh.position.z);
      // an air-bursting canister opens well above the water
      const trigger = spec.fuze === 'airburst' ? seaY + (spec.burstAlt || 55) : seaY;
      if(b.mesh.position.y > trigger){
        if(spec.fuze !== 'airburst') continue;
        continue;
      }

      // Resolve the crossing inside this frame, then reconcile X/Z to the
      // advertised marker so the warning remains an honest gameplay contract.
      const above0 = y0-sea0, above1 = b.mesh.position.y-seaY;
      const hitU = above0 > 0
        ? THREE.MathUtils.clamp(above0/Math.max(1e-6, above0-above1), 0, 1) : 0;
      this._impact.set(
        THREE.MathUtils.lerp(x0, b.mesh.position.x, hitU),
        0,
        THREE.MathUtils.lerp(z0, b.mesh.position.z, hitU));
      if(b.impact){ this._impact.x = b.impact.x; this._impact.z = b.impact.z; }
      this._impact.y = this.field.height(this._impact.x, this._impact.z);
      this.detonate(this._impact, ship, playerPos, b.kind);
      const marker = this.markers[b.index];
      if(marker){ marker.live = false; marker.mesh.visible = false; }
      this.scene.remove(b.mesh);
      this.bombs.splice(i, 1);
    }
  }

  detonate(point, ship, playerPos, kind = 'mk83'){
    const spec = munition(kind);
    const power = spec.blast?.power ?? 1;
    if(spec.nuclear){
      this.nuclear.detonate(point);
      this.cb.toast?.('Flash — an enormous wave is spreading from the impact.','bad');
    }
    const surface=this.cb.landHeight?.(point.x,point.z) ?? -40;
    if(power>0){
      if(surface>this.field.height(point.x,point.z)+0.1)this.blast.land(point,power);
      else this.blast.water(point,power);
    }

    // The two special families leave something behind that matters more
    // than the bang did.
    if(spec.family === 'incendiary' && spec.spread){
      const n = 4;
      // Split the store's fuel across the patches and let it burn for the
      // advertised duration. Handing the heat release rate down like this
      // keeps the fire's severity tied to how much fuel there actually
      // was, instead of to how large the footprint happens to be drawn.
      const duration = spec.burn?.duration ?? 78;
      const hrr = (spec.mass/duration)*43000/n;    // kW per patch
      for(let i = 0; i < n; i++){
        const t = (i/(n-1) - 0.5)*spec.spread.length;
        this.hazards.push({ type:'fire',
          point:{ x:point.x + this._dir.x*t, y:point.y, z:point.z + this._dir.z*t },
          radius: spec.spread.width*0.5, age:0, ttl: duration, intensity:1, hrr });
      }
      this.cb.toast?.('The water is burning. Do not sail into it.', 'bad');
    } else if(spec.family === 'chemical' && spec.cloud){
      this.hazards.push({ type:'cloud', point:{ x:point.x, y:point.y, z:point.z },
        radius: spec.cloud.radius, rise:spec.cloud.rise, age:0, ttl: spec.cloud.duration ?? 135, intensity:1 });
      if(!spec.internal)this.cb.toast?.('Something is spreading on the wind. Get upwind of it.', 'bad');
    }

    const d = playerPos ? playerPos.distanceTo(point) : 999;
    // Every impact is reported, hit or miss — in a two-player game this is
    // what the sailor tells the pilot, and it is deliberately only "near"
    // or "not near", never a number.
    this.cb.impact?.(point, d);
    this.audio.explosion(THREE.MathUtils.clamp(1-d/700, 0.05, 1)*power, d/340);

    if(ship){
      const force = Blast.impulseAt(point, ship.pos);
      if(force) ship.impulse(force, point);
    }
    if(d < Math.min(90,spec.blast?.shockR ?? 90)) this.cb.shake?.(THREE.MathUtils.clamp(1-d/90, 0, 1));
    // Specific impulse on a person, in N·s. Deliberately a simple tuned
    // falloff rather than a weapons-effects fit: what it is for is
    // deciding whether the blast takes your spectacles off your face.
    if(d < (spec.blast?.shockR ?? 220)) this.cb.blastWave?.(power*2600/Math.pow(Math.max(d, 6), 1.5), d);
    const wound=spec.blast?.woundR ?? 55,lethal=spec.blast?.lethalR ?? 16;
    if(wound>0 && d < wound) this.cb.damage?.(THREE.MathUtils.clamp(1-d/wound, 0, 1)*95*Math.min(1,power),
      'A near miss. The water hit you like a wall.');
    if(lethal>0 && d < lethal) this.cb.damage?.(200, 'You were where it landed.');
  }

  dispose(){
    this.arm(false);
    this.flyover.dispose();
    this.blast.dispose();
    this.hazardFX.dispose();
    this.clusters.dispose();
    this.gun.dispose(); this.nuclear.dispose();
    for(const m of this.markers){ this.scene.remove(m.mesh); m.mesh.material.dispose(); }
    this.markerGeo.dispose();
    this.scene.remove(this.trails);
    this.trailGeo.dispose(); this.trailMat.dispose();
  }
}
