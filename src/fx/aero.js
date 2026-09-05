import { munition } from './munitions.js';

/* ────────────────────────────────────────────────────────────────
   Aerodynamics: what makes a store's Cd and calibre in the registry
   actually matter, and what keeps the strike jet from just moving at
   a fixed scripted speed. Pure maths — plain numbers and {x,y,z}
   objects in, the same out, so it runs and is tested under node with
   no Three.js and no build step. trajectory.js and flyover.js are the
   only intended callers; this module owns no state about any one
   flight, only the physical constants and the per-store cache.

   These are the same public, order-of-magnitude figures a flight sim
   uses — mass, calibre, a drag coefficient, a wing area — nothing
   here describes how any store or aircraft is built or functions.
   ──────────────────────────────────────────────────────────────── */

export const AIR = { rho0: 1.225 };   // kg/m^3, sea-level reference
const G = 9.81;

// Sea-level speed of sound. Release altitudes here (350-700 m) don't move
// this enough to change the Mach numbers that matter for a drag-rise curve,
// so one constant stands in for a proper atmosphere lookup.
const SOUND_SPEED = 340;

function clamp(v, lo, hi){ return v < lo ? lo : v > hi ? hi : v; }
function safe(n, fallback = 0){ return Number.isFinite(n) ? n : fallback; }

// Shared by stores and the airframe: a subsonic body's Cd climbs sharply as
// shock-induced separation appears through M 0.8-1.1, then eases off a little
// once the flow is cleanly supersonic. None of these shapes are built for
// speed past that hump, so the curve is only ever asked to rise, in practice.
function transonicFactor(mach){
  if(!(mach > 0)) return 1;
  const t1 = clamp((mach - 0.78) / (1.05 - 0.78), 0, 1);
  const rise = t1*t1*(3 - 2*t1);
  const t2 = clamp((mach - 1.05) / (1.60 - 1.05), 0, 1);
  const relax = t2*t2*(3 - 2*t2);
  return 1 + 0.55*rise - 0.20*relax;
}

/* ── stores ──────────────────────────────────────────────────────── */

const _storeCache = new Map();

function computeStoreAero(id){
  const m = munition(id);
  const calibre = m.calibre > 0 ? m.calibre : 0.3;
  const length = m.length > 0 ? m.length : calibre*4;
  const mass = m.mass > 0 ? m.mass : 200;
  const Cd0 = m.Cd > 0 ? m.Cd : 0.5;

  const r = calibre*0.5;
  const area = Math.PI*r*r;                        // frontal area, nose-on — the Cd's reference area
  // Our own consistent m/(Cd*A) figure, not a ballistics-table BC (those are
  // unit- and reference-projectile-dependent) — bigger means drag has less
  // relative say over the trajectory, which is the only thing we use it for.
  const ballisticCoefficient = mass/(Cd0*area);

  // A finless body going end over end presents its long side to the airflow
  // for part of every tumble, not just its nose — model that as an area
  // multiplier on the same reference area, rather than inventing a second Cd.
  // sqrt() keeps a long thin canister from claiming an absurd multiplier just
  // because length >> calibre; real tumble drag is dominated by separation,
  // not by the flat-plate area ratio alone.
  const tumbles = !!m.tumbles;
  const sideArea = calibre*length;
  const tumbleMaxFactor = tumbles ? clamp(Math.sqrt(Math.max(1, sideArea/area)), 1, 3.5) : 1;
  const tumbleAvgFactor = 1 + (tumbleMaxFactor - 1)*0.5;   // sin^2 averages to 1/2 over a full tumble

  const finsDeploy = m.finsDeploy > 0 ? m.finsDeploy : 0;   // seconds from release to fins fully out

  const aero = {
    id, mass, area, Cd0, ballisticCoefficient,
    tumbles, tumbleMaxFactor, tumbleAvgFactor, finsDeploy,
    terminalV(density){
      const rho = density > 0 ? density : AIR.rho0;
      const factor = tumbles ? tumbleAvgFactor : 1;    // a tumbling body settles at its *average* drag
      return Math.sqrt((2*mass*G)/(rho*Cd0*area*factor));
    },
  };
  return aero;
}

/** Per-store aerodynamic constants, computed once per munition id and cached. */
export function storeAero(id){
  let a = _storeCache.get(id);
  if(!a){ a = computeStoreAero(id); _storeCache.set(id, a); }
  return a;
}

export function terminalVelocity(id, density){
  return storeAero(id).terminalV(density);
}

// Unmodelled rotational dynamics stand-in: roughly how fast a body this size
// tumbles once aerodynamic torque takes over from its release attitude. Not a
// measured rate — it only has to look and drag right, not integrate torque.
const TUMBLE_RATE = 2*Math.PI*1.3;      // rad/s
const FIN_STOWED_FACTOR = 0.55;         // folded-fin drag as a fraction of the deployed Cd

/**
 * Drag-only acceleration on a falling store, in world units, written into
 * `out` (or a fresh {x,y,z} if omitted) so the per-frame hot path never
 * allocates. `opts` may carry:
 *   age        - seconds since release; drives the fin-deployment ramp and,
 *                absent tumblePhase, the tumble cycle
 *   finsOpen   - 0..1, overrides the age-based ramp (e.g. to stay in sync
 *                with the same value driving the visual fins)
 *   tumblePhase- radians, overrides the age-based tumble cycle
 * No opts, or missing fields, still returns a sane, non-NaN value.
 */
