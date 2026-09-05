/* ────────────────────────────────────────────────────────────────
   A GAME weather model, not a forecast system. It favours legibility
   and pacing over meteorological rigour: a player has to be able to
   *read* what's coming (a darkening horizon, a backing wind, a
   dropping glass) and act on it before it arrives.

   Everything here is a pure function of a seed and elapsed time, plus
   a couple of small integrators (sea state, sea-direction lag) that
   genuinely need memory of the recent past. That split matters: the
   stateless part means forecast() can "peek" at the future by just
   evaluating the same functions at a later t, and the whole model is
   frame-rate independent — the same elapsed time always produces the
   same fronts and squalls regardless of how update() was chopped into
   steps. No THREE, no DOM, no imports.

   Mechanisms modelled:
   - a wandering synoptic pressure field, with discrete FRONTS that
     sweep through: pressure falls, wind rises, then direction snaps
     (backs or veers) over a few minutes, then eases behind it. The
     new direction relaxes back toward the prevailing wind over a few
     hours, the way wind settles as a high builds in behind a front.
   - SQUALLS: short, local, much stronger than the ambient wind, with
     an approach you can see coming (falling barometer, building
     cloud) before a sharp hit and a quick decay.
   - three named Mediterranean winds for flavour — mistral (strong,
     gusty, clearing, from the NNW), meltemi (very steady, N, builds
     through the afternoon), sirocco (warm, hazy, from the SSE) — as
     a slowly blended-in "regime" under the fronts/squalls above.
   - diurnal land/sea breeze near an island, and the flat calm that
     precedes dawn, both of which only show up once the gradient wind
     is weak enough for thermal effects to matter.
   - sea state (Hs) as a fetch/duration-limited process: it chases an
     equilibrium set by wind speed, but climbs and decays on its own
     time constants rather than snapping to it, and it keeps pointing
     the way the wind blew a while ago rather than the way it blows
     right now.
   - visibility as the worst of three independent limiters: haze,
     rain, fog.
   ──────────────────────────────────────────────────────────────── */

const TAU = Math.PI * 2;
const D2R = Math.PI / 180;
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (t) => (t = clamp(t, 0, 1)) * t * (3 - 2 * t);

// Integer hash (murmur-style finalizer). Deterministic, allocation-free,
// takes int32 in, returns a float in [0,1). This is the seed for every
// "did an event happen in this time-slot" decision below.
function hash32(x) {
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = Math.imul(x ^ (x >>> 16), 0x45d9f3b);
  x = x ^ (x >>> 16);
  return (x >>> 0) / 4294967296;
}
function hash2(a, b) {
  return hash32(Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca77) ^ 0x27d4eb2d);
}

// Smooth (quintic) 1D value noise, continuous in t, no allocation.
// Used for anything that should wander rather than snap: pressure
// wobble, direction wander, gust jitter.
function noise1(t, salt) {
  const i0 = Math.floor(t), f = t - i0;
  const u = f * f * f * (f * (f * 6 - 15) + 10);
  const a = hash2(i0, salt) * 2 - 1;
  const b = hash2(i0 + 1, salt) * 2 - 1;
  return a + (b - a) * u;
}

// Hour-of-day bump, wraps across midnight. Used for the afternoon
// breeze/build and the pre-dawn lull.
function dayBump(hour, center, width) {
  let d = Math.abs(hour - center);
  if (d > 12) d = 24 - d;
  return Math.exp(-(d * d) / (2 * width * width));
}

// Fetch/duration-limited significant wave height for a small, mostly
// enclosed Mediterranean-scale basin — calibrated (not derived) so
// that the game's five modes land in the Hs neighbourhoods the design
// wants at their chosen sustained wind speeds. An open-ocean formula
// (e.g. Hs ~ 0.02*U^2) would put a give a proper gale several times
// too big a sea for what a 13 m hull needs to survive here.
function hsEquilibrium(u) {
  return 0.064 * Math.pow(Math.max(0, u), 1.41);
}

/* ── discrete weather events, sampled statelessly from elapsed time ──
   Each "sampleX" function looks at the 3 time-slots straddling `t`,
   decides (via hash) whether an event occupies each slot, and shapes
   its contribution with smooth envelopes. Writing into a caller-owned
   `out` object keeps this allocation-free at 120 Hz. */

