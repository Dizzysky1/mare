import * as THREE from 'three';
import { VISION_GLSL } from './vision.js';

/* HDR pipeline: MSAA float target → bright pass → separable bloom →
   ray-marched crepuscular rays → graded ACES composite.
   Every pass except the composite runs at half or quarter resolution,
   which is what keeps this affordable at native Retina. */

const VERT = /* glsl */`
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`;

function fsQuad(mat){
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([-1,-1,0, 3,-1,0, -1,3,0], 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute([0,0, 2,0, 0,2], 2));
  const m = new THREE.Mesh(g, mat);
  m.frustumCulled = false;
  return m;
}

export class Post {
  constructor(renderer, scene, camera, tier){
    this.renderer = renderer; this.scene = scene; this.camera = camera;
    this.enabled = tier.bloom;
    this.god = tier.god;
    this.cam = new THREE.OrthographicCamera(-1,1,1,-1,0,1);
    this.quadScene = new THREE.Scene();

    const opts = { type:THREE.HalfFloatType, depthBuffer:true, samples: tier.bloom ? 4 : 0,
                   minFilter:THREE.LinearFilter, magFilter:THREE.LinearFilter };
    this.rt   = new THREE.WebGLRenderTarget(2,2, opts);
    this.rtB  = new THREE.WebGLRenderTarget(2,2, { type:THREE.HalfFloatType, depthBuffer:false });
    this.rtC  = new THREE.WebGLRenderTarget(2,2, { type:THREE.HalfFloatType, depthBuffer:false });
    this.rtD  = new THREE.WebGLRenderTarget(2,2, { type:THREE.HalfFloatType, depthBuffer:false });
    this.rtE  = new THREE.WebGLRenderTarget(2,2, { type:THREE.HalfFloatType, depthBuffer:false });
    this.rtG  = new THREE.WebGLRenderTarget(2,2, { type:THREE.HalfFloatType, depthBuffer:false });

    this.bright = new THREE.ShaderMaterial({
      uniforms:{ tD:{value:null}, uThresh:{value:1.05}, uSoft:{value:0.5} },
      vertexShader:VERT, fragmentShader:/* glsl */`
        uniform sampler2D tD; uniform float uThresh, uSoft; varying vec2 vUv;
        void main(){
          vec3 c = texture2D(tD, vUv).rgb;
          float l = dot(c, vec3(0.2126,0.7152,0.0722));
          float k = smoothstep(uThresh, uThresh+uSoft, l);
          gl_FragColor = vec4(c*k, 1.0);
        }`});

    this.blur = new THREE.ShaderMaterial({
      uniforms:{ tD:{value:null}, uDir:{value:new THREE.Vector2(1,0)}, uTexel:{value:new THREE.Vector2()} },
      vertexShader:VERT, fragmentShader:/* glsl */`
        uniform sampler2D tD; uniform vec2 uDir, uTexel; varying vec2 vUv;
        void main(){
          vec2 o = uDir*uTexel;
          vec3 s = texture2D(tD,vUv).rgb*0.2270270;
          s += (texture2D(tD,vUv+o*1.3846).rgb + texture2D(tD,vUv-o*1.3846).rgb)*0.3162162;
          s += (texture2D(tD,vUv+o*3.2307).rgb  + texture2D(tD,vUv-o*3.2307).rgb )*0.0702702;
          gl_FragColor = vec4(s,1.0);
        }`});

    this.rays = new THREE.ShaderMaterial({
      uniforms:{ tD:{value:null}, uSun:{value:new THREE.Vector2(0.5,0.5)},
                 uAmt:{value:0.0}, uSteps:{value:36.0}, uDecay:{value:0.965} },
      vertexShader:VERT, fragmentShader:/* glsl */`
        uniform sampler2D tD; uniform vec2 uSun; uniform float uAmt, uSteps, uDecay;
        varying vec2 vUv;
        void main(){
          if(uAmt <= 0.001){ gl_FragColor = vec4(0.0); return; }
          vec2 d = (vUv - uSun);
          float steps = uSteps;
          d /= steps*1.12;
          vec2 uv = vUv;
          float w = 1.0;
          vec3 acc = vec3(0.0);
          for(int i=0;i<48;i++){
            if(float(i) >= steps) break;
            uv -= d;
            vec3 s = texture2D(tD, clamp(uv, 0.0, 1.0)).rgb;
            acc += s*w;
            w *= uDecay;
          }
          acc /= steps;
          float edge = smoothstep(1.4, 0.25, length(vUv-uSun));
          gl_FragColor = vec4(acc*uAmt*edge, 1.0);
        }`});

    this.comp = new THREE.ShaderMaterial({
      uniforms:{
        tD:{value:null}, tBloom:{value:null}, tRays:{value:null},
        uBloom:{value:0.55}, uExposure:{value:1.0}, uTime:{value:0},
        uVignette:{value:0.32}, uGrain:{value:0.035}, uChroma:{value:0.0},
        uUnder:{value:0.0}, uUnderCol:{value:new THREE.Color(0.06,0.30,0.36)},
        // what the character's eyes and lenses are doing to the image
        uVisionOn:{value:0.0}, uBlur:{value:0.0}, uDroplets:{value:0.0}, uFog:{value:0.0},
        uSalt:{value:0.0}, uScratches:{value:0.0}, uDazzle:{value:0.0}, uLensSeed:{value:0.0},
        uExposureMul:{value:1.0}, uSatMul:{value:1.0},
        uColourMatrix:{value:new THREE.Matrix3()}, uTexel:{value:new THREE.Vector2(1/1920,1/1080)},
        uSat:{value:1.0}, uWarp:{value:0.0}, uTint:{value:new THREE.Color(1,1,1)},
        uFlash:{value:0.0}, uRain:{value:0.0}, uAspect:{value:1.6},
      },
      vertexShader:VERT, fragmentShader:VISION_GLSL + /* glsl */`
        uniform sampler2D tD, tBloom, tRays;
        uniform float uBloom, uExposure, uTime, uVignette, uGrain, uChroma, uUnder, uSat, uWarp, uFlash, uRain, uAspect;
        uniform vec3 uUnderCol, uTint;
        uniform float uVisionOn, uBlur, uDroplets, uFog, uSalt, uScratches, uDazzle, uLensSeed;
        uniform float uExposureMul, uSatMul;
        uniform mat3 uColourMatrix;
        uniform vec2 uTexel;
        varying vec2 vUv;

        vec3 aces(vec3 x){
          const float a=2.51,b=0.03,c=2.43,d=0.59,e=0.14;
          return clamp((x*(a*x+b))/(x*(c*x+d)+e), 0.0, 1.0);
        }
        float h21(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }

        void main(){
          vec2 uv = vUv;

          // sanity warp — the horizon breathes when you are not well
          if(uWarp > 0.001){
            uv += vec2(sin(uv.y*11.0 + uTime*1.3), cos(uv.x*9.0 + uTime*1.1))*0.004*uWarp;
          }
          // underwater lensing
          if(uUnder > 0.001){
            uv += vec2(sin(uv.y*24.0 + uTime*2.2), cos(uv.x*20.0 + uTime*1.7))*0.0035*uUnder;
          }

          vec3 col;
          float ca = uChroma*0.004 + uUnder*0.002;
          if(uVisionOn > 0.5){
            col = visionApply(tD, uv, uTexel, uAspect, uBlur, uDroplets, uFog,
                              uSalt, uScratches, uDazzle, uLensSeed, uColourMatrix);
          } else if(ca > 0.0001){
            col.r = texture2D(tD, uv + vec2(ca,0.0)).r;
            col.g = texture2D(tD, uv).g;
            col.b = texture2D(tD, uv - vec2(ca,0.0)).b;
          } else col = texture2D(tD, uv).rgb;

          col += texture2D(tBloom, uv).rgb*uBloom;
          col += texture2D(tRays, uv).rgb;

          // rain streaks, only in weather
          if(uRain > 0.001){
            // Shape each drop inside its cell. The old cell-wide mask made
            // rain look like falling rectangular pixels on dark nights.
            vec2 rp = vec2((uv.x + uv.y*0.08)*uAspect*105.0,
                           uv.y*27.0 - uTime*10.0);
            vec2 cell = floor(rp), rf = fract(rp);
            float seed = h21(cell);
            float dropX = fract(seed*17.71);
            float thin = 1.0 - smoothstep(0.018, 0.055, abs(rf.x-dropX));
            float tail = smoothstep(0.02,0.20,rf.y)*(1.0-smoothstep(0.58,0.98,rf.y));
            float streak = thin*tail*smoothstep(0.76,0.995,seed);
            col += vec3(0.58,0.67,0.78)*streak*uRain*0.42;
          }

          if(uUnder > 0.001) col = mix(col, col*uUnderCol*2.6, uUnder*0.85);
          col += uFlash;
          col *= uExposure*uExposureMul;
          col *= uTint;
          col = aces(col);

          float l = dot(col, vec3(0.2126,0.7152,0.0722));
          col = mix(vec3(l), col, uSat*uSatMul);

          float d = length(vUv-0.5);
          col *= 1.0 - smoothstep(0.42, 0.95, d)*uVignette;
          col += (h21(vUv*vec2(1920.0,1080.0)+fract(uTime))-0.5)*uGrain;

          gl_FragColor = vec4(col, 1.0);
        }`});

    this.quad = fsQuad(this.comp);
    this.quadScene.add(this.quad);
    this._sun = new THREE.Vector3();
  }

