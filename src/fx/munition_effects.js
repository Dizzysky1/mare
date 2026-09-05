/* ────────────────────────────────────────────────────────────────
   What the hazards actually do to you.

   `munition_vfx.js` draws the fire and the cloud; `strikes.js` decides
   where they are and how long they last. This module is the third leg:
   given the same hazard list, it works out what the person standing in
   the middle of it is being subjected to, and hands the result to the
   survival, cardiovascular and visual models.

   Two different exposure problems, and they are genuinely different —
   which is the point of carrying two kinds of store:

   FIRE is a radiation problem. It hurts you at a distance, instantly,
   through line of sight, and the injury is cumulative and permanent.
   You escape it by putting distance between you and it, and distance
   works fast because the flux falls off as 1/d². Modelled with the
   standard point-source radiation model and the thermal dose unit used
   in fire-safety engineering — ordinary published fire science.

   THE CLOUD is a dispersion problem. It is nearly harmless for the
   first breath and dangerous for the twentieth, it goes where the wind
   goes, it dilutes as it grows, and it is thickest at the surface. You
   escape it by getting upwind, getting high, or not breathing. The
   dispersion here is real Gaussian-puff meteorology; the agent itself
   is invented and its dose thresholds are tuned for the game. Nothing
   in this file describes a real substance, a real composition, or any
   real-world procedure — it is a volume of map you cannot stand in.
   ──────────────────────────────────────────────────────────────── */

const clamp = (x, a, b) => x < a ? a : x > b ? b : x;
const smooth01 = x => { x = clamp(x, 0, 1); return x*x*(3-2*x); };

/* ── fire: the radiating pool ──────────────────────────────────
   Point-source model, the workhorse of fire-safety practice:

       q" = χ · Q̇ / (4π d²)          [kW/m²]

   with the fire's total heat release rate from the pool area,

       Q̇ = ṁ" · ΔHc · A             [kW]

   ṁ" ≈ 0.055 kg/m²·s and ΔHc ≈ 43 MJ/kg are the usual coarse figures
   for a large hydrocarbon pool. χ is the radiative fraction: about 0.30
   for a small clean flame, but large-diameter pools shroud themselves in
   soot and radiate a smaller share of their output, so it falls with
   size. That soot blockage is why a big fire is not as much worse than a
   medium one as the area alone would suggest. */
const BURN_RATE   = 0.055;    // kg/m²·s
const HEAT_OF_COMB = 43000;   // kJ/kg
const FLUX_CEIL   = 120;      // kW/m², ~the emissive power of a luminous flame front

function radiativeFraction(diameter){
  // 0.30 small, tailing to ~0.17 for a wide, soot-blocked pool
  return 0.17 + 0.13*Math.exp(-diameter/22);
}

/* Thermal dose unit: TDU = ∫ q"^(4/3) dt, (kW/m²)^4/3 · s. The 4/3
   exponent is the empirical skin-injury relation behind the standard
   probit. Landmarks used below:
       ~130   threshold of pain
       ~260   first-degree burn
       ~1000  "dangerous dose" — significant injury, ~1% fatal
       ~2000  around half of an exposed population does not survive   */
const TDU_PAIN = 130;
const TDU_LD50 = 2000;

/* Severity in [0,1] from accumulated dose, 0 at the pain threshold and
   1 at the LD50. Health is spent against the *increase* in this, so the
   mapping is monotonic and a given total dose always costs the same
   whether you took it in one rush or three passes. */
function burnSeverity(tdu){
  return clamp((tdu - TDU_PAIN)/(TDU_LD50 - TDU_PAIN), 0, 1);
}

/* ── the cloud: a drifting puff ────────────────────────────
   Mass-conserving Gaussian puff. The released mass is fixed, so as the
   puff grows its peak concentration falls as 1/(σh²σz) — which is why
   running through a fresh cloud is far worse than sitting in an old one,
   and why the cloud getting visually bigger is the cloud getting weaker.

   The width is deliberately slaved to the SAME growth curve HazardFX
   draws with, rather than to a free-running Pasquill-Gifford sigma. Left
   to itself the dispersion physics gives a dangerous core only ten or
   fifteen metres across inside a sixty-metre painted cloud, and the
   player would be standing in obvious billowing smoke taking no dose at
   all. The drawn cloud is the promise; this keeps the simulation to it.
   Realism is preserved where it decides outcomes — conserved mass, the
   1/σ³ dilution, a flat surface-hugging shape, and the slow lift — and
   bent only on the one number that has to agree with the picture.

   Horizontal and vertical spread stay separate. A dense release that
   starts at the surface spreads sideways far faster than it spreads up,
   and that anisotropy is the whole reason height is a defence. */
