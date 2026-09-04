import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   Procedural Aegean islands: limestone bones, scrub, olive terraces,
   a white village or two, and — on exactly one of them — a light.
   ──────────────────────────────────────────────────────────────── */

function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
function hash2(x, y, s){
  let h = Math.sin(x*127.1 + y*311.7 + s*74.7)*43758.5453;
  return h - Math.floor(h);
}
function vnoise(x, y, s){
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x-ix, fy = y-iy;
  const ux = fx*fx*(3-2*fx), uy = fy*fy*(3-2*fy);
  const a = hash2(ix,iy,s), b = hash2(ix+1,iy,s), c = hash2(ix,iy+1,s), d = hash2(ix+1,iy+1,s);
  return (a*(1-ux)+b*ux)*(1-uy) + (c*(1-ux)+d*ux)*uy;
}
function fbm(x, y, s, oct = 5){
  let v = 0, a = 0.5, n = 0;
  for(let i = 0; i < oct; i++){ v += a*vnoise(x,y,s+i*17.3); n += a; x = x*2.03+1.7; y = y*2.03-2.3; a *= 0.5; }
  return v/n;
}

const SAND = new THREE.Color(0.86,0.79,0.62);
const DRYSAND = new THREE.Color(0.78,0.71,0.55);
const SCRUB = new THREE.Color(0.34,0.40,0.22);
const OLIVE = new THREE.Color(0.42,0.46,0.30);
const ROCK = new THREE.Color(0.62,0.60,0.55);
const LIME = new THREE.Color(0.78,0.76,0.70);

export class Island {
  constructor(opts){
    Object.assign(this, opts);
    this.shoreR = this.radius*0.60;
    this.shoalW = this.radius*0.85;
    this.group = new THREE.Group();
    this.items = [];
    this.build();
  }

  /* Terrain height in world space. Negative = under water. */
  height(x, z){
    const dx = x - this.pos.x, dz = z - this.pos.z;
    let d = Math.hypot(dx, dz)/this.radius;
    if(d > 1.45) return -40;
    const ang = Math.atan2(dz, dx);
    // ragged coastline: push the radius in and out with angular noise
    const wob = fbm(Math.cos(ang)*2.1+11, Math.sin(ang)*2.1+7, this.seed, 4);
    d *= 1.0 + (wob-0.5)*0.62;
    const shell = Math.max(0, 1 - d);
    const base = Math.pow(shell, 1.45);
    const n = fbm(x*0.0125, z*0.0125, this.seed, 5);
    const ridge = 1 - Math.abs(fbm(x*0.0052+3, z*0.0052-2, this.seed+5, 3)*2 - 1);
    let h = this.peak*base*(0.30 + 0.62*n + 0.42*ridge*base);
    h -= this.radius*0.055;                       // sink the rim so beaches emerge
    if(h > 0 && h < 2.6) h *= 0.55 + 0.45*(h/2.6);  // flatten the beach shelf
    return h;
  }

  normalAt(x, z, e = 1.4){
    const hL = this.height(x-e,z), hR = this.height(x+e,z);
    const hD = this.height(x,z-e), hU = this.height(x,z+e);
    return new THREE.Vector3(hL-hR, 2*e, hD-hU).normalize();
  }

