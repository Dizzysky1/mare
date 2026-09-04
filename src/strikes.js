import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   Contested waters. Somebody else's air force is using this stretch
   of sea as a range, and does not care that you are on it.

   One strike runs through four phases — inbound, marked, falling,
   impact — so it is always survivable if you read the water and put
   the helm over in time.
   ──────────────────────────────────────────────────────────────── */

const JET_ALT = 780;
const DROP_ALT = 620;

function jetMesh(){
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color:0x2b3138, roughness:0.55, metalness:0.35 });
  const body = new THREE.Mesh(new THREE.ConeGeometry(1.5, 15, 8), mat);
  body.rotation.x = Math.PI/2; g.add(body);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(15, 0.4, 3.6), mat);
  wing.position.z = -1.2;
  wing.geometry.translate(0,0,0);
  g.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(5.5, 0.35, 2.0), mat);
  tail.position.z = -6.0; g.add(tail);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.35, 3.0, 2.2), mat);
  fin.position.set(0, 1.4, -6.0); g.add(fin);
  g.visible = false;
  return g;
}

export class Strikes {
  constructor(scene, field, audio, cb = {}){
    this.scene = scene; this.field = field; this.audio = audio; this.cb = cb;
    this.active = false;
    this.timer = 55;
    this.wave = 0;
    this.events = [];

    this.jet = jetMesh();
    scene.add(this.jet);
    this.jetState = null;

    // pooled visuals
    this.bombGeo = new THREE.CapsuleGeometry(0.32, 1.5, 4, 8);
    this.bombMat = new THREE.MeshStandardMaterial({ color:0x23282c, roughness:0.7, metalness:0.3 });
    this.bombs = [];

    this.ringMat = new THREE.MeshBasicMaterial({ color:0xff5a3c, transparent:true, opacity:0,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide });
    this.waveMat = new THREE.MeshBasicMaterial({ color:0xdff0ff, transparent:true, opacity:0,
      blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide });

    this.rings = [];
    for(let i = 0; i < 6; i++){
      const m = new THREE.Mesh(new THREE.RingGeometry(9.0, 10.6, 40), this.ringMat.clone());
      m.rotation.x = -Math.PI/2; m.visible = false; m.renderOrder = 3;
      scene.add(m);
      this.rings.push({ mesh:m, used:false });
    }
    this.shocks = [];
    for(let i = 0; i < 5; i++){
      const m = new THREE.Mesh(new THREE.RingGeometry(0.86, 1.0, 64), this.waveMat.clone());
      m.rotation.x = -Math.PI/2; m.visible = false; m.renderOrder = 3;
      scene.add(m);
      this.shocks.push({ mesh:m, t:0, r:0, alive:false });
    }

    // spray/geyser particles
    const N = 900;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N*3), 3));
    this.geyser = new THREE.Points(g, new THREE.PointsMaterial({
      color:0xf2f8fb, size:0.55, transparent:true, opacity:0.85, depthWrite:false, sizeAttenuation:true }));
    this.geyser.frustumCulled = false;
    scene.add(this.geyser);
    this.parts = [];
    for(let i = 0; i < N; i++) this.parts.push({ p:new THREE.Vector3(), v:new THREE.Vector3(), life:0 });

    // smoke trails behind falling ordnance
    const S = 700;
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(S*3), 3));
    this.smoke = new THREE.Points(sg, new THREE.PointsMaterial({
      color:0x9aa3a8, size:1.9, transparent:true, opacity:0.42, depthWrite:false, sizeAttenuation:true }));
    this.smoke.frustumCulled = false;
    scene.add(this.smoke);
    this.smokeParts = [];
    for(let i = 0; i < S; i++) this.smokeParts.push({ p:new THREE.Vector3(), life:0 });

    this.flash = 0;
    this._v = new THREE.Vector3();
  }

  arm(on, interval = 95){
    this.active = on;
    this.interval = interval;
    this.timer = on ? 48 : 1e9;
    this.wave = 0;
    if(!on){
      this.jet.visible = false;
      this.jetState = null;
      for(const b of this.bombs) b.mesh.visible = false;
      this.bombs.length = 0;
      for(const r of this.rings){ r.used = false; r.mesh.visible = false; }
    }
  }

  /* ── begin a sortie ─────────────────────────────────────── */
  launch(target){
    this.wave++;
    const n = Math.min(5, 1 + Math.floor(this.wave/2) + (Math.random() < 0.4 ? 1 : 0));
    const from = Math.random()*Math.PI*2;
    const dir = new THREE.Vector3(Math.cos(from), 0, Math.sin(from));
    this.jetState = {
      pos: target.clone().addScaledVector(dir, -2600).setY(JET_ALT + Math.random()*120),
      dir, speed: 245 + Math.random()*70, t: 0, dropped:false, count:n, target: target.clone(),
    };
    this.jet.visible = true;
    this.audio.jet(0.35);
    this.cb.toast?.('Aircraft — high, fast, unmarked. It has seen you.', 'bad');
  }

  freeRing(){
    for(const r of this.rings) if(!r.used) return r;
    return null;
  }

  dropOn(point, delay){
    const r = this.freeRing();
    const mesh = new THREE.Mesh(this.bombGeo, this.bombMat);
    mesh.position.copy(point).setY(DROP_ALT);
    this.scene.add(mesh);
    const fall = Math.sqrt(2*DROP_ALT/9.81);          // free-fall time from release
    this.bombs.push({
      mesh, target:point.clone(), t:-delay, fall,
      vel:new THREE.Vector3(0,-1,0), ring:r,
    });
    if(r){
      r.used = true;
      r.mesh.visible = true;
      r.mesh.position.set(point.x, 0, point.z);
      r.mesh.material.opacity = 0;
      r.mesh.scale.setScalar(1);
    }
  }

  /* ── per-frame ──────────────────────────────────────────── */
  update(dt, target, ship, playerPos){
    this.flash = Math.max(0, this.flash - dt*3.0);
    this.updateParticles(dt);

    if(!this.active) return;

    if(!this.jetState && this.bombs.length === 0){
      this.timer -= dt;
      if(this.timer <= 0){
        this.timer = this.interval*(0.65 + Math.random()*0.7)/(1 + this.wave*0.05);
        this.launch(target);
      }
    }

    // the aircraft's run
    if(this.jetState){
      const j = this.jetState;
      j.t += dt;
      j.pos.addScaledVector(j.dir, j.speed*dt);
      this.jet.position.copy(j.pos);
      this.jet.rotation.set(0, Math.atan2(j.dir.x, j.dir.z), 0);
      // release when abeam of the target
      const rem = this._v.copy(j.target).sub(j.pos);
      rem.y = 0;
      if(!j.dropped && rem.dot(j.dir) < 900){
        j.dropped = true;
        // scatter the sticks around where the boat is *heading*
        const lead = ship ? ship.vel.clone().multiplyScalar(6) : new THREE.Vector3();
        for(let i = 0; i < j.count; i++){
          const a = Math.random()*Math.PI*2, r = 18 + Math.random()*120;
          const p = j.target.clone().add(lead);
          p.x += Math.cos(a)*r; p.z += Math.sin(a)*r; p.y = 0;
          this.dropOn(p, i*0.28);
        }
        this.cb.toast?.('Something is coming down. Get out from under it.', 'bad');
        this.audio.whistle();
      }
      if(j.t > 26){ this.jetState = null; this.jet.visible = false; }
    }

    // ordnance
    for(let i = this.bombs.length-1; i >= 0; i--){
      const b = this.bombs[i];
      b.t += dt;
      if(b.t < 0) continue;
      const u = b.t/b.fall;
      if(b.ring){
        const m = b.ring.mesh;
        const pulse = 0.35 + 0.65*Math.abs(Math.sin(b.t*(3 + u*14)));
        m.material.opacity = 0.55*pulse*Math.min(1, u*3);
        m.position.y = this.field.height(m.position.x, m.position.z) + 0.12;
        m.scale.setScalar(1 - u*0.35);
      }
      if(u >= 1){
        this.impact(b, playerPos, ship);
        if(b.ring){ b.ring.used = false; b.ring.mesh.visible = false; }
        this.scene.remove(b.mesh);
        this.bombs.splice(i,1);
        continue;
      }
      const y = DROP_ALT - 0.5*9.81*(b.t*b.t);
      b.mesh.position.set(b.target.x, y, b.target.z);
      b.mesh.rotation.x = -Math.PI/2 + 0.2;
      // smoke trail
      if(Math.random() < dt*40) this.emitSmoke(b.mesh.position);
    }

    // shock rings on the water
    for(const s of this.shocks){
      if(!s.alive) continue;
      s.t += dt;
      s.r += dt*46;
      s.mesh.scale.setScalar(s.r);
      s.mesh.position.y = this.field.height(s.mesh.position.x, s.mesh.position.z) + 0.1;
      s.mesh.material.opacity = Math.max(0, 0.55*(1 - s.t/2.6));
      if(s.t > 2.6){ s.alive = false; s.mesh.visible = false; }
    }
  }

  impact(b, playerPos, ship){
    const p = b.target.clone();
    p.y = this.field.height(p.x, p.z);
    this.flash = 1;

    // water column
    for(let i = 0, n = 0; i < this.parts.length && n < 150; i++){
      const q = this.parts[i];
      if(q.life > 0) continue;
      n++;
      const a = Math.random()*Math.PI*2, r = Math.random()*4.5;
      q.p.set(p.x + Math.cos(a)*r, p.y, p.z + Math.sin(a)*r);
      const up = 22 + Math.random()*34;
      q.v.set(Math.cos(a)*(2+Math.random()*13), up, Math.sin(a)*(2+Math.random()*13));
      q.life = 1.6 + Math.random()*2.2;
    }
    // shock ring
    const s = this.shocks.find(x=>!x.alive);
    if(s){ s.alive = true; s.t = 0; s.r = 2; s.mesh.visible = true; s.mesh.position.set(p.x, p.y, p.z); }

    const d = playerPos ? playerPos.distanceTo(p) : 999;
    this.audio.explosion(THREE.MathUtils.clamp(1 - d/700, 0.05, 1), d/340);

    // shove the hull
    if(ship){
      const dv = new THREE.Vector3().subVectors(ship.pos, p);
      const dist = Math.max(4, dv.length());
      if(dist < 220){
        const power = 5.2e6/(dist*dist);
        dv.normalize().multiplyScalar(power);
        dv.y += power*0.55;
        ship.impulse(dv, p);
      }
    }
    if(d < 90) this.cb.shake?.(THREE.MathUtils.clamp(1 - d/90, 0, 1));
    if(d < 55) this.cb.damage?.(THREE.MathUtils.clamp((1 - d/55), 0, 1)*95, 'A near miss. The water hit you like a wall.');
    if(d < 16) this.cb.damage?.(200, 'You were where it landed.');
  }

  emitSmoke(pos){
    for(const s of this.smokeParts){
      if(s.life > 0) continue;
      s.p.copy(pos); s.life = 2.2 + Math.random()*1.6;
      return;
    }
  }

  updateParticles(dt){
    const a = this.geyser.geometry.attributes.position.array;
    for(let i = 0; i < this.parts.length; i++){
      const q = this.parts[i], o = i*3;
      if(q.life > 0){
        q.life -= dt;
        q.v.y -= 9.81*dt;
        q.v.multiplyScalar(1 - dt*0.35);
        q.p.addScaledVector(q.v, dt);
        if(q.p.y < this.field.height(q.p.x, q.p.z) - 0.4) q.life = 0;
        a[o]=q.p.x; a[o+1]=q.p.y; a[o+2]=q.p.z;
      } else { a[o]=0; a[o+1]=-9999; a[o+2]=0; }
    }
    this.geyser.geometry.attributes.position.needsUpdate = true;

    const sa = this.smoke.geometry.attributes.position.array;
    for(let i = 0; i < this.smokeParts.length; i++){
      const q = this.smokeParts[i], o = i*3;
      if(q.life > 0){
        q.life -= dt;
        q.p.y += dt*1.2;
        sa[o]=q.p.x; sa[o+1]=q.p.y; sa[o+2]=q.p.z;
      } else { sa[o]=0; sa[o+1]=-9999; sa[o+2]=0; }
    }
    this.smoke.geometry.attributes.position.needsUpdate = true;
  }
}