export function dragAccel(id, vel, density, opts, out){
  out = out || { x: 0, y: 0, z: 0 };
  const vx = safe(vel && vel.x), vy = safe(vel && vel.y), vz = safe(vel && vel.z);
  const speed = Math.sqrt(vx*vx + vy*vy + vz*vz);
  if(!(speed > 1e-6)){ out.x = 0; out.y = 0; out.z = 0; return out; }

  const aero = storeAero(id);
  const rho = density > 0 ? density : AIR.rho0;

  let areaFactor = 1;
  if(aero.tumbles){
    let phase = null;
    if(opts && Number.isFinite(opts.tumblePhase)) phase = opts.tumblePhase;
    else if(opts && Number.isFinite(opts.age)) phase = opts.age*TUMBLE_RATE;
    if(phase == null) areaFactor = aero.tumbleAvgFactor;   // no timing info: assume steady-state average
    else { const s = Math.sin(phase); areaFactor = 1 + (aero.tumbleMaxFactor - 1)*s*s; }
  }

  let finFactor = 1;
  if(aero.finsDeploy > 0){
    let finsOpen;
    if(opts && Number.isFinite(opts.finsOpen)) finsOpen = clamp(opts.finsOpen, 0, 1);
    else if(opts && Number.isFinite(opts.age)) finsOpen = clamp(opts.age/aero.finsDeploy, 0, 1);
    else finsOpen = 1;                                     // no timing info: assume deployed, the steady state
    finFactor = FIN_STOWED_FACTOR + (1 - FIN_STOWED_FACTOR)*finsOpen;
  }

  const mach = speed/SOUND_SPEED;
  const CdA = aero.Cd0*aero.area*areaFactor*finFactor*transonicFactor(mach);
  const k = 0.5*rho*CdA*speed/aero.mass;    // |accel| = 1/2 rho Cd A v^2 / m, direction opposes velocity
  out.x = -k*vx; out.y = -k*vy; out.z = -k*vz;
  if(!Number.isFinite(out.x + out.y + out.z)){ out.x = 0; out.y = 0; out.z = 0; }
  return out;
}

/* No Magnus term: none of these stores are spin-stabilised. The tumbling
   canister rotates end over end (captured above), not about its long axis,
   so there's no coherent spin axis for a Magnus force to act about — adding
   one would just be an unearned wobble, not a real effect. */

/* ── aircraft ────────────────────────────────────────────────────── */

// Public order-of-magnitude figures for a clean two-engine strike fighter —
// not this game's specific jet's measured polar, just enough shape that a
// hard turn costs speed and dropping stores earns some back.
export const AIRCRAFT = {
  emptyMass: 10800,     // kg
  wingArea: 37.2,       // m^2
  aspectRatio: 3.5,     // low-AR fighter planform
  oswaldE: 0.68,
  Cd0: 0.022,           // clean parasitic drag coefficient
  Cd0PerStore: 0.006,   // parasitic drag "count" added per external store carried
  thrustMil: 98000,     // N, both engines, dry
  thrustAB: 156000,     // N, both engines, full afterburner
};

/** Parasitic + induced drag on the aircraft, in newtons. */
export function aircraftDrag({ speed, density, bank, loadFactor, storesMass, storesCount, mass: totalMass }){
  const v = Math.max(0, safe(speed));
  const rho = density > 0 ? density : AIR.rho0;
  // Live aircraft pass wet mass; scripted flyovers retain the dry-mass fallback.
  const mass = totalMass > 0 ? totalMass : AIRCRAFT.emptyMass + Math.max(0, safe(storesMass));
  // A load factor may be given directly (e.g. from a scripted manoeuvre); a
  // bank angle implies the coordinated-turn value 1/cos(bank). Cap near 90°
  // so a vertical bank can't demand infinite lift.
  const n = clamp(
    Number.isFinite(loadFactor) && loadFactor > 0
      ? loadFactor
      : 1/Math.max(0.09, Math.cos(clamp(safe(bank), -1.48, 1.48))),
    0, 9);

  const q = 0.5*rho*v*v;
  const mach = v/SOUND_SPEED;
  const count = Math.max(0, safe(storesCount));
  const Cd0 = AIRCRAFT.Cd0 + count*AIRCRAFT.Cd0PerStore;
  const parasitic = safe(Cd0*q*AIRCRAFT.wingArea*transonicFactor(mach));

  // Induced drag from the lift the turn demands: Cl^2/(pi e AR) is the
  // standard parabolic-polar term, and it's this — not parasitic drag —
  // that makes a hard bank cost real speed.
  const weight = mass*G*n;
  const cl = q > 1 ? clamp(weight/(q*AIRCRAFT.wingArea), 0, 3) : 0;
  const induced = safe((cl*cl)/(Math.PI*AIRCRAFT.oswaldE*AIRCRAFT.aspectRatio)*q*AIRCRAFT.wingArea);

  return { parasitic, induced, total: parasitic + induced };
}

/** Net acceleration along the flight path from thrust and drag alone. */
export function aircraftAccel({ thrust, dragTotal, mass }){
  const m = safe(mass) > 1 ? mass : AIRCRAFT.emptyMass;
  const a = (safe(thrust) - safe(dragTotal))/m;
  return Number.isFinite(a) ? a : 0;
}