function sampleFront(seed, storminess, t, out) {
  const slot = clamp(5400 / (0.25 + storminess * 2.2), 1200, 10800);
  const settle = slot * 0.8;     // how long a front's direction shift lingers before relaxing back
  const base = Math.floor(t / slot);
  let severity = 0, pressureDip = 0, dirShiftDeg = 0, eta = 1e9, phase = 'clear', active = false;

  for (let k = -1; k <= 1; k++) {
    const idx = base + k;
    if (hash2(idx, seed * 7 + 1) >= 0.12 + storminess * 0.55) continue;      // no front this slot
    const center = idx * slot + hash2(idx, seed * 7 + 2) * slot;
    const dur = 1400 + hash2(idx, seed * 7 + 3) * 4200 * (0.4 + storminess); // passage length
    const durPre = dur * 0.65, durPost = dur * 0.35;                         // slow build, quicker clearing
    const shiftWidth = Math.min(dur * 0.10, 900);                           // the shift itself is abrupt

    const sShape = t < center ? (t - center) / durPre : (t - center) / durPost;
    const shape = Math.abs(sShape) <= 1 ? Math.cos(clamp(sShape, -1, 1) * Math.PI * 0.5) : 0;

    const preT = center - shiftWidth * 0.5, postT = center + shiftWidth * 0.5;
    let ease;
    if (t <= preT) ease = 0;
    else if (t < postT) ease = smooth((t - preT) / shiftWidth);
    else ease = Math.exp(-(t - postT) / settle);                            // slow relax to prevailing dir

    const sign = hash2(idx, seed * 7 + 4) < 0.5 ? -1 : 1;
    const shiftMag = 35 + hash2(idx, seed * 7 + 5) * 75;                    // deg: a real backing/veering shift
    dirShiftDeg += sign * shiftMag * ease;

    const sev = shape * (0.5 + storminess * 0.5 + hash2(idx, seed * 7 + 6) * 0.3);
    if (sev > severity) {
      severity = sev;
      pressureDip = -shape * (6 + storminess * 14);
      eta = center - t;
      phase = t < preT ? 'approach' : (t > postT ? 'clearing' : 'passage');
    }
    if (shape > 0.02 || ease > 0.02) active = true;
  }
  out.active = active; out.severity = severity; out.pressureDip = pressureDip;
  out.dirShiftDeg = dirShiftDeg; out.eta = eta; out.phase = active ? phase : 'clear';
}

function sampleSquall(seed, storminess, frontApproaching, t, out) {
  const slot = clamp(2200 / (0.15 + storminess * 2.6), 300, 3600);
  const base = Math.floor(t / slot);
  const pExists = clamp(0.06 + storminess * 0.5 + (frontApproaching ? 0.2 : 0), 0, 0.85);
  let severity = 0, dirShiftDeg = 0, eta = 1e9, phase = 'clear', active = false;

  for (let k = -1; k <= 1; k++) {
    const idx = base + k;
    if (hash2(idx, seed * 13 + 1) >= pExists) continue;
    const center = idx * slot + hash2(idx, seed * 13 + 2) * slot;           // moment of peak strength
    const lead = 300 + hash2(idx, seed * 13 + 3) * 600;                     // 5-15 min visible approach
    const peak = 90 + hash2(idx, seed * 13 + 4) * 120;                      // 1.5-3.5 min at full strength
    const decay = 300 + hash2(idx, seed * 13 + 5) * 900;                    // 5-20 min to fall away
    const dt0 = t - center;
    if (dt0 < -lead || dt0 > peak + decay) continue;

    let sev;
    if (dt0 < 0) sev = Math.pow(smooth(1 + dt0 / lead), 3);                 // stays low, then jumps late — "sudden"
    else if (dt0 < peak) sev = 1;
    else sev = Math.exp(-(dt0 - peak) / (decay * 0.4));

    if (sev > severity) {
      severity = sev;
      const sign = hash2(idx, seed * 13 + 6) < 0.5 ? -1 : 1;
      dirShiftDeg = sign * (30 + hash2(idx, seed * 13 + 7) * 60) * smooth((sev - 0.4) / 0.6);
      eta = Math.max(0, -dt0);
      phase = dt0 < 0 ? 'approach' : (dt0 < peak ? 'strike' : 'decay');
      active = true;
    }
  }
  out.active = active; out.severity = severity; out.dirShiftDeg = dirShiftDeg;
  out.eta = eta; out.phase = active ? phase : 'clear';
}

