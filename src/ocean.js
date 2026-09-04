import * as THREE from 'three';
import { gerstnerGLSL } from './waves.js';
import { SKY_GLSL, NOISE_GLSL } from './sky.js';

export const NISL = 16;   // islands the water can shoal against

/* Quality tiers. `ultra` is sized for a 32-core Apple GPU at native
   Retina: half a million ocean triangles and a 32-wave spectrum. */
export const TIERS = {
  low:   { waves:10, rings:160, sect:200, ripple:3, pr:1.00, bloom:false, shadow:0,    samples:0, fbm:3, rt:0,  god:false },
  high:  { waves:20, rings:320, sect:384, ripple:5, pr:1.50, bloom:true,  shadow:2048, samples:4, fbm:5, rt:16, god:true },
  ultra: { waves:28, rings:448, sect:512, ripple:7, pr:2.00, bloom:true,  shadow:4096, samples:4, fbm:6, rt:26, god:true },
  max:   { waves:32, rings:576, sect:640, ripple:8, pr:2.00, bloom:true,  shadow:4096, samples:8, fbm:7, rt:40, god:true },
};

/* A polar "disc" grid, re-centred on the camera every frame: dense under
   your feet, cheap at the horizon, and no visible tiling anywhere. */
function discGeometry(rings, sectors, radius){
  const pos = new Float32Array((rings+1)*sectors*3);
  const r0 = 0.45;
  const growth = Math.pow(radius/r0, 1/rings);
  let p = 0;
  for(let i = 0; i <= rings; i++){
    const r = i === 0 ? 0 : r0*Math.pow(growth, i-1);
    for(let j = 0; j < sectors; j++){
      const a = (j/sectors)*Math.PI*2;
      pos[p++] = Math.cos(a)*r; pos[p++] = 0; pos[p++] = Math.sin(a)*r;
    }
  }
  const n = (rings+1)*sectors;
  const idx = new (n > 65535 ? Uint32Array : Uint16Array)(rings*sectors*6);
  let q = 0;
  for(let i = 0; i < rings; i++){
    for(let j = 0; j < sectors; j++){
      const j2 = (j+1)%sectors;
      const a = i*sectors+j, b = i*sectors+j2, c = (i+1)*sectors+j, d = (i+1)*sectors+j2;
      idx[q++]=a; idx[q++]=c; idx[q++]=b; idx[q++]=b; idx[q++]=c; idx[q++]=d;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos,3));
  g.setIndex(new THREE.BufferAttribute(idx,1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), radius*1.2);
  return g;
}

