import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   The flight half of an air strike. We own the jet's path, its
   animation and its contrail; f18.js owns the model, whatever calls
   us owns the bombs and the explosions. The one thing that has to be
   exact is the handoff: onRelease fires with a position and velocity
   such that the orchestrator's own drag-free integrator

       vel.y -= 9.81*dt;  pos.addScaledVector(vel, dt);

   lands the bomb on plannedImpacts[i]. That only works if the jet is
   flying dead level, at the exact release altitude and speed, with
   zero vertical rate, at the instant of release — so the run-in and
   the release sequence never bend the actual flight line, and every
   bit of banking/pitching you see before or after that window is
   cosmetic only.
   ──────────────────────────────────────────────────────────────── */

const G = 9.81;
const YAXIS = new THREE.Vector3(0, 1, 0);
const XAXIS = new THREE.Vector3(1, 0, 0);
const ZAXIS = new THREE.Vector3(0, 0, 1);

/* Crude stand-in matching buildF18()'s contract, used until the real
   model loads (or if it never does) so flight behaviour can always be
   built and watched on its own. */
function buildPlaceholder(){
  const mat = new THREE.MeshStandardMaterial({ color: 0x30343a, roughness: 0.6, metalness: 0.3 });
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.3, 15), mat);
  group.add(body);
  const wing = new THREE.Mesh(new THREE.BoxGeometry(11, 0.3, 3.4), mat);
  wing.position.z = 0.5;
  group.add(wing);
  const tail = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.25, 1.8), mat);
  tail.position.z = -6.4;
  group.add(tail);
  const fin = new THREE.Mesh(new THREE.BoxGeometry(0.25, 2.2, 1.8), mat);
  fin.position.set(0, 1.2, -6.4);
  group.add(fin);
  const pylons = [];
  for(const x of [-4.2, -2.3, 2.3, 4.2]){
    const p = new THREE.Object3D();
    p.position.set(x, -0.7, 0.4);
    group.add(p);
    pylons.push(p);
  }
  return {
    group, pylons, length: 15, span: 11,
    setBurner(){}, setSurfaces(){},
    dispose(){
      body.geometry.dispose(); wing.geometry.dispose();
      tail.geometry.dispose(); fin.geometry.dispose(); mat.dispose();
    },
  };
}

