/* ────────────────────────────────────────────────────────────────
   The air itself. A GAME model of a Mediterranean summer (and the
   gale that occasionally interrupts it), not a climate simulation —
   every formula below is a standard, cheap meteorological
   approximation (Bolton's vapour-pressure fit, a Newton's-law-of-
   cooling wind chill, a humidex-style heat index, moist-air density
   from partial pressures) chosen because its SHAPE is right and it
   never needs an iterative solver, not because it is a textbook.
   Pure math, no imports, no allocation once update() has run once —
   fx/aero.js, strikes.js and physiology.js can all read the public
   fields every frame without any of them owning this module.

   The throughline the brief asked for: heat and cold are not just a
   HUD readout, they cost the body something. That cost is exposed
   as `strain`, shaped so main.js can hand it straight to Cardio and
   Survival — see the field-by-field notes below `strain`'s block.
   ──────────────────────────────────────────────────────────────── */

function clamp(x, a, b){ return x < a ? a : (x > b ? b : x); }
function lerp(a, b, t){ return a + (b - a) * t; }

// Smooth toward a target with a time constant — exp(-dt/tau), so it
// never overshoots and is stable for any dt >= 0. Same shape as the
// one in physiology.js; duplicated rather than imported so this file
// stays a zero-dependency leaf module.
function approach(cur, target, dt, tau){
  if(tau <= 1e-6) return target;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}
function smoothstep(x, a, b){
  if(a === b) return x < a ? 0 : 1;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}

