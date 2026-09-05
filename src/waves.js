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

/* JONSWAP spectral density, unnormalised (the overall scale — usually written
   αg²/ω⁵ — cancels out once we rescale the whole spectrum to hit a target Hs,
   so it is left out here). `gamma` is the standard peak-enhancement factor. */
const JONSWAP_GAMMA = 3.3;
function jonswapShape(w, wp){
  const sigma = w <= wp ? 0.07 : 0.09;
  const r = Math.exp(-((w-wp)*(w-wp))/(2*sigma*sigma*wp*wp));
  return Math.pow(w,-5)*Math.exp(-1.25*Math.pow(wp/w,4))*Math.pow(JONSWAP_GAMMA, r);
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
    this.tsunami = new THREE.Vector4(0,0,-1000,0);
    this.windDir = new THREE.Vector2(1,0.35).normalize();
    this.configure({ swell: 1.0, windDeg: 38 });
  }

  /* `swell` is significant wave height Hs in metres, the standard measure
     (mean height of the highest third of waves; four times the standard
     deviation of the surface). A calm Mediterranean day is Hs 0.5-1m, a
     genuine storm is Hs 5-7m — the mode presets in main.js (0.78 .. 3.9)
     sit at the calm-to-rough end of that scale, which reads right in the
     game's compressed sense of distance. `chop` is still 0..1.4, a Q-scale
     knob independent of wave height. */
  configure({ swell = 1.0, windDeg = 38, chop = 1.05, longest = 92,
              count = this.activeCount } = {}){
    const rng = mulberry32(9137);
    const NW = THREE.MathUtils.clamp(Math.floor(count || this.count), 2, this.count);
    this.activeCount = NW;
    const Hs = Math.max(0.05, swell);
    this.swell = swell; this.chop = chop; this.windDeg = windDeg;
    const wind = windDeg*Math.PI/180;
    this.windDir.set(Math.cos(wind), Math.sin(wind));
    this.waves.length = 0;

    // Component wavelengths come from the dispersion relation, not the other
    // way around: pick a frequency band from the wavelength limits, then walk
    // it geometrically (equal spacing in ln ω) from long to short.
    const shortest = 0.55;
    const omegaLong  = Math.sqrt(G*2*Math.PI/longest);
    const omegaShort = Math.sqrt(G*2*Math.PI/shortest);

    // JONSWAP peak frequency, backed out from Hs via the Pierson-Moskowitz
    // fully-developed-sea relation (Hs = 0.21 U²/g, ωp = 0.877 g/U) so a
    // bigger sea automatically pushes energy toward longer waves without a
    // separate wind-speed input. Clamped into the sampled band: a real storm's
    // peak would sit past `longest`, at which point the spectrum is simply
    // still climbing at our long-wave cutoff, which is the right look anyway.
    const windEst = Math.sqrt(Hs*G/0.21);
    const omegaP = THREE.MathUtils.clamp(0.877*G/windEst, omegaLong*1.02, omegaShort*0.6);

    const ratio = Math.pow(omegaShort/omegaLong, 1/NW);
    const omegas = [], dOmegas = [], shapes = [];
    let m0raw = 0;
    for(let i = 0; i < NW; i++){
      const wLo = omegaLong*Math.pow(ratio, i);
      const wHi = wLo*ratio;
      const w = Math.sqrt(wLo*wHi);          // geometric-mean frequency of the band
      const dw = wHi - wLo;
      const S = jonswapShape(w, omegaP);
      omegas.push(w); dOmegas.push(dw); shapes.push(S);
      m0raw += S*dw;
    }
    // Rescale the (arbitrarily-scaled) JONSWAP shape so 4·sqrt(m0) really is Hs,
    // regardless of gamma/peak choices above — this is what makes `swell` a
    // physical quantity instead of a tuning knob.
    const targetM0 = (Hs*0.25)*(Hs*0.25);
    const scale = m0raw > 1e-12 ? targetM0/m0raw : 0;

    // spreading exponent for the cos^(2s) fan: long components track the wind
    // closely (large s, narrow fan), short chop scatters much wider (small s)
    const SPREAD_LONG = 18, SPREAD_SHORT = 3;

    for(let i = 0; i < NW; i++){
      const w = omegas[i];
      const k = w*w/G;                       // invert ω² = gk
      let amp = Math.sqrt(Math.max(0, 2*scale*shapes[i]*dOmegas[i]));  // a = sqrt(2·S·Δω)

      // rejection-sample the wind-relative angle from a cos^(2s)(Δθ/2) lobe
      const sExp = THREE.MathUtils.lerp(SPREAD_LONG, SPREAD_SHORT, i/Math.max(1,NW-1));
      let dtheta = 0;
      for(let tries = 0; tries < 32; tries++){
        const cand = (rng()*2-1)*Math.PI;
        if(rng() <= Math.pow(Math.cos(cand*0.5), 2*sExp)){ dtheta = cand; break; }
      }
      const ang = wind + dtheta;

      amp = Math.min(amp, 0.42/k);           // never let a single wave loop over itself
      const Q = Math.min(chop/(k*amp*NW), 1.0);
      this.waves.push({ dx:Math.cos(ang), dz:Math.sin(ang), amp, k, w, Q, phase: rng()*Math.PI*2 });
    }
  }

  /* Vertical displacement only — enough for cheap probes (birds, spray, splashes). */
  height(x, z, t = this.time){
    let y = this.tsunamiHeight(x,z,t);
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
    dy += this.tsunamiHeight(x,z,t);
    ty += (this.tsunamiHeight(x+0.5,z,t)-this.tsunamiHeight(x-0.5,z,t));
    by += (this.tsunamiHeight(x,z+0.5,t)-this.tsunamiHeight(x,z-0.5,t));
    vy += (this.tsunamiHeight(x,z,t+0.01)-this.tsunamiHeight(x,z,t-0.01))/0.02;
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

  addTsunami(x,z){ this.tsunami.set(x,z,this.time,22); }
  clearTsunami(){ this.tsunami.w=0; }
  tsunamiHeight(x,z,t=this.time){
    const w=this.tsunami, age=t-w.z;
    if(w.w===0 || age<0 || age>90) return 0;
    const radius=age*95, q=(Math.hypot(x-w.x,z-w.y)-radius)/65;
    return w.w*(1-Math.exp(-age))*Math.exp(-age/35)*(1-q*q)*Math.exp(-0.5*q*q);
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
uniform vec4 uTsunami;
float tsunamiHeight(vec2 p,float t){
  float age=t-uTsunami.z;
  if(uTsunami.w==0.0 || age<0.0 || age>90.0) return 0.0;
  float q=(length(p-uTsunami.xy)-age*95.0)/65.0;
  return uTsunami.w*(1.0-exp(-age))*exp(-age/35.0)*(1.0-q*q)*exp(-0.5*q*q);
}

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
  disp.y += tsunamiHeight(p,t);
  tanX.y += tsunamiHeight(p+vec2(0.5,0.0),t)-tsunamiHeight(p-vec2(0.5,0.0),t);
  tanZ.y += tsunamiHeight(p+vec2(0.0,0.5),t)-tsunamiHeight(p-vec2(0.0,0.5),t);
  nrm = normalize(cross(tanZ, tanX));
  jac = tanX.x*tanZ.z - tanX.z*tanZ.x;
  return disp;
}`;