  build(){
    const N = this.detail;                 // grid resolution
    const ext = this.radius*1.5;
    const g = new THREE.PlaneGeometry(ext*2, ext*2, N, N);
    g.rotateX(-Math.PI/2);
    const pos = g.attributes.position;
    const col = new Float32Array(pos.count*3);
    const c = new THREE.Color();

    for(let i = 0; i < pos.count; i++){
      const x = pos.getX(i) + this.pos.x, z = pos.getZ(i) + this.pos.z;
      let h = this.height(x, z);
      if(h < -14) h = -14;
      pos.setY(i, h);

      const nrm = this.normalAt(x, z, 2.2);
      const slope = 1 - nrm.y;
      const n = fbm(x*0.06, z*0.06, this.seed+31, 3);

      if(h < 1.1)                c.copy(SAND).lerp(DRYSAND, n);
      else if(h < 3.0)           c.copy(DRYSAND).lerp(SCRUB, (h-1.1)/1.9*0.85);
      else {
        const alt = Math.min(1, (h-3)/(this.peak*0.72));
        c.copy(SCRUB).lerp(OLIVE, n);
        c.lerp(LIME, alt*0.55);
      }
      if(slope > 0.18) c.lerp(ROCK, Math.min(1, (slope-0.18)*2.6));
      c.offsetHSL(0, 0, (n-0.5)*0.07);
      col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
    g.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.97, metalness:0.0 });
    this.terrain = new THREE.Mesh(g, mat);
    this.terrain.position.set(this.pos.x, 0, this.pos.z);
    this.terrain.receiveShadow = true;
    this.terrain.castShadow = false;
    this.group.add(this.terrain);

