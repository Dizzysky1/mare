import { munition } from './munitions.js';

/* ────────────────────────────────────────────────────────────────
   Where a released store actually goes, and the release solution
   that puts it on target once drag is in the picture.

   aero.js supplies the drag; we don't know its exact call shape
   while it's still being written next to this file, so every call
   into it is wrapped and defensive — if the module is missing, still
   loading, or throws, a step just falls back to gravity-only motion
   for that step. Nothing here ever trusts aero.js to be perfect.

   Plain {x,y,z} objects throughout, no THREE — this is pure maths
   consumed by scene code, not scene code itself.
   ──────────────────────────────────────────────────────────────── */

const G = 9.81;
const DEFAULT_DENSITY = 1.225;

// Internal step size for both the flight integrator and the release
// solver's trial trajectories. Small enough that RK4 error is far
// below anything the game can render, independent of the caller's
// frame dt (which can be as coarse as 1/20s — see Store.update).
const SUBSTEP_DT = 1/120;
const MAX_SUBSTEPS_PER_CALL = 12;     // caps cost if dt ever spikes
const MAX_FLIGHT_TIME = 60;           // guard: a store must eventually stop

const SOLVE_DT = 1/120;
const MAX_SOLVE_STEPS = Math.ceil(60/SOLVE_DT);
const MAX_SOLVE_ITER = 8;
const MISS_TOL = 0.05;                // metres; solver stops once this tight

/* ── aero.js, loaded defensively ───────────────────────────────
   Dynamic import so a missing/broken/not-yet-written aero.js can
   never take the whole module down with it — trajectory.js keeps
   working with drag-free (vacuum) ballistics until it resolves. */
let aeroMod = null;
import('./aero.js').then(m => { aeroMod = m; }).catch(() => { aeroMod = null; });

const _dragOut = { x:0, y:0, z:0 };

// aero.dragAccel's exact parameter order for its allocation-free "out"
// value isn't nailed down yet, so we hand it a scratch object as a
// trailing arg AND accept a returned vector — whichever convention it
// lands on, this reads it correctly. See the report for the assumed
// signature: dragAccel(munitionId, vel, density, opts, out).
function accel(out, vel, munitionId, density, opts){
  out.x = 0; out.y = -G; out.z = 0;
  if(aeroMod && typeof aeroMod.dragAccel === 'function'){
    try{
      _dragOut.x = 0; _dragOut.y = 0; _dragOut.z = 0;
      const ret = aeroMod.dragAccel(munitionId, vel, density, opts, _dragOut);
      const d = (ret && Number.isFinite(ret.x) && Number.isFinite(ret.y) && Number.isFinite(ret.z)) ? ret : _dragOut;
      if(Number.isFinite(d.x) && Number.isFinite(d.y) && Number.isFinite(d.z)){
        out.x += d.x; out.y += d.y; out.z += d.z;
      }
    } catch(_e){ /* aero not ready or errored: this step just falls drag-free */ }
  }
  return out;
}

function surfaceY(field, x, z, t){
  if(!field || typeof field.height !== 'function') return 0;
  try{
    const y = field.height(x, z, t);
    return Number.isFinite(y) ? y : 0;
  } catch(_e){ return 0; }
}

function fieldTimeOf(field){
  return (field && Number.isFinite(field.time)) ? field.time : 0;
}

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }

/* Rotate `vel` toward the unit vector `aimDir`, by at most `maxAngle`
   radians, preserving |vel|. This is the whole guidance law: a pure
   pursuit turn capped by the store's physical turn rate. Slerp rather
   than a linear nudge so the cap is an actual angle regardless of how
   fast the store is going. */
