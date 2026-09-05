import * as THREE from 'three';
import { aircraftDrag, AIRCRAFT, AIR } from './aero.js';
import { buildF18 } from './f18.js';
import { munition, LOADOUTS } from './munitions.js';

/* ────────────────────────────────────────────────────────────────
   A human-flyable strike jet. Where boats.js gives a hull forces,
   torques and an inertia tensor and lets Newton do the rest, this
   gives the same treatment to a fighter: 6-DOF rigid body, a lift
   curve that actually stalls, and stability/damping derivatives
   instead of a scripted flight path. flyover.js is the AI half of
   this aircraft (a path the numbers are bent to fit); this is the
   real thing, flown by inputs alone.

   Forces are resolved in the wind frame and simply projected onto
   the aircraft's own up/right/forward axes — thrust along the nose,
   lift along "up" tilted by bank (which is *why* banking turns you,
   with no separate turn-rate formula needed), drag straight back
   along the true airspeed vector, weight straight down. Moments are
   the classical nondimensional stability-derivative sum (Cm/Cl/Cn
   from alpha, beta, body rates and control deflection) rather than
   forces applied at an offset — cheaper, and it's what actually
   lets the damping and stability terms be tuned independently.

   aero.js owns the drag polar and the thrust figures; this module
   never recomputes parasitic/induced drag itself, only the things
   aero.js doesn't model — real lift (so alpha can stall), sideforce,
   moments, fuel, and the instruments.
   ──────────────────────────────────────────────────────────────── */

const G = 9.81;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function safe(n, fallback = 0){ return Number.isFinite(n) ? n : fallback; }

/* ── wing lift curve ─────────────────────────────────────────────
   Linear region up to stall, matching a thin swept-wing fighter's
   lift-curve slope; past it, lift collapses exponentially toward a
   lower separated-flow plateau rather than to zero — a real stalled
   wing (or a fin in a spin) still makes *some* lift, which is why
   recovery is a matter of un-stalling it, not restarting from scratch. */
const CL_ALPHA = 5.0;           // per rad — includes the LERX's vortex-lift boost
const ALPHA0 = -0.02;           // rad, zero-lift angle from wing camber
const ALPHA_STALL = 0.27;       // ~15.5°, where attached flow breaks down
const CL_MAX = CL_ALPHA * (ALPHA_STALL - ALPHA0);
const CL_DEEP = 0.55;           // residual lift of fully separated flow
const STALL_WIDTH = 0.22;       // rad, how fast lift falls once it breaks
const CY_BETA = -0.6;           // sideforce opposing sideslip
const CD_BETA = 0.25;           // parasitic drag a slipping fuselage adds
const STALL_CD = 0.9;           // extra separated-flow drag once well past the break
const G_LIMIT = 7.6;            // structural/FBW load-factor limiter, either sign

function liftCoeff(alpha){
  const a = alpha - ALPHA0;
  const aAbs = Math.abs(a);
  const sign = a < 0 ? -1 : 1;
  if(aAbs <= ALPHA_STALL) return CL_ALPHA * a;
  const over = aAbs - ALPHA_STALL;
  const collapse = Math.exp(-over / STALL_WIDTH);   // 1 at the break, ->0 deep into it
  return sign * (CL_MAX * collapse + CL_DEEP * (1 - collapse));
}

/* ── stability & control derivatives (nondimensional) ────────────
   Body axes throughout: pitch about X, yaw about Y, roll about Z
   (nose +Z, up +Y, right wing +X — same convention as f18.js and
   boats.js's inertia comment). Signs are derived from that axis
   convention, not copied off a textbook page written in a different
   one: a positive rotation about +X tips the nose down, about +Y
   swings it right, about +Z rolls the right wing up. */