const SIGMA_Z_RATIO = 0.30;   // σz as a fraction of σh — a flat, spreading pancake
const SIGMA_Z_MIN   = 2.5;    // m
const GROW_LATE     = 0.22;   // m/s of continued spread after it has filled out
/* The canister empties over a few seconds rather than all at once, so the
   airborne mass ramps in. Without this the puff is at its most
   concentrated in the instant it opens and the entire encounter is
   decided before the player can react to a cloud that is not yet drawn. */
const RELEASE_S     = 6;

/* HazardFX fills the drawn radius over its first 20 s, starting at a
   quarter of it. σh is set so that ~2σ lands on that drawn edge: what
   looks like the cloud is what doses you. */
function puffSigmaH(h){
  const R = Math.max(4, h.radius || 58);
  const grown = Math.min(1, h.age/20);
  const drawn = R*(0.25 + 0.75*grown);
  return drawn*0.5 + GROW_LATE*Math.max(0, h.age - 20);
}

/* Concentration is reported in units of "the middle of a puff ten
   seconds after it opens" — a realistic moment to be caught by one.
   Everything downstream is calibrated against that reference rather than
   any physical measure, because the agent is invented. */
const CONC_REF_T = 10;
function puffPeak(h){
  const shRef = puffSigmaH({ radius:h.radius, age:CONC_REF_T });
  const szRef = Math.max(SIGMA_Z_MIN, shRef*SIGMA_Z_RATIO);
  const sh = puffSigmaH(h);
  const sz = Math.max(SIGMA_Z_MIN, sh*SIGMA_Z_RATIO);
  const airborne = Math.min(1, h.age/RELEASE_S);   // mass released so far
  return airborne*(shRef*shRef*szRef)/(sh*sh*sz);
}

function puffConcentration(h, dx, dy, dz){
  const sh = puffSigmaH(h);
  const sz = Math.max(SIGMA_Z_MIN, sh*SIGMA_Z_RATIO);
  const r2 = dx*dx + dz*dz;
  // the puff's own centre lifts slowly off the water as it warms and thins
  const centreY = (h.rise != null ? h.rise : 9)*smooth01(h.age/45);
  const dyc = dy - centreY;
  return puffPeak(h)*Math.exp(-r2/(2*sh*sh) - dyc*dyc/(2*sz*sz));
}

/* Haber's rule — dose is concentration integrated over time. Generic
   inhalation toxicology, agent-agnostic. The thresholds below are game
   calibration, not anybody's exposure limits. */
const DOSE_STING  = 3;    // eyes and throat start to complain
const DOSE_COUGH  = 10;   // productive coughing, you cannot work the boat
const DOSE_HARM   = 22;   // injury begins to accumulate
const DOSE_LD50   = 75;   // sitting in the middle of one for about a minute

/* Clearance: the body works it off, but slowly, and the tail is long. */
const DOSE_CLEAR_TAU = 95;   // s

export class MunitionEffects {
  constructor(cb = {}){
    this.cb = cb;
    this.reset();
  }

  reset(){
    /* fire */
    this.flux = 0;          // kW/m², what is landing on you right now
    this.tdu = 0;           // accumulated thermal dose
    this.burn = 0;          // severity 0..1, permanent
    this.hullFire = 0;      // 0..1, the boat itself alight

    /* cloud */
    this.conc = 0;          // instantaneous concentration, arbitrary units
    this.dose = 0;          // accumulated, Haber
    this.breathing = 1;     // 0 = holding it / submerged

    /* what the rest of the game reads off this */
    this.heatStrain = 0;    // → cardio
    this.fear = 0;          // → cardio
    this.respiratory = 0;   // → cardio
    this.exertionCap = 1;   // → movement, 1 = unimpaired
    this.eyeIrritation = 0; // → vision blur
    this.veil = 0;          // → screen haze inside a cloud

    this._warned = new Set();
    this._toastT = 0;
    this._dmgCarry = 0;
    this._severity = 0;
    this._gasSpent = 0;
  }

