import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   Shared atmosphere. One GLSL function, `skyColor(dir)`, is used by
   both the sky dome and the ocean's reflection term, so the water
   always mirrors exactly the sky that is above it.
   ──────────────────────────────────────────────────────────────── */

export const NOISE_GLSL = /* glsl */`
float hash12(vec2 p){ vec3 p3=fract(vec3(p.xyx)*.1031); p3+=dot(p3,p3.yzx+33.33); return fract((p3.x+p3.y)*p3.z); }
float hash13(vec3 p3){ p3=fract(p3*.1031); p3+=dot(p3,p3.zyx+31.32); return fract((p3.x+p3.y)*p3.z); }
float vnoise(vec2 p){
  vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash12(i),hash12(i+vec2(1,0)),f.x),
             mix(hash12(i+vec2(0,1)),hash12(i+vec2(1,1)),f.x),f.y);
}
float fbm(vec2 p,int oct){
  float s=0.0,a=0.5,n=0.0;
  for(int i=0;i<7;i++){ if(i>=oct) break; s+=a*vnoise(p); n+=a; p=p*2.03+vec2(1.7,-2.3); a*=0.5; }
  return s/max(n,1e-4);
}`;

export const SKY_GLSL = /* glsl */`
uniform float uTime;
uniform vec3  uSunDir;
uniform vec3  uSunColor;
uniform vec3  uSunTint;
uniform vec3  uZenith;
uniform vec3  uHorizon;
uniform float uSunI;
uniform float uNight;
uniform float uStorm;
uniform float uCloudCover;
uniform float uCloudAmt;
uniform vec3  uCloudLit;
uniform vec3  uCloudDark;
uniform vec2  uWindDir;
uniform vec3  uMoonDir;

vec3 skyColor(vec3 dir){
  float y = dir.y;
  float t = pow(clamp(y*0.92+0.08,0.0,1.0), 0.42);
  vec3 col = mix(uHorizon, uZenith, t);

  // haze thickening toward the horizon — the Mediterranean's soft white band
  col += uHorizon*0.30*pow(1.0-clamp(abs(y)*3.2,0.0,1.0),3.0)*(1.0-uStorm*0.7);

  float mu = dot(dir, uSunDir);

  // stars + moon (only meaningful at night)
  if(uNight > 0.01){
    vec3 sp = dir*140.0;
    vec3 id = floor(sp);
    float h = hash13(id);
    if(h > 0.9905){
      vec3 c = fract(sp)-0.5;
      float d = length(c);
      float tw = 0.62+0.38*sin(uTime*(1.6+h*9.0)+h*90.0);
      float star = smoothstep(0.30,0.0,d)*(h-0.9905)*105.0*tw;
      col += vec3(0.82,0.87,1.0)*star*uNight*clamp(y*3.0,0.0,1.0)*(1.0-uStorm);
    }
    float mm = dot(dir,uMoonDir);
    col += vec3(0.72,0.78,0.95)*smoothstep(0.9988,0.99955,mm)*3.2*uNight*(1.0-uStorm);
    col += vec3(0.30,0.36,0.52)*pow(max(mm,0.0),120.0)*0.5*uNight*(1.0-uStorm);
  }

  // sun: broad mie halo, tight aureole, then the disc itself
  col += uSunTint*pow(max(mu,0.0),5.0)*0.42*(1.0-uStorm*0.85);
  col += uSunTint*pow(max(mu,0.0),160.0)*1.4*(1.0-uStorm*0.9);
  col += uSunColor*smoothstep(0.99955,0.99987,mu)*14.0*uSunI*(1.0-uStorm*0.95);

  // cloud deck, projected onto a flat layer overhead
  if(y > 0.006 && uCloudAmt > 0.001){
    vec2 cp = dir.xz/max(y,0.006)*260.0;
    vec2 drift = uWindDir*uTime*2.4;
    vec2 q = (cp+drift)*0.00085;
    float d = fbm(q,5);
    d = mix(d, fbm(q*2.7+vec2(4.0,1.0),4), 0.32);
    float cov = uCloudCover;
    float c = smoothstep(cov, cov+0.20, d);
    float lit = smoothstep(cov-0.10, cov+0.38, d);
    vec3 cc = mix(uCloudDark, uCloudLit, lit);
    cc += uSunTint*pow(max(mu,0.0),3.0)*0.55*(1.0-uStorm*0.8)*(1.0-lit*0.5);
    cc *= mix(1.0, 0.30+0.70*lit, uStorm);
    float edge = smoothstep(0.006,0.10,y);
    col = mix(col, cc, clamp(c*edge*uCloudAmt,0.0,1.0));
  }

  // below the horizon the "sky" is only ever seen as a reflection, keep it dim
  col *= mix(1.0, 0.55, clamp(-y*3.0,0.0,1.0));
  return col;
}`;