// Magnitudes are picked against this airframe's actual q*S*(c or b)/I, not
// lifted off a textbook table for a different aircraft — full aft stick is
// tuned to trim toward a stalled alpha (~25-30deg) rather than looping the
// jet, and full aileron/rudder toward peak rates a real fighter would show
// (roll ~300deg/s, rudder much weaker than either).
const CM_ALPHA = 0.85;   // positive: nose-up alpha -> nose-down moment (restoring)
// Fixed tail/stabilator incidence, rigged for cruise — without it Cpitch=0
// only at alpha=0, so a hands-off jet would "chase" zero AoA (pitching down
// to track whatever shallow dive it's already in) instead of holding the
// small positive AoA that actually balances lift against weight. Real
// aircraft trim exactly this way: a fixed surface bias that only zeroes the
// moment at some alpha other than zero. Because q*S*chord factors out of
// the whole Cpitch sum, this trim alpha (-CM0/CM_ALPHA) is independent of
// airspeed, same as the real thing.
const CM0 = -0.033;
const CM_Q = -14;        // pitch-rate damping
const CM_DE = -0.40;     // elevator: +pitch input -> nose up
const CL_BETA = -0.10;   // dihedral effect: restoring roll from sideslip
const CL_P = -0.4;       // roll-rate damping
const CL_DA = -0.07;     // aileron: +roll input -> right wing down
const CN_BETA = 0.10;    // weathervane: restoring yaw from sideslip
const CN_R = -0.18;      // yaw-rate damping
const CN_DR = 0.035;     // rudder: +yaw input -> nose right
// Stalled-and-rolling is how a departure turns into an autorotating spin:
// pitch stability fades near the stall break (the real CP-shift/LERX-burst
// mechanism, simplified to one knob), and a roll rate while stalled feeds
// straight into yaw — the coupling that keeps a spin spinning. Reducing
// alpha (unstalling) kills both terms, which is also the real recovery.
const STALL_CM_FADE = 0.9;
const STALL_YAW_COUPLE = 0.35;

/* ── engine & fuel ───────────────────────────────────────────────
   Fuel flow is charged against the thrust actually delivered this
   frame (so density/throttle/afterburner are all "free" — whatever
   already derated thrust also derates the flow), plus a small idle
   flow so the engines cost something even at flight idle. */
const FUEL_CAPACITY = 4900;        // kg, internal fuel for a jet this size
const SFC_MIL = 1.02e-5;           // kg fuel per newton per second, dry power
const SFC_AB = 2.55e-5;            // afterburner: ~2.5x the fuel per newton of dry thrust
const IDLE_FLOW = 0.04;            // kg/s, engines turning even at zero throttle
const THRUST_DENSITY_EXP = 0.75;   // thrust falls off faster than density itself (mass-flow limited)
const THRUST_RAM_GAIN = 0.08;      // small inlet ram-recovery bonus with airspeed

const AIRBRAKE_CDA = 1.2;          // m^2, flat-plate-equivalent speedbrake drag area
const MAX_ANGVEL = 8.0;            // rad/s, generous enough for a snap roll without blowing up

/* ── standard atmosphere, inverted for the altimeter ─────────────
   The altimeter only ever sees pressure — it has no idea what the
   true air density or true altitude are. It converts the pressure
   it reads into an altitude by assuming standard lapse from whatever
   sea-level pressure the pilot last dialled in. If that number goes
   stale (a front moves through) the dial is wrong and nothing says so. */
const ISA_T0 = 288.15, ISA_L = 0.0065, ISA_R = 287.05, ISA_G0 = 9.80665;
const ISA_EXP = ISA_G0 / (ISA_L * ISA_R);

function pressureAtAltitude(seaLevelHpa, altM){
  const base = 1 - (ISA_L * altM) / ISA_T0;
  return seaLevelHpa * Math.pow(Math.max(1e-6, base), ISA_EXP);
}
function altitudeFromPressure(seaLevelHpa, pHpa){
  const ratio = clamp(pHpa / Math.max(1e-6, seaLevelHpa), 1e-6, 2);
  return (ISA_T0 / ISA_L) * (1 - Math.pow(ratio, 1 / ISA_EXP));
}

