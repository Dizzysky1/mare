/* ────────────────────────────────────────────────────────────────
   A heart, not a metronome. This is a GAME model, not a clinical
   one: every constant below was picked for plausibility and feel,
   sanity-checked against the textbook shape of the mechanism it
   stands for, and then bent wherever "correct" would have made the
   game unplayable. Pure math, no imports, no allocation once warm —
   the audio and post-processing layers can both read it without
   either of them owning it.

   The interesting claim this file makes is that heart rate is an
   OUTCOME, not a dial. update() gathers several independent
   autonomic "drives" (exertion, fear, blood loss, cold, the diving
   reflex...), each with its own onset/decay kinetics because the
   nervous mechanisms behind them genuinely differ in speed, then
   combines them through a saturating sum so simultaneous stresses
   pile up believably instead of adding to nonsense numbers, and
   finally turns the result into a bpm relative to a resting rate
   and an age-scaled reserve (Karvonen-style), not an absolute dial.
   ──────────────────────────────────────────────────────────────── */

function clamp(x, a, b){ return x < a ? a : (x > b ? b : x); }

// Smooth toward a target with a time constant, stable for any dt >= 0 —
// this is exp(-dt/tau), so it never overshoots and never needs dt<tau.
function approach(cur, target, dt, tau){
  if(tau <= 1e-6) return target;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

function smoothstep(x, a, b){
  if(a === b) return x < a ? 0 : 1;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

export class Cardio {
  constructor(opts = {}){
    this.age = opts.age ?? 30;
    this.fitness = opts.fitness ?? 1;          // >1 fitter: bigger reserve, quicker kinetics
    // Tanaka/Monahan/Seals (2001): HRmax = 208 − 0.7×age. Tracks the
    // textbook "220 − age" closely in the 20s-30s and diverges usefully
    // outside them, which is all the accuracy this needs.
    this.maxHR = opts.maxHR ?? (208 - 0.7 * this.age);
    this.restingHR0 = opts.restingHR ?? (74 - 8 * (this.fitness - 1));
    this.k = opts.decay ?? 1;                  // mode multiplier, see update()

    // deterministic PRNG (mulberry32) so beat-to-beat noise is repeatable
    // given the same seed — needed for testing, and for replay/demo sync.
    this._seed = (opts.seed ?? 0x2545f491) >>> 0;

    // exertion: two pools with different kinetics (see update() for why)
    this._exFast = 0; this._exSlow = 0;
    // fear: single pool plus its own held jitter target
    this._fear = 0; this._fearNoise = 0; this._fearNoiseT = 0;
    // chronic/slow accumulators
    this._chill = 0;          // how deep hypothermia has progressed, 0..1+
    this._starve = 0;         // chronic undernutrition, 0..1
    this._bloodLoss = 0;      // fraction of blood volume lost, 0..1+ (>1 = past class IV)
    this._dive = 0;           // diving-reflex bradycardia strength, 0..1

    // cardiac cycle state
    this._curRR = 60 / this.restingHR0;   // seconds
    this._curSystole = 0.30 * Math.sqrt(this._curRR);
    this._curDiastole = this._curRR - this._curSystole;
    this._phaseT = 0;         // seconds since the last S1
    this._smoothBpm = this.restingHR0;
    this._breathPhase = 0;
    this._msd = 4;            // mean squared successive RR diff, ms² — rMSSD seed
    this._prevRRms = 60000 / this.restingHR0;

    this.t = 0;

    // public outputs
    this.bpm = this.restingHR0;
    this.meanBpm = this.restingHR0;
    this.hrv = Math.sqrt(this._msd);
    this.contractility = 0.6;
    this.phase = 0;
    this.perfusion = 1;
    this.danger = 0;
    this.state = 'rest';

    // beat queue: fixed pool, reused every frame — never allocates a beat
    this._pool = [];
    for(let i = 0; i < 8; i++) this._pool.push({ t: 0, kind: 'S1', strength: 0 });
    this._poolI = 0;
    this.beats = [];
  }

  _rand(){
    let t = (this._seed += 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  _noise(){ return this._rand() + this._rand() - 1; } // ~triangular, [-1,1], cheap

  _pushBeat(t, kind, strength){
    const ev = this._pool[this._poolI];
    this._poolI = (this._poolI + 1) % this._pool.length;
    ev.t = t; ev.kind = kind; ev.strength = strength;
    this.beats.push(ev);
  }

  update(dt, ctx = {}){
    if(!(dt > 0) || !isFinite(dt)) dt = 1/60;
    dt = clamp(dt, 0, 0.25);         // defensive only; spec range is 1/240..1/20
    this.beats.length = 0;
    this.t += dt;

    const k = ctx.decay ?? this.k;                 // mode stress multiplier
    const exertion = clamp(ctx.exertion ?? 0, 0, 1);
    const fearIn   = clamp(ctx.fear ?? 0, 0, 1);
    const water    = ctx.water ?? 100;
    const food     = ctx.food  ?? 100;
    const bleeding = clamp(ctx.bleeding ?? 0, 0, 1);
    const fatigue  = clamp(ctx.sleep ?? ctx.fatigue ?? 0, 0, 1);
    const breath   = clamp(ctx.breath ?? 1, 0, 1);
    const submerged = !!(ctx.submerged || ctx.faceInWater);
    const coldIn = ctx.coreTemp != null
      ? clamp((37 - ctx.coreTemp) / 7, 0, 1.4)
      : clamp(ctx.cold ?? 0, 0, 1.4);

    /* ── exertion: fast vagal withdrawal, then a slower sympathetic
       climb; recovery has the same two speeds in reverse, which is
       exactly why a heart that sprints and stops stays up a while.
       Real numbers this is aimed at: ~90% of a fast recovery inside a
       minute (HRR1, the clinical "heart rate recovery" metric), with a
       slow tail that is still ~15-20% present five minutes out. */
    const fastUp = 8/this.fitness, fastDn = 28/this.fitness;
    const slowUp = 50/this.fitness, slowDn = 170/this.fitness;
    this._exFast = approach(this._exFast, exertion, dt, exertion > this._exFast ? fastUp : fastDn);
    this._exSlow = approach(this._exSlow, exertion, dt, exertion > this._exSlow ? slowUp : slowDn);
    const exertionDrive = clamp(0.5*this._exFast + 0.5*this._exSlow, 0, 1);

    /* ── fear: onset almost as fast as an adrenaline bolus, decays a
       bit slower than it rises, and — unlike exertion — never sits
       still. The jitter is what makes it "read" as fear rather than
       effort on the audio side. */
    this._fear = approach(this._fear, fearIn, dt, fearIn > this._fear ? 2.5 : 22);
    this._fearNoiseT -= dt;
    if(this._fearNoiseT <= 0){ this._fearNoise = this._noise()*0.18; this._fearNoiseT = 0.25 + this._rand()*0.3; }
    const fearDrive = clamp(this._fear*(1 + this._fearNoise), 0, 1.15);

    /* ── hypothermia: shivering + catecholamines push HR up early;
       as the core actually cools (a slow process even once the skin
       is freezing — hence its own long-tau accumulator, scaled by
       mode harshness like survival.js's own decay does) the heart
       swings the other way: direct myocardial cooling and rising
       vagal tone give progressive bradycardia, with growing beat
       irregularity as core temperature keeps falling. */
    this._chill = approach(this._chill, coldIn, dt, coldIn > this._chill ? 90/k : 240/k);
    const shiverDrive   = coldIn * (1 - smoothstep(this._chill, 0.45, 1.0)) * 0.8;
    const lateHypoBrady = smoothstep(this._chill, 0.5, 1.3) * 0.9;
    const hypoChaos = this._chill > 1.0 ? clamp((this._chill - 1.0)/0.4, 0, 1) : 0;

    /* ── hypovolemia: dehydration is compensated by tachycardia long
       before it is compensated by anything else, and the compensation
       gets worse than linear as free water runs out (concentrating the
       remaining plasma volume loss). Contractility (our stroke-volume
       proxy) drops at the same time — Frank-Starling: less venous
       return, less to eject — so a dehydrated heart beats faster AND
       softer, the game's stand-in for narrowing pulse pressure. */
    const dehydSev = clamp((55 - water)/55, 0, 1);
    const dehydTachy = Math.pow(dehydSev, 1.3) * 0.6;
    const dehydContractLoss = Math.pow(dehydSev, 1.5) * 0.35;

    /* ── starvation: slow chronic signal (minutes, not seconds) —
       reduced metabolic rate and down-regulated thyroid drive give a
       lower resting rate AND a smaller reserve to spend on exertion. */
    this._starve = approach(this._starve, clamp(1 - food/100, 0, 1), dt, 260/k);

    /* ── haemorrhage/shock: classic compensated-then-decompensated
       curve. Below ~55% of the tracked "volume lost" scale, tachycardia
       alone holds cardiac output up (Class I-III). Past that, the
       compensation itself fails — contractility craters and the heart
       can slide into a slow, thready, pre-terminal rhythm rather than
       just "very fast" (Class IV decompensation). Bleeding integrates
       over time rather than snapping, so a graze and a punctured lung
       feel different even at the same instantaneous ctx.bleeding. */
    this._bloodLoss = clamp(
      this._bloodLoss + bleeding*dt*0.011*k - (bleeding <= 0 ? dt/900 : 0),
      0, 1.4);
    const shockComp = smoothstep(this._bloodLoss, 0, 0.55) * 0.95;
    const decomp = smoothstep(this._bloodLoss, 0.55, 1.05);
    const shockCollapse = decomp*decomp*0.9;

    /* ── the diving reflex: cold water on the face is a trigeminal
       cue that drives vagal outflow straight to the sinus node —
       bradycardia, not tachycardia, and it does not care that you
       might also be swimming hard (exercise blunts it, real diving
       physiology, but does not cancel it — see the netDrive combine
       below). It engages in a few seconds and lets go almost as fast
       once your face clears the surface. As breath runs out, rising
       CO2/falling O2 drive overrides it — the same reflex that slowed
       you down now gets steadily out-voted by the urge to breathe,
       until a real breath-hold ends in a gasp-flavoured tachycardia
       rather than a slow one. */
    const diveTarget = submerged ? clamp(0.35 + 0.65*clamp(ctx.cold ?? 0.5, 0, 1), 0, 1) : 0;
    this._dive = approach(this._dive, diveTarget, dt, diveTarget > this._dive ? 4 : 6);
    const airHunger = smoothstep(1 - breath, 0.55, 0.95);
    const divingBrady = this._dive * (1 - airHunger*0.9);
    const airHungerPanic = airHunger * 0.8;

    /* ── combine: one sympathetic nervous system, one vagus, both with
       a ceiling. Summing raw fractions would let five simultaneous
       stresses blow past any sane bpm; a saturating "probabilistic OR"
       keeps everything in 0..1 while still letting a second and third
       stressor matter (each knocks a bite out of what is left). */
    let symP = 1;
    symP *= (1 - clamp(exertionDrive,0,1));
    symP *= (1 - clamp(fearDrive,0,1));
    symP *= (1 - clamp(dehydTachy,0,1));
    symP *= (1 - clamp(shockComp,0,1));
    symP *= (1 - clamp(shiverDrive,0,1));
    symP *= (1 - clamp(airHungerPanic,0,1));
    const sympathetic = 1 - symP;

    let vagP = 1;
    vagP *= (1 - clamp(divingBrady,0,1));
    vagP *= (1 - clamp(lateHypoBrady,0,1));
    vagP *= (1 - clamp(shockCollapse,0,1));
    const vagal = 1 - vagP;

    // exercise blunts the diving reflex but does not erase it
    const netDrive = clamp(sympathetic - vagal*(1 - 0.3*sympathetic), -0.4, 1.15);

    const restingHR_eff = this.restingHR0 - this._starve*9;
    const reserveScale = (1 - this._starve*0.32) * (1 - fatigue*0.15);
    const reserve = (this.maxHR - this.restingHR0) * reserveScale;
    const targetRaw = restingHR_eff + reserve*netDrive;

    this._smoothBpm = approach(this._smoothBpm, targetRaw, dt, 1.4);
    this.meanBpm = clamp(this._smoothBpm, 26, 215);

    /* ── HRV: respiratory sinus arrhythmia (HR rises on inspiration,
       falls on expiration) rides on top of the mean rate, sized by
       vagal tone — and vagal tone is exactly what sympathetic drive
       and decompensation eat first. A high-stress heart is not just
       fast, it is METRONOMIC, and that flatness is itself the tell. */
    let vagalTone = clamp(1 - sympathetic*1.15 - decomp*1.4 - this._starve*0.15, 0, 1);
    vagalTone *= (1 - clamp(this._chill,0,1)*0.4);
    const breathHz = submerged ? 0 : clamp(0.20 + 0.30*sympathetic + 0.15*fearDrive, 0.15, 0.6);
    this._breathPhase = (this._breathPhase + breathHz*dt) % 1;
    const rsaAmpBpm = 5.5 * vagalTone;
    const rsaTerm = submerged ? 0 : rsaAmpBpm * Math.sin(this._breathPhase * 2*Math.PI);

    /* ── beat scheduling: phase runs 0..1 across the current cycle;
       when it wraps we know that cycle's rate (mean + RSA + noise) and
       can lay down S1 and S2 for it immediately, S2 offset by that
       cycle's systolic duration. Systole scales with sqrt(RR) (a
       Bazett-style regression, same family as the QT/RR relationship)
       so it shrinks far more slowly than the cycle as a whole — which
       is exactly why diastole (the gap) is what visibly disappears as
       the heart speeds up, not the "lub-dub" itself. */
    this._phaseT += dt;
    let guard = 0;
    while(this._phaseT >= this._curRR && guard++ < 8){
      const boundaryT = this.t - this._phaseT;
      this._phaseT -= this._curRR;

      const sigmaBpm = 2.2*vagalTone + hypoChaos*9;
      const hrAtBeat = clamp(this.meanBpm + rsaTerm + this._noise()*sigmaBpm, 26, 220);
      const RRms = 60000 / hrAtBeat;
      const RRs = RRms / 1000;
      const systole = clamp(0.30*Math.sqrt(RRs), 0.15, 0.34);
      const diastole = Math.max(0.06, RRs - systole);

      this._curRR = RRs;
      this._curSystole = systole;
      this._curDiastole = diastole;
      this.bpm = hrAtBeat;

      const diff = RRms - this._prevRRms;
      this._msd = this._msd + (diff*diff - this._msd)*0.35;
      this._prevRRms = RRms;

      this._pushBeat(boundaryT, 'S1', this.contractility);
      this._pushBeat(boundaryT + systole, 'S2', this.contractility*0.82);
    }
    this.phase = clamp(this._phaseT / this._curRR, 0, 1);
    this.hrv = Math.sqrt(Math.max(0, this._msd));

    /* ── contractility: how hard the beat lands, i.e. how loud it
       should sound. Catecholamines give positive inotropy; dehydration,
       decompensated shock, cold myocardium and starvation all take it
       away — a weak, quiet pulse is one of the most honest tells this
       model has, and it is nearly free to compute. */
    let c = 0.58 + 0.34*clamp(sympathetic,0,1);
    c -= dehydContractLoss;
    c -= decomp*0.55 + shockComp*0.12;
    c -= this._starve*0.12;
    c -= lateHypoBrady*0.30;
    c -= fatigue*0.10;
    this.contractility = clamp(c, 0.05, 1);

    /* ── perfusion: a cardiac-output proxy, not a real one. Rate ×
       stroke proxy, where the stroke proxy itself falls if diastole
       (filling time) gets too short — the real reason extreme
       tachycardia can cost you cardiac output instead of buying more
       of it. Decompensated shock and deep hypothermia then tax
       perfusion again directly, since at that point it is peripheral
       vasomotor failure, not the pump, that is the problem. */
    const fillFactor = clamp(this._curDiastole/0.45, 0, 1);
    const strokeProxy = this.contractility * (0.55 + 0.45*fillFactor);
    const co0 = this.restingHR0 * 0.55;
    let perf = clamp((this.bpm*strokeProxy)/co0, 0, 1.2);
    perf *= (1 - decomp*0.85);
    perf *= (1 - lateHypoBrady*0.5);
    this.perfusion = clamp(perf, 0, 1);

    /* ── danger: the single "this heart is in trouble" scalar, taken
       as the worst of its contributing troubles rather than a sum —
       one bad thing being very bad matters more than five mild ones. */
    const tachyOver = this.bpm > this.maxHR*1.05 ? clamp((this.bpm - this.maxHR*1.05)/(this.maxHR*0.35), 0, 1) : 0;
    const bradyUnder = (this.bpm < 40 && divingBrady < 0.2) ? clamp((40 - this.bpm)/25, 0, 1) : 0;
    const lowPerf = this.perfusion < 0.45 ? clamp((0.45 - this.perfusion)/0.45, 0, 1) : 0;
    this.danger = clamp(Math.max(decomp, lateHypoBrady*0.85, Math.pow(dehydSev,1.5)*0.55, tachyOver, bradyUnder, lowPerf), 0, 1);

    /* ── state: whichever drive is actually in charge right now. */
    let state = 'rest';
    if(decomp > 0.45) state = 'shock';
    else if(lateHypoBrady > 0.35) state = 'hypothermic';
    else if(this._dive > 0.25 && airHunger < 0.5) state = 'diving';
    else if(fearDrive > 0.3 && fearDrive >= exertionDrive) state = 'fear';
    else if(exertionDrive > 0.12 || shiverDrive > 0.25) state = 'exertion';
    else if(this._exFast > 0.08 || this._exSlow > 0.08) state = 'recovery';
    this.state = state;
  }
}