/* palette keyframes across a 24h day — elevation drives the blend */
const DAY = [
  { e:-0.35, zen:[0.006,0.012,0.032], hor:[0.020,0.030,0.055], sun:[0.05,0.06,0.10], tint:[0.03,0.05,0.10], i:0.0,  night:1.0 },
  { e:-0.09, zen:[0.030,0.055,0.115], hor:[0.180,0.135,0.150], sun:[0.55,0.32,0.24], tint:[0.35,0.20,0.22], i:0.12, night:0.62 },
  { e: 0.00, zen:[0.075,0.130,0.235], hor:[0.760,0.420,0.240], sun:[1.60,0.72,0.34], tint:[0.95,0.48,0.26], i:0.55, night:0.20 },
  { e: 0.10, zen:[0.100,0.190,0.360], hor:[0.900,0.640,0.440], sun:[1.90,1.30,0.86], tint:[1.00,0.72,0.46], i:0.85, night:0.0 },
  { e: 0.30, zen:[0.090,0.215,0.470], hor:[0.700,0.760,0.780], sun:[1.95,1.72,1.42], tint:[0.90,0.86,0.78], i:1.0,  night:0.0 },
  { e: 0.75, zen:[0.075,0.200,0.520], hor:[0.640,0.760,0.840], sun:[2.00,1.92,1.78], tint:[0.82,0.88,0.95], i:1.0,  night:0.0 },
];

function lerp(a,b,t){ return a+(b-a)*t; }
function lerpArr(a,b,t,out){ for(let i=0;i<3;i++) out[i]=lerp(a[i],b[i],t); return out; }