export class Flyover {
  constructor(scene, opts = {}){
    this.scene = scene;
    this.audio = opts.audio || null;
    this.makeStore = typeof opts.makeStore === 'function' ? opts.makeStore : null;

    this.active = false;
    this.plannedImpacts = [];
    this.onRelease = null;
    this.onPass = null;

    this.craft = null;     // { group, pylons, setBurner, setSurfaces, length, span, dispose }
    this.stores = [];       // pooled hardpoint fillers, one per pylon, reused across runs
    this.run = null;        // current sortie state, or null between runs
    this._disposed = false;
    this._lastListener = null;

    // contrail: a fixed pool of fading points written round-robin, so
    // emitting one never allocates or hunts for a free slot
    this.trailCount = 240;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailCount * 3), 3));
    this.trail = new THREE.Points(tg, new THREE.PointsMaterial({
      color: 0xe8eef2, size: 1.6, transparent: true, opacity: 0.32,
      depthWrite: false, sizeAttenuation: true }));
    this.trail.frustumCulled = false;
    scene.add(this.trail);
    this.trailData = [];
    for(let i = 0; i < this.trailCount; i++) this.trailData.push({ p: new THREE.Vector3(0, -9999, 0), life: 0 });
    this.trailCursor = 0;

    // scratch — reused every frame, never allocated in the hot path
    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._qYaw = new THREE.Quaternion(); this._qPitch = new THREE.Quaternion(); this._qRoll = new THREE.Quaternion();

    this._loadCraft();
  }

  /* f18.js may still be mid-write the first time this runs — start with
     the placeholder immediately (an async function body runs up to its
     first await synchronously) and swap in the real model if/when it
     resolves. The real app will always have it; this just means we
     never block on it. */
  async _loadCraft(){
    this._setCraft(buildPlaceholder());
    try {
      const mod = await import('./f18.js');
      if(this._disposed) return;
      if(mod && typeof mod.buildF18 === 'function') this._setCraft(mod.buildF18());
    } catch(e){ /* keep the placeholder */ }
  }

  _setCraft(built){
    if(this.craft){ this.scene.remove(this.craft.group); this.craft.dispose?.(); }
    this.craft = built;
    built.group.visible = false;
    this.scene.add(built.group);
    this._rebuildStores();
  }

  _rebuildStores(){
    for(const st of this.stores) st.obj.parent?.remove(st.obj);
    this.stores = [];
    if(!this.makeStore || !this.craft || !this.craft.pylons.length) return;
    for(let i = 0; i < this.craft.pylons.length; i++){
      const obj = this.makeStore();
      obj.visible = false;
      this.stores.push({ obj, attached: false });
    }
  }

  /* ── sortie control ─────────────────────────────────────── */

  start({ target, count = 3, spacing = 45, heading = null, altitude = null, speed = null }){
    this.abort();

    const h = altitude ?? THREE.MathUtils.randFloat(350, 700);
    const s = speed ?? THREE.MathUtils.randFloat(220, 280);
    const hd = heading ?? Math.random() * Math.PI * 2;
    const dir = new THREE.Vector3(Math.sin(hd), 0, Math.cos(hd));
    const n = Math.max(1, count | 0);
    const fallT = Math.sqrt(2 * h / G);      // time to fall from release altitude, zero initial vy

    // a walked stick, centred on target, in the order the aircraft will cross them
    const impacts = [];
    const releasePts = [];
    for(let i = 0; i < n; i++){
      const off = (i - (n - 1) / 2) * spacing;
      const p = new THREE.Vector3(target.x + dir.x * off, 0, target.z + dir.z * off);
      impacts.push(p);
      releasePts.push(new THREE.Vector3(p.x - dir.x * s * fallT, 0, p.z - dir.z * s * fallT));
    }

    const spawnDist = THREE.MathUtils.randFloat(4000, 5000);
    const spawnPos = new THREE.Vector3(target.x - dir.x * spawnDist, h, target.z - dir.z * spawnDist);

    this.active = true;
    this.plannedImpacts = impacts;
    this.run = {
      target: target.clone(), dir, speed: s, altitude: h,
      releasePts, released: new Array(n).fill(false), releasedCount: 0,
      phase: 'inbound', pos: spawnPos, t: 0, passed: false,
      settle: THREE.MathUtils.randFloat(1.4, 2.2),      // cosmetic roll-out duration
      correctionSign: Math.random() < 0.5 ? -1 : 1,
      bank: 0, pitch: 0,
      egress: null,
    };

    if(this.craft){
      this.craft.group.visible = true;
      this.craft.setBurner?.(0);
      this._placeStores(n);
    }

    // best-effort doppler: we only get a one-shot gain, so bake distance
    // into it once, using whatever listener position update() last saw
    const dist = this._lastListener ? this._lastListener.distanceTo(spawnPos) : 2500;
    const gain = THREE.MathUtils.clamp(0.42 * (1 - dist / 6000), 0.08, 0.42);
    const dur = THREE.MathUtils.clamp(spawnDist / s * 1.15, 10, 22);
    this.audio?.jet?.(gain, dur);
  }

  abort(){
    this.active = false;
    this.run = null;
    if(this.craft) this.craft.group.visible = false;
    for(const st of this.stores){ st.obj.parent?.remove(st.obj); st.obj.visible = false; st.attached = false; }
    for(const d of this.trailData) d.life = 0;
  }

  dispose(){
    this._disposed = true;
    this.abort();
    for(const st of this.stores){
      st.obj.traverse?.(o => {
        o.geometry?.dispose?.();
        if(o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose());
      });
    }
    this.stores = [];
    if(this.craft){ this.scene.remove(this.craft.group); this.craft.dispose?.(); this.craft = null; }
    this.scene.remove(this.trail);
    this.trail.geometry.dispose(); this.trail.material.dispose();
  }

  _placeStores(n){
    if(!this.stores.length || !this.craft.pylons.length) return;
    const pylons = this.craft.pylons;
    for(let i = 0; i < n; i++){
      const st = this.stores[i % this.stores.length];
      if(st.attached) continue;
      pylons[i % pylons.length].add(st.obj);
      st.obj.position.set(0, 0, 0);
      st.obj.visible = true;
      st.attached = true;
    }
  }

  _releaseStore(i){
    if(!this.stores.length) return;
    const st = this.stores[i % this.stores.length];
    if(st && st.attached){ st.obj.parent?.remove(st.obj); st.obj.visible = false; st.attached = false; }
  }

  /* ── per-frame ──────────────────────────────────────────── */

  update(dt, listenerPos){
    if(!(dt > 0) || !Number.isFinite(dt)) return;
    if(listenerPos) (this._lastListener || (this._lastListener = new THREE.Vector3())).copy(listenerPos);

    this._updateTrail(dt);       // fades whether or not a run is active

    if(!this.active || !this.run) return;
    const run = this.run;
    run.t += dt;

    if(run.phase === 'inbound') this._stepInbound(dt, run);
    else if(run.phase === 'egress') this._stepEgress(dt, run);

    if(this.craft) this._applyPose(run);
  }

  _stepInbound(dt, run){
    const stepLen = run.speed * dt;

    // cosmetic roll-out onto the run-in heading — visual only, the track
    // itself never bends, so the release maths below stay exact
    const settleU = THREE.MathUtils.clamp(run.t / run.settle, 0, 1);
    run.bank = run.correctionSign * 0.30 * (1 - settleU) * (1 - settleU);
    run.pitch = run.bank * 0.15;

    if(!run.passed){
      this._v1.copy(run.pos).setY(0).sub(run.target);
      if(this._v1.dot(run.dir) >= 0){ run.passed = true; this.onPass?.(); }
    }

    // release with sub-frame precision — at 60fps a whole frame is ~4m of
    // travel, which is most of our error budget, so interpolate the exact
    // crossing point rather than releasing wherever the frame lands
    for(let i = 0; i < run.releasePts.length; i++){
      if(run.released[i]) continue;
      this._v1.copy(run.pos).setY(0).sub(run.releasePts[i]);
      const before = this._v1.dot(run.dir);
      if(before + stepLen < 0) continue;
      const frac = before >= 0 ? 0 : THREE.MathUtils.clamp(-before / stepLen, 0, 1);
      const relPos = this._v2.copy(run.pos).addScaledVector(run.dir, stepLen * frac);
      run.released[i] = true; run.releasedCount++;
      const relVel = this._v3.copy(run.dir).multiplyScalar(run.speed);   // level flight: zero vertical rate
      this._releaseStore(i);
      this.onRelease?.(relPos.clone(), relVel.clone(), i);
      this.audio?.whistle?.();
    }

    run.pos.addScaledVector(run.dir, stepLen);

    if(run.releasedCount >= run.releasePts.length) this._beginEgress(run);
  }

  _beginEgress(run){
    run.phase = 'egress';
    run.egress = {
      t: 0, yaw: Math.atan2(run.dir.x, run.dir.z),
      bank: run.bank, climb: 0, speed: run.speed,
      turnDir: run.correctionSign >= 0 ? -1 : 1,     // break away from the roll-out side
    };
    this.craft?.setBurner?.(1);
  }

  _stepEgress(dt, run){
    const e = run.egress;
    e.t += dt;
    const targetBank = e.turnDir * THREE.MathUtils.degToRad(68);
    const targetClimb = THREE.MathUtils.degToRad(24);
    const targetSpeed = run.speed * 1.35;
    e.bank += (targetBank - e.bank) * Math.min(1, dt * 1.8);
    e.climb += (targetClimb - e.climb) * Math.min(1, dt * 0.9);
    e.speed += (targetSpeed - e.speed) * Math.min(1, dt * 0.5);

    const yawRate = G * Math.tan(e.bank) / Math.max(e.speed, 30);   // coordinated turn
    e.yaw += yawRate * dt;

    this._v1.set(Math.sin(e.yaw), 0, Math.cos(e.yaw));
    const dir = this._v3.copy(this._v1).multiplyScalar(Math.cos(e.climb));
    dir.y = Math.sin(e.climb);
    if(!Number.isFinite(dir.x + dir.y + dir.z)) return;

    run.pos.addScaledVector(dir, e.speed * dt);
    run.dir.copy(this._v1);
    run.bank = e.bank; run.pitch = e.climb;

    const away = Math.hypot(run.pos.x - run.target.x, run.pos.z - run.target.z);
    if(away > 3500 || e.t > 16) this._finish();
  }

  _finish(){
    this.active = false;
    if(this.craft) this.craft.group.visible = false;
    this.run = null;
  }

  _applyPose(run){
    const g = this.craft.group;
    if(!Number.isFinite(run.pos.x + run.pos.y + run.pos.z)) return;
    g.position.copy(run.pos);

    // 3-2-1 (roll, then pitch, then yaw) composition, body axes: nose +Z,
    // right wing +X, up +Y
    const yaw = Math.atan2(run.dir.x, run.dir.z);
    this._qYaw.setFromAxisAngle(YAXIS, yaw);
    this._qPitch.setFromAxisAngle(XAXIS, run.pitch);
    this._qRoll.setFromAxisAngle(ZAXIS, -run.bank);
    g.quaternion.copy(this._qYaw).multiply(this._qPitch).multiply(this._qRoll);

    this.craft.setSurfaces?.({
      aileron: THREE.MathUtils.clamp(run.bank * 1.2, -1, 1),
      elevator: THREE.MathUtils.clamp(run.pitch * 1.4, -1, 1),
      rudder: THREE.MathUtils.clamp(run.bank * 0.2, -1, 1),
    });

    this._emitTrail(g);
  }

  _emitTrail(g){
    const span = this.craft.span || 10, len = this.craft.length || 15;
    const local = [
      this._v1.set(-span * 0.46, -0.05, -len * 0.05),
      this._v2.set(span * 0.46, -0.05, -len * 0.05),
      this._v3.set(0, -0.15, -len * 0.46),
    ];
    for(const o of local){
      o.applyQuaternion(g.quaternion).add(g.position);
      const d = this.trailData[this.trailCursor];
      d.p.copy(o); d.life = 3.2;
      this.trailCursor = (this.trailCursor + 1) % this.trailCount;
    }
  }

  _updateTrail(dt){
    const arr = this.trail.geometry.attributes.position.array;
    for(let i = 0; i < this.trailCount; i++){
      const d = this.trailData[i];
      if(d.life <= 0) continue;
      d.life -= dt;
      const o = i * 3;
      if(d.life <= 0){ arr[o + 1] = -9999; continue; }
      arr[o] = d.p.x; arr[o + 1] = d.p.y; arr[o + 2] = d.p.z;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
  }
}