// Named regional winds, purely as flavour: a slow crossfade between
// "nothing in particular" and a characteristic regime. `lat` biases
// which one is likely (0 = southern/Sirocco coast, 1 = northern/
// Mistral-Meltemi coast); pass 0.5 for "don't know, don't care".
function sampleRegime(seed, storminess, lat, t, out) {
  const slot = clamp(9000 / (0.2 + storminess * 1.2), 3000, 14400);
  const idx = Math.floor(t / slot);
  const fade = Math.min(slot * 0.12, 900);
  const into = t - idx * slot, outOf = (idx + 1) * slot - t;
  const weight = Math.min(smooth(into / fade), smooth(outOf / fade));

  const r = hash2(idx, seed * 31 + 1);
  let name = 'none';
  if (r > 0.35) {
    const mistralShare = 0.30 + 0.15 * lat, meltemiShare = 0.30 + 0.10 * lat;
    const roll = (r - 0.35) / 0.65;
    if (roll < mistralShare) name = 'mistral';
    else if (roll < mistralShare + meltemiShare) name = 'meltemi';
    else name = 'sirocco';
  }

  switch (name) {
    case 'mistral': out.dirRad = 330 * D2R; out.speedMul = 1.6 + storminess * 0.4; out.steadiness = 0.4; out.hazeAmt = 0; out.clearBonus = 0.55; break;
    case 'meltemi': out.dirRad = 20 * D2R; out.speedMul = 1.35; out.steadiness = 0.85; out.hazeAmt = 0; out.clearBonus = 0.35; break;
    case 'sirocco': out.dirRad = 165 * D2R; out.speedMul = 1.15; out.steadiness = 0.5; out.hazeAmt = 0.8; out.clearBonus = -0.1; break;
    default: out.dirRad = 0; out.speedMul = 1; out.steadiness = 0.55; out.hazeAmt = 0; out.clearBonus = 0; break;
  }
  out.weight = name === 'none' ? 0 : weight;
  out.name = name;
}

export class Weather {
  constructor(opts = {}) {
    this.seed = (opts.seed ?? 1) >>> 0 || 1;
    this.climate = opts.climate || 'mediterranean';
    this.storminess = clamp(opts.storminess ?? 0.2, 0, 1);
    this.baseDir = (opts.windDeg ?? 38) * D2R;
    this.baseSpeed = opts.windSpeed ?? (3 + this.storminess * 13);
    // Fixed "toward land" bearing for this run, for the thermal breeze —
    // arbitrary without real geometry, but stable per seed.
    this.shoreDir = hash2(this.seed, 9001) * TAU;

    // public outputs
    this.windDir = this.baseDir;      // radians, direction the wind blows TOWARD
    this.windSpeed = this.baseSpeed;  // m/s sustained
    this.gust = 0;                    // m/s, ADDED on top of windSpeed (peak = windSpeed+gust)
    this.pressure = 1016;             // hPa
    this.storm = clamp(this.storminess, 0, 1);
    this.rain = 0;                    // 0..1
    this.visibility = 25000;          // metres
    this.cloudCover = 0.15 + this.storminess * 0.3;
    this.seaState = { hs: hsEquilibrium(this.baseSpeed) * 0.6, period: 4, dirDeg: opts.windDeg ?? 38 };
    this.event = null;

    // internal state (mutated in place, never reallocated)
    this._seaDirX = Math.cos(this.windDir);
    this._seaDirZ = Math.sin(this.windDir);
    this._front = { active: false, severity: 0, pressureDip: 0, dirShiftDeg: 0, eta: 1e9, phase: 'clear' };
    this._squall = { active: false, severity: 0, dirShiftDeg: 0, eta: 1e9, phase: 'clear' };
    this._regime = { name: 'none', weight: 0, dirRad: 0, speedMul: 1, steadiness: 0.55, hazeAmt: 0, clearBonus: 0 };
    this._eventOut = { type: null, phase: '', eta: 0, severity: 0 };
    this._forecastOut = { pressure: 0, pressureTrend: 0, windSpeed: 0, front: null, squall: null, summary: '' };
    this._pressureBase = 1016 - this.storminess * 8;
  }