// deterministic PRNG (mulberry32) — kept for API parity with the rest
// of the sim (seeded, reproducible) even though nothing here currently
// needs randomness beyond what the weather module already supplies.
function mulberry32(seed){
  let s = seed >>> 0;
  return function(){
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Bolton (1980) saturation vapour pressure over liquid water, hPa —
// good to ~0.1% across -30..+35C, which is everything this game sees.
function satVaporPressure(tC){
  return 6.112 * Math.exp((17.67 * tC) / (tC + 243.5));
}
// Inverse of the same fit: dew point from actual vapour pressure (hPa).
function dewPointFromVaporPressure(e){
  const ln = Math.log(Math.max(1e-6, e) / 6.112);
  return (243.5 * ln) / (17.67 - ln);
}

// A single climate preset is all this game needs; kept as a table
// (rather than inlined numbers) so a future mode ("aegean-winter"?)
// is a one-line addition, not a rewrite.
const CLIMATES = {
  mediterranean: { tMean: 27, tRange: 9, rhMean: 58, rhRange: 22 },
};

export class Atmosphere {
  constructor(opts = {}){
    this.climate = CLIMATES[opts.climate] || CLIMATES.mediterranean;
    this.seaTempC = opts.seaTempC ?? 24.5;     // Aegean-in-August surface temp
    this._rand = mulberry32(opts.seed ?? 0xA53CFEED);

    this._hour = 12;

    // smoothed state (see update() for why each has its own tau)
    this.tempC = this.seaTempC + 1.2;
    this.humidity = this.climate.rhMean;
    this._pNow = 1013.25;
    this._pWas = 1013.25;

    // public outputs — populated on first update(), given sane
    // pre-update defaults here so nothing reads undefined/NaN
    this.pressure = 1013.25;
    this.pressureTrend = 0;         // hPa, see update() — a legible proxy, not a true derivative
    this.dewPointC = this.tempC - 5;
    this.vaporPressureHpa = 0;
    this.density = 1.20;
    this.speedOfSound = 343;
    this.windChillDryC = this.tempC;
    this.windChillC = this.tempC;
    this.heatIndex = this.tempC;
    this.apparentTempC = this.tempC;
    this.fogRisk = 0;
    this.extinction = 0.08;
    this.windEffMs = 6;

    // mutated in place every frame — never reallocated, so callers can
    // hold a reference to `atmosphere.strain` for its whole lifetime
    this.strain = { cardio: 0, coldExposure: 0, thermal: 0, dehydrationRate: 1 };
  }

  update(dt, ctx = {}){
    if(!(dt > 0) || !isFinite(dt)) dt = 1/60;
    dt = clamp(dt, 0, 0.25);          // defensive only; spec range is 1/240..1/20

    const hour = ((ctx.hour ?? this._hour) % 24 + 24) % 24;
    this._hour = hour;

    const w = ctx.weather;            // weather.js — consumed defensively, may not exist yet
    const pressureIn = clamp(w?.pressure ?? 1013.25, 870, 1085);
    const gust = Math.max(0, w?.gust ?? 0);
    // Gusts matter for what a body actually feels, even though they're
    // brief; blend a fraction of gust into the "effective" wind used
    // below rather than tracking a whole separate gust-chill pulse.
    const windMs = Math.max(0, (w?.windSpeed ?? 6) + 0.4 * gust);
    this.windEffMs = windMs;
    const stormIn = clamp(w?.storm ?? 0, 0, 1);
    const rainIn = clamp(w?.rain ?? 0, 0, 1);
    const cloudIn = clamp(w?.cloudCover ?? 0.3, 0, 1);
    const altitude = Math.max(0, ctx.altitude ?? 0);
    const nearLand = typeof ctx.nearLand === 'number' ? clamp(ctx.nearLand, 0, 1) : (ctx.nearLand ? 1 : 0);
    const exertion = clamp(ctx.exertion ?? 0, 0, 1);
    const wet = clamp(ctx.playerWet ?? 0, 0, 1);

    /* ── pressure: the value, and — what a sailor actually reads — its
       trend. Rather than a per-frame finite difference (which at up to
       120Hz would be almost pure noise), track two EMAs at very
       different time constants and take their gap. It's a proxy for
       "how far the barometer has moved in the last few hours," not a
       calculus derivative, and that's exactly the granularity a glance
       at a barometer gives you. */
    this._pNow = approach(this._pNow, pressureIn, dt, 300);       // ~5 min: filters frame/gust noise
    this._pWas = approach(this._pWas, this._pNow, dt, 10800);     // ~3 h lag reference
    this.pressure = this._pNow;
    this.pressureTrend = this._pNow - this._pWas;

    /* ── temperature: diurnal cycle, moderated by how much open sea vs
       land is under the player (water's heat capacity flattens the
       swing enormously — a boat offshore barely feels day/night, an
       island shore bakes and then chills), a dry-adiabatic-ish lapse
       rate for anyone up a hillside, and a storm/rain downdraught. The
       downdraught isn't its own state machine — it rides the same
       smoothing below with a faster "cooling" time constant than
       "warming," which is exactly the asymmetry a squall's gust front
       has: the cold air arrives in seconds, the warmth back takes
       longer to reassert itself. */
    const hourMin = 3;             // coolest just before dawn
    const phase = (hour - hourMin) / 24 * Math.PI * 2;
    const tempDiurnal = -Math.cos(phase);        // -1 at hourMin, +1 twelve hours later
    const humidityDiurnal = Math.cos(phase);      // anti-phase: driest when hottest

    const diurnalMean = lerp(this.seaTempC + 1.4, this.climate.tMean, nearLand);
    const diurnalRange = lerp(2.6, this.climate.tRange, nearLand);
    const tempTarget = diurnalMean + 0.5 * diurnalRange * tempDiurnal
                        - 0.0065 * altitude
                        - 6.0 * stormIn - 3.0 * rainIn;
    this.tempC = approach(this.tempC, tempTarget, dt, tempTarget < this.tempC ? 12 : 40);

    const rhMeanEff = lerp(72, this.climate.rhMean, nearLand);
    const rhRangeEff = lerp(10, this.climate.rhRange, nearLand);
    const humidityTarget = clamp(
      rhMeanEff + 0.5 * rhRangeEff * humidityDiurnal + 30 * rainIn + 10 * stormIn, 8, 100);
    this.humidity = approach(this.humidity, humidityTarget, dt, humidityTarget > this.humidity ? 15 : 50);

    /* ── humidity/dew point, from the same Bolton fit both ways */
    const tSafe = clamp(this.tempC, -40, 55);
    const es = satVaporPressure(tSafe);                 // saturation vapour pressure at air temp
    const RH = clamp(this.humidity, 1, 100);
    const e = RH / 100 * es;                            // actual vapour pressure, hPa
    this.vaporPressureHpa = e;
    this.dewPointC = dewPointFromVaporPressure(e);

    /* ── moist-air density: partial pressures of dry air and water
       vapour, each through its own gas constant. Water vapour (M≈18)
       is LIGHTER than the N2/O2 mix it displaces (M≈29) — so humid air
       is less dense than dry air at the same pressure and temperature,
       the counterintuitive one the brief asked for. The effect is
       small (a percent or so even in a Mediterranean summer) but it is
       real and it is what fx/aero.js should multiply its drag by. */
    const Tk = this.tempC + 273.15;
    const Rd = 287.05, Rv = 461.5;
    const pd_pa = (this.pressure - e) * 100, pv_pa = e * 100;
    this.density = pd_pa / (Rd * Tk) + pv_pa / (Rv * Tk);

    /* ── speed of sound: 331.3*sqrt(Tv/273.15), using virtual
       temperature so the same humidity that lightens the air also
       (correctly, if subtly) speeds sound through it a hair. */
    const mixRatio = 0.622 * e / Math.max(1e-3, this.pressure - 0.378 * e);
    const Tv = Tk * (1 + 0.61 * mixRatio);
    this.speedOfSound = 331.3 * Math.sqrt(Math.max(0, Tv) / 273.15);

    /* ── wind chill: not the NWS chart (which is only defined/valid
       below ~10C), but the same physics it's built on — forced
       convection raises the effective heat-transfer coefficient with
       roughly sqrt(wind), which is equivalent to saying the body loses
       heat as though the still-air temperature were colder than it is.
       Calibrated against the NWS chart at a couple of points (0C/36kph
       and 0C/72kph) rather than derived from first principles, because
       "matches the chart people already trust" beats "derived." */
    const SKIN_C = 33;
    const convRatio = 1 + 0.075 * Math.sqrt(windMs);
    this.windChillDryC = SKIN_C - convRatio * (SKIN_C - this.tempC);

    /* ── wet skin is the real threat: evaporating water pulls heat far
       faster than dry convection, scaled by the vapour-pressure DEFICIT
       (how much drier the air is than saturated skin) and by wind
       (which sweeps the evaporating boundary layer away and lets more
       water evaporate). This is why a sailor soaked to the skin in a
       stiff breeze can be in real trouble on a day that would otherwise
       be pleasant — dry-bulb temperature alone hides it completely. */
    const esSkin = satVaporPressure(SKIN_C);
    const vpdKpa = Math.max(0, esSkin - e) / 10;
    const evapCoolC = clamp(1.3 * Math.sqrt(windMs) * vpdKpa, 0, 14);
    this.windChillC = this.windChillDryC - evapCoolC * wet;

    /* ── heat side: a humidex-style apparent temperature — humidity
       makes the air feel hotter because it caps how fast sweat can
       evaporate, which is the entire mechanism, so folding vapour
       pressure straight in (rather than relative humidity) is the
       physically honest version of "feels like." */
    this.heatIndex = this.tempC + Math.max(0, 0.5555 * (e - 10));

    // Below ~18C nobody's "feels-like" complaint is about heat; above
    // ~24C it isn't about wind chill. Blend across the gap so the HUD
    // number doesn't visibly kink at the crossover.
    const coldWeight = 1 - smoothstep(this.tempC, 18, 24);
    this.apparentTempC = lerp(this.heatIndex, this.windChillC, coldWeight);

    /* ── fog: two real mechanisms, either one enough to fog you in.
       (1) the air is simply close to saturation already (its own dew
       point is within a couple of degrees of its temperature) — night
       radiation fog. (2) moist air is advected over water cooler than
       its dew point and condenses on contact — the classic sea fog,
       which is why it's checked against seaTempC and not air temp.
       Wind breaks either kind up by mixing the saturated layer with
       drier air above it. */
    const satGap = this.tempC - this.dewPointC;
    const nearSat = clamp(1 - satGap / 4, 0, 1);
    const seaGap = this.dewPointC - this.seaTempC;
    const seaFog = smoothstep(seaGap, -1, 2);
    const windClears = 1 - clamp(windMs / 22, 0, 1);
    this.fogRisk = clamp(Math.max(nearSat * 0.85, seaFog) * (0.35 + 0.65 * windClears), 0, 1);

    /* ── extinction: haze the renderer's fog can use directly. Aerosol
       scattering (mostly hygroscopic growth of salt/dust particles)
       climbs sharply above ~55% RH, rain washes it back out, low cloud
       scatters a bit of its own, and actual fog dominates everything
       once it's forming. */
    const hazeRH = smoothstep(this.humidity, 55, 95);
    this.extinction = clamp(0.04 + 0.30 * hazeRH * (1 - 0.5 * rainIn) + 0.10 * cloudIn + 0.55 * this.fogRisk, 0.02, 1);

    /* ── strain: what the air costs the body. See field notes below —
       this is the block the brief specifically asked for, and it's
       written to be handed straight into Cardio.update()/Survival.update(). */

    // cardio: heat-driven cardiovascular load, at REST (no dehydration
    // term — Cardio already derives that from ctx.water on its own).
    // Cutaneous vasodilation to dump heat competes with central/venous
    // return; the body compensates with tachycardia exactly the way it
    // compensates for early hypovolemia. High humidity makes it worse
    // out of proportion to temperature alone because it's specifically
    // an evaporation-failure mechanism — sweat that doesn't evaporate
    // cools nothing, so the compensation has to work harder for the
    // same core heat load. Exertion adds metabolic heat on top.
    const heatLoad = smoothstep(this.heatIndex, 27, 40);
    const evapImpair = smoothstep(this.humidity, 50, 95);
    const heatDrive = clamp(heatLoad * (1 + 0.4 * evapImpair) * (1 + 0.6 * exertion), 0, 1.2);

    // coldExposure: replaces the ad-hoc 0/0.35/1 the game currently
    // hardcodes for ctx.cold (see main.js's updateCardio). Same 0..1.4
    // scale Cardio already expects, driven by the wet-skin wind chill
    // rather than a mode flag, so a calm hostile-mode swim and a windy
    // easy-mode one are told apart instead of both reading "1".
    const coldExposure = clamp((18 - this.windChillC) / 18, 0, 1.4);

    // thermal: one 0..1 "how much is the climate costing you right
    // now" scalar for UI/vignette-type consumers that don't want two
    // separate hot/cold numbers to reconcile themselves.
    const thermal = clamp(Math.max(heatDrive, coldExposure * 0.85), 0, 1);

    // dehydrationRate: a multiplier on the water bar's base drain.
    // Warmer air raises sweat drive; wind raises evaporative demand
    // (this is why a hot dry gale is the worst case, not the stillest
    // hottest day); humidity suppresses evaporation, which — counter-
    // intuitively for "feels worse" — actually means LESS water is lost
    // to it per unit time even though cooling fails, because sweat that
    // sits on the skin instead of evaporating isn't being replaced as
    // fast. Exertion still gets its own multiplier since that's a
    // player-input signal, not an atmospheric one.
    const dehydrationRate = clamp(
      (1 + 0.05 * (this.tempC - 20)) *
      (1 + 0.03 * Math.sqrt(windMs)) *
      (1 - 0.25 * clamp((this.humidity - 40) / 60, 0, 1)) *
      (1 + 0.6 * exertion),
      0.25, 4.0);

    this.strain.cardio = heatDrive;
    this.strain.coldExposure = coldExposure;
    this.strain.thermal = thermal;
    this.strain.dehydrationRate = dehydrationRate;
  }

  /* A short human-readable line — a barometer/weather-glass readout. */
  describe(){
    const p = Math.round(this.pressure);
    const trend = this.pressureTrend > 0.6 ? 'rising' : this.pressureTrend < -0.6 ? 'falling' : 'steady';
    const t = Math.round(this.tempC);
    const damp = this.humidity > 75 ? ', close' : this.humidity < 35 ? ', dry' : '';
    const fog = this.fogRisk > 0.5 ? ' — fog banking up' : this.fogRisk > 0.2 ? ' — haze thickening' : '';
    return `${p} hPa, ${trend} · ${t}°C${damp}${fog}`;
  }
}