  /* Fire exposure at a point. Separated out so the same code serves the
     player, the hull, and anything else that can be cooked. */
  fluxAt(hazards, x, y, z, windX, windZ){
    let total = 0;
    for(const h of hazards){
      if(h.type !== 'fire' || !h.point) continue;
      const fade = Math.min(1, h.age/2.5)
                 * smooth01(clamp((h.ttl - h.age)/8, 0, 1));
      if(fade <= 0.01) continue;

      const R = Math.max(1.5, h.radius);
      const D = R*2;
      const area = Math.PI*R*R;
      const Q = BURN_RATE*HEAT_OF_COMB*area*fade*(h.intensity ?? 1);   // kW

      const dx = x - h.point.x, dz = z - h.point.z;
      // Radiate from the flame's centre of gravity, roughly a third of the
      // way up a flame whose height scales as Q̇^2/5 (Heskestad).
      const flameH = Math.max(0.5, 0.235*Math.pow(Math.max(Q,1), 0.4) - 1.02*D);
      const dy = y - (h.point.y + flameH*0.33);
      let d2 = dx*dx + dy*dy + dz*dz;

      // Inside the burning footprint there is no "distance" left to speak
      // of — you are in the flame, and you take the flame's own emissive
      // power. Outside, the inverse square does the work.
      const inside = (dx*dx + dz*dz) < R*R && Math.abs(dy) < flameH;
      let q;
      if(inside){
        q = FLUX_CEIL*fade;
      } else {
        d2 = Math.max(d2, 1);
        q = radiativeFraction(D)*Q/(4*Math.PI*d2);
      }

      // A flame leans downwind and its hot plume tilts with it, so the
      // downwind side of a fire is meaningfully worse than the upwind.
      const wl = Math.hypot(windX, windZ);
      if(wl > 0.5 && !inside){
        const hd = Math.hypot(dx, dz) || 1;
        const align = (dx*windX + dz*windZ)/(hd*wl);   // +1 = you are downwind
        q *= 1 + 0.42*align;
      }
      total += q;
    }
    return Math.min(total, FLUX_CEIL);
  }

  /* Concentration at a point, summed over every live cloud. */
  concAt(hazards, x, y, z){
    let total = 0;
    for(const h of hazards){
      if(h.type !== 'cloud' || !h.point) continue;
      const fade = smooth01(clamp((h.ttl - h.age)/25, 0, 1));
      if(fade <= 0.01) continue;
      total += puffConcentration(h, x - h.point.x, y - h.point.y, z - h.point.z)
             * fade * (h.intensity ?? 1);
    }
    return total;
  }

  /*  ctx: {
        hazards, playerPos, ship, wind, dt,
        submerged  — face under water: no intake, no radiation
        breath     — 0..1 remaining breath-hold
        rain       — 0..1, damps a hull fire
        washing    — 0..1, green water over the deck, damps it harder
        alive      — false once the survival model has given up
      }                                                                */
  update(dt, ctx = {}){
    if(!(dt > 0) || !isFinite(dt)) return this;
    const hazards = ctx.hazards || [];
    const p = ctx.playerPos;
    this._toastT = Math.max(0, this._toastT - dt);

    const windX = ctx.wind ? ctx.wind.x : 0;
    const windZ = ctx.wind ? ctx.wind.z : 0;

    if(!p || !hazards.length){
      this._decay(dt);
      if(this.hullFire > 0) this._burnHull(dt, ctx, 0);
      return this;
    }

    /* ── the boat, which can catch ────────────────────────────── */
    let hullFlux = 0;
    if(ctx.ship && ctx.ship.pos){
      hullFlux = this.fluxAt(hazards, ctx.ship.pos.x, ctx.ship.pos.y + 0.8,
                             ctx.ship.pos.z, windX, windZ);
    }
    this._burnHull(dt, ctx, hullFlux);

    /* ── fire on the person ───────────────────────────────────── */
    // Under water you are shielded from radiation completely.
    const shielded = ctx.submerged ? 0 : 1;
    let q = this.fluxAt(hazards, p.x, p.y, p.z, windX, windZ)*shielded;
    // Standing on a burning deck, the fire is under your feet wherever
    // you go: the hull's own fire follows you around.
    q += this.hullFire*this.hullFire*46*shielded;
    this.flux = q;

    if(q > 0.6){
      this.tdu += Math.pow(q, 4/3)*dt;
    }
    const sev = burnSeverity(this.tdu);
    if(sev > this._severity){
      const cost = (sev - this._severity)*100;
      this._severity = sev;
      this.burn = sev;
      this._dmgCarry += cost;
      if(this._dmgCarry >= 1){
        const n = this._dmgCarry;
        this._dmgCarry = 0;
        this.cb.damage?.(n, sev >= 0.98
          ? 'You did not get clear of the fire.'
          : 'Burns. The heat came through your clothes.');
      }
    }

    /* ── the cloud on the person ──────────────────────────────── */
    // Intake is what reaches the lungs. Face under water, or a held
    // breath, and nothing does — swimming under a cloud genuinely works,
    // for as long as you can hold it.
    const holding = ctx.submerged ? 1 : 0;
    this.breathing = holding ? 0 : 1;
    const c = this.concAt(hazards, p.x, p.y, p.z);
    this.conc = c;
    this.dose += c*this.breathing*dt;
    // and it clears, slowly, once you are out of it
    if(c < 0.02) this.dose = Math.max(0, this.dose - this.dose*dt/DOSE_CLEAR_TAU);

    if(this.dose > DOSE_HARM){
      // Injury accrues with the dose above the harm threshold, reaching
      // fatal around DOSE_LD50. Same monotonic-cost trick as the burns.
      const frac = clamp((this.dose - DOSE_HARM)/(DOSE_LD50 - DOSE_HARM), 0, 1);
      const want = frac*100;
      if(want > (this._gasSpent || 0)){
        const n = want - (this._gasSpent || 0);
        this._gasSpent = want;
        if(n > 0.4) this.cb.damage?.(n, 'Your chest will not fill. You breathed too much of it.');
      }
    }

    /* ── what the rest of the simulation should feel ──────────── */
    // Radiant heat is a real cardiovascular load: skin vasodilates,
    // blood is diverted to the surface, and the heart makes up the
    // shortfall in central return with rate.
    this.heatStrain = clamp(this.flux/9, 0, 1);
    // Eyes streaming and airways closing. Not lens fogging — this is the
    // tear film, so it applies whether or not glasses are being worn.
    this.eyeIrritation = clamp(this.dose/DOSE_STING*0.35, 0, 1)*0.8
                       + clamp(this.conc*0.5, 0, 0.35);
    this.respiratory = clamp(this.dose/DOSE_COUGH, 0, 1);
    // Coughing costs you the boat: you cannot haul on a sheet like this.
    this.exertionCap = 1 - 0.55*smooth01(clamp((this.dose - DOSE_STING)/(DOSE_COUGH*1.6), 0, 1));
    this.fear = clamp(this.flux/14, 0, 0.7) + clamp(this.conc*0.8, 0, 0.5)
              + this.hullFire*0.6;
    this.veil = clamp(this.conc*0.9, 0, 0.85);

    this._speak();
    return this;
  }