export class Aircraft {
  constructor(scene, opts = {}){
    this.scene = scene;
    this.atmosphere = opts.atmosphere || null;
    this.weather = opts.weather || null;
    this.field = opts.field || null;

    const built = buildF18();
    this.craft = built;
    this.group = built.group;
    this.pylons = built.pylons;
    scene.add(this.group);

    // state — same shape as Ship: world-frame position/orientation,
    // world-frame linear and angular velocity
    this.pos = new THREE.Vector3(opts.pos?.x || 0, opts.pos?.y ?? 500, opts.pos?.z || 0);
    this.heading = opts.heading || 0;
    this.quat = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.heading);
    this.vel = new THREE.Vector3(
      Math.sin(this.heading) * (opts.speed ?? 180), 0, Math.cos(this.heading) * (opts.speed ?? 180));
    this.angVel = new THREE.Vector3();

    // inertia: same equivalent-box approximation Ship uses, sized off the
    // jet's own built geometry rather than a second set of guessed figures
    const L = built.length, B = built.span, H = 2.0;   // H: fuselage+fin depth, not modelled elsewhere
    this.emptyMass = AIRCRAFT.emptyMass;
    this.I = new THREE.Vector3(
      this.emptyMass / 12 * (H * H + L * L),   // pitch, about X
      this.emptyMass / 12 * (B * B + L * L),   // yaw, about Y
      this.emptyMass / 12 * (B * B + H * H));  // roll, about Z
    this.chord = AIRCRAFT.wingArea / B;
    this.span = B;

    // fuel & stores
    this.fuel = opts.fuel ?? FUEL_CAPACITY;
    this.fuelCapacity = FUEL_CAPACITY;
    const loadout = Array.isArray(opts.loadout) ? opts.loadout.slice()
      : (LOADOUTS[opts.loadout] || LOADOUTS.he).slice();
    this._remaining = loadout;
    this._releaseIndex = 0;
    this.storesCount = this._remaining.length;
    this.storesMass = this._remaining.reduce((m, id) => m + munition(id).mass, 0);
    this.mass = this.emptyMass + this.fuel + this.storesMass;

    // flight state exposed to callers
    this.alpha = 0; this.beta = 0;
    this.loadFactor = 1;
    this.stalled = false;
    this.crashed = false;
    this.trueAltitude = this.pos.y;
    this.trueAirspeed = this.vel.length();
    this.groundSpeed = this.vel.length();
    this.fuelFlowKgS = 0;

    // altimeter datum: whatever the local sea-level pressure was when the
    // pilot last set it. Defaults to "set correctly at takeoff"; a front
    // passing afterward is what makes it go wrong, on purpose.
    this._altimeterDatum = this.atmosphere?.pressure ?? 1013.25;

    this.instruments = {
      altitude: this.trueAltitude, indicatedAirspeed: 0, heading: this.heading * THREE.MathUtils.RAD2DEG,
      vsi: 0, fuel: this.fuel, g: 1, aoa: 0,
    };
    this._vsiSmoothed = 0;