    this.scatter();
    if(this.hasLight) this.buildLighthouse();
    if(this.village) this.buildVillage();
    this.buildWell();
  }

  /* Trees, rocks and shrubs, placed by rule and drawn as instances. */
  scatter(){
    const rng = mulberry32(this.seed*7919|0);
    const cy = [], ol = [], tr = [], rk = [], bu = [];
    const tries = Math.floor(this.radius*this.radius*0.016);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    const up = new THREE.Vector3(0,1,0);

    for(let i = 0; i < tries; i++){
      const a = rng()*Math.PI*2, r = Math.sqrt(rng())*this.radius*1.12;
      const x = this.pos.x + Math.cos(a)*r, z = this.pos.z + Math.sin(a)*r;
      const h = this.height(x,z);
      if(h < 1.4 || h > this.peak*0.94) continue;
      const nrm = this.normalAt(x,z,2.0);
      if(nrm.y < 0.80) { if(rng() < 0.75) continue; }
      const dens = fbm(x*0.02, z*0.02, this.seed+91, 3);
      q.setFromUnitVectors(up, up.clone().lerp(nrm, 0.35).normalize());

      if(h > 2.6 && dens > 0.52 && rng() < 0.55){
        // cypress — tall dark spindle
        const s = 0.75 + rng()*0.8;
        sc.set(s, s*(1.1+rng()*0.7), s);
        cy.push(m.compose(new THREE.Vector3(x, h+3.4*sc.y, z), q, sc).clone());
        tr.push(m.compose(new THREE.Vector3(x, h+1.2, z), q, new THREE.Vector3(s*0.7,1.2,s*0.7)).clone());
      } else if(dens > 0.36 && rng() < 0.7){
        // olive / carob — low broad canopy
        const s = 0.9 + rng()*1.1;
        sc.set(s*1.5, s*1.0, s*1.5);
        ol.push(m.compose(new THREE.Vector3(x, h+2.0*s, z), q, sc).clone());
        tr.push(m.compose(new THREE.Vector3(x, h+0.9, z), q, new THREE.Vector3(s*0.8,0.95,s*0.8)).clone());
      } else if(rng() < 0.34){
        const s = 0.5 + rng()*2.4;
        q.setFromEuler(new THREE.Euler(rng()*3, rng()*6, rng()*3));
        rk.push(m.compose(new THREE.Vector3(x, h+s*0.32, z), q, new THREE.Vector3(s,s*0.75,s*1.2)).clone());
      } else if(rng() < 0.5){
        const s = 0.4 + rng()*0.7;
        bu.push(m.compose(new THREE.Vector3(x, h+s*0.4, z), new THREE.Quaternion(), new THREE.Vector3(s*1.4,s,s*1.4)).clone());
      }
    }

    const add = (geo, mat, list, shadow = true) => {
      if(!list.length) return null;
      const im = new THREE.InstancedMesh(geo, mat, list.length);
      list.forEach((mm,i)=>im.setMatrixAt(i,mm));
      im.instanceMatrix.needsUpdate = true;
      im.castShadow = shadow; im.receiveShadow = true;
      im.frustumCulled = true;
      this.group.add(im);
      return im;
    };

    add(new THREE.ConeGeometry(1.05, 7.2, 7), new THREE.MeshStandardMaterial({color:0x2c4526, roughness:1}), cy);
    add(new THREE.SphereGeometry(1.7, 8, 6), new THREE.MeshStandardMaterial({color:0x5d6b3c, roughness:1, flatShading:true}), ol);
    add(new THREE.CylinderGeometry(0.20,0.30,2.4,6), new THREE.MeshStandardMaterial({color:0x4a3a28, roughness:1}), tr);
    add(new THREE.DodecahedronGeometry(1,0), new THREE.MeshStandardMaterial({color:0x8b8578, roughness:0.98, flatShading:true}), rk);
    add(new THREE.SphereGeometry(1,6,4), new THREE.MeshStandardMaterial({color:0x6b7042, roughness:1, flatShading:true}), bu, false);
    this.treeCount = cy.length + ol.length;
  }

  /* A cistern — the only fresh water for a very long way. */
  buildWell(){
    const rng = mulberry32(this.seed*31337|0);
    let spot = this.villagePos;
    if(!spot){
      for(let i = 0; i < 300; i++){
        const a = rng()*Math.PI*2, r = this.radius*(0.15+rng()*0.5);
        const x = this.pos.x+Math.cos(a)*r, z = this.pos.z+Math.sin(a)*r;
        const h = this.height(x,z);
        if(h > 3 && h < this.peak*0.7 && this.normalAt(x,z,3).y > 0.94){ spot = new THREE.Vector3(x,h,z); break; }
      }
    }
    if(!spot) return;
    const h = this.height(spot.x, spot.z);
    const g = new THREE.Group();
    g.position.set(spot.x, h, spot.z);
    const stone = new THREE.MeshStandardMaterial({color:0xa8a094, roughness:1});
    const wall = new THREE.Mesh(new THREE.CylinderGeometry(0.95,1.05,1.0,14), stone);
    wall.position.y = 0.45; g.add(wall);
    const water = new THREE.Mesh(new THREE.CircleGeometry(0.82,16),
      new THREE.MeshStandardMaterial({color:0x123b44, roughness:0.15, metalness:0.1}));
    water.rotation.x = -Math.PI/2; water.position.y = 0.62; g.add(water);
    for(const s of [-1,1]){
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.12,1.3,0.12),
        new THREE.MeshStandardMaterial({color:0x6b5236, roughness:1}));
      post.position.set(s*0.85, 1.5, 0); g.add(post);
    }
    const beam = new THREE.Mesh(new THREE.BoxGeometry(2.0,0.12,0.12),
      new THREE.MeshStandardMaterial({color:0x6b5236, roughness:1}));
    beam.position.y = 2.1; g.add(beam);
    g.traverse(o=>{ if(o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(g);
    this.wellPos = new THREE.Vector3(spot.x, h, spot.z);
  }

  buildVillage(){
    const rng = mulberry32(this.seed*104729|0);
    const white = new THREE.MeshStandardMaterial({color:0xf0ece2, roughness:0.9});
    const roof = new THREE.MeshStandardMaterial({color:0xb5613a, roughness:0.95});
    const blue = new THREE.MeshStandardMaterial({color:0x2a6ea8, roughness:0.7});
    // find a gentle shelf near the water on the lee side
    let best = null;
    for(let i = 0; i < 400; i++){
      const a = rng()*Math.PI*2, r = this.radius*(0.35+rng()*0.45);
      const x = this.pos.x+Math.cos(a)*r, z = this.pos.z+Math.sin(a)*r;
      const h = this.height(x,z);
      if(h < 2.5 || h > 26) continue;
      const n = this.normalAt(x,z,3);
      if(n.y < 0.955) continue;
      best = {x,z,h}; break;
    }
    if(!best) return;
    const n = 4 + Math.floor(rng()*7);
    for(let i = 0; i < n; i++){
      const ox = best.x + (rng()-0.5)*34, oz = best.z + (rng()-0.5)*34;
      const h = this.height(ox,oz);
      if(h < 1.6) continue;
      const w = 3.2+rng()*2.6, d = 3.0+rng()*2.4, ht = 2.6+rng()*2.2;
      const b = new THREE.Mesh(new THREE.BoxGeometry(w,ht,d), white);
      b.position.set(ox, h+ht/2-0.2, oz); b.rotation.y = rng()*Math.PI;
      b.castShadow = b.receiveShadow = true;
      const r = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w,d)*0.80, 1.5, 4), rng()<0.75?roof:blue);
      r.position.set(0, ht/2+0.72, 0); r.rotation.y = Math.PI/4;
      r.castShadow = true;
      b.add(r);
      this.group.add(b);
    }
    // a chapel with a blue dome
    const ch = new THREE.Mesh(new THREE.BoxGeometry(4.4,3.4,5.6), white);
    ch.position.set(best.x, this.height(best.x,best.z)+1.5, best.z);
    ch.castShadow = ch.receiveShadow = true;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1.9,16,10,0,Math.PI*2,0,Math.PI/2), blue);
    dome.position.y = 1.7; dome.castShadow = true;
    ch.add(dome);
    this.group.add(ch);
    this.villagePos = new THREE.Vector3(best.x, best.h, best.z);
  }

  buildLighthouse(){
    // put it on the highest ground we can find
    let bx = this.pos.x, bz = this.pos.z, bh = -1;
    for(let i = 0; i < 900; i++){
      const a = (i/900)*Math.PI*2*7, r = this.radius*0.55*(i/900);
      const x = this.pos.x+Math.cos(a)*r, z = this.pos.z+Math.sin(a)*r;
      const h = this.height(x,z);
      if(h > bh){ bh = h; bx = x; bz = z; }
    }
    const g = new THREE.Group();
    g.position.set(bx, bh-0.6, bz);
    const white = new THREE.MeshStandardMaterial({color:0xf4f1e8, roughness:0.85});
    const red = new THREE.MeshStandardMaterial({color:0xb03a2e, roughness:0.85});
    const base = new THREE.Mesh(new THREE.CylinderGeometry(4.2,5.0,2.4,16), new THREE.MeshStandardMaterial({color:0xd8d2c4, roughness:0.95}));
    base.position.y = 1.2; g.add(base);
    for(let i = 0; i < 5; i++){
      const y = 2.4 + i*3.4;
      const r0 = 2.7 - i*0.28, r1 = 2.7 - (i+1)*0.28;
      const seg = new THREE.Mesh(new THREE.CylinderGeometry(r1, r0, 3.4, 20), i%2 ? red : white);
      seg.position.y = y + 1.7; g.add(seg);
    }
    const gal = new THREE.Mesh(new THREE.CylinderGeometry(2.6,2.6,0.5,20), red);
    gal.position.y = 20.0; g.add(gal);
    const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.6,1.6,3.0,16),
      new THREE.MeshStandardMaterial({color:0xffe9b0, emissive:0xffcf6a, emissiveIntensity:2.4, roughness:0.2}));
    lamp.position.y = 21.9; g.add(lamp);
    const cap = new THREE.Mesh(new THREE.ConeGeometry(2.0,1.8,16), red);
    cap.position.y = 24.3; g.add(cap);
    g.traverse(o=>{ if(o.isMesh){ o.castShadow = true; o.receiveShadow = true; } });

    this.lampMesh = lamp;
    this.light = new THREE.PointLight(0xffcf6a, 0, 900, 1.4);
    this.light.position.set(0, 21.9, 0);
    g.add(this.light);
    // the rotating beam
    const beamGeo = new THREE.ConeGeometry(9, 240, 4, 1, true);
    beamGeo.rotateZ(Math.PI/2); beamGeo.translate(120,0,0);
    this.beam = new THREE.Mesh(beamGeo, new THREE.MeshBasicMaterial({
      color:0xffe2a8, transparent:true, opacity:0.0, blending:THREE.AdditiveBlending,
      depthWrite:false, side:THREE.DoubleSide }));
    this.beam.position.y = 21.9;
    g.add(this.beam);

    this.group.add(g);
    this.lightPos = new THREE.Vector3(bx, bh+22, bz);
  }

  update(dt, night){
    if(this.beam){
      this.beam.rotation.y -= dt*0.75;
      const on = THREE.MathUtils.clamp(night*1.6, 0, 1);
      this.beam.material.opacity = 0.13*on;
      this.light.intensity = 900*on;
      this.lampMesh.material.emissiveIntensity = 0.4 + 3.4*on;
    }
  }
}