function turnToward(vel, aimDir, maxAngle){
  const speed = Math.hypot(vel.x, vel.y, vel.z);
  if(!(speed > 1e-6) || !(maxAngle > 0)) return;
  const vx = vel.x/speed, vy = vel.y/speed, vz = vel.z/speed;
  const dot = clamp(vx*aimDir.x + vy*aimDir.y + vz*aimDir.z, -1, 1);
  const angle = Math.acos(dot);
  if(angle < 1e-9) return;
  const t = Math.min(1, maxAngle/angle);
  const sinA = Math.sin(angle);
  if(sinA < 1e-9) return;             // aimed dead opposite: no well-defined turn axis, hold course
  const w1 = Math.sin((1-t)*angle)/sinA, w2 = Math.sin(t*angle)/sinA;
  vel.x = (w1*vx + w2*aimDir.x)*speed;
  vel.y = (w1*vy + w2*aimDir.y)*speed;
  vel.z = (w1*vz + w2*aimDir.z)*speed;
}

/* ── RK4 integrator ─────────────────────────────────────────────
   Forward Euler drifts badly over an 8-11s fall at dt=1/20 — a
   constant acceleration error compounds for the whole flight. Since
   drag here only depends on velocity (never on position), a 4th-order
   Runge-Kutta step is cheap (4 acceleration evaluations) and folds
   position and velocity together correctly; combined with substepping
   to ~1/120s (see Store.update) its error at real frame rates is well
   under a centimetre over a full fall — see the dt=1/240 vs 1/60 vs
   1/20 comparison in the verification report. */
const _k1 = {x:0,y:0,z:0}, _k2 = {x:0,y:0,z:0}, _k3 = {x:0,y:0,z:0}, _k4 = {x:0,y:0,z:0};
const _tv = {x:0,y:0,z:0};

function rk4Step(pos, vel, dt, munitionId, density, opts){
  accel(_k1, vel, munitionId, density, opts);
  _tv.x = vel.x + _k1.x*dt*0.5; _tv.y = vel.y + _k1.y*dt*0.5; _tv.z = vel.z + _k1.z*dt*0.5;
  accel(_k2, _tv, munitionId, density, opts);
  _tv.x = vel.x + _k2.x*dt*0.5; _tv.y = vel.y + _k2.y*dt*0.5; _tv.z = vel.z + _k2.z*dt*0.5;
  accel(_k3, _tv, munitionId, density, opts);
  _tv.x = vel.x + _k3.x*dt; _tv.y = vel.y + _k3.y*dt; _tv.z = vel.z + _k3.z*dt;
  accel(_k4, _tv, munitionId, density, opts);

  const dt2_6 = dt*dt/6;
  pos.x += vel.x*dt + dt2_6*(_k1.x + _k2.x + 2*_k3.x);
  pos.y += vel.y*dt + dt2_6*(_k1.y + _k2.y + 2*_k3.y);
  pos.z += vel.z*dt + dt2_6*(_k1.z + _k2.z + 2*_k3.z);

  const dt_6 = dt/6;
  vel.x += dt_6*(_k1.x + 2*_k2.x + 2*_k3.x + _k4.x);
  vel.y += dt_6*(_k1.y + 2*_k2.y + 2*_k3.y + _k4.y);
  vel.z += dt_6*(_k1.z + 2*_k2.z + 2*_k3.z + _k4.z);
}

/* Locate the surface crossing inside [0,h] by bisection on trial RK4
   steps from the substep's starting state. 20 halvings resolve the
   crossing to better than a millionth of the substep — the store can
   easily move 20m in a whole render frame, but the substep itself is
   already small (~1/120s), so this pins the true impact point/velocity
   to well under a millimetre of travel, independent of frame rate. */
const _cp = {x:0,y:0,z:0}, _cv = {x:0,y:0,z:0};
function findCrossing(pos0, vel0, h, munitionId, density, opts, field, tAbs0, fuzeOffset){
  let lo = 0, hi = h;
  for(let i = 0; i < 20; i++){
    const mid = (lo+hi)*0.5;
    _cp.x = pos0.x; _cp.y = pos0.y; _cp.z = pos0.z;
    _cv.x = vel0.x; _cv.y = vel0.y; _cv.z = vel0.z;
    rk4Step(_cp, _cv, mid, munitionId, density, opts);
    const above = _cp.y - surfaceY(field, _cp.x, _cp.z, tAbs0+mid) - fuzeOffset;
    if(above > 0) lo = mid; else hi = mid;
  }
  _cp.x = pos0.x; _cp.y = pos0.y; _cp.z = pos0.z;
  _cv.x = vel0.x; _cv.y = vel0.y; _cv.z = vel0.z;
  rk4Step(_cp, _cv, hi, munitionId, density, opts);
  return { t: hi, pos:{x:_cp.x,y:_cp.y,z:_cp.z}, vel:{x:_cv.x,y:_cv.y,z:_cv.z} };
}

