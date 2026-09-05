import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   What ordnance does when it goes off. A water shot is a very
   specific sequence — flash, dome, column, crown, falling curtain,
   base surge, foam — and the timing between those stages is what
   sells it, not any one of them alone. A land shot runs the same rig
   with dirt and smoke standing in for water.

   THREE THINGS DECIDE WHETHER THIS READS AS WATER OR AS "generic
   orange particles", and all three are structural, not tuning:

   1. Per-particle alpha must be LOW (0.2-0.5) and the sprite's own
      falloff soft. A water column is a *density gradient* built out of
      hundreds of overlapping translucent droplet clusters. Sprites at
      alpha ~1 saturate to flat white the instant two of them overlap,
      which is exactly how you get the featureless cotton-wool blob
      this file used to draw.
   2. Sprite size must be in METRES and converted with the real
      projection, not a magic pixel constant. Instanced quads are expanded
      in camera space before projection, so the same physical diameter
      survives FOV changes, Retina displays and offscreen render targets.
   3. Mass must not glow. The flash is a genuine light source
      (additive, tiny, gone in ~0.1s); the column, crown, curtain,
      surge and mist are displaced water and are normal-blended so they
      occlude each other and stack into something with volume.

   Sprites come from a procedurally-drawn 2x2 atlas (three irregular
   puffs + one dense droplet) with a per-particle rotation, so a
   thousand particles are not a thousand copies of the same disc.

   Everything is pooled up front (particles, rings, discs, lights) so
   several overlapping detonations cost a fixed, known amount: nothing
   allocates once the game is running. All active detonations share
   these pools — there is one Blast per scene, not one per shot.
   ──────────────────────────────────────────────────────────────── */

const G = 9.81;

/* ease curve for fade-in/out — a linear ramp pops in/out with a visible
   "edge"; smoothstep's flat tangents at 0 and 1 read as continuous instead
   of mechanical. Cheap (one multiply-add extra) so it's used everywhere. */
export function smooth01(x){
  x = x < 0 ? 0 : x > 1 ? 1 : x;
  return x*x*(3 - 2*x);
}

/* ── procedural sprite atlas ─────────────────────────────────────
   No texture files are allowed (and none are wanted): each cell is
   built by accumulating a couple of dozen soft radial dots in 'lighter'
   mode and then masking the result with a global radial falloff. The
   accumulation gives an irregular, cloudy interior — the thing a single
   radial gradient can never have — and the mask guarantees the sprite
   still fades to nothing before the quad edge, so there is no hard disc
   silhouette anywhere.

   Layout (2x2, 256px cells):
     0 compact puff   1 broken puff   2 wispy shred   3 dense droplet
   Cell content is kept inside ~85% of the cell so that mipmap bleeding
   between neighbours only ever pulls in transparent gutter.           */
const CELL = { PUFF: 0, BROKEN: 1, WISP: 2, DROP: 3 };
let _atlas = null;