export class Sky {
  constructor(scene, camera){
    this.camera = camera;
    this.uniforms = {
      uTime:{value:0}, uSunDir:{value:new THREE.Vector3(0.3,0.5,0.5).normalize()},
      uMoonDir:{value:new THREE.Vector3(-0.3,0.5,-0.5).normalize()},
      uSunColor:{value:new THREE.Color(1.9,1.6,1.3)}, uSunTint:{value:new THREE.Color(0.9,0.85,0.75)},
      uZenith:{value:new THREE.Color(0.08,0.2,0.48)}, uHorizon:{value:new THREE.Color(0.65,0.76,0.83)},
      uSunI:{value:1}, uNight:{value:0}, uStorm:{value:0},
      uCloudCover:{value:0.56}, uCloudAmt:{value:0.9},
      uCloudLit:{value:new THREE.Color(1.06,1.02,0.99)}, uCloudDark:{value:new THREE.Color(0.52,0.56,0.62)},
      uWindDir:{value:new THREE.Vector2(1,0.3)},
    };

    scene.userData.particleEnvironment = this.uniforms;

    const mat = new THREE.ShaderMaterial({
      uniforms:this.uniforms, side:THREE.BackSide, depthWrite:false, depthTest:false, fog:false,
      vertexShader:/* glsl */`
        varying vec3 vDir;
        void main(){
          vDir = mat3(modelMatrix)*position;      // world-space view ray
          gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);
        }`,
      fragmentShader:NOISE_GLSL + SKY_GLSL + /* glsl */`
        varying vec3 vDir;
        void main(){ gl_FragColor = vec4(max(skyColor(normalize(vDir)),0.0),1.0); }`,
    });

    this.mesh = new THREE.Mesh(new THREE.SphereGeometry(1,48,32), mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    camera.add(this.mesh);
    scene.add(camera);

    this.sun = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sun.position.set(100,180,80);
    this.hemi = new THREE.HemisphereLight(0xbfd8e8, 0x1d5a63, 0.75);
    scene.add(this.sun, this.sun.target, this.hemi);

    this.scene = scene;
    this.horizonColor = new THREE.Color();
    this.storm = 0;
    this.flash = 0;
  }

  enableShadows(on, renderer, size = 2048){
    this.sun.castShadow = on;
    renderer.shadowMap.enabled = on;
    if(!on){ this.shadowSize = 0; return; }
    const s = this.sun.shadow;
    const nextSize = Math.max(256, Math.floor(size));
    if(this.shadowSize !== nextSize){
      s.map?.dispose(); s.map = null;
      s.mapSize.set(nextSize,nextSize);
      this.shadowSize = nextSize;
    }
    s.camera.near = 1; s.camera.far = 160;
    s.camera.left = -26; s.camera.right = 26; s.camera.top = 26; s.camera.bottom = -26;
    s.bias = -0.0012; s.normalBias = 0.05;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  }

  /* hour: 0..24 (12 = noon) ; storm: 0..1 */
  update(hour, storm, dt, focus){
    const u = this.uniforms;
    this.storm = storm;

    // sun path: elevation peaks at noon, tilted azimuth so it sweeps the sky
    const a = (hour/24)*Math.PI*2 - Math.PI/2;
    const elev = Math.sin(a)*0.82 - 0.02;
    const az = Math.cos(a);
    const sd = u.uSunDir.value.set(az*0.72, elev, -0.42 + az*0.15).normalize();
    u.uMoonDir.value.set(-sd.x, -sd.y*0.85 + 0.10, -sd.z).normalize();

    // interpolate the palette
    let i = 0;
    while(i < DAY.length-2 && sd.y > DAY[i+1].e) i++;
    const A = DAY[i], B = DAY[Math.min(i+1, DAY.length-1)];
    const t = THREE.MathUtils.clamp((sd.y - A.e)/Math.max(1e-4, B.e - A.e), 0, 1);
    const tmp = [0,0,0];
    const zen = lerpArr(A.zen,B.zen,t,tmp).slice();
    const hor = lerpArr(A.hor,B.hor,t,tmp).slice();
    const sun = lerpArr(A.sun,B.sun,t,tmp).slice();
    const tint = lerpArr(A.tint,B.tint,t,tmp).slice();
    const inten = lerp(A.i,B.i,t), night = lerp(A.night,B.night,t);

    // storm desaturates and darkens everything
    const sm = (c,g)=>{ const l=(c[0]+c[1]+c[2])/3; return [ lerp(c[0],l*g,storm), lerp(c[1],l*g*1.02,storm), lerp(c[2],l*g*1.14,storm) ]; };
    const z = sm(zen,0.30), h = sm(hor,0.42);

    u.uZenith.value.setRGB(z[0],z[1],z[2]);
    u.uHorizon.value.setRGB(h[0],h[1],h[2]);
    u.uSunColor.value.setRGB(sun[0],sun[1],sun[2]);
    u.uSunTint.value.setRGB(tint[0],tint[1],tint[2]);
    u.uSunI.value = inten*(1-storm*0.9);
    u.uNight.value = night;
    u.uStorm.value = storm;
    u.uCloudCover.value = lerp(0.60, 0.14, storm);
    u.uCloudAmt.value = lerp(0.72, 1.0, storm);
    u.uCloudLit.value.setRGB(lerp(1.10,0.34,storm), lerp(1.06,0.36,storm), lerp(1.02,0.42,storm));
    u.uCloudDark.value.setRGB(lerp(0.48,0.05,storm), lerp(0.53,0.06,storm), lerp(0.60,0.09,storm));

    // lightning
    this.flash = Math.max(0, this.flash - dt*4.2);
    if(storm > 0.35 && Math.random() < dt*0.16*storm) this.flash = 1;

    // scene lights follow the sun
    const lit = Math.max(0, sd.y);
    this.sun.color.setRGB(sun[0],sun[1],sun[2]).multiplyScalar(0.55);
    this.sun.intensity = (0.25 + lit*2.2) * (1 - storm*0.72) + this.flash*3.0;
    this.hemi.color.setRGB(h[0]*0.9+0.05, h[1]*0.9+0.06, h[2]*0.9+0.09);
    this.hemi.groundColor.setRGB(0.05+0.06*lit, 0.20+0.12*lit, 0.24+0.14*lit);
    // keep a floor under the ambient so a stormy night is still navigable
    this.hemi.intensity = 0.46 + lit*0.80 + this.flash*1.2;

    if(focus){
      this.sun.target.position.copy(focus);
      this.sun.position.copy(focus).addScaledVector(sd, 90);
    }

    this.horizonColor.setRGB(h[0],h[1],h[2]);
    if(this.scene.fog){
      this.scene.fog.color.copy(this.horizonColor);
      this.scene.fog.density = lerp(0.00016, 0.00095, storm) * lerp(1.0, 1.5, night);
    }
    u.uTime.value += dt;
    return { night, elevation: sd.y, flash: this.flash };
  }
}