  _decay(dt){
    this.flux = Math.max(0, this.flux - this.flux*dt*3);
    this.conc = Math.max(0, this.conc - this.conc*dt*3);
    if(this.dose > 0) this.dose = Math.max(0, this.dose - this.dose*dt/DOSE_CLEAR_TAU);
    this.heatStrain = clamp(this.flux/9, 0, 1);
    this.respiratory = clamp(this.dose/DOSE_COUGH, 0, 1);
    this.eyeIrritation = clamp(this.dose/DOSE_STING*0.35, 0, 1)*0.8;
    this.exertionCap = 1 - 0.55*smooth01(clamp((this.dose - DOSE_STING)/(DOSE_COUGH*1.6), 0, 1));
    this.fear = this.hullFire*0.6;
    this.veil = 0;
  }

  /* A wooden hull in a burning pool lights, and once it is alight the
     fire is aboard with you. Sea and rain fight it; nothing else does. */
  _burnHull(dt, ctx, hullFlux){
    // Piloted ignition of dry timber wants roughly 12 kW/m² sustained.
    const ignite = clamp((hullFlux - 12)/28, 0, 1);
    const douse = 0.06 + (ctx.rain || 0)*0.10 + (ctx.washing || 0)*0.55;
    this.hullFire = clamp(this.hullFire + (ignite*0.55 - douse*this.hullFire)*dt, 0, 1);
    if(this.hullFire > 0.15 && !this._warned.has('hull')){
      this._warned.add('hull');
      this.cb.toast?.('The deck has caught. Get water on it or get off her.', 'bad');
    }
    if(this.hullFire < 0.03) this._warned.delete('hull');
  }

  _speak(){
    const say = (key, text) => {
      if(this._warned.has(key) || this._toastT > 0) return;
      this._warned.add(key); this._toastT = 3.5;
      this.cb.toast?.(text, 'bad');
    };
    if(this.flux > 2.5) say('heat', 'The heat is on your face. It hurts to look at it.');
    if(this.flux > 10)  say('sear', 'Too close. Your skin is going.');
    if(this.dose > DOSE_STING) say('sting', 'Your eyes are streaming and your throat is closing.');
    if(this.dose > DOSE_COUGH) say('cough', 'You cannot stop coughing. Get out of it — upwind, or under.');
    if(this.flux < 1.2) this._warned.delete('heat');
    if(this.flux < 6)   this._warned.delete('sear');
    if(this.dose < DOSE_STING*0.5) this._warned.delete('sting');
    if(this.dose < DOSE_COUGH*0.5) this._warned.delete('cough');
  }

  /* For the HUD / debug readout. */
  report(){
    return {
      flux: +this.flux.toFixed(2), tdu: Math.round(this.tdu),
      burn: +this.burn.toFixed(3),
      conc: +this.conc.toFixed(3), dose: +this.dose.toFixed(1),
      hullFire: +this.hullFire.toFixed(2),
    };
  }
}
