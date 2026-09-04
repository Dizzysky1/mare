import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   What ordnance does when it goes off. A water shot is a very
   specific sequence — flash, dome, column, base surge, shock ring,
   falling spray, lingering mist, foam — and the timing between
   those stages is what sells it, not any one of them alone. A land
   shot runs the same rig with dirt and smoke standing in for water.

   Everything is pooled up front (particles, rings, foam discs,
   lights) so five overlapping detonations cost a fixed, known
   amount: no allocation happens once the game is running.
   ──────────────────────────────────────────────────────────────── */

const G = 9.81;

/* soft round sprite, drawn with a tiny shader so size/opacity can vary
   per-particle without one draw call each (see boats.js/strikes.js,
   which use plain PointsMaterial — we need per-point colour too). */
const PARTICLE_VERT = /* glsl */`
attribute float aSize;
attribute vec4 aColor;
varying vec4 vColor;
uniform float uScale;
void main(){
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (uScale / max(1.0, -mv.z));
  gl_Position = projectionMatrix * mv;
}`;
const PARTICLE_FRAG = /* glsl */`
varying vec4 vColor;
void main(){
  float d = length(gl_PointCoord - vec2(0.5));
  float a = smoothstep(0.5, 0.05, d);
  if(a <= 0.001) discard;
  gl_FragColor = vec4(vColor.rgb, vColor.a*a);
}`;

function makeParticlePool(n, blending, scale){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n*3), 3));
  g.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(n), 1));
  g.setAttribute('aColor', new THREE.BufferAttribute(new Float32Array(n*4), 4));
  const mat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
    uniforms: { uScale: { value: scale } },
    transparent: true, depthWrite: false, blending,
  });
  const pts = new THREE.Points(g, mat);
  pts.frustumCulled = false;
  return pts;
}

/* radial-gradient sprite for the foam/scorch patches — one canvas,
   shared by every pooled disc. */
function makeSoftDot(){
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32,32,0, 32,32,32);
  g.addColorStop(0.0, 'rgba(255,255,255,1)');
  g.addColorStop(0.55,'rgba(255,255,255,0.55)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,64,64);
  const tex = new THREE.CanvasTexture(c);
  return tex;
}

/* Dedicated, dynamic surface meshes let each pooled blast conform to the
   analytic sea independently. Unit X/Z coordinates are retained beside the
   attribute so update() only writes existing typed arrays. */