  setSize(w, h, pr){
    const W = Math.max(2, Math.floor(w*pr)), H = Math.max(2, Math.floor(h*pr));
    this.w = W; this.h = H;
    this.rt.setSize(W,H);
    const halfW = Math.max(1, W>>1), halfH = Math.max(1, H>>1);
    const quarterW = Math.max(1, W>>2), quarterH = Math.max(1, H>>2);
    this.rtB.setSize(halfW, halfH);
    this.rtC.setSize(halfW, halfH);
    this.rtD.setSize(quarterW, quarterH);
    this.rtE.setSize(quarterW, quarterH);
    this.rtG.setSize(halfW, halfH);
    this.comp.uniforms.uAspect.value = w/h;
  }

  setQuality(tier, maxSamples = 4){
    this.enabled = tier.bloom;
    this.god = tier.god;
    this.rt.samples = Math.min(tier.samples || 0, maxSamples || 0);
  }

  draw(mat, target){
    this.quad.material = mat;
    this.renderer.setRenderTarget(target);
    this.renderer.render(this.quadScene, this.cam);
  }

  render(dt, p){
    const r = this.renderer;
    if(!this.enabled){
      r.setRenderTarget(null);
      r.render(this.scene, this.camera);
      return;
    }
    r.setRenderTarget(this.rt);
    r.clear();
    r.render(this.scene, this.camera);

    // bright pass at half res
    this.bright.uniforms.tD.value = this.rt.texture;
    this.bright.uniforms.uThresh.value = p.bloomThresh ?? 1.05;
    this.draw(this.bright, this.rtB);

    // two-tap separable gaussian, half then quarter
    const t1 = this.blur.uniforms.uTexel.value;
    this.blur.uniforms.tD.value = this.rtB.texture;
    t1.set(1/Math.max(1,this.w>>1), 1/Math.max(1,this.h>>1));
    this.blur.uniforms.uDir.value.set(1,0); this.draw(this.blur, this.rtC);
    this.blur.uniforms.tD.value = this.rtC.texture;
    this.blur.uniforms.uDir.value.set(0,1); this.draw(this.blur, this.rtB);
    this.blur.uniforms.tD.value = this.rtB.texture;
    t1.set(1/Math.max(1,this.w>>2), 1/Math.max(1,this.h>>2));
    this.blur.uniforms.uDir.value.set(1.6,0); this.draw(this.blur, this.rtD);
    this.blur.uniforms.tD.value = this.rtD.texture;
    this.blur.uniforms.uDir.value.set(0,1.6); this.draw(this.blur, this.rtE);

    // crepuscular rays marched out from the sun
    if(this.god && p.sunAmt > 0.001){
      this.rays.uniforms.tD.value = this.rtB.texture;
      this.rays.uniforms.uSun.value.copy(p.sunUv);
      this.rays.uniforms.uAmt.value = p.sunAmt;
      this.rays.uniforms.uSteps.value = p.rays ?? 36;
      this.draw(this.rays, this.rtG);
    } else {
      this.rays.uniforms.uAmt.value = 0;
      this.draw(this.rays, this.rtG);
    }

    const u = this.comp.uniforms;
    u.tD.value = this.rt.texture;
    u.tBloom.value = this.rtE.texture;
    u.tRays.value = this.rtG.texture;
    u.uTime.value += dt;
    u.uBloom.value = p.bloom;
    u.uExposure.value = p.exposure;
    u.uVignette.value = p.vignette;
    u.uGrain.value = p.grain;
    u.uChroma.value = p.chroma;
    u.uUnder.value = p.under;
    u.uSat.value = p.sat;
    u.uWarp.value = p.warp;
    u.uFlash.value = p.flash;
    u.uRain.value = p.rain;
    u.uTint.value.copy(p.tint);
    this.draw(this.comp, null);
  }
}