/* One full flight, from release to impact/airburst, at a fixed internal
   step. Used by solveRelease's trial trajectories and by ballisticRange
   — never by the per-frame game loop, which uses Store instead (same
   maths, but tracked incrementally so it can be drawn every frame). */
function simulateFlight(munitionId, pos0, vel0, density, field, timeAbs0, opts, guideTarget, turnRate){
  const m = munition(munitionId);
  const fuzeOffset = m.fuze === 'airburst' ? Math.max(0, m.burstAlt||0) : 0;
  const pos = {x:pos0.x,y:pos0.y,z:pos0.z}, vel = {x:vel0.x,y:vel0.y,z:vel0.z};
  let t = 0, timeAbs = timeAbs0;

  for(let i = 0; i < MAX_SOLVE_STEPS; i++){
    const above0 = pos.y - surfaceY(field, pos.x, pos.z, timeAbs) - fuzeOffset;

    if(guideTarget){
      const heightAbove = pos.y - surfaceY(field, guideTarget.x, guideTarget.z, timeAbs);
      const disc = Math.max(0, vel.y*vel.y + 2*G*Math.max(0, heightAbove));
      const tRem = Math.max(0.05, (-vel.y + Math.sqrt(disc))/G);
      const aimY = surfaceY(field, guideTarget.x, guideTarget.z, timeAbs+tRem);
      let dx = guideTarget.x-pos.x, dy = aimY-pos.y, dz = guideTarget.z-pos.z;
      const dlen = Math.hypot(dx,dy,dz);
      if(dlen > 1e-6) turnToward(vel, {x:dx/dlen,y:dy/dlen,z:dz/dlen}, (turnRate||0.5)*SOLVE_DT);
    }

    const p0 = {x:pos.x,y:pos.y,z:pos.z}, v0 = {x:vel.x,y:vel.y,z:vel.z};
    rk4Step(pos, vel, SOLVE_DT, munitionId, density, opts);
    t += SOLVE_DT; timeAbs += SOLVE_DT;
    if(!Number.isFinite(pos.x+pos.y+pos.z+vel.x+vel.y+vel.z)) return { pos:p0, vel:v0, t };

    const above1 = pos.y - surfaceY(field, pos.x, pos.z, timeAbs) - fuzeOffset;
    if(above0 > 0 && above1 <= 0){
      const cross = findCrossing(p0, v0, SOLVE_DT, munitionId, density, opts, field, timeAbs-SOLVE_DT, fuzeOffset);
      return { pos:cross.pos, vel:cross.vel, t: t-SOLVE_DT+cross.t };
    }
    if(t > MAX_FLIGHT_TIME) break;
  }
  return { pos, vel, t };   // gave up (e.g. a pathological field) — still finite, still terminates
}

/* ── the release solution ──────────────────────────────────────
   Drag has no closed form, so we iterate: release along the flight
   line at trial lead distance D, simulate the fall with drag, see how
   far it actually travelled, and use that as the next D. Because the
   horizontal deceleration only depends on fall time (not on where D
   puts the release point), this is a fixed point — D_{n+1} = traveled(D_n)
   — and it converges in a handful of iterations rather than needing a
   general root-finder. */