export class Ocean {
  constructor(scene, field, env, tier){
    this.field = field;
    this.tier = tier;
    this.radius = 16000;
    const NW = field.count;

    const islands = [];
    const peaks = new Array(NISL).fill(1);
    for(let i = 0; i < NISL; i++) islands.push(new THREE.Vector4(0,0,-1,1));

    const packed = field.pack();
    this.uniforms = Object.assign({}, env, {
      uWaveA:{ value: packed.A }, uWaveB:{ value: packed.B },
      uCamPos:{ value: new THREE.Vector3() },
      uIsl:{ value: islands },
      uIslPeak:{ value: peaks },
      uRTSteps:{ value: tier.rt },
      uDeep:{ value: new THREE.Color(0.0035,0.028,0.058) },
      uMid:{ value: new THREE.Color(0.010,0.145,0.235) },
      uShallow:{ value: new THREE.Color(0.085,0.585,0.575) },
      uSSS:{ value: new THREE.Color(0.065,0.430,0.400) },
      uFoamAmt:{ value: 1.0 },
      uDetail:{ value: 1.0 },
      uSeaSwell:{ value: 1.0 },
      uWaveCut:{ value: NW },
      uPxScale:{ value: 0.002 },
    });

    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      side: THREE.DoubleSide,
      fog: false,
      vertexShader: gerstnerGLSL(NW) + /* glsl */`
        uniform vec3 uCamPos;
        uniform float uWaveCut;
        uniform float uTime;
        uniform float uPxScale;
        varying vec3 vWorld;
        varying vec2 vBase;
        varying float vDist;
        varying float vJac;
        void main(){
          vec3 wp = (modelMatrix*vec4(position,1.0)).xyz;
          vBase = wp.xz;
          float dist = length(wp.xz - uCamPos.xz);
          // a vertex this far away covers roughly this much world space per
          // pixel; waves smaller than that are not worth displacing
          float px = max(dist*uPxScale, 0.015);
          vec3 nrm; float jac;
          vec3 disp = gerstner(vBase, uTime, px, uWaveCut, nrm, jac);
          wp += disp;
          vWorld = wp; vDist = dist; vJac = jac;
          gl_Position = projectionMatrix*viewMatrix*vec4(wp,1.0);
        }`,
      fragmentShader: NOISE_GLSL + SKY_GLSL + gerstnerGLSL(NW) + /* glsl */`
        #define RIPPLES ${tier.ripple}
        #define FOAM_OCT ${tier.fbm}
        uniform vec3 uCamPos;
        uniform vec4 uIsl[${NISL}];
        uniform float uIslPeak[${NISL}];
        uniform float uRTSteps;
        uniform vec3 uDeep, uMid, uShallow, uSSS;
        uniform float uFoamAmt, uDetail, uSeaSwell, uWaveCut;

        /* ── ray tracing against the analytic sea ──────────────────
           There is no hardware RT in WebGL, but the water *is* a
           closed-form surface, so we can march real rays against it:
           grazing reflections genuinely bounce off the wave in front,
           and islands are traced as ellipsoids for reflections and
           for the shadows they throw across the water.            */

        float seaH(vec2 p, float t){          // long waves only — enough for a ray
          float y = 0.0;
          for(int i=0;i<NW;i++){
            if(i > 9) break;
            y += uWaveA[i].z*sin(uWaveA[i].w*dot(uWaveA[i].xy,p) - uWaveB[i].x*t + uWaveB[i].z);
          }
          return y;
        }

        // ray vs. the ellipsoid that stands in for an island
        float hitIsland(vec3 ro, vec3 rd, out float peak, out vec3 hitN){
          float best = 1e9; peak = 0.0; hitN = vec3(0.0,1.0,0.0);
          for(int i=0;i<${NISL};i++){
            float r = uIsl[i].z;
            if(r < 0.0) continue;
            float pk = max(uIslPeak[i], 4.0);
            vec3 c  = vec3(uIsl[i].x, -pk*0.30, uIsl[i].y);
            vec3 sc = vec3(r*1.12, pk*1.30, r*1.12);
            vec3 o = (ro-c)/sc, d = rd/sc;
            float a = dot(d,d), b = dot(o,d), cc = dot(o,o)-1.0;
            float disc = b*b - a*cc;
            if(disc < 0.0) continue;
            float t = (-b - sqrt(disc))/a;
            if(t > 0.08 && t < best){
              best = t; peak = pk;
              hitN = normalize(((ro + rd*t) - c)/(sc*sc));
            }
          }
          return best < 1e8 ? best : -1.0;
        }

        // march the reflected ray across the wave field
        float traceSea(vec3 ro, vec3 rd, float steps){
          if(rd.y > 0.34) return -1.0;         // steep rays escape to the sky
          float t = 0.8, dt = 0.7;
          for(int s=0;s<48;s++){
            if(float(s) >= steps) break;
            vec3 p = ro + rd*t;
            if(p.y > uSeaSwell*1.6 && rd.y > 0.0) return -1.0;
            if(p.y < seaH(p.xz, uTime)) return t;
            t += dt; dt *= 1.235;
            if(t > 340.0) break;
          }
          return -1.0;
        }
        varying vec3 vWorld;
        varying vec2 vBase;
        varying float vDist;
        varying float vJac;

        // how close to shore this patch of water is: 0 open sea, 1 on the sand
        float shoal(vec2 p, out float ring){
          float s = 0.0; ring = 1e6;
          for(int i=0;i<${NISL};i++){
            float r = uIsl[i].z;
            if(r < 0.0) continue;
            float d = distance(p, uIsl[i].xy);
            float f = 1.0 - smoothstep(r, r + uIsl[i].w, d);
            if(f > s){ s = f; ring = d - r; }
          }
          return s;
        }

        // fine capillary ripples, analytic so they cost almost nothing.
        // Each octave dies once its wavelength nears a pixel.
        vec3 ripples(vec2 p, float t, float amt, float px){
          vec3 n = vec3(0.0,1.0,0.0);
          for(int i=0;i<RIPPLES;i++){
            float fi = float(i);
            vec2 d = normalize(vec2(cos(fi*2.399+0.7), sin(fi*1.717+1.9)));
            float k = (1.1 + fi*0.72)*3.1;
            float lod = smoothstep(px*3.0, px*9.0, 6.28318530718/k);
            if(lod < 0.004) break;
            float a = 0.019*amt*lod/(1.0+fi*0.8);
            float ph = k*dot(d,p) - t*(2.3+fi*1.55);
            float c = cos(ph)*a*k;
            n.x += -d.x*c; n.z += -d.y*c;
          }
          return normalize(n);
        }

        void main(){
          vec3 V = normalize(uCamPos - vWorld);

          // exact world-space footprint of this pixel — the whole anti-aliasing
          // strategy for the water hangs off this number
          vec2 dpx = fwidth(vBase);
          float px = max(max(dpx.x, dpx.y), 0.008);

          vec3 N; float jac;
          gerstner(vBase, uTime, px, uWaveCut, N, jac);

          float rAmt = uDetail;
          if(rAmt > 0.001){
            vec3 rn = ripples(vBase, uTime, rAmt, px);
            N = normalize(N + vec3(rn.x, 0.0, rn.z)*1.5);
          }
          if(dot(N,V) < 0.0) N = -N;          // seen from below the surface

          vec3 L = uSunDir;
          vec3 H = normalize(L+V);
          float ndv = max(dot(N,V), 0.0);
          float ndl = max(dot(N,L), 0.0);

          // ── reflection ─────────────────────────────────────────
          vec3 R = reflect(-V, N);
          R.y = max(abs(R.y), 0.012);         // fold rays that dip below the surface
          R = normalize(R);
          vec3 refl = skyColor(R);
          float fres = 0.02 + 0.98*pow(1.0-ndv, 5.0);

          // traced reflections + traced sun shadow, near field only
          float shadow = 1.0;
          if(uRTSteps > 0.5 && vDist < 3200.0){
            float pk; vec3 hn;
            float ti = hitIsland(vWorld, R, pk, hn);
            float ts = traceSea(vWorld, R, uRTSteps);

            if(ts > 0.0 && (ti < 0.0 || ts < ti)){
              // the ray hit the back of the wave in front: dark, water-coloured
              vec3 wp = vWorld + R*ts;
              float depthTint = clamp(ts/90.0, 0.0, 1.0);
              vec3 backface = mix(uMid*0.55, uDeep*3.0, 0.4) * (0.45 + 0.55*max(uSunI,0.08));
              refl = mix(backface, refl, 0.18 + 0.62*depthTint);
            } else if(ti > 0.0){
              // an island standing in the reflection
              vec3 hp = vWorld + R*ti;
              float up = clamp((hp.y + pk*0.30)/(pk*1.35), 0.0, 1.0);
              vec3 icol = mix(vec3(0.30,0.34,0.20), vec3(0.62,0.60,0.53), smoothstep(0.30,0.85,up));
              icol = mix(vec3(0.80,0.74,0.58), icol, smoothstep(0.24,0.34,up));   // beach at the foot
              icol *= 0.35 + 0.75*max(dot(hn, uSunDir), 0.0)*max(uSunI,0.12) + 0.18;
              refl = mix(icol, skyColor(R), smoothstep(300.0, 2600.0, ti));
            }

            // does an island stand between this water and the sun?
            if(uSunDir.y > 0.0){
              float pk2; vec3 hn2;
              float tsun = hitIsland(vWorld + uSunDir*0.6, uSunDir, pk2, hn2);
              if(tsun > 0.0) shadow = 0.10;
            }
          }

          // ── body colour, shoaling toward the beaches ───────────
          float ring; float sh = shoal(vWorld.xz, ring);
          vec3 body = mix(uDeep, uMid, 0.45 + 0.55*smoothstep(0.0,0.35,sh));
          body = mix(body, uShallow, pow(sh, 1.55));
          body *= 0.28 + 0.72*(0.34 + 0.66*ndl*shadow);
          // never let the sea go fully black — there is always some sky on it
          body += vec3(0.006,0.017,0.026)*uNight*(1.0 - uStorm*0.35);

          // sub-surface glow: light coming through the back of a crest
          float back = pow(max(dot(V, -normalize(vec3(L.x,0.0,L.z))), 0.0), 2.0);
          float lift = clamp((vWorld.y + uSeaSwell*0.35)/max(uSeaSwell,0.2), 0.0, 1.0);
          body += uSSS*back*lift*1.30*max(uSunI,0.05)*(0.4+0.6*sh);

          vec3 col = mix(body, refl, clamp(fres,0.0,1.0));

          // ── sun glint ──────────────────────────────────────────
          float rough = mix(260.0, 1100.0, clamp(1.0-uSeaSwell*0.22,0.0,1.0));
          float spec = pow(max(dot(N,H),0.0), rough)*uSunI;
          float wide = pow(max(dot(N,H),0.0), 20.0)*0.09*uSunI;
          col += uSunColor*(spec*3.0 + wide)*shadow;

          // ── foam ───────────────────────────────────────────────
          float crestFoam = smoothstep(0.44, -0.18, jac);        // where the wave folds
          float tipFoam = smoothstep(uSeaSwell*0.58, uSeaSwell*1.08, vWorld.y)*0.5;
          float surf = 0.0;
          if(sh > 0.001){
            float band = sin(ring*0.30 - uTime*1.15)*0.5 + 0.5;
            surf = smoothstep(0.55,1.0,sh)*0.9 + smoothstep(0.16,0.60,sh)*pow(band,3.0)*0.85;
          }
          float f = clamp((crestFoam + tipFoam + surf)*uFoamAmt, 0.0, 1.0);
          float ftex = mix(0.5, fbm(vBase*0.8 + uWindDir*uTime*0.35, FOAM_OCT),
                           smoothstep(1.6, 0.25, px));
          f *= smoothstep(0.26, 0.74, ftex + f*0.38);
          f *= 1.0 - smoothstep(2600.0, 7200.0, vDist);
          vec3 foamCol = vec3(0.86,0.92,0.94)*(0.32+0.80*max(ndl,uSunI*0.4));
          col = mix(col, foamCol, f);

          // ── melt into the horizon ──────────────────────────────
          float hz = smoothstep(2400.0, 13000.0, vDist);
          col = mix(col, skyColor(normalize(vWorld-uCamPos)), hz);

          gl_FragColor = vec4(max(col,0.0), 1.0);
        }`,
    });

    this.mesh = new THREE.Mesh(discGeometry(tier.rings, tier.sect, this.radius), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    scene.add(this.mesh);
    this.triangles = tier.rings*tier.sect*2;
  }

  syncSpectrum(){
    const p = this.field.pack();
    this.uniforms.uWaveA.value = p.A;
    this.uniforms.uWaveB.value = p.B;
    this.uniforms.uSeaSwell.value = this.field.swell;
    this.uniforms.uWaveCut.value = this.field.activeCount - 1;
  }

  setTier(tier){
    this.tier = tier;
    const old = this.mesh.geometry;
    this.mesh.geometry = discGeometry(tier.rings, tier.sect, this.radius);
    this.triangles = tier.rings*tier.sect*2;
    old.dispose();
    this.uniforms.uRTSteps.value = tier.rt;
  }

  setIslands(list){
    const u = this.uniforms.uIsl.value;
    const p = this.uniforms.uIslPeak.value;
    for(let i = 0; i < NISL; i++){
      const isl = list[i];
      if(isl){ u[i].set(isl.pos.x, isl.pos.z, isl.shoreR, isl.shoalW); p[i] = isl.peak; }
      else { u[i].set(0,0,-1,1); p[i] = 1; }
    }
  }

  update(camera, viewHeightPx){
    // snap the disc to a 2m grid so vertices don't crawl under the camera
    this.mesh.position.set(Math.round(camera.position.x/2)*2, 0, Math.round(camera.position.z/2)*2);
    this.uniforms.uCamPos.value.copy(camera.position);
    // world units per pixel, per unit of distance
    this.uniforms.uPxScale.value =
      2*Math.tan(camera.fov*Math.PI/360)/Math.max(1, viewHeightPx || 1080);
  }
}