  // ctx: { hour (0..24), latitudeish (0..1, optional), nearLand (0..1 or bool), elapsed (s) }
  update(dt, ctx) {
    dt = Math.min(0.3, Math.max(0, dt || 0));
    const t = ctx.elapsed || 0;
    const hour = ctx.hour ?? 12;
    const near = typeof ctx.nearLand === 'number' ? ctx.nearLand : (ctx.nearLand ? 1 : 0);
    const lat = typeof ctx.latitudeish === 'number' ? clamp(ctx.latitudeish, 0, 1) : 0.5;
    const storminess = this.storminess;

    sampleFront(this.seed, storminess, t, this._front);
    sampleSquall(this.seed, storminess, this._front.active && this._front.phase === 'approach', t, this._squall);
    sampleRegime(this.seed, storminess, lat, t, this._regime);
    const front = this._front, squall = this._squall, regime = this._regime;

    /* pressure: slow synoptic wobble plus the front's local trough */
    this.pressure = clamp(
      this._pressureBase
      + noise1(t / 5400, this.seed * 2 + 1) * (3 + storminess * 9)
      + noise1(t / 1800, this.seed * 2 + 2) * (1.5 + storminess * 4)
      + front.pressureDip,
      960, 1045);

    /* direction: prevailing + wander + front shift, blended toward the
       named regime, then toward the local thermal breeze, then the
       squall's own sharp veer/back laid on top of all of it. */
    const wanderRad = noise1(t / 2400, this.seed * 3 + 1) * (10 * D2R) * (1 - regime.steadiness * regime.weight);
    const driftRad = this.baseDir + wanderRad + front.dirShiftDeg * D2R;

    let vx = Math.cos(driftRad) * (1 - regime.weight) + Math.cos(regime.dirRad) * regime.weight;
    let vz = Math.sin(driftRad) * (1 - regime.weight) + Math.sin(regime.dirRad) * regime.weight;

    // sea/land breeze only matters once the gradient wind is weak enough
    // that thermal circulation isn't simply blown away.
    const ambientGuess = this.baseSpeed * (1 + (regime.speedMul - 1) * regime.weight);
    const calmFactor = 1 / (1 + ambientGuess / 7);
    const seaBreeze = near * calmFactor * dayBump(hour, 15, 3.2);
    const landBreeze = near * calmFactor * dayBump(hour, 4.5, 2.2) * 0.6;
    const netBreeze = seaBreeze - landBreeze;
    vx += Math.cos(this.shoreDir) * netBreeze;
    vz += Math.sin(this.shoreDir) * netBreeze;

    if (squall.active && squall.severity > 0.02) {
      const priorDir = Math.atan2(vz, vx);
      const squallDir = priorDir + squall.dirShiftDeg * D2R;
      const w = squall.severity;
      vx = vx * (1 - w) + Math.cos(squallDir) * w;
      vz = vz * (1 - w) + Math.sin(squallDir) * w;
    }
    this.windDir = Math.atan2(vz, vx);

    /* speed: baseline * diurnal build/lull * regime multiplier, plus
       thermal breeze speed, plus front/squall additive boosts. */
    const diurnal = 1 + 0.18 * dayBump(hour, 15, 3.5) - 0.20 * dayBump(hour, 4.5, 2.5);
    let spd = this.baseSpeed * diurnal * (1 + noise1(t / 900, this.seed * 5 + 1) * 0.10);
    spd *= 1 + (regime.speedMul - 1) * regime.weight;
    spd += near * calmFactor * (seaBreeze * 5.5 + landBreeze * 3.0);
    spd += front.severity * (this.baseSpeed * 0.5 + 2 + storminess * 4);
    spd += squall.severity * (this.baseSpeed * (1.1 + storminess) + 4);   // "much stronger than ambient"
    this.windSpeed = clamp(spd, 0.3, 32);

    const gustFactor = clamp(
      1.10 + 0.28 * storminess + 0.5 * front.severity + 1.0 * squall.severity - 0.18 * regime.steadiness * regime.weight,
      1.02, 2.8);
    this.gust = Math.max(0, this.windSpeed * (gustFactor - 1) + noise1(t * 1.7, this.seed * 5 + 2) * this.windSpeed * 0.05);

    /* cloud, rain, haze, storm */
    const cloudBase = 0.15 + storminess * 0.5 + 0.10 * dayBump(hour, 15, 4);
    this.cloudCover = clamp(cloudBase + front.severity * 0.7 + squall.severity * 0.55 - regime.clearBonus * regime.weight * 0.7, 0, 1);
    this.rain = clamp((front.severity * 0.6 + squall.severity * 0.95) * (0.35 + 0.65 * this.cloudCover), 0, 1);
    this.storm = clamp(
      0.12 + storminess * 0.5
      + 0.22 * (this.windSpeed / 22)
      + 0.30 * this.cloudCover
      + 0.35 * this.rain
      + 0.20 * squall.severity
      - regime.clearBonus * regime.weight * 0.35,
      0, 1);

    const hazeAmt = regime.hazeAmt * regime.weight;
    const fogAmt = near * dayBump(hour, 4.5, 1.6) * clamp(1 - this.windSpeed / 5, 0, 1) * (1 - storminess * 0.6);
    const visHaze = lerp(28000, 6000, hazeAmt);
    const visRain = lerp(28000, 700, this.rain);
    const visFog = lerp(28000, 250, fogAmt);
    this.visibility = clamp(Math.min(visHaze, visRain, visFog), 100, 30000);

    /* sea state: chase an equilibrium Hs set by wind, but climb and
       decay on their own (different!) time constants — this is the
       "fetch and duration" lag; and let its direction lag behind the
       wind's, so a sea keeps arriving from where the wind USED to be. */
    const hsTarget = hsEquilibrium(this.windSpeed);
    const tau = hsTarget > this.seaState.hs
      ? 600 + 60 * hsTarget          // building takes longer for a bigger sea
      : 1800 + 400 * this.seaState.hs; // and a bigger sea takes far longer to lie down
    this.seaState.hs = clamp(this.seaState.hs + (hsTarget - this.seaState.hs) * (1 - Math.exp(-dt / tau)), 0.05, 9);
    this.seaState.period = clamp(3.0 + 1.15 * Math.sqrt(this.seaState.hs), 1.5, 14);

    const tauDir = 900 + this.seaState.hs * 300;
    const kDir = 1 - Math.exp(-dt / tauDir);
    this._seaDirX += (Math.cos(this.windDir) - this._seaDirX) * kDir;
    this._seaDirZ += (Math.sin(this.windDir) - this._seaDirZ) * kDir;
    const mag = Math.hypot(this._seaDirX, this._seaDirZ) || 1;
    this._seaDirX /= mag; this._seaDirZ /= mag;
    this.seaState.dirDeg = Math.atan2(this._seaDirZ, this._seaDirX) / D2R;

    /* headline event, most urgent first */
    if (squall.active && squall.severity > 0.03) {
      const e = this._eventOut; e.type = 'squall'; e.phase = squall.phase; e.eta = squall.eta; e.severity = squall.severity;
      this.event = e;
    } else if (front.active && front.severity > 0.03) {
      const e = this._eventOut; e.type = 'front'; e.phase = front.phase; e.eta = Math.max(0, front.eta); e.severity = front.severity;
      this.event = e;
    } else if (fogAmt > 0.35 || (near > 0 && this.windSpeed < 2.5 && dayBump(hour, 4.5, 1.6) > 0.5)) {
      const e = this._eventOut; e.type = 'calm'; e.phase = 'lull'; e.eta = 0; e.severity = clamp(fogAmt, 0, 1);
      this.event = e;
    } else {
      this.event = null;
    }
  }

