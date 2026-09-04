import * as THREE from 'three';
import { buildF18 } from './f18.js';

/* ────────────────────────────────────────────────────────────────
   The flight half of an air strike. We own the jet's path, its
   animation and its contrail; f18.js owns the model, whatever calls
   us owns the bombs and the explosions. The one thing that has to be
   exact is the handoff: onRelease fires with a position and velocity
   such that the orchestrator's own drag-free integrator

       pos.addScaledVector(vel, dt);  pos.y -= 0.5*9.81*dt*dt;
       vel.y -= 9.81*dt;

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
    this._lastListener = new THREE.Vector3();
    this._hasListener = false;

    // contrail: a fixed pool of fading points written round-robin, so
    // emitting one never allocates or hunts for a free slot
    this.trailCount = 600;
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.trailCount * 3), 3));
    tg.setAttribute('alpha', new THREE.BufferAttribute(new Float32Array(this.trailCount), 1));
    this.trail = new THREE.Points(tg, new THREE.ShaderMaterial({
      uniforms: {
        color: { value: new THREE.Color(0xe8eef2) },
        size: { value: 28 },
      },
      vertexShader: `
        attribute float alpha;
        varying float vAlpha;
        uniform float size;
        void main(){
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vAlpha = alpha;
          gl_PointSize = size / max(1.0, -mv.z * 0.018);
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 color;
        varying float vAlpha;
        void main(){
          float soft = 1.0 - smoothstep(0.18, 0.5, length(gl_PointCoord - 0.5));
          gl_FragColor = vec4(color, vAlpha * soft * 0.34);
        }
      `,
      transparent: true, depthWrite: false,
    }));
    this.trail.frustumCulled = false;
    scene.add(this.trail);
    this.trailData = [];
    for(let i = 0; i < this.trailCount; i++) this.trailData.push({ p: new THREE.Vector3(0, -9999, 0), life: 0 });
    this.trailCursor = 0;

    // scratch — reused every frame, never allocated in the hot path
    this._v1 = new THREE.Vector3(); this._v2 = new THREE.Vector3(); this._v3 = new THREE.Vector3();
    this._qYaw = new THREE.Quaternion(); this._qPitch = new THREE.Quaternion(); this._qRoll = new THREE.Quaternion();
    this._surfaceState = { aileron: 0, elevator: 0, rudder: 0 };

    this._setCraft(buildF18());
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
      const obj = this.makeStore(i);
      obj.visible = false;
      this.stores.push({ obj, attached: false });
    }
  }

  /* ── sortie control ─────────────────────────────────────── */

  start({ target, count = 3, spacing = 45, heading = null, altitude = null, speed = null }){
    this.abort();

    if(!target || !Number.isFinite(target.x) || !Number.isFinite(target.z)
      || Math.abs(target.x) > 1e7 || Math.abs(target.z) > 1e7) return;

    const h = Number.isFinite(altitude) && altitude > 0
      ? THREE.MathUtils.clamp(altitude, 1, 5000) : THREE.MathUtils.randFloat(350, 700);
    const s = Number.isFinite(speed) && speed > 0
      ? THREE.MathUtils.clamp(speed, 1, 1000) : THREE.MathUtils.randFloat(220, 280);
    const hd = Number.isFinite(heading) ? heading : Math.random() * Math.PI * 2;
    const dir = new THREE.Vector3(Math.sin(hd), 0, Math.cos(hd));
    const n = Math.max(1, Math.min(16, Number.isFinite(count) ? Math.trunc(count) : 3));
    const gap = Number.isFinite(spacing) && spacing > 0 ? Math.min(spacing, 1e5) : 45;
    const fallT = Math.sqrt(2 * h / G);      // time to fall from release altitude, zero initial vy

    // a walked stick, centred on target, in the order the aircraft will cross them
    const impacts = [];
    const releasePts = [];
    for(let i = 0; i < n; i++){
      const off = (i - (n - 1) / 2) * gap;
      const p = new THREE.Vector3(target.x + dir.x * off, 0, target.z + dir.z * off);
      impacts.push(p);
      releasePts.push(new THREE.Vector3(p.x - dir.x * s * fallT, 0, p.z - dir.z * s * fallT));
    }

    // Explicit high/fast runs may need more than 5 km of ballistic lead;
    // always leave enough room to cross every release point in sequence.
    const halfStick = (n - 1) * gap * 0.5;
    const spawnDist = Math.max(THREE.MathUtils.randFloat(4000, 5000), s * fallT + halfStick + 800);
    const spawnPos = new THREE.Vector3(target.x - dir.x * spawnDist, h, target.z - dir.z * spawnDist);

    this.active = true;
    this.plannedImpacts = impacts;
    this.run = {
      target: new THREE.Vector3(target.x, 0, target.z), dir, speed: s, altitude: h, fallT,
      releasePts, released: new Array(n).fill(false), releasedCount: 0,
      phase: 'inbound', pos: spawnPos, t: 0, passed: false,
      settle: THREE.MathUtils.randFloat(1.4, 2.2),      // cosmetic roll-out duration
      correctionSign: Math.random() < 0.5 ? -1 : 1,
      bank: 0, pitch: 0, burnerOn: false,
      egress: null,
    };

    if(this.craft){
      this.craft.group.visible = true;
      this.craft.setBurner?.(0);
      this._placeStores(n);
    }

    // best-effort doppler: we only get a one-shot gain, so bake distance
    // into it once, using whatever listener position update() last saw
    const dist = this._hasListener ? this._lastListener.distanceTo(spawnPos) : 2500;
    const gain = THREE.MathUtils.clamp(0.42 * (1 - dist / 6000), 0.08, 0.42);
    const dur = THREE.MathUtils.clamp(spawnDist / s * 1.15, 10, 22);
    this.audio?.jet?.(gain, dur);
  }

  abort(){
    this.active = false;
    this.run = null;
    this.plannedImpacts.length = 0;
    if(this.craft){
      this.craft.group.visible = false;
      this.craft.setBurner?.(0);
      this.craft.setSurfaces?.({ aileron: 0, elevator: 0, rudder: 0 });
    }
    for(const st of this.stores){ st.obj.parent?.remove(st.obj); st.obj.visible = false; st.attached = false; }
    const pos = this.trail.geometry.attributes.position.array;
    const alpha = this.trail.geometry.attributes.alpha.array;
    for(let i = 0; i < this.trailCount; i++){
      this.trailData[i].life = 0;
      pos[i * 3 + 1] = -9999;
      alpha[i] = 0;
    }
    this.trail.geometry.attributes.position.needsUpdate = true;
    this.trail.geometry.attributes.alpha.needsUpdate = true;
  }

  dispose(){
    this.abort();
    // makeStore hands us externally owned/shared assets; detach but do not
    // invalidate their module-level geometry and materials.
    for(const st of this.stores) st.obj.parent?.remove(st.obj);
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
    dt = Math.min(dt, 0.1);
    if(listenerPos && Number.isFinite(listenerPos.x + listenerPos.y + listenerPos.z)){
      this._lastListener.copy(listenerPos);
      this._hasListener = true;
    }

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
      this.audio?.whistle?.(Math.max(0, run.fallT - 3.4));
    }

    run.pos.addScaledVector(run.dir, stepLen);

    if(!run.passed){
      this._v1.copy(run.pos).setY(0).sub(run.target);
      if(this._v1.dot(run.dir) >= 0){
        run.passed = true;
        this.onPass?.();
      }
    }

    if(run.releasedCount >= run.releasePts.length){
      if(!run.burnerOn){
        run.burnerOn = true;
        this.craft?.setBurner?.(1);
      }
      if(run.passed) this._beginEgress(run);
    }
  }

  _beginEgress(run){
    run.phase = 'egress';
    run.egress = {
      t: 0, yaw: Math.atan2(run.dir.x, run.dir.z),
      bank: run.bank, climb: 0, speed: run.speed,
      turnDir: run.correctionSign >= 0 ? -1 : 1,     // break away from the roll-out side
    };
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

    const surfaces = this._surfaceState;
    surfaces.aileron = THREE.MathUtils.clamp(run.bank * 1.2, -1, 1);
    surfaces.elevator = THREE.MathUtils.clamp(run.pitch * 1.4, -1, 1);
    surfaces.rudder = THREE.MathUtils.clamp(run.bank * 0.2, -1, 1);
    this.craft.setSurfaces?.(surfaces);

    this._emitTrail(g);
  }

  _emitTrail(g){
    const span = this.craft.span || 10, len = this.craft.length || 15;
    this._emitTrailPoint(this._v1.set(-span * 0.46, -0.05, -len * 0.05), g);
    this._emitTrailPoint(this._v2.set( span * 0.46, -0.05, -len * 0.05), g);
    this._emitTrailPoint(this._v3.set(0, -0.15, -len * 0.46), g);
  }

  _emitTrailPoint(point, g){
    point.applyQuaternion(g.quaternion).add(g.position);
    const d = this.trailData[this.trailCursor];
    d.p.copy(point); d.life = 3.2;
    this.trailCursor = (this.trailCursor + 1) % this.trailCount;
  }

  _updateTrail(dt){
    const arr = this.trail.geometry.attributes.position.array;
    const alpha = this.trail.geometry.attributes.alpha.array;
    let dirty = false;
    for(let i = 0; i < this.trailCount; i++){
      const d = this.trailData[i];
      if(d.life <= 0) continue;
      dirty = true;
      d.life -= dt;
      const o = i * 3;
      if(d.life <= 0){ arr[o + 1] = -9999; alpha[i] = 0; continue; }
      arr[o] = d.p.x; arr[o + 1] = d.p.y; arr[o + 2] = d.p.z;
      alpha[i] = Math.min(1, d.life / 1.2);
    }
    if(dirty){
      this.trail.geometry.attributes.position.needsUpdate = true;
      this.trail.geometry.attributes.alpha.needsUpdate = true;
    }
  }
}
