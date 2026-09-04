import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   A sum-of-Gerstner-waves sea. The identical spectrum is evaluated
   on the GPU (displacement + normals) and on the CPU (buoyancy), so
   a hull floats on exactly the surface you can see.

   The wave count is a quality knob: 10 for a weak GPU, 32 on an
   M1 Max, where the extra octaves buy genuinely richer water.
   ──────────────────────────────────────────────────────────────── */

const G = 9.81;

function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

export class WaveField {
  constructor(count = 24){
    // The shader is compiled once for this capacity. Lower quality tiers use
    // fewer live waves and zero-fill the rest, so changing quality does not
    // require rebuilding every material that samples the sea.
    this.count = Math.max(2, Math.floor(count));
    this.activeCount = this.count;
    this.waves = [];
    this.time = 0;
    this.windDir = new THREE.Vector2(1,0.35).normalize();
    this.configure({ swell: 1.0, windDeg: 38 });
  }

  /* swell = rough half-height of the sea in metres, chop = 0..1.4 */
  configure({ swell = 1.0, windDeg = 38, chop = 1.05, longest = 92,
              count = this.activeCount } = {}){
    const rng = mulberry32(9137);
    const NW = THREE.MathUtils.clamp(Math.floor(count || this.count), 2, this.count);
    this.activeCount = NW;
    this.swell = swell; this.chop = chop; this.windDeg = windDeg;
    const wind = windDeg*Math.PI/180;
    this.windDir.set(Math.cos(wind), Math.sin(wind));
    this.waves.length = 0;

    // geometric wavelength ladder from long swell down to 20cm chop
    const shortest = 0.55;
    const ratio = Math.pow(shortest/longest, 1/(NW-1));
    const raw = [], lens = [];
    for(let i = 0; i < NW; i++){
      const L = longest*Math.pow(ratio, i)*(0.88 + rng()*0.26);
      lens.push(L);
      raw.push(Math.pow(L/longest, 0.88));      // energy falls off with wavelength
    }
    const norm = swell/raw.reduce((a,b)=>a+b, 0);

    for(let i = 0; i < NW; i++){
      const L = lens[i];
      const k = 2*Math.PI/L;
      // directional spreading: long swell runs true with the wind, short chop fans out
      const spread = (rng()*2-1)*(Math.PI*0.48)*(0.14 + 0.86*(i/(NW-1)));
      const ang = wind + spread;
      let amp = raw[i]*norm;
      amp = Math.min(amp, 0.42/k);              // never let a single wave loop over itself
      const w = Math.sqrt(G*k);
      const Q = Math.min(chop/(k*amp*NW), 1.0);
      this.waves.push({ dx:Math.cos(ang), dz:Math.sin(ang), amp, k, w, Q, phase: rng()*Math.PI*2 });
    }
  }

  /* Vertical displacement only — enough for cheap probes (birds, spray, splashes). */
  height(x, z, t = this.time){
    let y = 0;
    for(let i = 0; i < this.waves.length; i++){
      const v = this.waves[i];
      y += v.amp*Math.sin(v.k*(v.dx*x + v.dz*z) - v.w*t + v.phase);
    }
    return y;
  }

  /* Full sample: surface point, normal and the orbital velocity of the water
     at that point (which is what actually pushes a hull around). */
  sample(x, z, out = {}, t = this.time){
    let dy = 0, dxs = 0, dzs = 0;
    let tx = 1, ty = 0, tz = 0;      // d(displaced)/dx
    let bx = 0, by = 0, bz = 1;      // d(displaced)/dz
    let vx = 0, vy = 0, vz = 0;
    const W = this.waves;
    for(let i = 0; i < W.length; i++){
      const v = W[i];
      const f = v.k*(v.dx*x + v.dz*z) - v.w*t + v.phase;
      const c = Math.cos(f), s = Math.sin(f);
      const QA = v.Q*v.amp, WA = v.k*v.amp;
      dxs += QA*v.dx*c;  dzs += QA*v.dz*c;  dy += v.amp*s;
      tx += -v.Q*v.dx*v.dx*WA*s;  ty += v.dx*WA*c;  tz += -v.Q*v.dx*v.dz*WA*s;
      bx += -v.Q*v.dx*v.dz*WA*s;  by += v.dz*WA*c;  bz += -v.Q*v.dz*v.dz*WA*s;
      vx += QA*v.dx*v.w*s;  vy += -v.amp*v.w*c;  vz += QA*v.dz*v.w*s;
    }
    let nx = by*tz - bz*ty, ny = bz*tx - bx*tz, nz = bx*ty - by*tx;
    const l = Math.hypot(nx,ny,nz) || 1;
    out.y = dy; out.dx = dxs; out.dz = dzs;
    out.nx = nx/l; out.ny = ny/l; out.nz = nz/l;
    out.vx = vx; out.vy = vy; out.vz = vz;
    out.steep = tx*bz - tz*bx;             // horizontal Jacobian; < 1 means a crest is folding
    return out;
  }

  /* Packed spectrum for the shader uniforms. */
  pack(){
    const A = [], B = [];
    for(const v of this.waves){
      A.push(new THREE.Vector4(v.dx, v.dz, v.amp, v.k));
      B.push(new THREE.Vector4(v.w, v.Q, v.phase, 0));
    }
    // Uniform arrays keep their compile-time length when a lighter spectrum
    // is active. Zero waves are inert in both displacement and shading.
    while(A.length < this.count){
      A.push(new THREE.Vector4(1, 0, 0, 1));
      B.push(new THREE.Vector4(0, 0, 0, 0));
    }
    return { A, B };
  }

  update(dt){ this.time += dt; }
}

/* GLSL twin of `sample`, generated for a specific wave count.

   `px` is the world-space size of one pixel at this point. Waves whose
   wavelength approaches it are faded out before they can alias — which
   is what stops a summed-sine ocean turning into moiré corduroy in the
   middle distance. Waves are ordered long → short, so once one drops
   out every wave after it has too. */
export const gerstnerGLSL = (n) => /* glsl */`
#define NW ${n}
uniform vec4 uWaveA[NW];
uniform vec4 uWaveB[NW];

vec3 gerstner(vec2 p, float t, float px, float cut, out vec3 nrm, out float jac){
  vec3 disp = vec3(0.0);
  vec3 tanX = vec3(1.0,0.0,0.0), tanZ = vec3(0.0,0.0,1.0);
  for(int i=0;i<NW;i++){
    if(float(i) > cut) break;
    float k = uWaveA[i].w;
    float lod = smoothstep(px*2.5, px*7.0, 6.28318530718/k);
    if(lod < 0.004) break;
    vec2  d = uWaveA[i].xy;
    float A = uWaveA[i].z*lod;
    float w = uWaveB[i].x, Q = uWaveB[i].y, ph = uWaveB[i].z;
    float f = k*dot(d,p) - w*t + ph;
    float c = cos(f), s = sin(f);
    float QA = Q*A, WA = k*A;
    disp.x += QA*d.x*c; disp.z += QA*d.y*c; disp.y += A*s;
    tanX.x += -Q*d.x*d.x*WA*s; tanX.y += d.x*WA*c; tanX.z += -Q*d.x*d.y*WA*s;
    tanZ.x += -Q*d.x*d.y*WA*s; tanZ.y += d.y*WA*c; tanZ.z += -Q*d.y*d.y*WA*s;
  }
  nrm = normalize(cross(tanZ, tanX));
  jac = tanX.x*tanZ.z - tanX.z*tanZ.x;
  return disp;
}`;