/* ── item props ─────────────────────────────────────────────── */
const AMPHORA_PROFILE = [[0.00,0.00],[0.26,0.05],[0.40,0.28],[0.46,0.62],[0.34,1.00],[0.16,1.22],[0.22,1.34],[0.19,1.44],[0.0,1.46]];
export function makeAmphora(){
  const pts = AMPHORA_PROFILE.map(p=>new THREE.Vector2(p[0]*0.62, p[1]*0.62));
  const g = new THREE.LatheGeometry(pts, 18);
  const m = new THREE.MeshStandardMaterial({color:0xb2643c, roughness:0.85});
  const mesh = new THREE.Mesh(g, m);
  mesh.castShadow = true;
  return mesh;
}
export function makeBarrel(color = 0x6d4c31){
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.42,0.38,0.92,14),
    new THREE.MeshStandardMaterial({color, roughness:0.92}));
  const hoop = new THREE.Mesh(new THREE.TorusGeometry(0.43,0.035,6,16),
    new THREE.MeshStandardMaterial({color:0x3a3a3a, roughness:0.6, metalness:0.7}));
  hoop.rotation.x = Math.PI/2; hoop.position.y = 0.22;
  const hoop2 = hoop.clone(); hoop2.position.y = -0.22;
  g.add(body, hoop, hoop2);
  g.traverse(o=>{ if(o.isMesh) o.castShadow = o.receiveShadow = true; });
  return g;
}

