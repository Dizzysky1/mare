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

/* one particle: position/velocity plus the bits that decide how it
   ages. `hug` clamps it to the wave surface instead of letting it
   fall through (the base surge skims, it doesn't arc). */
function makeParticle(){
  return {
    p: new THREE.Vector3(), v: new THREE.Vector3(),
    life: 0, maxLife: 1, delay: 0,
    size: 1, r: 1, g: 1, b: 1,
    grav: G, drag: 0, hug: 0,
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
    this.ringGeo = new THREE.RingGeometry(0.85, 1.0, 56);
    this.rings = [];
    const RN = opts.rings || 6;
    for(let i = 0; i < RN; i++){
      const mesh = new THREE.Mesh(this.ringGeo, this.ringMat.clone());
      mesh.rotation.x = -Math.PI/2;
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.rings.push({ mesh, t: 0, maxT: 1, r0: 1, rate: 1, cx: 0, cz: 0, alive: false });
    }

    // ── residual foam / scorch discs ──────────────────────────────
    this.dotTex = makeSoftDot();
    this.dotGeo = new THREE.CircleGeometry(1, 24);
    this.foamMat = new THREE.MeshBasicMaterial({
      map: this.dotTex, color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.NormalBlending, depthWrite: false });
    this.foams = [];
    const FN = opts.foamPatches || 6;
    for(let i = 0; i < FN; i++){
      const mesh = new THREE.Mesh(this.dotGeo, this.foamMat.clone());
      mesh.rotation.x = -Math.PI/2;
      mesh.visible = false;
      mesh.renderOrder = 2;
      scene.add(mesh);
      this.foams.push({ mesh, t: 0, maxT: 10, cx: 0, cz: 0 });
    }

    // ── a few real lights for the flash — not one per blast, that's
    //    more than it's worth; three overlapping is already plenty ──
    this.lights = [];
    const LN = opts.lights || 3;
    for(let i = 0; i < LN; i++){
      const light = new THREE.PointLight(0xfff0c8, 0, 260, 2);
      scene.add(light);
      this.lights.push({ light, t: 0, maxT: 0.22 });
    }

    // scratch, reused every call — nothing in water()/land()/update() allocates
    this._d = new THREE.Vector3();
  }

  /* ── detonation entry points ─────────────────────────────────── */

  water(point, power = 1){ this._detonate(point, power, true); }
  land(point, power = 1){ this._detonate(point, power, false); }

  _detonate(point, power, isWater){
    power = THREE.MathUtils.clamp(power, 0.15, 3.0);
    this.flash = 1;

    let li = 0;
    for(; li < this.lights.length; li++) if(this.lights[li].t <= 0) break;
    if(li < this.lights.length){
      const L = this.lights[li];
      L.t = L.maxT;
      L.light.position.set(point.x, point.y + 4, point.z);
      L.light.color.setHex(isWater ? 0xfff0c8 : 0xffb070);
      L.light.intensity = (isWater ? 900 : 500)*power;
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
    const coreN = Math.round(110*power);
    const skirtN = Math.round(90*power);
    const peakH = THREE.MathUtils.lerp(38, 55, Math.random())*scale;

    // core: a fountain, not a firehose — each particle gets its own apex
    // height, and the ones that go higher stay narrower (real water does
    // this because drag scrubs horizontal speed off the slower streams
    // long before it touches vertical speed). That correlation is what
    // makes the shape taper instead of reading as a uniform cloud.
    let idx = 0;
    for(let n = 0; n < coreN && idx < this.brightN; idx++){
      const q = this.bright[idx];
      if(q.life > 0) continue;
      n++;
      const a = Math.random()*Math.PI*2;
      const h01 = 0.35 + Math.random()*0.65;           // fraction of peakH this one reaches
      const vy = Math.sqrt(2*peakH*h01*G);
      const outSpeed = (3 + (1 - h01)*13)*scale;         // low streams flare out, tall ones stay tight
      q.p.set(point.x + Math.cos(a)*0.6*scale, point.y, point.z + Math.sin(a)*0.6*scale);
      q.v.set(Math.cos(a)*outSpeed, vy, Math.sin(a)*outSpeed);
      q.life = q.maxLife = Math.min(2.6, (2*vy/G)*1.15 + 0.2);   // roughly its own flight time
      q.delay = Math.random()*0.05;
      q.size = (3.2 + Math.random()*2.6)*scale;
      q.grav = G; q.drag = 0.12; q.hug = 0;
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
      q.grav = G*0.9; q.drag = 0.4; q.hug = 0;
      if(isWater){ q.r = 1.0; q.g = 1.0; q.b = 1.0; }
      else       { q.r = 0.40; q.g = 0.32; q.b = 0.22; }
    }
  }

  /* base surge: low, fast, hugs the surface as it spreads — the thing
     most games skip and the thing that actually reads as "water shot". */
  _spawnSurge(point, power, isWater){
    const scale = Math.sqrt(power);
    const n0 = Math.round(90*power);
    let idx = 0;
    for(let n = 0; n < n0 && idx < this.brightN; idx++){
      const q = this.bright[idx];
      if(q.life > 0) continue;
      n++;
      const a = Math.random()*Math.PI*2;
      q.p.set(point.x, point.y + 0.6, point.z);
      const outSpeed = (16 + Math.random()*20)*scale;
      q.v.set(Math.cos(a)*outSpeed, 3 + Math.random()*5, Math.sin(a)*outSpeed);
      q.life = q.maxLife = 2.2 + Math.random()*1.6;
      q.delay = 0.1 + Math.random()*0.2;
      q.size = (4.5 + Math.random()*3.5)*scale;
      q.grav = G*0.35; q.drag = 0.55; q.hug = 1;
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
      const rr = Math.random()*4*scale;
      q.p.set(point.x + Math.cos(a)*rr, point.y + Math.random()*3*scale, point.z + Math.sin(a)*rr);
      q.v.set(Math.cos(windA)*windS + (Math.random()-0.5)*1.5, 2 + Math.random()*4*scale, Math.sin(windA)*windS + (Math.random()-0.5)*1.5);
      q.life = q.maxLife = 4.5 + Math.random()*3.2;
      q.delay = 0.5 + Math.random()*0.8;
      q.size = (8.0 + Math.random()*6.0)*scale;
      q.grav = -0.6;         // faintly buoyant: it climbs, slowly, then drifts apart
      q.drag = 0.5; q.hug = 0;
      if(isWater){ q.r = 0.92; q.g = 0.95; q.b = 0.97; }
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
      s.cx = point.x; s.cz = point.z;
      s.mesh.visible = true;
      s.mesh.position.set(point.x, point.y, point.z);
      s.mesh.scale.setScalar(s.r0);
      s.mesh.material.color.setHex(isWater ? 0xeaf6ff : 0xd9b98a);
      s.mesh.material.opacity = 0;
      return;
    }
  }

  _spawnPatch(point, power, isWater){
    for(const f of this.foams){
      if(f.mesh.visible) continue;
      f.t = 0;
      f.maxT = isWater ? (8 + Math.random()*3) : (9 + Math.random()*3);
      f.cx = point.x; f.cz = point.z;
      f.mesh.visible = true;
      f.mesh.position.set(point.x, point.y + 0.05, point.z);
      f.mesh.scale.setScalar((5 + Math.random()*3)*Math.sqrt(power));
      f.mesh.material.color.setHex(isWater ? 0xf2f8fb : 0x2a241c);
      f.mesh.material.opacity = 0;
      return;
    }
  }

  /* ── per-frame ──────────────────────────────────────────────── */

  update(dt, camPos){
    this.flash = Math.max(0, this.flash - dt/0.3);

    for(const L of this.lights){
      if(L.t <= 0){ if(L.light.intensity) L.light.intensity = 0; continue; }
      L.t -= dt;
      L.light.intensity *= Math.max(0, L.t/L.maxT);
      if(L.t <= 0) L.light.intensity = 0;
    }

    this._updatePool(this.bright, this.brightPts, dt, true);
    this._updatePool(this.mist, this.mistPts, dt, false);

    for(const s of this.rings){
      if(!s.alive) continue;
      s.t += dt;
      const r = s.r0 + s.t*s.rate;
      s.mesh.scale.setScalar(r);
      s.mesh.position.y = this.field.height(s.cx, s.cz) + 0.15;
      const fade = 1 - s.t/s.maxT;
      s.mesh.material.opacity = Math.max(0, 0.6*fade*Math.min(1, s.t*6));
      if(s.t >= s.maxT){ s.alive = false; s.mesh.visible = false; }
    }

    for(const f of this.foams){
      if(!f.mesh.visible) continue;
      f.t += dt;
      f.mesh.position.y = this.field.height(f.cx, f.cz) + 0.05;
      const grow = Math.min(1, f.t*2.2);
      const fade = 1 - THREE.MathUtils.clamp((f.t - f.maxT*0.4)/(f.maxT*0.6), 0, 1);
      f.mesh.material.opacity = 0.45*grow*fade;
      if(f.t >= f.maxT) f.mesh.visible = false;
    }
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
          const wy = this.field.height(q.p.x, q.p.z);
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
    for(const s of this.rings){ this.scene.remove(s.mesh); s.mesh.material.dispose(); }
    this.ringGeo.dispose(); this.ringMat.dispose();
    for(const f of this.foams){ this.scene.remove(f.mesh); f.mesh.material.dispose(); }
    this.dotGeo.dispose(); this.foamMat.dispose(); this.dotTex.dispose();
    for(const L of this.lights) this.scene.remove(L.light);
  }

  /* Pure maths: how hard does a detonation at `blastPoint` shove a body
     at `bodyPos`. Inverse-square, capped in range, with enough lift that
     a near miss heels the hull instead of just sliding it sideways. */
  static impulseAt(blastPoint, bodyPos, yieldN = 5.2e6){
    const dx = bodyPos.x - blastPoint.x, dy = bodyPos.y - blastPoint.y, dz = bodyPos.z - blastPoint.z;
    const dist = Math.max(4, Math.hypot(dx, dy, dz));
    if(dist > 250) return null;
    const power = yieldN/(dist*dist);
    const f = new THREE.Vector3(dx/dist, dy/dist, dz/dist).multiplyScalar(power);
    f.y += power*0.55;
    return f;
  }
}