export function solveRelease({ target, releaseAlt, aircraftVel, munitionId, density = DEFAULT_DENSITY, field = null, timeNow = 0 }){
  const speed = Math.hypot(aircraftVel.x, aircraftVel.z);
  let dirX = 0, dirZ = 1;
  if(speed > 1e-6){ dirX = aircraftVel.x/speed; dirZ = aircraftVel.z/speed; }

  const sea0 = surfaceY(field, target.x, target.z, timeNow);
  let D = speed*Math.sqrt(2*Math.max(0.05, releaseAlt-sea0)/G);   // vacuum seed

  const m = munition(munitionId);
  // Fins are open for all but the first ~0.3s of an 8-11s fall, so
  // solving with them already deployed is the right steady-state model.
  const opts = { finsOpen:1, tumbling: !!m.tumbles, tumblePhase:0 };
  const guideTarget = m.guided ? { x:target.x, z:target.z } : null;

  let fallTime = 0, miss = Infinity, iterations = 0;
  let relPoint = { x:target.x-dirX*D, y:releaseAlt, z:target.z-dirZ*D };
  let relVel = { x:dirX*speed, y:0, z:dirZ*speed };

  for(; iterations < MAX_SOLVE_ITER; iterations++){
    relPoint.x = target.x - dirX*D; relPoint.z = target.z - dirZ*D;
    relVel.x = dirX*speed; relVel.z = dirZ*speed;
    const sim = simulateFlight(munitionId, relPoint, relVel, density, field, timeNow, opts, guideTarget, m.turnRate);
    fallTime = sim.t;
    miss = Math.hypot(sim.pos.x-target.x, sim.pos.z-target.z);
    if(!Number.isFinite(miss)) { miss = 9999; break; }
    if(miss < MISS_TOL) { iterations++; break; }
    const traveled = (sim.pos.x-relPoint.x)*dirX + (sim.pos.z-relPoint.z)*dirZ;
    if(!Number.isFinite(traveled) || traveled <= 0) break;
    D = traveled;
  }

  relPoint.x = target.x - dirX*D; relPoint.z = target.z - dirZ*D;
  relVel.x = dirX*speed; relVel.z = dirZ*speed;
  return {
    releasePoint: { x:relPoint.x, y:releaseAlt, z:relPoint.z },
    releaseVel: { x:relVel.x, y:0, z:relVel.z },
    fallTime, iterations, predictedMiss: Number.isFinite(miss) ? miss : 9999,
  };
}

/* Quick lookup/debug: flat-earth, no-wind range for a level release —
   how far a store travels before it would hit y=0. */
export function ballisticRange(munitionId, releaseAlt, speed, density = DEFAULT_DENSITY){
  const flat = { height: () => 0 };
  const m = munition(munitionId);
  const opts = { finsOpen:1, tumbling: !!m.tumbles, tumblePhase:0 };
  const sim = simulateFlight(munitionId, {x:0,y:releaseAlt,z:0}, {x:0,y:0,z:speed}, density, flat, 0, opts, null, 0);
  return Math.hypot(sim.pos.x, sim.pos.z);
}

/* ── a store in flight ──────────────────────────────────────────
   Tracked incrementally frame to frame (unlike simulateFlight, which
   runs a trial trajectory to completion in one call) so the model/vfx
   layer has somewhere to read pos/vel/finsOpen/tumblePhase every draw. */
export class Store {
  constructor({ munitionId, pos, vel, target = null, density = DEFAULT_DENSITY, field = null }){
    this.munitionId = munitionId;
    this.m = munition(munitionId);
    this.pos = { x:pos.x, y:pos.y, z:pos.z };
    this.vel = { x:vel.x, y:vel.y, z:vel.z };
    this.target = target ? { x:target.x, z:target.z } : null;
    this.density = (Number.isFinite(density) && density > 0) ? density : DEFAULT_DENSITY;
    this.field = field;
    this.age = 0;
    this.timeAbs = fieldTimeOf(field);
    this.finsOpen = 0;
    this.tumblePhase = 0;
    this.done = false;
    this.impact = null;
    this._opts = { finsOpen:0, tumbling: !!this.m.tumbles, tumblePhase:0 };
    this._fuzeOffset = this.m.fuze === 'airburst' ? Math.max(0, this.m.burstAlt||0) : 0;
  }