export class World {
  constructor(scene, opts = {}){
    this.scene = scene;
    this.islands = [];
    this.detail = opts.detail || 160;
    this.generate(opts.seed || 4210, opts.count || 13, opts.spread || 4200);
  }

  generate(seed, count, spread){
    const rng = mulberry32(seed);
    const placed = [];
    let guard = 0;
    while(placed.length < count && guard++ < 4000){
      const a = rng()*Math.PI*2;
      const r = 620 + Math.pow(rng(), 0.72)*spread;
      const p = new THREE.Vector3(Math.cos(a)*r, 0, Math.sin(a)*r);
      const radius = 78 + Math.pow(rng(),1.5)*230;
      if(placed.some(q => p.distanceTo(q.pos) < (q.radius + radius)*1.9)) continue;
      placed.push({ pos:p, radius, seed: Math.floor(rng()*10000),
                    peak: radius*(0.30 + rng()*0.55), village: rng() < 0.45 });
    }
    // the farthest island gets the light — it has to be worth reaching
    placed.sort((a,b)=>a.pos.length()-b.pos.length());
    const goal = placed[placed.length-1];
    goal.hasLight = true; goal.village = true;

    for(const o of placed){
      const isl = new Island(Object.assign({ detail:this.detail }, o));
      this.islands.push(isl);
      this.scene.add(isl.group);
    }
    this.goal = this.islands.find(i=>i.hasLight);
  }

  /* Highest land at this point, or a large negative number at sea. */
  heightAt(x, z){
    let h = -40;
    for(const i of this.islands){
      const dx = x-i.pos.x, dz = z-i.pos.z;
      if(dx*dx + dz*dz > (i.radius*1.5)**2) continue;
      const t = i.height(x,z);
      if(t > h) h = t;
    }
    return h;
  }

  nearest(x, z){
    let best = null, bd = Infinity;
    for(const i of this.islands){
      const d = Math.hypot(x-i.pos.x, z-i.pos.z) - i.radius;
      if(d < bd){ bd = d; best = i; }
    }
    return { island:best, dist:bd };
  }

  update(dt, night){ for(const i of this.islands) i.update(dt, night); }
}