function drawPuff(ctx, S, blobs, spread, rMin, rMax, a){
  ctx.globalCompositeOperation = 'lighter';
  for(let i = 0; i < blobs; i++){
    // a squashed, randomly-oriented scatter (not a disc of dots) so the
    // resulting silhouette has lobes and notches rather than being round
    const ang = Math.random()*Math.PI*2;
    const rad = Math.pow(Math.random(), 0.6)*spread*S;
    const x = S*0.5 + Math.cos(ang)*rad, y = S*0.5 + Math.sin(ang)*rad*0.85;
    const r = (rMin + Math.random()*(rMax - rMin))*S;
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${a})`);
    g.addColorStop(0.45, `rgba(255,255,255,${a*0.45})`);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(x-r, y-r, r*2, r*2);
  }
  // hard mask to the inner disc: whatever the scatter did, the sprite
  // must reach zero alpha well before the quad edge or rotation would
  // reveal a clipped square.
  ctx.globalCompositeOperation = 'destination-in';
  const m = ctx.createRadialGradient(S*0.5, S*0.5, 0, S*0.5, S*0.5, S*0.5);
  m.addColorStop(0.0, 'rgba(255,255,255,1)');
  m.addColorStop(0.62, 'rgba(255,255,255,0.92)');
  m.addColorStop(0.86, 'rgba(255,255,255,0.18)');
  m.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = m;
  ctx.fillRect(0, 0, S, S);
  ctx.globalCompositeOperation = 'source-over';
}

function buildAtlas(){
  const S = 256;
  const atlas = document.createElement('canvas');
  atlas.width = atlas.height = S*2;
  const actx = atlas.getContext('2d');

  const cell = document.createElement('canvas');
  cell.width = cell.height = S;
  const cctx = cell.getContext('2d');

  const specs = [
    { blobs: 20, spread: 0.13, rMin: 0.10, rMax: 0.22, a: 0.20 }, // compact, dense
    { blobs: 24, spread: 0.20, rMin: 0.07, rMax: 0.18, a: 0.16 }, // broken up
    { blobs: 26, spread: 0.26, rMin: 0.04, rMax: 0.13, a: 0.13 }, // wispy shred
  ];
  for(let i = 0; i < 3; i++){
    cctx.clearRect(0, 0, S, S);
    const s = specs[i];
    drawPuff(cctx, S, s.blobs, s.spread, s.rMin, s.rMax, s.a);
    actx.drawImage(cell, (i%2)*S, Math.floor(i/2)*S);
  }
  // droplet: a small dense core with a soft halo. Used for individual
  // drops and for the fast part of the column, where the eye wants
  // discrete points of water rather than more cloud.
  cctx.clearRect(0, 0, S, S);
  const g = cctx.createRadialGradient(S*0.5, S*0.5, 0, S*0.5, S*0.5, S*0.42);
  g.addColorStop(0.00, 'rgba(255,255,255,1)');
  g.addColorStop(0.30, 'rgba(255,255,255,0.85)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.22)');
  g.addColorStop(1.00, 'rgba(255,255,255,0)');
  cctx.fillStyle = g;
  cctx.fillRect(0, 0, S, S);
  actx.drawImage(cell, S, S);

  const tex = new THREE.CanvasTexture(atlas);
  tex.colorSpace = THREE.SRGBColorSpace;
  // Each atlas cell is independent. Whole-atlas mipmaps eventually blend
  // neighbouring cells; at distance a droplet then becomes somebody else's
  // smoke mask. Linear sampling preserves the transparent cell gutters.
  tex.flipY = false;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}
export function spriteAtlas(){ if(!_atlas) _atlas = buildAtlas(); return _atlas; }

/* Camera-facing instanced quads keep sizes in metres all the way through
   the projection matrix. Point sprites have a hardware diameter limit and
   disappear when their centre crosses a clip plane even if the plume still
   covers the view. Four vertices and six indices per instance remove both
   failure modes, still using one draw call per pool. Flattening the quad
   also reduces fragment work for the ground-hugging gas layer. */
export const PARTICLE_VERT = /* glsl */`
attribute vec2 corner;
attribute float aSize;
attribute float aAspect;
attribute float aFloor;
attribute vec4 aColor;
attribute vec2 aRot;
varying vec4 vColor;
varying vec2 vRot;
varying vec2 vCell;
varying vec2 vUv;
varying vec3 vWorldPosition;
varying float vHeight;
void main(){
  vColor = aColor;
  vRot = vec2(cos(aRot.x), sin(aRot.x));
  vCell = vec2(mod(aRot.y, 2.0), floor(aRot.y*0.5));
  vUv = corner + 0.5;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  mv.xy += corner * vec2(aSize, aSize*aAspect);
  vWorldPosition = (modelMatrix*vec4(position,1.0)).xyz
    + vec3(viewMatrix[0][0],viewMatrix[1][0],viewMatrix[2][0])*corner.x*aSize
    + vec3(viewMatrix[0][1],viewMatrix[1][1],viewMatrix[2][1])*corner.y*aSize*aAspect;
  vHeight = vWorldPosition.y - aFloor;
  gl_Position = projectionMatrix * mv;
}`;
export const PARTICLE_FRAG = /* glsl */`
uniform sampler2D uMap;
uniform float uLight;
uniform float uFire;
uniform float uTime;
varying vec4 vColor;
varying vec2 vRot;
varying vec2 vCell;
varying vec2 vUv;
varying vec3 vWorldPosition;
varying float vHeight;
// Quintic-interpolated 3D noise has continuous first and second
// derivatives across cell boundaries. Three octaves resolve the large
// rolls and smaller folds of a flame without periodic stripe patterns.
float hash31(vec3 p){
  p=fract(p*0.1031);p+=dot(p,p.yzx+33.33);
  return fract((p.x+p.y)*p.z);
}
float noise3(vec3 p){
  vec3 i=floor(p),f=fract(p);f=f*f*f*(f*(f*6.0-15.0)+10.0);
  return mix(mix(mix(hash31(i),hash31(i+vec3(1,0,0)),f.x),
                 mix(hash31(i+vec3(0,1,0)),hash31(i+vec3(1,1,0)),f.x),f.y),
             mix(mix(hash31(i+vec3(0,0,1)),hash31(i+vec3(1,0,1)),f.x),
                 mix(hash31(i+vec3(0,1,1)),hash31(i+vec3(1,1,1)),f.x),f.y),f.z);
}
float flameNoise(vec3 p){return noise3(p)*0.57 + noise3(p*2.03+4.7)*0.29 + noise3(p*4.11+9.2)*0.14;}
void main(){
  vec2 p = vUv - 0.5;
  vec2 r = vec2(p.x*vRot.x - p.y*vRot.y, p.x*vRot.y + p.y*vRot.x) + 0.5;
  if(uFire < 0.5 && (any(lessThan(r, vec2(0.0))) || any(greaterThan(r, vec2(1.0))))) discard;
  float density = texture2D(uMap, (clamp(r, 0.002, 0.998) + vCell)*0.5).a;
  vec3 color = vColor.rgb;
  if(uFire > 0.5){
    // Sample a shared world-space density field, advected upward. Sheets
    // that overlap see the same folds, rather than unrelated sprite noise.
    vec3 domain = vWorldPosition*vec3(0.65,0.9,0.65) - vec3(0.0,uTime*1.7,0.0);
    float n = flameNoise(domain);
    float y = vUv.y;
    float width = 0.46*(1.0-0.58*y);
    float core = 1.0-smoothstep(width*0.15,width,abs(vUv.x-0.5));
    float envelope = core*smoothstep(0.0,0.18,y)*(1.0-smoothstep(0.18,1.0,y));
    density = envelope*smoothstep(0.25,0.72,n);
    float heat = clamp(core*(1.0-y)*(0.45+n),0.0,1.0);
    color = mix(vec3(0.7,0.055,0.005),vec3(1.0,0.72,0.18),heat);
  }
  // Beer-Lambert transmittance: overlapping thin puffs accumulate optical
  // depth instead of immediately clipping to opaque white. The texture is
  // a projected density field, and aColor.a is its time-varying depth.
  float a = (1.0 - exp(-density * max(0.0, vColor.a)))*smoothstep(0.0,0.65,vHeight);
  if(a <= 0.004) discard;
  gl_FragColor = vec4(color * uLight, a);
}`;

export function makeParticlePool(n, blending, scale){
  // `scale` remains accepted for older callers; projection now supplies
  // pixel size exactly, including render targets and the quality governor.
  const g = new THREE.InstancedBufferGeometry();
  g.setIndex([0, 1, 2, 0, 2, 3]);
  g.setAttribute('corner', new THREE.BufferAttribute(new Float32Array([-.5,-.5,.5,-.5,.5,.5,-.5,.5]), 2));
  g.setAttribute('position', new THREE.InstancedBufferAttribute(new Float32Array(n*3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aSize', new THREE.InstancedBufferAttribute(new Float32Array(n), 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aAspect', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(1), 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aFloor', new THREE.InstancedBufferAttribute(new Float32Array(n).fill(-1e6), 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aColor', new THREE.InstancedBufferAttribute(new Float32Array(n*4), 4).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aRot', new THREE.InstancedBufferAttribute(new Float32Array(n*2), 2).setUsage(THREE.DynamicDrawUsage));
  g.instanceCount = n;
  const mat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG,
    uniforms: { uMap: { value: spriteAtlas() }, uLight: { value: 1 }, uFire: { value:0 }, uTime: { value:0 } },
    transparent: true, depthWrite: false, blending, side:THREE.DoubleSide,
  });
  const pts = new THREE.Mesh(g, mat);
  pts.frustumCulled = false;
  pts.onBeforeRender = (renderer, scene) => {
    const env = scene.userData.particleEnvironment;
    // Emission keeps its energy at night; spray/smoke reflect the same
    // day/storm lighting as the sea, with a modest moonlight floor.
    mat.uniforms.uLight.value = blending === THREE.AdditiveBlending || !env ? 1
      : (1 - 0.82*env.uNight.value)*(1 - 0.35*env.uStorm.value);
  };
  return pts;
}

export function makeSoftDot(){
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

/* annulus gradient: transparent centre, a soft broad band near the outer
   edge, transparent again past it. Painting this onto a disc whose radius
   grows over time gives a travelling "front" — the base surge and the
   shock ring both use it — without adding geometry. The band is wide and
   its peak is low: a thin, opaque, hard-edged ring is the single most
   artificial-looking thing you can put on water. */
function makeRingBandTexture(inner = 0.52, outer = 0.97){
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const ctx = c.getContext('2d');
  const cx = 64, cy = 64, R = 64;
  const g = ctx.createRadialGradient(cx,cy,0, cx,cy,R);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(Math.max(0, inner - 0.30), 'rgba(255,255,255,0)');
  g.addColorStop(inner, 'rgba(255,255,255,0.35)');
  g.addColorStop((inner+outer)*0.5, 'rgba(255,255,255,0.9)');
  g.addColorStop(outer, 'rgba(255,255,255,0.25)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0,0,128,128);
  return new THREE.CanvasTexture(c);
}

/* Dedicated, dynamic surface meshes let each pooled effect conform to the
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
    ux[k] = x*0.94; uz[k] = z*0.94;
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

export function makeSurfaceDisc(radial = 3, segments = 32){
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

/* one particle. `sizeA`→`sizeB` over normalised age is the size-over-life
   curve — every real spray or smoke element expands as it entrains air,
   and a constant-size sprite is one of the loudest "cheap particle system"
   tells there is. `hug` clamps to the wave surface (the base surge skims,
   it does not arc), `sink` kills the particle the moment it touches the
   surface (falling spray *returns to the sea*, it does not sink through
   it or hang), and `turb` adds a cheap sine wobble so a mass of droplets
   boils instead of flying on identical clean parabolas. */
function makeParticle(){
  return {
    p: new THREE.Vector3(), v: new THREE.Vector3(),
    life: 0, maxLife: 1, delay: 0, age: 0,
    sizeA: 1, sizeB: 1, sizeCurve: 1,
    alpha: 1, fadeIn: 0.05, fadeOutFrac: 0.4,
    r: 1, g: 1, b: 1, r1: 1, g1: 1, b1: 1, coolTime: 1,
    grav: G, drag: 0, hug: 0, sink: 0, water: true, groundY: 0,
    turb: 0, tPhase: 0,
    rot: 0, rotV: 0, cell: 0,
    // baked once at spawn: a per-particle brightness/opacity jitter so a
    // few hundred droplets don't all fade on the exact same curve — that
    // uniformity is a big part of what reads as "cheap particle system".
    jit: 1,
  };
}

export class Blast {
  constructor(scene, field, opts = {}){
    this.scene = scene;
    this.field = field;

    this.flash = 0;
    this._flashT = 0;
    this._flashRaw = 0;
    this._flashPeak = 0;
    this._flashPt = new THREE.Vector3();
    this._flashAtten = -1;

    // ── particle pools, three draw calls total ─────────────────────
    // flash: the instant, additive burst — a real light, very brief.
    // body: dome, column, crown, droplets, base surge — the "mass" of
    //       the shot. Normal blend: it must occlude, not glow.
    // mist: falling curtain and the lingering haze, very low alpha.
    // Counts are up slightly on the old rig but the sprites are ~3x
    // smaller across, so total shaded area (the thing that actually
    // costs) is down by roughly an order of magnitude.
    this.flashN = opts.flashParticles || 420;
    this.bodyN = opts.bodyParticles || 5200;
    this.mistN = opts.mistParticles || 2200;
    const uScale = opts.sizeScale;
    this.flashPts = makeParticlePool(this.flashN, THREE.AdditiveBlending, uScale);
    this.bodyPts = makeParticlePool(this.bodyN, THREE.NormalBlending, uScale);
    this.mistPts = makeParticlePool(this.mistN, THREE.NormalBlending, uScale);
    this.flashPts.renderOrder = 6;
    this.bodyPts.renderOrder = 4;
    this.mistPts.renderOrder = 3;
    scene.add(this.flashPts, this.bodyPts, this.mistPts);

    this.flashP = []; for(let i = 0; i < this.flashN; i++) this.flashP.push(makeParticle());
    this.body   = []; for(let i = 0; i < this.bodyN;  i++) this.body.push(makeParticle());
    this.mist   = []; for(let i = 0; i < this.mistN;  i++) this.mist.push(makeParticle());
    // rolling allocation cursors: a fresh spawn starts scanning where the
    // last one stopped, so filling 1500 particles is O(1500), not O(n²).
    this._curFlash = 0; this._curBody = 0; this._curMist = 0;

    // ── shock ring: a faint bright line racing across the surface ──
    this.ringMat = new THREE.MeshBasicMaterial({
      color: 0xeaf6ff, transparent: true, opacity: 0,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
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

    // ── base-surge sheet: a soft, wide band that grows outward and
    //    fades, giving the low spray ring continuity between droplets.
    //    Deliberately faint — it exists to bind the surge particles
    //    together, not to be seen as a disc in its own right. ──
    this.bandTex = makeRingBandTexture();
    this.surgeMat = new THREE.MeshBasicMaterial({
      map: this.bandTex, color: 0xf4fbff, transparent: true, opacity: 0,
      blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
    this.surges = [];
    const SN = opts.surges || 6;
    for(let i = 0; i < SN; i++){
      const surface = makeSurfaceDisc();
      const mesh = new THREE.Mesh(surface.geometry, this.surgeMat.clone());
      mesh.visible = false;
      mesh.frustumCulled = false;
      mesh.renderOrder = 3;
      scene.add(mesh);
      this.surges.push({ mesh, ux:surface.ux, uz:surface.uz, t: 0, maxT: 1, r0: 1, rate: 1,
        cx: 0, cy: 0, cz: 0, water: true, alive: false });
    }

    // ── residual foam / scorch discs ──────────────────────────────
    this.dotTex = makeSoftDot();
    this.foamMat = new THREE.MeshBasicMaterial({
      map: this.dotTex, color: 0xffffff, transparent: true, opacity: 0,
      blending: THREE.NormalBlending, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
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

  // A carrier opening is an airborne puff, not a water detonation:
  // no surface rings, column, damage impulse or foam at release altitude.
  airburst(point,power=0.2){
    if(!point || !Number.isFinite(point.x+point.y+point.z))return;
    this._spawnFlash(point,power,false,Math.sqrt(power));
    this._spawnMist(point,power,false,Math.sqrt(power));
  }

  water(point, power = 1){ this._detonate(point, power, true); }
  land(point, power = 1){ this._detonate(point, power, false); }

  _detonate(point, power, isWater){
    if(!point || !Number.isFinite(point.x + point.y + point.z)) return;
    power = Number.isFinite(power) ? THREE.MathUtils.clamp(power, 0.015, 3.0) : 1;
    // Screen flash is raised here but attenuated by camera distance in
    // update(): main.js adds strikes.flash straight onto the composite, so
    // an un-attenuated flash whites out the entire screen for a bomb that
    // went off 600 m away. It should be a punch up close and nothing at all
    // from across the bay.
    this._flashRaw = 1;
    this._flashT = 0;
    this._flashPeak = Math.min(1, 0.55*Math.sqrt(power));
    this._flashPt.set(point.x, point.y, point.z);
    this._flashAtten = -1;

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

    // Column height drives most of the other stages, so it is drawn once
    // here and handed down. ~35-50 m for a 500 lb store: tall enough to
    // dwarf a boat, short enough that it is plainly a bomb and not a
    // nuclear test.
    const s = Math.sqrt(power);
    const peakH = (30 + Math.random()*14)*s;

    this._spawnFlash(point, power, isWater, s);
    this._spawnDome(point, power, isWater, s);
    this._spawnColumn(point, power, isWater, s, peakH);
    this._spawnPlume(point, power, isWater, s, peakH);
    this._spawnDroplets(point, power, isWater, s, peakH);
    this._spawnCurtain(point, power, isWater, s, peakH);
    this._spawnSurge(point, power, isWater, s);
    this._spawnMist(point, power, isWater, s);
    this._spawnRing(point, power, isWater);
    this._spawnSurgeSheet(point, power, isWater);
    this._spawnPatch(point, power, isWater);
  }

  /* Rolling free-slot search. Returns -1 when the pool is saturated, and
     the caller simply stops spawning that stage — a dropped particle is
     always better than a stall or an allocation. */
  _take(list, cur){
    const n = list.length;
    for(let k = 0; k < n; k++){
      const i = cur + k < n ? cur + k : cur + k - n;
      if(list[i].life <= 0) return i;
    }
    return -1;
  }

  /* the instant burst: additive, small, gone in a tenth of a second. This
     is the only part of the shot that should actually glow, and the only
     part that is allowed to be near-opaque. */
  _spawnFlash(point, power, isWater, s){
    const n0 = Math.round(26*power);
    for(let n = 0; n < n0; n++){
      const i = this._take(this.flashP, this._curFlash); if(i < 0) break;
      this._curFlash = (i + 1) % this.flashN;
      const q = this.flashP[i];
      const a = Math.random()*Math.PI*2;
      const rr = Math.random()*1.2*s;
      q.p.set(point.x + Math.cos(a)*rr, point.y + 0.4 + Math.random()*2*s, point.z + Math.sin(a)*rr);
      const outSpeed = (5 + Math.random()*14)*s;
      q.v.set(Math.cos(a)*outSpeed, (5 + Math.random()*14)*s, Math.sin(a)*outSpeed);
      q.age = 0; q.delay = 0; q.fadeIn = 0; q.fadeOutFrac = 1.0;
      q.life = q.maxLife = 0.07 + Math.random()*0.09;
      q.sizeA = (2.2 + Math.random()*2.6)*s;
      q.sizeB = q.sizeA*2.4; q.sizeCurve = 0.55;
      q.alpha = 0.75; q.jit = 0.7 + Math.random()*0.3;
      q.grav = 0; q.drag = 3.0; q.hug = 0; q.sink = 0; q.water = isWater; q.groundY = point.y;
      q.turb = 0; q.tPhase = 0;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*3;
      q.cell = Math.random() < 0.5 ? CELL.PUFF : CELL.BROKEN;
      q.coolTime = q.maxLife;
      if(isWater){ q.r=1.0; q.g=0.96; q.b=0.84; q.r1=0.85; q.g1=0.86; q.b1=0.90; }
      else       { q.r=1.0; q.g=0.82; q.b=0.42; q.r1=0.55; q.g1=0.26; q.b1=0.12; }
    }
  }

  /* The dome: the first 0.3 s, where the surface is thrown outward as a
     low hemispherical shell before the column has climbed out of it. This
     is the stage that makes the base look dense and white — without it the
     column appears to grow out of nothing. */
  _spawnDome(point, power, isWater, s){
    const n0 = Math.round(120*power);
    for(let n = 0; n < n0; n++){
      const i = this._take(this.body, this._curBody); if(i < 0) break;
      this._curBody = (i + 1) % this.bodyN;
      const q = this.body[i];
      const a = Math.random()*Math.PI*2;
      // elevation biased low: a dome, not a ball
      const el = Math.pow(Math.random(), 1.6)*1.15;
      const speed = (8 + Math.random()*15)*s;
      const ch = Math.cos(el), sh = Math.sin(el);
      q.p.set(point.x + Math.cos(a)*0.8*s, point.y + 0.3, point.z + Math.sin(a)*0.8*s);
      q.v.set(Math.cos(a)*speed*ch, speed*sh, Math.sin(a)*speed*ch);
      q.age = 0; q.delay = Math.random()*0.03;
      q.life = q.maxLife = 0.45 + Math.random()*0.55;
      q.fadeIn = 0.03; q.fadeOutFrac = 0.6;
      q.sizeA = (1.4 + Math.random()*2.2)*s;
      q.sizeB = q.sizeA*(2.4 + Math.random()); q.sizeCurve = 0.7;
      q.alpha = 0.42; q.jit = 0.7 + Math.random()*0.3;
      q.grav = G*0.8; q.drag = 1.4; q.hug = 0; q.sink = 1; q.water = isWater; q.groundY = point.y;
      q.turb = 1.6*s; q.tPhase = Math.random()*6.283;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*2.0;
      q.cell = Math.random() < 0.6 ? CELL.PUFF : CELL.BROKEN;
      q.coolTime = 0.9;
      if(isWater){ q.r=0.94; q.g=0.97; q.b=1.0; q.r1=0.70; q.g1=0.79; q.b1=0.86; }
      else       { q.r=0.42; q.g=0.34; q.b=0.24; q.r1=0.26; q.g1=0.21; q.b1=0.15; }
    }
  }

  /* The column: a tight, tall shaft of atomised water. Hundreds of SMALL
     droplet sprites at low alpha — the density comes from overlap, and
     because each one is small the shaft keeps a legible, ragged edge
     instead of becoming one smooth blob. Outward speed is small at the
     top and larger at the foot, which is what gives a real column its
     flared skirt and narrow waist. */
  _spawnColumn(point, power, isWater, s, peakH){
    const n0 = Math.round(520*power);
    for(let n = 0; n < n0; n++){
      const i = this._take(this.body, this._curBody); if(i < 0) break;
      this._curBody = (i + 1) % this.bodyN;
      const q = this.body[i];
      const a = Math.random()*Math.PI*2;
      const h01 = 0.10 + Math.pow(Math.random(), 0.7)*0.90;
      const vy = Math.sqrt(2*peakH*h01*G);
      const outSpeed = (0.2 + Math.pow(Math.random(), 2)*1.8 + (1-h01)*2.6)*s;
      const rr = Math.pow(Math.random(), 0.6)*1.7*s;
      q.p.set(point.x + Math.cos(a)*rr, point.y + 0.2, point.z + Math.sin(a)*rr);
      q.v.set(Math.cos(a)*outSpeed, vy, Math.sin(a)*outSpeed);
      // lives through the whole rise AND fall: the descending half of the
      // column is the falling spray, not a separate effect.
      q.life = q.maxLife = (2*vy/G)*1.05 + 0.3;
      q.delay = 0.02 + Math.random()*0.10;
      q.age = 0; q.fadeIn = 0.06; q.fadeOutFrac = 0.42;
      q.sizeA = (0.7 + Math.random()*1.5)*s;
      q.sizeB = q.sizeA*(2.0 + Math.random()*1.6);   // atomises as it flies
      q.sizeCurve = 0.8;
      q.alpha = 0.26 + Math.random()*0.20;
      q.jit = 0.7 + Math.random()*0.3;
      q.grav = G; q.drag = 0.10; q.hug = 0; q.sink = 1; q.water = isWater; q.groundY = point.y;
      q.turb = (1.0 + Math.random()*1.4)*s; q.tPhase = Math.random()*6.283;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*1.6;
      // the fast core is made of droplets, the slower outer sheath of
      // broken puffs — mixing the two is what stops it reading as either
      // "fog" or "confetti".
      const rc = Math.random();
      q.cell = rc < 0.45 ? CELL.DROP : (rc < 0.8 ? CELL.BROKEN : CELL.WISP);
      q.coolTime = q.maxLife*0.8;
      if(isWater){ q.r=0.96; q.g=0.98; q.b=1.0; q.r1=0.66; q.g1=0.75; q.b1=0.83; }
      else       { q.r=0.40; q.g=0.32; q.b=0.22; q.r1=0.24; q.g1=0.19; q.b1=0.14; }
    }
  }

  /* The crown: the aerated, billowing head of the column. Few, big, very
     translucent, slow — they hang above the shaft and give it a top. Alpha
     has to stay low here or these alone turn the whole thing into a
     cauliflower. */
  _spawnPlume(point, power, isWater, s, peakH){
    const n0 = Math.round(140*power);
    for(let n = 0; n < n0; n++){
      const i = this._take(this.body, this._curBody); if(i < 0) break;
      this._curBody = (i + 1) % this.bodyN;
      const q = this.body[i];
      const a = Math.random()*Math.PI*2;
      const h01 = 0.45 + Math.random()*0.55;
      const vy = Math.sqrt(2*peakH*h01*G)*0.85;
      const outSpeed = (0.5 + Math.random()*2.6)*s;
      const rr = Math.random()*2.2*s;
      q.p.set(point.x + Math.cos(a)*rr, point.y + 0.5, point.z + Math.sin(a)*rr);
      q.v.set(Math.cos(a)*outSpeed, vy, Math.sin(a)*outSpeed);
      q.life = q.maxLife = 1.5 + Math.random()*1.5;
      q.delay = 0.06 + Math.random()*0.22;
      q.age = 0; q.fadeIn = 0.18; q.fadeOutFrac = 0.6;
      q.sizeA = (2.0 + Math.random()*2.6)*s;
      q.sizeB = q.sizeA*(2.2 + Math.random()*1.2); q.sizeCurve = 0.65;
      q.alpha = 0.16 + Math.random()*0.08;
      q.jit = 0.75 + Math.random()*0.25;
      // aerated water hangs: less than full gravity, plenty of drag
      q.grav = G*0.5; q.drag = 0.6; q.hug = 0; q.sink = 0; q.water = isWater; q.groundY = point.y;
      q.turb = 0.9*s; q.tPhase = Math.random()*6.283;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*0.9;
      q.cell = Math.random() < 0.55 ? CELL.PUFF : CELL.WISP;
      q.coolTime = q.maxLife;
      if(isWater){ q.r=0.92; q.g=0.95; q.b=1.0; q.r1=0.72; q.g1=0.78; q.b1=0.85; }
      else       { q.r=0.36; q.g=0.31; q.b=0.25; q.r1=0.20; q.g1=0.18; q.b1=0.16; }
    }
  }

  /* Individual droplets thrown clear of the column. Small, opaque, sharp,
     ballistic — a handful of these arcing out and pattering back is worth
     more for scale and for "that is water" than another hundred puffs. */
  _spawnDroplets(point, power, isWater, s, peakH){
    const n0 = Math.round(210*power);
    for(let n = 0; n < n0; n++){
      const i = this._take(this.body, this._curBody); if(i < 0) break;
      this._curBody = (i + 1) % this.bodyN;
      const q = this.body[i];
      const a = Math.random()*Math.PI*2;
      const el = 0.5 + Math.random()*0.9;
      const speed = (12 + Math.random()*24)*s;
      const ch = Math.cos(el), sh = Math.sin(el);
      q.p.set(point.x, point.y + 0.6, point.z);
      q.v.set(Math.cos(a)*speed*ch, speed*sh, Math.sin(a)*speed*ch);
      q.life = q.maxLife = (2*speed*sh/G) + 0.3;
      q.delay = 0.01 + Math.random()*0.06;
      q.age = 0; q.fadeIn = 0.02; q.fadeOutFrac = 0.2;
      q.sizeA = (0.22 + Math.random()*0.45)*s;
      q.sizeB = q.sizeA*1.5; q.sizeCurve = 1.0;
      q.alpha = 0.65 + Math.random()*0.3;
      q.jit = 0.8 + Math.random()*0.2;
      q.grav = G; q.drag = 0.02; q.hug = 0; q.sink = 1; q.water = isWater; q.groundY = point.y;
      q.turb = 0; q.tPhase = 0;
      q.rot = 0; q.rotV = 0; q.cell = CELL.DROP;
      q.coolTime = 1e9;
      if(isWater){ q.r=0.93; q.g=0.96; q.b=1.0; q.r1=q.r; q.g1=q.g; q.b1=q.b; }
      else       { q.r=0.34; q.g=0.27; q.b=0.19; q.r1=q.r; q.g1=q.g; q.b1=q.b; }
    }
  }

  /* The falling curtain: the column coming back down as a veil of spray
     around the impact point, roughly a second after the shot. The column
     particles fall on their own, but they fall along the paths they rose
     on; a real column collapses outward into a much wider, softer skirt
     of descending water, and that skirt is the last clearly "water" read
     before only foam and haze are left. */
  _spawnCurtain(point, power, isWater, s, peakH){
    const n0 = Math.round(180*power);
    for(let n = 0; n < n0; n++){
      const i = this._take(this.mist, this._curMist); if(i < 0) break;
      this._curMist = (i + 1) % this.mistN;
      const q = this.mist[i];
      const a = Math.random()*Math.PI*2;
      const rr = (2.5 + Math.random()*9)*s;
      const h = peakH*(0.25 + Math.random()*0.5);
      q.p.set(point.x + Math.cos(a)*rr, point.y + h, point.z + Math.sin(a)*rr);
      q.v.set(Math.cos(a)*(0.8 + Math.random()*3), -(1 + Math.random()*5), Math.sin(a)*(0.8 + Math.random()*3));
      q.life = q.maxLife = 1.4 + Math.random()*1.3;
      q.delay = 0.55 + Math.random()*0.9;
      q.age = 0; q.fadeIn = 0.25; q.fadeOutFrac = 0.5;
      q.sizeA = (1.0 + Math.random()*1.8)*s;
      q.sizeB = q.sizeA*1.9; q.sizeCurve = 0.8;
      q.alpha = 0.15 + Math.random()*0.10;
      q.jit = 0.7 + Math.random()*0.3;
      q.grav = G*0.8; q.drag = 0.35; q.hug = 0; q.sink = 1; q.water = isWater; q.groundY = point.y;
      q.turb = 0.5*s; q.tPhase = Math.random()*6.283;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*0.8;
      q.cell = Math.random() < 0.5 ? CELL.WISP : CELL.BROKEN;
      q.coolTime = 1e9;
      if(isWater){ q.r=0.88; q.g=0.93; q.b=0.99; q.r1=q.r; q.g1=q.g; q.b1=q.b; }
      else       { q.r=0.33; q.g=0.28; q.b=0.22; q.r1=q.r; q.g1=q.g; q.b1=q.b; }
    }
  }

  /* Base surge: low, fast, hugs the surface as it spreads — the thing most
     games skip and the thing that actually reads as "water shot". Particles
     carry the broken, spraying edge; _spawnSurgeSheet carries the faint
     continuous sheet underneath them. */
  _spawnSurge(point, power, isWater, s){
    const n0 = Math.round(300*power);
    for(let n = 0; n < n0; n++){
      const i = this._take(this.body, this._curBody); if(i < 0) break;
      this._curBody = (i + 1) % this.bodyN;
      const q = this.body[i];
      const a = Math.random()*Math.PI*2;
      q.p.set(point.x + Math.cos(a)*1.5*s, point.y + 0.5, point.z + Math.sin(a)*1.5*s);
      const outSpeed = (11 + Math.random()*16)*s;
      q.v.set(Math.cos(a)*outSpeed, 0.4 + Math.random()*1.8, Math.sin(a)*outSpeed);
      q.life = q.maxLife = 1.6 + Math.random()*1.6;
      q.delay = 0.05 + Math.random()*0.22;
      q.age = 0; q.fadeIn = 0.12; q.fadeOutFrac = 0.65;
      q.sizeA = (1.2 + Math.random()*2.0)*s;
      q.sizeB = q.sizeA*(3.0 + Math.random()*1.5);  // the sheet thins and spreads
      q.sizeCurve = 0.75;
      q.alpha = 0.22 + Math.random()*0.14;
      q.jit = 0.75 + Math.random()*0.25;
      q.grav = G*0.5; q.drag = 1.0; q.hug = 1; q.sink = 0; q.water = isWater; q.groundY = point.y;
      q.turb = (0.8 + Math.random()*1.2)*s; q.tPhase = Math.random()*6.283;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*1.2;
      q.cell = Math.random() < 0.5 ? CELL.BROKEN : CELL.WISP;
      q.coolTime = 1.6;
      if(isWater){ q.r=0.93; q.g=0.97; q.b=0.99; q.r1=0.74; q.g1=0.82; q.b1=0.86; }
      else       { q.r=0.44; q.g=0.36; q.b=0.26; q.r1=0.28; q.g1=0.23; q.b1=0.17; }
    }
  }

  /* The lingering haze: slow, buoyant, drifts and dissipates over several
     seconds — this is what is still hanging there at t=6-8 s. Water mist
     barely rises and hugs the site; land smoke actually climbs. Alpha is
     tiny on purpose: this stage is a veil, and a veil you can see the
     individual sprites in is worse than no veil. */
  _spawnMist(point, power, isWater, s){
    const n0 = Math.round(150*power);
    const windA = Math.random()*Math.PI*2, windS = 0.8 + Math.random()*1.6;
    for(let n = 0; n < n0; n++){
      const i = this._take(this.mist, this._curMist); if(i < 0) break;
      this._curMist = (i + 1) % this.mistN;
      const q = this.mist[i];
      const a = Math.random()*Math.PI*2;
      const plume = Math.random() < 0.5;
      const rr = Math.random()*(plume ? 4 : 9)*s;
      const out = (plume ? (0.2 + Math.random()*0.9) : (1.2 + Math.random()*2.2))*s;
      q.p.set(point.x + Math.cos(a)*rr, point.y + 0.4 + Math.random()*4*s, point.z + Math.sin(a)*rr);
      q.v.set(Math.cos(windA)*windS + Math.cos(a)*out,
              (plume ? 1.6 : 0.4) + Math.random()*(plume ? 2 : 1)*s,
              Math.sin(windA)*windS + Math.sin(a)*out);
      q.life = q.maxLife = 4.5 + Math.random()*4.0;
      q.delay = 0.4 + Math.random()*1.1;
      q.age = 0; q.fadeIn = 0.8; q.fadeOutFrac = 0.6;
      q.sizeA = (4 + Math.random()*5)*s;
      q.sizeB = q.sizeA*(2.2 + Math.random()); q.sizeCurve = 0.6;
      q.alpha = isWater ? (0.07 + Math.random()*0.07) : (0.11 + Math.random()*0.09);
      q.jit = 0.7 + Math.random()*0.3;
      q.grav = isWater ? -0.14 : -1.2;      // negative gravity is buoyancy
      q.drag = 0.55; q.hug = 0; q.sink = 0;
      q.turb = 0.35*s; q.tPhase = Math.random()*6.283;
      q.rot = Math.random()*6.283; q.rotV = (Math.random()-0.5)*0.5;
      q.cell = Math.random() < 0.5 ? CELL.WISP : CELL.PUFF;
      q.coolTime = 6;
      if(isWater){ q.r=0.88; q.g=0.92; q.b=0.96; q.r1=0.80; q.g1=0.85; q.b1=0.90; }
      else       { q.r=0.30; q.g=0.28; q.b=0.26; q.r1=0.17; q.g1=0.16; q.b1=0.15; }
    }
  }

  _spawnRing(point, power, isWater){
    for(const s of this.rings){
      if(s.alive) continue;
      s.alive = true; s.t = 0;
      s.maxT = 1.6 + Math.random()*0.5;
      s.rate = (42 + Math.random()*16)*Math.sqrt(power);
      s.r0 = 1.6*Math.sqrt(power);
      s.cx = point.x; s.cy = point.y; s.cz = point.z; s.water = isWater;
      s.mesh.visible = true;
      s.mesh.position.set(point.x, 0, point.z);
      s.mesh.scale.setScalar(1);
      s.mesh.material.color.setHex(isWater ? 0xeaf6ff : 0xd9b98a);
      s.mesh.material.opacity = 0;
      return;
    }
  }

  /* The faint surge sheet — see makeRingBandTexture. Travels a little
     slower than the shock ring (it is water mass, not a pressure wave) and
     lingers a bit longer. */
  _spawnSurgeSheet(point, power, isWater){
    for(const s of this.surges){
      if(s.alive) continue;
      s.alive = true; s.t = 0;
      s.maxT = 2.6 + Math.random()*0.8;
      s.rate = (13 + Math.random()*7)*Math.sqrt(power);
      s.r0 = 2.2*Math.sqrt(power);
      s.cx = point.x; s.cy = point.y; s.cz = point.z; s.water = isWater;
      s.mesh.visible = true;
      s.mesh.position.set(point.x, 0, point.z);
      s.mesh.scale.setScalar(1);
      s.mesh.material.color.setHex(isWater ? 0xf4fbff : 0xcbb488);
      s.mesh.material.opacity = 0;
      return;
    }
  }

  _spawnPatch(point, power, isWater){
    for(const f of this.foams){
      if(f.mesh.visible) continue;
      f.t = 0;
      // Foam should still be plainly visible around the ten-second mark —
      // that's the whole point of it lingering — and only fully gone a
      // few seconds past that.
      f.maxT = 13 + Math.random()*3;
      f.cx = point.x; f.cy = point.y; f.cz = point.z; f.water = isWater;
      f.radius = (7 + Math.random()*4)*Math.sqrt(power);
      f.mesh.visible = true;
      f.mesh.position.set(point.x, 0, point.z);
      f.mesh.scale.setScalar(1);
      f.mesh.material.color.setHex(isWater ? 0xeef6fa : 0x2a241c);
      f.mesh.material.opacity = 0;
      return;
    }
  }

  /* ── per-frame ──────────────────────────────────────────────── */

  update(dt, camPos){
    if(!Number.isFinite(dt) || dt <= 0) return;

    if(this._flashRaw > 0){
      if(this._flashAtten < 0){
        // resolved on the first frame after the shot, when a camera
        // position is finally available
        if(camPos){
          const d = Math.hypot(camPos.x - this._flashPt.x, camPos.y - this._flashPt.y, camPos.z - this._flashPt.z);
          const k = THREE.MathUtils.clamp(1 - d/240, 0, 1);
          this._flashAtten = k*k;
        } else this._flashAtten = 0.5;
      }
      // hold briefly at full brightness, then fall fast — a "hard" flash
      // reads as a spike, not a dimmer fading down. Both numbers are much
      // shorter than a frame budget's worth of patience: 0.02 s hold.
      this._flashT += dt;
      const hold = 0.02, fall = 0.10;
      this._flashRaw = this._flashT < hold ? 1 : Math.max(0, 1 - (this._flashT-hold)/fall);
      this.flash = this._flashRaw*this._flashPeak*this._flashAtten;
      if(this._flashRaw <= 0) this.flash = 0;
    }

    for(const L of this.lights){
      if(L.t <= 0){ if(L.light.intensity) L.light.intensity = 0; continue; }
      L.t -= dt;
      const u = Math.max(0, L.t/L.maxT);
      L.light.intensity = L.peak*u*u;
      if(L.t <= 0) L.light.intensity = 0;
    }

    this._updatePool(this.flashP, this.flashPts, dt, false);
    this._updatePool(this.body, this.bodyPts, dt, true);
    this._updatePool(this.mist, this.mistPts, dt, true);

    for(const s of this.rings){
      if(!s.alive) continue;
      s.t += dt;
      const r = s.r0 + s.t*s.rate;
      this._deformSurface(s, r, 0.16);
      const fade = 1 - s.t/s.maxT;
      s.mesh.material.opacity = Math.max(0, 0.20*fade*fade*Math.min(1, s.t*8));
      if(s.t >= s.maxT){ s.alive = false; s.mesh.visible = false; }
    }

    for(const s of this.surges){
      if(!s.alive) continue;
      s.t += dt;
      const r = s.r0 + s.t*s.rate;
      this._deformSurface(s, r, 0.20);
      const grow = Math.min(1, s.t*6);           // snap in fast, it's the leading edge
      const fade = 1 - s.t/s.maxT;
      s.mesh.material.opacity = Math.max(0, 0.30*grow*fade*fade);
      if(s.t >= s.maxT){ s.alive = false; s.mesh.visible = false; }
    }

    for(const f of this.foams){
      if(!f.mesh.visible) continue;
      f.t += dt;
      // the foam patch keeps growing slowly: churned water spreads out and
      // dilutes rather than sitting as a fixed-size stain
      this._deformSurface(f, f.radius*(0.55 + 0.45*Math.min(1, f.t*0.5)), 0.1);
      const grow = Math.min(1, f.t*1.8);
      const fade = 1 - THREE.MathUtils.clamp((f.t - f.maxT*0.4)/(f.maxT*0.6), 0, 1);
      f.mesh.material.opacity = 0.30*grow*fade;
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
    const rotArr = points.geometry.attributes.aRot.array;
    for(let i = 0; i < list.length; i++){
      const q = list[i], o3 = i*3, o4 = i*4, o2 = i*2;
      if(q.delay > 0){ q.delay -= dt; arr[o3]=0; arr[o3+1]=-9999; arr[o3+2]=0; continue; }
      if(q.life > 0){
        q.life -= dt;
        q.age += dt;
        // cheap sine wobble instead of real curl noise — enough to read as
        // turbulent boil in a mass of droplets, not enough to blow the budget.
        if(q.turb > 0){
          q.v.x += Math.sin(q.age*7.3 + q.tPhase)*q.turb*dt;
          q.v.z += Math.cos(q.age*5.1 + q.tPhase*1.7)*q.turb*dt;
        }
        q.v.y -= q.grav*dt;
        const k = Math.max(0, 1 - q.drag*dt);
        q.v.x *= k; q.v.z *= k;
        q.p.addScaledVector(q.v, dt);
        q.rot += q.rotV*dt;

        if(clampToSurface){
          const wy = q.water ? this.field.height(q.p.x, q.p.z) : q.groundY;
          if(q.hug){
            if(q.p.y < wy + 0.4){ q.p.y = wy + 0.4; q.v.y = Math.max(0, q.v.y*0.2); }
          } else if(q.sink){
            // spray that reaches the sea is absorbed by it, on contact —
            // sprites vanishing a metre *under* the surface is a tell
            if(q.p.y < wy + 0.15) q.life = 0;
          } else if(q.p.y < wy - 0.5){
            q.life = 0;
          }
        }
        if(!Number.isFinite(q.p.x + q.p.y + q.p.z)){ q.life = 0; }
      }
      if(q.life > 0){
        arr[o3]=q.p.x; arr[o3+1]=q.p.y; arr[o3+2]=q.p.z;
        const u = 1 - q.life/q.maxLife;            // 0 at birth, 1 at death
        // opacity is fade-in * fade-out, not fade-out alone — popping to full
        // size the instant a droplet spawns is as much a tell as vanishing
        // abruptly at the end of its life.
        const fadeIn = q.fadeIn > 0 ? smooth01(q.age/q.fadeIn) : 1;
        const fadeOut = smooth01(q.life/(q.maxLife*q.fadeOutFrac));
        sizeArr[i] = q.sizeA + (q.sizeB - q.sizeA)*Math.pow(u, q.sizeCurve);
        const cool = q.coolTime > 0 ? Math.min(1, q.age/q.coolTime) : 1;
        colArr[o4]   = q.r + (q.r1 - q.r)*cool;
        colArr[o4+1] = q.g + (q.g1 - q.g)*cool;
        colArr[o4+2] = q.b + (q.b1 - q.b)*cool;
        colArr[o4+3] = fadeIn*fadeOut*q.jit*q.alpha;
        rotArr[o2] = q.rot; rotArr[o2+1] = q.cell;
      } else {
        arr[o3]=0; arr[o3+1]=-9999; arr[o3+2]=0;
      }
    }
    points.geometry.attributes.position.needsUpdate = true;
    points.geometry.attributes.aSize.needsUpdate = true;
    points.geometry.attributes.aColor.needsUpdate = true;
    points.geometry.attributes.aRot.needsUpdate = true;
  }

  dispose(){
    this.scene.remove(this.flashPts, this.bodyPts, this.mistPts);
    this.flashPts.geometry.dispose(); this.flashPts.material.dispose();
    this.bodyPts.geometry.dispose(); this.bodyPts.material.dispose();
    this.mistPts.geometry.dispose(); this.mistPts.material.dispose();
    for(const s of this.rings){ this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    this.ringMat.dispose();
    for(const s of this.surges){ this.scene.remove(s.mesh); s.mesh.geometry.dispose(); s.mesh.material.dispose(); }
    this.surgeMat.dispose(); this.bandTex.dispose();
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