  update(dt){
    if(this.done || !(dt > 0) || !Number.isFinite(dt)) return;
    dt = Math.min(dt, 0.1);    // guard a hitch/tab-out from dumping a huge step in

    const subs = Math.min(MAX_SUBSTEPS_PER_CALL, Math.max(1, Math.ceil(dt/SUBSTEP_DT)));
    const h = dt/subs;
    const fuzeOffset = this._fuzeOffset;

    for(let i = 0; i < subs; i++){
      const above0 = this.pos.y - surfaceY(this.field, this.pos.x, this.pos.z, this.timeAbs) - fuzeOffset;

      if(this.m.guided && this.target) this._steer(h);

      const p0 = { x:this.pos.x, y:this.pos.y, z:this.pos.z };
      const v0 = { x:this.vel.x, y:this.vel.y, z:this.vel.z };
      this._opts.finsOpen = this.finsOpen;
      this._opts.tumblePhase = this.tumblePhase;
      rk4Step(this.pos, this.vel, h, this.munitionId, this.density, this._opts);
      this.age += h; this.timeAbs += h;
      this.finsOpen = Math.min(1, this.age*3.5);
      if(this.m.tumbles) this.tumblePhase += (3.0 + 0.01*Math.hypot(this.vel.x,this.vel.y,this.vel.z))*h;

      if(!Number.isFinite(this.pos.x+this.pos.y+this.pos.z+this.vel.x+this.vel.y+this.vel.z)){
        this.pos.x = p0.x; this.pos.y = p0.y; this.pos.z = p0.z;
        this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;
        this._finish(fuzeOffset > 0 ? 'airburst' : 'impact');
        return;
      }

      const above1 = this.pos.y - surfaceY(this.field, this.pos.x, this.pos.z, this.timeAbs) - fuzeOffset;
      if(above0 > 0 && above1 <= 0){
        const cross = findCrossing(p0, v0, h, this.munitionId, this.density, this._opts, this.field, this.timeAbs-h, fuzeOffset);
        this.pos.x = cross.pos.x; this.pos.y = cross.pos.y; this.pos.z = cross.pos.z;
        this.vel.x = cross.vel.x; this.vel.y = cross.vel.y; this.vel.z = cross.vel.z;
        this.timeAbs += cross.t-h; this.age += cross.t-h;
        this._finish(fuzeOffset > 0 ? 'airburst' : 'impact');
        return;
      }
      if(this.age > MAX_FLIGHT_TIME){ this._finish(fuzeOffset > 0 ? 'airburst' : 'impact'); return; }
    }
  }

  _steer(h){
    const heightAbove = this.pos.y - surfaceY(this.field, this.target.x, this.target.z, this.timeAbs);
    const disc = Math.max(0, this.vel.y*this.vel.y + 2*G*Math.max(0, heightAbove));
    const tRem = Math.max(0.05, (-this.vel.y + Math.sqrt(disc))/G);
    const aimY = surfaceY(this.field, this.target.x, this.target.z, this.timeAbs+tRem);
    let dx = this.target.x-this.pos.x, dy = aimY-this.pos.y, dz = this.target.z-this.pos.z;
    const dlen = Math.hypot(dx,dy,dz);
    if(dlen < 1e-6) return;
    turnToward(this.vel, { x:dx/dlen, y:dy/dlen, z:dz/dlen }, (this.m.turnRate||0.5)*h);
  }

  _finish(kind){
    const speed = Math.hypot(this.vel.x, this.vel.y, this.vel.z);
    const angleDeg = speed > 1e-6 ? Math.asin(clamp(-this.vel.y/speed, -1, 1))*180/Math.PI : 90;
    this.impact = {
      point: { x:this.pos.x, y:this.pos.y, z:this.pos.z },
      vel: { x:this.vel.x, y:this.vel.y, z:this.vel.z },
      speed, angleDeg, kind,
    };
    this.done = true;
  }
}