  // A short, mutation-free outlook: samples the same stateless functions
  // at a future point in time. Sea state itself isn't forecast (it
  // depends on the wind history between now and then) — only its
  // expected direction of travel (rising/falling) is reported.
  forecast(minutes) {
    const horizon = Math.max(1, minutes || 60) * 60;
    const t0 = 0, tf = horizon; // relative; caller only ever sees "now" vs "+horizon" from the live state
    const out = this._forecastOut;
    const nowElapsed = this._lastElapsed || 0;
    const future = nowElapsed + horizon;

    const f = { active: false, severity: 0, pressureDip: 0, dirShiftDeg: 0, eta: 1e9, phase: 'clear' };
    const s = { active: false, severity: 0, dirShiftDeg: 0, eta: 1e9, phase: 'clear' };
    sampleFront(this.seed, this.storminess, future, f);
    sampleSquall(this.seed, this.storminess, false, future, s);

    const pFuture = this._pressureBase
      + noise1(future / 5400, this.seed * 2 + 1) * (3 + this.storminess * 9)
      + noise1(future / 1800, this.seed * 2 + 2) * (1.5 + this.storminess * 4)
      + f.pressureDip;

    out.pressure = this.pressure;
    out.pressureTrend = pFuture - this.pressure;
    out.windSpeed = this.windSpeed; // best simple estimate; no confident future value without simulating forward
    out.front = f.active ? { eta: f.eta, phase: f.phase, severity: f.severity } : null;
    out.squall = s.active ? { eta: s.eta, phase: s.phase, severity: s.severity } : null;
    out.summary = out.pressureTrend < -1.5 ? 'glass falling — wind and a shift likely'
      : out.pressureTrend > 1.5 ? 'glass rising — easing behind whatever passes'
      : 'little change expected';
    return out;
  }
}