    // scratch — allocated once, mutated every frame, never reallocated
    this._fwd = new THREE.Vector3(); this._up = new THREE.Vector3(); this._right = new THREE.Vector3();
    this._wind = new THREE.Vector3(); this._vAir = new THREE.Vector3();
    this._vBody = new THREE.Vector3(); this._angVelBody = new THREE.Vector3();
    this._invQ = new THREE.Quaternion(); this._dq = new THREE.Quaternion(); this._axis = new THREE.Vector3();
    this._force = new THREE.Vector3(); this._torqueBody = new THREE.Vector3();
    this._fieldSample = {};
    this._relPos = new THREE.Vector3();
    this._surfaces = { aileron: 0, elevator: 0, rudder: 0 };
  }

  /* Pilot action: dial the altimeter to a known pressure (field elevation
     QNH, typically). Everything else about the reading follows from this
     going stale or not. */
  setAltimeterDatum(hPa){ if(Number.isFinite(hPa) && hPa > 500) this._altimeterDatum = hPa; }

  /* Drop the next store in the loadout order, off the next pylon in turn.
     Returns plain {x,y,z} objects (matching aero.js's own convention) so
     whatever simulates the falling munition has no THREE dependency of
     its own. Mass leaves the airframe immediately — a clean jet handles
     differently from the moment of release, not after some fade. */
  release(){
    if(!this._remaining.length) return null;
    const id = this._remaining.shift();
    this.storesMass -= munition(id).mass;
    this.storesCount = this._remaining.length;
    this.group.updateMatrixWorld(true);
    const anchor = this.pylons[this._releaseIndex % Math.max(1, this.pylons.length)];
    this._releaseIndex++;
    anchor.getWorldPosition(this._relPos);
    return {
      munitionId: id,
      pos: { x: this._relPos.x, y: this._relPos.y, z: this._relPos.z },
      vel: { x: this.vel.x, y: this.vel.y, z: this.vel.z },
    };
  }

  /* One physics substep, fixed h. Everything below is force/moment
     accumulation followed by a single semi-implicit integration step,
     same shape as Ship.step(). */
  step(h, controls){
    const density = this.atmosphere?.density ?? AIR.rho0;
    const soundSpeed = this.atmosphere?.speedOfSound ?? 340;

    // airmass motion: wind is not a force on the jet, it's the medium the
    // jet's own aerodynamics are computed relative to. Groundspeed (vel)
    // and airspeed (vel - wind) are different vectors from here on down.
    const w = this.weather;
    let windX = 0, windZ = 0;
    if(w){
      const spd = (w.windSpeed || 0) + (w.gust || 0);
      windX = Math.cos(w.windDir || 0) * spd;
      windZ = Math.sin(w.windDir || 0) * spd;
    }
    this._wind.set(windX, 0, windZ);
    this._vAir.copy(this.vel).sub(this._wind);
    const trueAirspeed = this._vAir.length();
    this.trueAirspeed = trueAirspeed;
    this.groundSpeed = this.vel.length();

    this._invQ.copy(this.quat).invert();
    this._fwd.set(0, 0, 1).applyQuaternion(this.quat);
    this._up.set(0, 1, 0).applyQuaternion(this.quat);
    this._right.set(1, 0, 0).applyQuaternion(this.quat);

    let alpha = 0, beta = 0;
    const q = 0.5 * density * trueAirspeed * trueAirspeed;
    const mach = trueAirspeed / soundSpeed;
    const Vnorm = Math.max(trueAirspeed, 8);   // floor only for rate nondimensionalisation, never for q

    if(trueAirspeed > 1e-3){
      this._vBody.copy(this._vAir).applyQuaternion(this._invQ);
      alpha = Math.atan2(-this._vBody.y, this._vBody.z);
      beta = Math.asin(clamp(this._vBody.x / trueAirspeed, -1, 1));
    }
    this.alpha = alpha; this.beta = beta;
    this.stalled = Math.abs(alpha - ALPHA0) > ALPHA_STALL;
    const stallProgress = clamp((Math.abs(alpha - ALPHA0) - ALPHA_STALL) / 0.3, 0, 1);

    // ── thrust ───────────────────────────────────────────────────
    const throttle = clamp(safe(controls?.throttle), 0, 1);
    const burner = clamp(safe(controls?.burner), 0, 1);
    const densityFactor = Math.pow(clamp(density / AIR.rho0, 0.05, 1.3), THRUST_DENSITY_EXP);
    const thrustFactor = densityFactor * (1 + THRUST_RAM_GAIN * Math.min(1.2, mach));
    const fuelOk = this.fuel > 0 ? 1 : 0;
    const milThrust = AIRCRAFT.thrustMil * throttle * thrustFactor * fuelOk;
    const abThrust = (AIRCRAFT.thrustAB - AIRCRAFT.thrustMil) * burner * throttle * thrustFactor * fuelOk;
    const thrust = milThrust + abThrust;

    this.fuelFlowKgS = fuelOk * (IDLE_FLOW + milThrust * SFC_MIL + abThrust * SFC_AB);
    this.fuel = Math.max(0, this.fuel - this.fuelFlowKgS * h);
    this.mass = this.emptyMass + this.fuel + this.storesMass;

    // ── lift, side force, drag ──────────────────────────────────
    const S = AIRCRAFT.wingArea;
    let CL = liftCoeff(alpha);
    let Lmag = q * S * CL;
    // structural/FBW load-factor limiter: the jet simply won't give the
    // pilot more stick authority than the airframe (or the pilot) can take
    const nRaw = Lmag / (this.mass * G);
    if(Math.abs(nRaw) > G_LIMIT) Lmag = Math.sign(Lmag) * G_LIMIT * this.mass * G;
    const n = Lmag / (this.mass * G);
    this.loadFactor = n;

    const Ymag = q * S * CY_BETA * beta;

    // aero.js owns the parasitic+induced polar; loadFactor here is always
    // fed as a positive magnitude because aircraftDrag() falls back to a
    // bank-angle guess for any non-positive value, and induced drag only
    // ever cares about the magnitude of the lift being generated.
    const drag = aircraftDrag({
      speed: trueAirspeed, density, loadFactor: Math.max(0.05, Math.abs(n)),
      storesMass: this.storesMass, storesCount: this.storesCount,
    });
    // additions aero.js doesn't model: a slipping fuselage, a stalled
    // wing's separated-flow drag rise, and the speedbrake
    const airbrake = clamp(safe(controls?.airbrake), 0, 1);
    const extraDrag = q * S * CD_BETA * beta * beta
      + q * S * STALL_CD * stallProgress
      + q * AIRBRAKE_CDA * airbrake;
    const Dmag = drag.total + extraDrag;

    this._force.set(0, -this.mass * G, 0);                       // weight
    this._force.addScaledVector(this._fwd, thrust);               // thrust, along the nose
    this._force.addScaledVector(this._up, Lmag);                  // lift, along body "up" tilted by bank
    this._force.addScaledVector(this._right, Ymag);               // sideforce
    if(trueAirspeed > 1e-3) this._force.addScaledVector(this._vAir, -Dmag / trueAirspeed);  // drag, opposing true airspeed

    this.vel.addScaledVector(this._force, h / this.mass);

    // ── moments: classical nondimensional stability-derivative sum ──
    this._angVelBody.copy(this.angVel).applyQuaternion(this._invQ);
    const qhat = this._angVelBody.x * this.chord / (2 * Vnorm);
    const phat = this._angVelBody.z * this.span / (2 * Vnorm);
    const rhat = this._angVelBody.y * this.span / (2 * Vnorm);

    const pitchCtrl = clamp(safe(controls?.pitch), -1, 1);
    const rollCtrl = clamp(safe(controls?.roll), -1, 1);
    const yawCtrl = clamp(safe(controls?.yaw), -1, 1);

    const cmAlphaEff = CM_ALPHA * (1 - STALL_CM_FADE * stallProgress);
    const Cpitch = CM0 + cmAlphaEff * alpha + CM_Q * qhat + CM_DE * pitchCtrl;
    const Croll = CL_BETA * beta + CL_P * phat + CL_DA * rollCtrl;
    const Cyaw = CN_BETA * beta + CN_R * rhat + CN_DR * yawCtrl + STALL_YAW_COUPLE * stallProgress * phat;

    this._torqueBody.set(q * S * this.chord * Cpitch, q * S * this.span * Cyaw, q * S * this.span * Croll);
    this._torqueBody.x /= this.I.x; this._torqueBody.y /= this.I.y; this._torqueBody.z /= this.I.z;
    this._torqueBody.applyQuaternion(this.quat);
    this.angVel.addScaledVector(this._torqueBody, h);
    if(this.angVel.length() > MAX_ANGVEL) this.angVel.setLength(MAX_ANGVEL);

    // ── trap non-finite state before it poisons the transform ──
    if(!Number.isFinite(this.vel.x + this.vel.y + this.vel.z + this.angVel.x + this.angVel.y + this.angVel.z)){
      this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
      if(!Number.isFinite(this.pos.x + this.pos.y + this.pos.z)) this.pos.set(0, 500, 0);
      this.quat.setFromAxisAngle(this._axis.set(0, 1, 0), this.heading);
      return;
    }

    this.pos.addScaledVector(this.vel, h);
    const wl = this.angVel.length();
    if(wl > 1e-6){
      this._axis.copy(this.angVel).divideScalar(wl);
      this._dq.setFromAxisAngle(this._axis, wl * h);
      this.quat.premultiply(this._dq).normalize();
    }

    // ── sea collision ────────────────────────────────────────────
    let seaY = 0;
    if(this.field && typeof this.field.sample === 'function'){
      this.field.sample(this.pos.x, this.pos.z, this._fieldSample);
      if(Number.isFinite(this._fieldSample.y)) seaY = this._fieldSample.y;
    } else if(this.field && typeof this.field.height === 'function'){
      seaY = this.field.height(this.pos.x, this.pos.z);
    }
    if(this.pos.y <= seaY){
      this.pos.y = seaY;
      this.vel.set(0, 0, 0); this.angVel.set(0, 0, 0);
      this.crashed = true;
    }
  }

  update(dt, controls = {}){
    if(!(dt > 0) || !Number.isFinite(dt)) return;
    dt = Math.min(dt, 0.25);
    if(this.crashed){ this._sync(); return; }

    // Substep at up to 240Hz — a fighter's rates and closure speeds eat a
    // single frame's worth of Euler error far faster than a hull does, so
    // this targets a tighter step than Ship's, still capped for a huge dt.
    const sub = Math.min(16, Math.max(1, Math.ceil(dt * 240)));
    const h = dt / sub;
    for(let i = 0; i < sub && !this.crashed; i++) this.step(h, controls);

    this._sync();
    this._updateInstruments(dt, controls);

    this.craft.setBurner?.(clamp(safe(controls?.burner) * (controls?.throttle > 0.98 ? 1 : 0), 0, 1));
    this._surfaces.aileron = clamp(safe(controls?.roll), -1, 1);
    this._surfaces.elevator = clamp(safe(controls?.pitch), -1, 1);
    this._surfaces.rudder = clamp(safe(controls?.yaw), -1, 1);
    this.craft.setSurfaces?.(this._surfaces);
  }

  _sync(){
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
    this.trueAltitude = this.pos.y;
  }

  _updateInstruments(dt, controls){
    const atm = this.atmosphere;
    const seaLevelNow = atm?.pressure ?? 1013.25;
    const density = atm?.density ?? AIR.rho0;

    // barometric altimeter: true station pressure at the true altitude,
    // read back out against the pilot's (possibly stale) datum. If the
    // datum still equals the current sea-level pressure this reproduces
    // the true altitude exactly; once they diverge, so does the dial —
    // with nothing else in the cockpit able to tell the pilot why.
    const trueAlt = Math.max(0, this.trueAltitude);
    const stationP = pressureAtAltitude(seaLevelNow, trueAlt);
    const indicatedAlt = altitudeFromPressure(this._altimeterDatum, stationP);

    // indicated airspeed: what dynamic pressure the pitot-static system
    // reports, read as if the air were sea-level standard density — the
    // classic IAS/TAS split, and exactly why thin high-altitude air makes
    // the ASI under-read the speed the jet is actually making through it.
    const ias = this.trueAirspeed * Math.sqrt(density / AIR.rho0);

    const tau = 1.5;   // VSI diaphragm lag — an instantaneous vel.y reads as a twitchy needle otherwise
    const k = 1 - Math.exp(-dt / tau);
    this._vsiSmoothed += (this.vel.y - this._vsiSmoothed) * k;

    const ins = this.instruments;
    ins.altitude = indicatedAlt;
    ins.indicatedAirspeed = ias;
    ins.heading = ((Math.atan2(this._fwd.x, this._fwd.z) * THREE.MathUtils.RAD2DEG) % 360 + 360) % 360;
    ins.vsi = this._vsiSmoothed;
    ins.fuel = this.fuel;
    ins.g = this.loadFactor;
    ins.aoa = this.alpha * THREE.MathUtils.RAD2DEG;
  }

  dispose(){
    this.scene.remove(this.group);
    this.craft.dispose?.();
  }
}