function makeSurfaceRing(segments = 72){
  const count = (segments + 1)*2;
  const pos = new Float32Array(count*3);
  const ux = new Float32Array(count), uz = new Float32Array(count);
  const idx = new Uint16Array(segments*6);
  for(let i = 0; i <= segments; i++){
    const a = i/segments*Math.PI*2, x = Math.cos(a), z = Math.sin(a);
    const k = i*2;
    ux[k] = x*0.96; uz[k] = z*0.96;
    ux[k+1] = x; uz[k+1] = z;
    pos[k*3] = ux[k]; pos[k*3+2] = uz[k];
    pos[(k+1)*3] = ux[k+1]; pos[(k+1)*3+2] = uz[k+1];
    if(i < segments){
      const q = i*6;
      idx[q] = k; idx[q+1] = k+2; idx[q+2] = k+1;
      idx[q+3] = k+1; idx[q+4] = k+2; idx[q+5] = k+3;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  return { geometry, ux, uz };
}

function makeSurfaceDisc(radial = 3, segments = 32){
  const count = 1 + radial*(segments+1);
  const pos = new Float32Array(count*3), uv = new Float32Array(count*2);
  const ux = new Float32Array(count), uz = new Float32Array(count);
  const idx = new Uint16Array(segments*3 + (radial-1)*segments*6);
  uv[0] = uv[1] = 0.5;
  let v = 1;
  for(let r = 1; r <= radial; r++){
    const rr = r/radial;
    for(let i = 0; i <= segments; i++, v++){
      const a = i/segments*Math.PI*2;
      ux[v] = Math.cos(a)*rr; uz[v] = Math.sin(a)*rr;
      pos[v*3] = ux[v]; pos[v*3+2] = uz[v];
      uv[v*2] = 0.5 + ux[v]*0.5; uv[v*2+1] = 0.5 + uz[v]*0.5;
    }
  }
  let q = 0;
  for(let i = 0; i < segments; i++){
    idx[q++] = 0; idx[q++] = 1+i+1; idx[q++] = 1+i;
  }
  for(let r = 1; r < radial; r++){
    const inner = 1 + (r-1)*(segments+1), outer = inner + segments+1;
    for(let i = 0; i < segments; i++){
      const a = inner+i, b = a+1, c = outer+i, d = c+1;
      idx[q++] = a; idx[q++] = b; idx[q++] = c;
      idx[q++] = b; idx[q++] = d; idx[q++] = c;
    }
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geometry.setIndex(new THREE.BufferAttribute(idx, 1));
  return { geometry, ux, uz };
}

/* one particle: position/velocity plus the bits that decide how it
   ages. `hug` clamps it to the wave surface instead of letting it
   fall through (the base surge skims, it doesn't arc). */
function makeParticle(){
  return {
    p: new THREE.Vector3(), v: new THREE.Vector3(),
    life: 0, maxLife: 1, delay: 0,
    size: 1, r: 1, g: 1, b: 1,
    grav: G, drag: 0, hug: 0, water: true, groundY: 0,
  };
}

export class Blast {
  constructor(scene, field, opts = {}){
    this.scene = scene;
    this.field = field;

    this.flash = 0;

    // point sprites are sized in world metres and converted to pixels the
    // way THREE's own sizeAttenuation does (size * scale / -viewZ); this
    // constant stands in for screenHeight/(2*tan(fov/2)) since Blast isn't
    // given the camera. Tuned against the preview's 55° FOV — if the game's
    // canvas/FOV differs a lot, retune via opts.sizeScale.
    const sizeScale = opts.sizeScale || 520;

    // ── particle pools ──────────────────────────────────────────
    // bright: dome, column and base-surge spray — hot, additive.
    // mist: falling spray settling into a drifting plume — soft, normal blend.
    this.brightN = opts.brightParticles || 1500;
    this.mistN = opts.mistParticles || 500;
    this.brightPts = makeParticlePool(this.brightN, THREE.AdditiveBlending, sizeScale);
    this.mistPts = makeParticlePool(this.mistN, THREE.NormalBlending, sizeScale);
    this.brightPts.renderOrder = 4;
    this.mistPts.renderOrder = 3;
    scene.add(this.brightPts, this.mistPts);

    this.bright = [];
    for(let i = 0; i < this.brightN; i++) this.bright.push(makeParticle());
    this.mist = [];
    for(let i = 0; i < this.mistN; i++) this.mist.push(makeParticle());

    // ── shock rings: thin bright rings that race across the surface ──
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xeaf6ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.rings = [];
    const RN = opts.rings || 6;
    for(let i = 0; i < RN; i++){
      const surface = makeSurfaceRing();
      const mesh = new THREE.Mesh(surface.geometry, this.ringMat.clone());
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.rings.push({ mesh, ux:surface.ux, uz:surface.uz, t: 0, maxT: 1, r0: 1, rate: 1,
        cx: 0, cy: 0, cz: 0, water: true, alive: false });
    }

    // ── residual foam / scorch discs ──────────────────────────────
    this.dotTex = makeSoftDot();
    this.foamMat = new THREE.MeshBasicMaterial({
      map: this.dotTex, color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide });
    this.foams = [];
    const FN = opts.foamPatches || 6;
    for(let i = 0; i < FN; i++){
      const surface = makeSurfaceDisc();
      const mesh = new THREE.Mesh(surface.geometry, this.foamMat.clone());
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.foams.push({ mesh, ux:surface.ux, uz:surface.uz, t: 0, maxT: 10, radius: 1,
        cx: 0, cy: 0, cz: 0, water: true });
    }

    // ── a few real lights for the flash — not one per blast, that's
    //    more than it's worth; three overlapping is already plenty ──
    this.lights = [];
    const LN = opts.lights || 3;
    for(let i = 0; i < LN; i++){
      const light = new THREE.PointLight(0xfff0c8, 0, 260, 2);
      scene.add(light);
      this.lights.push({ light, t: 0, maxT: 0.22, peak: 0 });
    }

    // scratch, reused every call — nothing in water()/land()/update() allocates
    this._d = new THREE.Vector3();
  }

  /* ── detonation entry points ─────────────────────────────────── */

  water(point, power = 1){ this._detonate(point, power, true); }
  land(point, power = 1){ this._detonate(point, power, false); }

  _detonate(point, power, isWater){
    if(!point || !Number.isFinite(point.x + point.y + point.z)) return;
    power = Number.isFinite(power) ? THREE.MathUtils.clamp(power, 0.15, 3.0) : 1;
    this.flash = 1;

    let li = 0;
    for(; li < this.lights.length; li++) if(this.lights[li].t <= 0) break;
    if(li < this.lights.length){
      const L = this.lights[li];
      L.t = L.maxT;
      L.light.position.set(point.x, point.y + 4, point.z);
      L.light.color.setHex(isWater ? 0xfff0c8 : 0xffb070);
      L.peak = (isWater ? 900 : 500)*power;
      L.light.intensity = L.peak;
    }

    this._spawnColumn(point, power, isWater);
    this._spawnSurge(point, power, isWater);
    this._spawnMist(point, power, isWater);
    this._spawnRing(point, power, isWater);
    this._spawnPatch(point, power, isWater);
  }

  /* dome + column: a fast, narrow "core" that makes the tall spike, and a
     wider, shorter-lived "skirt" that reads as the initial dome/burst and
     the wide foot of the column. Both feel gravity and fall back. */
  _spawnColumn(point, power, isWater){
    const scale = Math.sqrt(power);
    const coreN = Math.round(160*power);
    const skirtN = Math.round(60*power);
    const peakH = THREE.MathUtils.lerp(38, 55, Math.random())*scale;

    // Most droplets form a dense shaft; a smaller shoulder fans outward.
    // Keeping radial speed low is important — a uniformly ballistic burst
    // reads as a hollow umbrella instead of a water column.
    let idx = 0;
    for(let n = 0; n < coreN && idx < this.brightN; idx++){
      const q = this.bright[idx];
      if(q.life > 0) continue;
      n++;
      const a = Math.random()*Math.PI*2;
      const shaft = Math.random() < 0.82;
      // A wide apex distribution keeps the shaft continuous: shorter arcs
      // occupy its foot while the energetic droplets form the crown.
      const h01 = shaft
        ? (0.16 + Math.pow(Math.random(), 0.72)*0.84)
        : (0.10 + Math.random()*0.58);
      const vy = Math.sqrt(2*peakH*h01*G);
      const outSpeed = (shaft
        ? (0.45 + Math.pow(Math.random(), 2)*2.5 + (1-h01)*1.8)
        : (3.0 + Math.random()*5.5))*scale;
      const rr = Math.random()*(shaft ? 0.8 : 1.8)*scale;
      q.p.set(point.x + Math.cos(a)*rr, point.y, point.z + Math.sin(a)*rr);
      q.v.set(Math.cos(a)*outSpeed, vy, Math.sin(a)*outSpeed);
      // Keep the droplets through their descent: the rising column breaks up
      // around 2.5s, but its falling spray is still part of the later plume.
      q.life = q.maxLife = (2*vy/G)*1.05 + 0.15;
      q.delay = 0.035 + Math.random()*0.11;
      q.size = ((shaft ? 5.2 : 4.3) + Math.random()*2.8)*scale;
      q.grav = G; q.drag = 0.12; q.hug = 0; q.water = isWater; q.groundY = point.y;
      if(isWater){ q.r = 1.0; q.g = 1.0; q.b = 0.98; }
      else       { q.r = 0.32; q.g = 0.24; q.b = 0.16; }
    }
    // skirt: the quick wide dome/burst at the foot of the column, t≈0-0.15s
    idx = 0;
    for(let n = 0; n < skirtN && idx < this.brightN; idx++){
      const q = this.bright[idx];
      if(q.life > 0) continue;
      n++;
      const a = Math.random()*Math.PI*2;
      const rr = (1 + Math.random()*4)*scale;
      q.p.set(point.x + Math.cos(a)*rr*0.25, point.y, point.z + Math.sin(a)*rr*0.25);
      const outSpeed = (7 + Math.random()*16)*scale;
      q.v.set(Math.cos(a)*outSpeed, (9 + Math.random()*15)*scale, Math.sin(a)*outSpeed);
      q.life = q.maxLife = 0.5 + Math.random()*0.55;
      q.delay = 0;
      q.size = (4.0 + Math.random()*3.2)*scale;
      q.grav = G*0.9; q.drag = 0.4; q.hug = 0; q.water = isWater; q.groundY = point.y;
      if(isWater){ q.r = 1.0; q.g = 1.0; q.b = 1.0; }
      else       { q.r = 0.40; q.g = 0.32; q.b = 0.22; }
    }
  }

  /* base surge: low, fast, hugs the surface as it spreads — the thing
     most games skip and the thing that actually reads as "water shot". */
  _spawnSurge(point, power, isWater){
    const scale = Math.sqrt(power);
    const n0 = Math.round(80*power);
    let idx = 0;
    for(let n = 0; n < n0 && idx < this.brightN; idx++){
      const q = this.bright[idx];
      if(q.life > 0) continue;
      n++;
      const a = Math.random()*Math.PI*2;
      q.p.set(point.x, point.y + 0.6, point.z);
      const outSpeed = (18 + Math.random()*16)*scale;
      q.v.set(Math.cos(a)*outSpeed, 0.5 + Math.random()*2, Math.sin(a)*outSpeed);
      q.life = q.maxLife = 2.2 + Math.random()*1.6;
      q.delay = 0.1 + Math.random()*0.2;
      q.size = (7.0 + Math.random()*4.0)*scale;
      q.grav = G*0.65; q.drag = 0.45; q.hug = 1; q.water = isWater; q.groundY = point.y;
      if(isWater){ q.r = 0.95; q.g = 0.98; q.b = 1.0; }
      else       { q.r = 0.45; q.g = 0.38; q.b = 0.28; }
    }
  }

  /* the lingering plume: slow, buoyant, drifts and dissipates over
     several seconds — this is what's still hanging there at t=6-8s. */
  _spawnMist(point, power, isWater){
    const scale = Math.sqrt(power);
    const n0 = Math.round(90*power);
    const windA = Math.random()*Math.PI*2, windS = 1 + Math.random()*2;
    let idx = 0;
    for(let n = 0; n < n0 && idx < this.mistN; idx++){
      const q = this.mist[idx];
      if(q.life > 0) continue;
      n++;
      const a = Math.random()*Math.PI*2;
      const plume = Math.random() < 0.55;
      const rr = Math.random()*(plume ? 5 : 9)*scale;
      const out = (plume ? (0.4 + Math.random()*1.2) : (2 + Math.random()*3))*scale;
      q.p.set(point.x + Math.cos(a)*rr, point.y + Math.random()*3*scale, point.z + Math.sin(a)*rr);
      q.v.set(Math.cos(windA)*windS + Math.cos(a)*out, (plume ? 2.5 : 0.8) + Math.random()*(plume ? 3 : 2)*scale, Math.sin(windA)*windS + Math.sin(a)*out);
      q.life = q.maxLife = 4.5 + Math.random()*3.2;
      q.delay = 0.5 + Math.random()*0.8;
      q.size = (11.0 + Math.random()*8.0)*scale;
      q.grav = -0.18;        // enough buoyancy to linger without becoming a smoke stack
      q.drag = 0.5; q.hug = 0;
      if(isWater){ q.r = 0.98; q.g = 1.0; q.b = 1.0; }
      else       { q.r = 0.42; q.g = 0.40; q.b = 0.38; }
    }
  }

  _spawnRing(point, power, isWater){
    for(const s of this.rings){
      if(s.alive) continue;
      s.alive = true; s.t = 0;
      s.maxT = 2.6 + Math.random()*0.6;
      s.rate = (28 + Math.random()*10)*Math.sqrt(power);
      s.r0 = 1.2*Math.sqrt(power);
      s.cx = point.x; s.cy = point.y; s.cz = point.z; s.water = isWater;
      s.mesh.visible = true;
      s.mesh.position.set(point.x, 0, point.z);
      s.mesh.scale.setScalar(1);
      s.mesh.material.color.setHex(isWater ? 0xeaf6ff : 0xd9b98a);
      s.mesh.material.opacity = 0;
      return;
    }
  }

  _spawnPatch(point, power, isWater){
    for(const f of this.foams){
      if(f.mesh.visible) continue;
      f.t = 0;
      // Keep a faint trace through the ten-second mark; the last seconds are
      // deliberately subtle, but prevent the impact site vanishing abruptly.
      f.maxT = 10 + Math.random()*2;
      f.cx = point.x; f.cy = point.y; f.cz = point.z; f.water = isWater;
      f.radius = (5 + Math.random()*3)*Math.sqrt(power);
      f.mesh.visible = true;
      f.mesh.position.set(point.x, 0, point.z);
      f.mesh.scale.setScalar(1);
      f.mesh.material.color.setHex(isWater ? 0xf2f8fb : 0x2a241c);
      f.mesh.material.opacity = 0;
      return;
    }
  }

  /* ── per-frame ──────────────────────────────────────────────── */

  update(dt, camPos){
    if(!Number.isFinite(dt) || dt <= 0) return;
    this.flash = Math.max(0, this.flash - dt/0.3);

    for(const L of this.lights){
      if(L.t <= 0){ if(L.light.intensity) L.light.intensity = 0; continue; }
      L.t -= dt;
      const u = Math.max(0, L.t/L.maxT);
      L.light.intensity = L.peak*u*u;
      if(L.t <= 0) L.light.intensity = 0;
    }

    this._updatePool(this.bright, this.brightPts, dt, true);
    this._updatePool(this.mist, this.mistPts, dt, false);

    for(const s of this.rings){
      if(!s.alive) continue;
      s.t += dt;
      const r = s.r0 + s.t*s.rate;
      this._deformSurface(s, r, 0.15);
      const fade = 1 - s.t/s.maxT;
      s.mesh.material.opacity = Math.max(0, 0.6*fade*Math.min(1, s.t*6));
      if(s.t >= s.maxT){ s.alive = false; s.mesh.visible = false; }
    }

    for(const f of this.foams){
      if(!f.mesh.visible) continue;
      f.t += dt;
      this._deformSurface(f, f.radius, 0.05);
      const grow = Math.min(1, f.t*2.2);
      const fade = 1 - THREE.MathUtils.clamp((f.t - f.maxT*0.4)/(f.maxT*0.6), 0, 1);
      f.mesh.material.opacity = 0.45*grow*fade;
      if(f.t >= f.maxT) f.mesh.visible = false;
    }
  }

  _deformSurface(surface, radius, lift){
    const attr = surface.mesh.geometry.attributes.position;
    const arr = attr.array, ux = surface.ux, uz = surface.uz;
    for(let i = 0; i < ux.length; i++){
      const x = ux[i]*radius, z = uz[i]*radius, o = i*3;
      arr[o] = x;
      arr[o+1] = (surface.water
        ? this.field.height(surface.cx + x, surface.cz + z)
        : surface.cy) + lift;
      arr[o+2] = z;
    }
    attr.needsUpdate = true;
  }

  _updatePool(list, points, dt, clampToSurface){
    const arr = points.geometry.attributes.position.array;
    const sizeArr = points.geometry.attributes.aSize.array;
    const colArr = points.geometry.attributes.aColor.array;
    for(let i = 0; i < list.length; i++){
      const q = list[i], o3 = i*3, o4 = i*4;
      if(q.delay > 0){ q.delay -= dt; arr[o3]=0; arr[o3+1]=-9999; arr[o3+2]=0; continue; }
      if(q.life > 0){
        q.life -= dt;
        q.v.y -= q.grav*dt;
        const k = Math.max(0, 1 - q.drag*dt);
        q.v.x *= k; q.v.z *= k;
        q.p.addScaledVector(q.v, dt);

        if(clampToSurface){
          const wy = q.water ? this.field.height(q.p.x, q.p.z) : q.groundY;
          if(q.hug){
            if(q.p.y < wy + 0.4){ q.p.y = wy + 0.4; q.v.y = Math.max(0, q.v.y*0.2); }
          } else if(q.p.y < wy - 0.5){
            q.life = 0;
          }
        }
        if(!Number.isFinite(q.p.x + q.p.y + q.p.z)){ q.life = 0; }
      }
      if(q.life > 0){
        arr[o3]=q.p.x; arr[o3+1]=q.p.y; arr[o3+2]=q.p.z;
        const fade = Math.min(1, q.life/(q.maxLife*0.4));       // fades on the way out, not the way in
        sizeArr[i] = q.size;
        colArr[o4]=q.r; colArr[o4+1]=q.g; colArr[o4+2]=q.b; colArr[o4+3]=fade;
      } else {
        arr[o3]=0; arr[o3+1]=-9999; arr[o3+2]=0;
      }
    }
    points.geometry.attributes.position.needsUpdate = true;
    points.geometry.attributes.aSize.needsUpdate = true;
    points.geometry.attributes.aColor.needsUpdate = true;
  }

  dispose(){
    this.scene.remove(this.brightPts, this.mistPts);
    this.brightPts.geometry.dispose(); this.brightPts.material.dispose();
    this.mistPts.geometry.dispose(); this.mistPts.material.dispose();
    for(const s of this.rings){ this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    this.ringMat.dispose();
    for(const f of this.foams){ this.scene.remove(f.mesh); f.mesh.geometry.dispose(); f.mesh.material.dispose(); }
    this.foamMat.dispose(); this.dotTex.dispose();
    for(const L of this.lights) this.scene.remove(L.light);
  }

  /* Pure maths: a softened inverse-square impulse with a smooth finite edge.
     The cap keeps a close water shot violent without numerically launching a
     five-ton hull; the cubic range envelope reaches zero cleanly at 250m. */
  static impulseAt(blastPoint, bodyPos, yieldN = 5.2e6){
    const dx = bodyPos.x - blastPoint.x, dy = bodyPos.y - blastPoint.y, dz = bodyPos.z - blastPoint.z;
    if(!Number.isFinite(dx + dy + dz + yieldN) || yieldN <= 0) return null;
    const rawDist = Math.hypot(dx, dy, dz);
    if(rawDist >= 250) return null;
    const dist = Math.max(0.001, rawDist);
    const x = dist/250;
    const falloff = 1 - x*x*(3 - 2*x);
    const scale = Math.sqrt(yieldN/5.2e6);
    const power = Math.min(12000*scale, yieldN/(dist*dist + 18*18))*falloff;
    const f = new THREE.Vector3(dx/dist, dy/dist, dz/dist).multiplyScalar(power);
    f.y += power*0.55;
    return f;
  }
}
