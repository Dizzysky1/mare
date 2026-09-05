/* ────────────────────────────────────────────────────────────────
   The player's eyes, simulated. A GAME model of optics, not clinical
   optometry: every formula below is chosen because its SHAPE matches
   real physiological optics (defocus, pupil-driven depth of field,
   dark adaptation, dichromacy), not because it would survive a peer
   review. Pure math except for the GLSL string at the bottom — no
   THREE import needed, nothing here owns three.js state.

   THE CENTRAL CLAIM: the simulation knows the character's exact
   dioptric error; the player never sees that number. Every public
   method translates it into a perceptual consequence — a blur
   radius, a yes/no on "can you make that out", a colour a protanope
   would actually see — and postUniforms()/VISION_GLSL turn that into
   pixels.

   ── the pupil correction, and why the brief's framing had it backwards ──
   Angular blur from an uncorrected refractive error is, to a very
   good small-angle approximation, the aperture diameter TIMES the
   dioptric defocus: θ_blur (rad) ≈ A(m) × Δ(D). This is the standard
   physiological-optics result for the circle of confusion (it is the
   same relation a camera's depth-of-field follows — an f/16 pinhole
   has enormous depth of field, an f/1.4 lens has almost none — the
   eye is just an aperture with a retina behind it). Since the pupil
   CONSTRICTS in bright light and DILATES in the dark, that means an
   uncorrected refractive error blurs the world MORE at night (dilated
   pupil, big blur circle) and LESS in daylight (constricted pupil,
   small blur circle) — the opposite of "worse in bright light". This
   file follows the physics, not the flipped framing: acuity for an
   uncorrected eye is at its best at noon and at its worst at dusk,
   which is also exactly why the pinhole occluder (below) works at all,
   and exactly why it stops working after dark — same equation, same
   aperture term, just forced small instead of left to the light level.
   ──────────────────────────────────────────────────────────────── */

function clamp(x, a, b){ return x < a ? a : (x > b ? b : x); }
function lerp(a, b, t){ return a + (b - a) * t; }
function smoothstep(x, a, b){
  if(a === b) return x < a ? 0 : 1;
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
}
// exp(-dt/tau) approach — stable for any dt, never overshoots. Same
// shape used throughout the sim (atmosphere.js, physiology.js); kept
// local so this stays a zero-dependency leaf module.
function approach(cur, target, dt, tau){
  if(tau <= 1e-6) return target;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}
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

/* ── constants, each with the reasoning it stands on ──────────────── */

// Pupil diameter vs. light level. Real pupils run ~2mm (bright sun) to
// ~7-8mm (full dark) — the de Groot & Gebhard (1952) luminance/pupil
// curve has this shape; we don't track cd/m² anywhere in this game, so
// `lightLevel` (0 dark..1 bright) stands in for log-luminance and the
// exponent is picked to match the curve's knee, not fitted to data.
const PUPIL_MIN_MM = 2.2, PUPIL_MAX_MM = 7.6;
const PUPIL_MAX_M = PUPIL_MAX_MM/1000;
// Miosis (constriction) is a fast reflex (~0.2-0.5s); mydriasis
// (dilation) is the slower recovery once the light drops. Same
// asymmetry the brief's flash mechanic needs.
const PUPIL_CONSTRICT_TAU = 0.25, PUPIL_DILATE_TAU = 3.0;

// Accommodation reserve. Hofstetter's classic clinical regression
// (amplitude ≈ 18.5 − 0.30×age) is the standard estimate; we default
// to its value around age 25 when no age is available and apply the
// formula itself when the character carries one. This is what lets a
// mild myope read a logbook at arm's length with zero effective blur.
const ACCOM_DEFAULT_D = 9;
function hofstetterAmplitude(age){ return clamp(18.5 - 0.30*age, 1, 14); }

// Baseline (non-defocus) angular resolution: ~1 arcminute is the
// textbook photopic (cone/foveal) acuity limit; scotopic (rod, no
// fovea to lean on) vision is far coarser — this is a ballpark, not a
// measured constant, but the ORDER of magnitude (~10-15x worse) is right.
const RES_PHOTOPIC_RAD = 0.00029;   // 1 arcmin
const RES_SCOTOPIC_RAD = 0.0045;    // ~15 arcmin

// Dark adaptation. Real rod dark-adaptation takes 20-30 real minutes
// to complete; compressed here for pacing (a player should feel eyes
// adjust within a scene, not across a coffee break) while keeping the
// asymmetry that matters: adapting UP is slow, bleaching back DOWN
// from a bright light is fast (seconds).
const DARK_ADAPT_TAU = 420, LIGHT_ADAPT_TAU = 2.5;
const NIGHT_ADAPT_GAIN = 6;         // effective sensitivity gain once fully dark-adapted
const DAZZLE_DECAY = 1.6;           // seconds for post-flash glare to fade
const LIGHT_FLOOR = 0.018;          // below this proxy, nothing resolves — "too dark, full stop"

// The pinhole occluder. ~1-1.5mm is the practical range (smaller
// starts losing MORE to diffraction than it gains from defocus
// correction; bigger stops being a pinhole). We use 1.3mm.
const PINHOLE_M = 0.0013;
const PINHOLE_VIGNETTE = 0.62;      // tunnel-vision cost, see report — a pinhole is a soda straw, not a lens

// Obstruction kinetics — all tuned for "reads as the right mechanism
// in a play session", not measured off a real pair of glasses.
const DROPLET_RATE_RAIN = 0.20, DROPLET_RATE_SPRAY = 0.14, DROPLET_DRY_RATE = 0.02;
const SALT_RATE = 0.010;
const FOG_RATE = 0.55, FOG_CLEAR_RATE = 0.10;
const LENS_THERMAL_TAU = 35;        // lenses have real (if small) thermal mass
const FACE_WARMTH_C = 1.0;          // worn glasses sit a few cm from a ~34C face — offsets a little of the radiative chill below, not all of it
const WIPE_DURATION = 1.35;         // seconds, occupies a hand — the game must check `.wiping`

// Colour-deficiency simulation matrices, 100%-severity dichromat case
// (Machado, Oliveira & Fairchild 2009 — the standard real-time
// colour-blindness simulation transform; applied directly to display
// RGB, which is the usual real-time approximation rather than a full
// LMS round-trip). Row-major 3x3, flattened.
const CM_IDENTITY = [1,0,0, 0,1,0, 0,0,1];
const CM_PROTAN = [
  0.152286, 1.052583, -0.204868,
  0.114503, 0.786281,  0.099216,
 -0.003882, -0.048116,  1.051998];
const CM_DEUTAN = [
  0.367322, 0.860646, -0.227968,
  0.280085, 0.672501,  0.047413,
 -0.011820, 0.042940,  0.968881];

function lerpMat(a, b, t, out){
  for(let i = 0; i < 9; i++) out[i] = a[i] + (b[i]-a[i])*t;
  return out;
}

export class Vision {
  constructor(character = {}, opts = {}){
    const v = character.vision || {};
    // consumed defensively — character.js is being built in parallel
    this.rightSphere = Number.isFinite(v.rightSphere) ? v.rightSphere : 0;
    this.leftSphere  = Number.isFinite(v.leftSphere)  ? v.leftSphere  : 0;
    const avgAbs = (Math.abs(this.rightSphere)+Math.abs(this.leftSphere))*0.5;
    this.needsCorrection = v.needsCorrection ?? (avgAbs > 0.5);
    // `dependence` isn't fully specified upstream yet — treated here as a
    // 0..1 multiplier on how much the uncorrected error actually costs
    // (a stand-in for astigmatism/higher-order aberrations this file
    // doesn't otherwise model), defaulted from sphere magnitude if absent.
    this.dependence = clamp(v.dependence ?? smoothstep(avgAbs, 0.5, 4.0), 0, 1);
    this.colourVision = v.colourVision || 'normal';    // 'normal' | 'protan(opia|omaly)' | 'deutan(opia|omaly)'
    this.nightVisionTrait = clamp(v.nightVision ?? 1, 0.15, 1.6);

    this.accommodationD = Number.isFinite(character.age) ? hofstetterAmplitude(character.age) : ACCOM_DEFAULT_D;

    // glasses as a real object
    this.hasGlasses = opts.hasGlasses ?? this.needsCorrection;
    this.glassesOn  = opts.glassesOn  ?? this.hasGlasses;
    this.isSpares = false;
    this.prescription = { rightSphere: this.rightSphere, leftSphere: this.leftSphere };
    this.obstruction = { droplets: 0, fog: 0, salt: 0, scratches: opts.scratches || 0 };

    this._pinholeOn = false;
    this._wiping = false; this._wipeT = 0; this._wipeFreshWater = false;

    this._pupilMm = PUPIL_MAX_MM*0.55;
    this._darkAdapt = 0;
    this._dazzle = 0;
    this._lensTempC = 24;
    this._lightLevel = 0.6;          // cached each update() for canResolve()'s light-floor gate
    this._fovRad = (opts.fovDeg ?? 55) * Math.PI/180;

    this._rand = mulberry32((opts.seed ?? 0x1ce5eed) >>> 0);
    this._lensSeed = this._rand()*1000;
    this._lastLossReason = null;

    this._colourMatrix = new Array(9);
    this._buildColourMatrix();

    this.acuity = 1;
    // reused every call — postUniforms() never allocates
    this._uOut = {
      uBlur:0, uBlurNear:0, uDroplets:0, uFog:0, uSalt:0, uScratches:0,
      uVignette:0, uExposureMul:1, uSatMul:1, uColourMatrix:this._colourMatrix,
      uDazzle:0, uLensSeed:this._lensSeed,
    };
  }

  _buildColourMatrix(){
    const c = String(this.colourVision).toLowerCase();
    let base = CM_IDENTITY, severity = 1;
    if(c.startsWith('protan')) base = CM_PROTAN;
    else if(c.startsWith('deutan')) base = CM_DEUTAN;
    else severity = 0;
    if(c.endsWith('omaly')) severity = 0.55;   // anomalous trichromat: partial, not a full dichromat
    lerpMat(CM_IDENTITY, base, severity, this._colourMatrix);
  }

  setFov(deg){ this._fovRad = deg * Math.PI/180; }

  /* ── the optics pipeline ──────────────────────────────────────── */

  // defocus in dioptres at distance u(m): accommodation cancels it up
  // to `amp` reserve; beyond that (too far for a myope, too close for
  // anyone) residual defocus is what's left over. See header comment.
  _defocusD(sphereD, uM, ampD){
    const demand = 1/uM + sphereD;
    return Math.max(0, -demand) + Math.max(0, demand - ampD);
  }

  // Sphere actually driving blur right now: raw error, corrected by
  // whatever's on the face (own glasses cancel it exactly; spares
  // leave a residual if the power doesn't match), or untouched under
  // a pinhole — the pinhole fixes blur through the APERTURE term
  // instead, which is the physically honest version of "works
  // regardless of refractive error."
  _effectiveSphere(){
    const avgSphere = (this.rightSphere + this.leftSphere)*0.5;
    if(this.glassesOn && this.hasGlasses){
      const avgCorr = (this.prescription.rightSphere + this.prescription.leftSphere)*0.5;
      return (avgSphere - avgCorr) * (0.4 + 0.6*this.dependence);
    }
    return avgSphere * (0.4 + 0.6*this.dependence);
  }

  _apertureM(){ return this._pinholeOn ? PINHOLE_M : this._pupilMm/1000; }

  _obstructionBlurRad(){
    const o = this.obstruction;
    // droplets/fog/salt/scratches scatter light independent of pupil
    // size, so they add their own (small) angular blur term rather
    // than scaling with aperture the way defocus does.
    return o.droplets*0.006 + o.fog*0.015 + o.salt*0.004 + o.scratches*0.003;
  }

  // The honest, distance-dependent answer: angular blur-circle
  // diameter in milliradians, combining defocus (aperture × dioptres)
  // with obstruction blur in quadrature (independent smear sources).
  blurAt(distanceM){
    const u = Math.max(0.05, distanceM);
    const defocusD = this._defocusD(this._effectiveSphere(), u, this.accommodationD);
    const defocusRad = this._apertureM() * defocusD;
    const obstructRad = this._obstructionBlurRad();
    return Math.sqrt(defocusRad*defocusRad + obstructRad*obstructRad) * 1000;
  }

  _baselineResRad(){
    const base = lerp(RES_PHOTOPIC_RAD, RES_SCOTOPIC_RAD, this._darkAdapt);
    return base * (1 + this._dazzle*3);   // glare scatters light across the retina, coarsening everything briefly
  }

  _lightStarved(){
    const apertureRatio = this._apertureM()/PUPIL_MAX_M;
    const gatherArea = apertureRatio*apertureRatio;          // light ∝ aperture area ∝ diameter²
    const adaptGain = 1 + this._darkAdapt*(NIGHT_ADAPT_GAIN-1)*this.nightVisionTrait;
    return (this._lightLevel*gatherArea*adaptGain) < LIGHT_FLOOR;
  }

  // Can this character actually resolve an object of `sizeM` at
  // `distanceM` — the gameplay hook. Never exposes a number; answers
  // the question the brief asked for directly.
  canResolve(sizeM, distanceM){
    if(this._lightStarved()) return false;
    const u = Math.max(0.5, distanceM);
    const angularObj = sizeM/u;
    const blurRad = this.blurAt(u)/1000;
    const combined = Math.sqrt((blurRad*0.5)*(blurRad*0.5) + this._baselineResRad()**2);
    return angularObj >= combined;
  }

  // A rough optical distinguishability check for the colour-blindness
  // consequence the brief asked for (a red/green nav light, a banded
  // marker) — transform both colours the way the shader does and
  // compare. `rgb` is [r,g,b] 0..1 linear-ish; threshold is tuned, not measured.
  canDistinguish(rgbA, rgbB, threshold = 0.12){
    const m = this._colourMatrix;
    const tA = [m[0]*rgbA[0]+m[1]*rgbA[1]+m[2]*rgbA[2], m[3]*rgbA[0]+m[4]*rgbA[1]+m[5]*rgbA[2], m[6]*rgbA[0]+m[7]*rgbA[1]+m[8]*rgbA[2]];
    const tB = [m[0]*rgbB[0]+m[1]*rgbB[1]+m[2]*rgbB[2], m[3]*rgbB[0]+m[4]*rgbB[1]+m[5]*rgbB[2], m[6]*rgbB[0]+m[7]*rgbB[1]+m[8]*rgbB[2]];
    const d = Math.hypot(tA[0]-tB[0], tA[1]-tB[1], tA[2]-tB[2]);
    return d >= threshold;
  }

  /* ── update ───────────────────────────────────────────────────── */

  update(dt, ctx = {}){
    if(!(dt > 0) || !isFinite(dt)) dt = 1/60;
    dt = clamp(dt, 0, 0.25);

    const weather = ctx.weather, atmosphere = ctx.atmosphere;
    const playerState = ctx.playerState || 'deck';
    const wet = clamp(ctx.wet ?? 0, 0, 1);
    const lightLevel = clamp(ctx.lightLevel ?? 0.6, 0, 1);
    this._lightLevel = lightLevel;
    this.glassesOn = (ctx.wearingGlasses ?? this.glassesOn) && this.hasGlasses;
    this._pinholeOn = !!(ctx.usingPinhole ?? this._pinholeOn);

    // pupil: light-driven aperture with the constrict-fast/dilate-slow asymmetry
    const pupilTarget = PUPIL_MIN_MM + (PUPIL_MAX_MM-PUPIL_MIN_MM)*Math.pow(1-lightLevel, 1.6);
    this._pupilMm = approach(this._pupilMm, pupilTarget, dt,
      pupilTarget < this._pupilMm ? PUPIL_CONSTRICT_TAU : PUPIL_DILATE_TAU);

    // dark adaptation: slow climb in the dark, fast bleach in the light
    const scotopicTarget = lightLevel < 0.18 ? Math.min(1, this.nightVisionTrait) : 0;
    const tauAdapt = scotopicTarget > this._darkAdapt ? DARK_ADAPT_TAU/Math.max(0.25, this.nightVisionTrait) : LIGHT_ADAPT_TAU;
    this._darkAdapt = approach(this._darkAdapt, scotopicTarget, dt, tauAdapt);
    this._dazzle = Math.max(0, this._dazzle - dt/DAZZLE_DECAY);

    // wiping occupies a hand for a moment, then resolves
    if(this._wiping){
      this._wipeT += dt;
      if(this._wipeT >= WIPE_DURATION) this._finishWipe();
    }

    // obstruction accumulation — only while the glasses are actually worn
    if(this.glassesOn){
      const rain = clamp(weather?.rain ?? 0, 0, 1);
      const windMs = Math.max(0, weather?.windSpeed ?? 0);
      const gust = Math.max(0, weather?.gust ?? 0);
      const onDeck = playerState === 'deck', swimming = playerState === 'swim';
      const sprayProxy = onDeck ? clamp((windMs+0.5*gust)/16, 0, 1) : (swimming ? 0.6 : 0);

      if(!this._wiping){
        const dropletGain = rain*DROPLET_RATE_RAIN + sprayProxy*DROPLET_RATE_SPRAY*(wet > 0.05 ? 1 : 0.4);
        const dropletDry = DROPLET_DRY_RATE*(1-rain)*(1-sprayProxy);
        this.obstruction.droplets = clamp(this.obstruction.droplets + (dropletGain-dropletDry)*dt, 0, 1);

        const saltGain = (onDeck||swimming) ? SALT_RATE*(0.3+0.7*sprayProxy) : 0;
        this.obstruction.salt = clamp(this.obstruction.salt + saltGain*dt, 0, 1);
      }

      // fog: physically gated on lens temp vs. dew point, not random —
      // and dew point is, by definition, never above air temperature,
      // so an inert lens sitting in ONE stable air mass forever can
      // never fog from that air mass alone (it just equilibrates to
      // it). Two real mechanisms actually get a lens below the dew
      // point: (1) the same radiative cooling that puts dew on grass
      // and windshields overnight — a clear sky is a cold sink, so an
      // exposed lens can sit a degree or two BELOW air temp on a
      // still, cloudless night, which wind breaks up by mixing in
      // warmer air (same windClears logic atmosphere.js uses for sea
      // fog); (2) simple thermal lag (LENS_THERMAL_TAU below) — carry
      // a lens from a cool cabin into warm humid night air and it
      // fogs for exactly as long as it takes to catch up.
      const airT = atmosphere?.tempC ?? 22;
      const dewT = atmosphere?.dewPointC ?? (airT-8);
      const cloud = clamp(weather?.cloudCover ?? 0.3, 0, 1);
      const night = lightLevel < 0.25;
      const radiativeCoolC = night ? Math.max(0, 1.3 + 1.9*(1-cloud) - FACE_WARMTH_C) : 0;
      const lensTarget = airT - radiativeCoolC - wet*1.6;
      this._lensTempC = approach(this._lensTempC, lensTarget, dt, LENS_THERMAL_TAU);
      const gap = dewT - this._lensTempC;
      const windClear = clamp(windMs/14, 0, 1);
      if(gap > 0) this.obstruction.fog = clamp(this.obstruction.fog + FOG_RATE*Math.min(1, gap/2)*(1-0.85*windClear)*dt, 0, 1);
      else this.obstruction.fog = clamp(this.obstruction.fog - FOG_CLEAR_RATE*(1+windMs*0.1)*dt, 0, 1);
    } else {
      // stowed/lost: nothing new lands on them; any fog left just clears
      this.obstruction.fog = clamp(this.obstruction.fog - FOG_CLEAR_RATE*dt, 0, 1);
    }

    this.glassesCondition = this.obstruction; // API-sketch alias, same object
    this.acuity = this._computeAcuity();
  }

  _computeAcuity(){
    const blurMrad = this.blurAt(120);           // "can you read the world around you" reference range
    let a = 1 - clamp(blurMrad/25, 0, 1);         // 25 mrad ≈ total loss of useful distance vision
    const o = this.obstruction;
    a *= (1 - o.droplets*0.35)*(1 - o.fog*0.55)*(1 - o.salt*0.30)*(1 - o.scratches*0.20);
    if(this._lightStarved()) a *= 0.05;           // not literally zero — shapes/lights can still register
    return clamp(a, 0, 1);
  }

  /* ── glasses as an object: wear state, cleaning, damage, loss ──── */

  get wiping(){ return this._wiping; }
  get wipeProgress(){ return this._wiping ? clamp(this._wipeT/WIPE_DURATION, 0, 1) : 0; }

  // freshWater=false: a shirt-hem wipe — clears droplets and some fog,
  // but only smears salt, and grinds it into the lens as scratches if
  // there was enough grit built up. freshWater=true: an actual rinse —
  // clears everything, which is the whole point of the mechanic.
  wipe(freshWater = false){
    if(!this.hasGlasses) return false;
    this._wiping = true; this._wipeT = 0; this._wipeFreshWater = !!freshWater;
    return true;
  }
  _finishWipe(){
    this._wiping = false;
    this.obstruction.droplets = 0;
    if(this._wipeFreshWater){
      this.obstruction.salt = 0;
      this.obstruction.fog = Math.max(0, this.obstruction.fog - 0.4);
    } else {
      if(this.obstruction.salt > 0.35) this.obstruction.scratches = clamp(this.obstruction.scratches + 0.03*this.obstruction.salt, 0, 1);
      this.obstruction.salt = clamp(this.obstruction.salt*0.85, 0, 1);
      this.obstruction.fog = Math.max(0, this.obstruction.fog - 0.25);
    }
  }

  damageGlasses(amount = 0.1){
    if(!this.hasGlasses) return;
    this.obstruction.scratches = clamp(this.obstruction.scratches + amount, 0, 1);
    if(amount >= 0.6 || this.obstruction.scratches >= 1) this.loseGlasses('shattered');
  }

  loseGlasses(reason = 'lost'){
    this.hasGlasses = false; this.glassesOn = false; this._lastLossReason = reason;
  }

  // Salvaged spares: helps if the sign matches and the magnitude is in
  // the ballpark, hurts if the sign is wrong (a myope's correction on
  // a hyperope's eyes, or vice versa, ADDS defocus rather than curing
  // it — see _effectiveSphere, which just subtracts prescribed from
  // actual with no clamping, so a bad match is honestly modelled as
  // worse than nothing).
  wearSpares(prescription = {}){
    this.hasGlasses = true; this.glassesOn = true; this.isSpares = true;
    this.prescription = {
      rightSphere: Number.isFinite(prescription.rightSphere) ? prescription.rightSphere : 0,
      leftSphere:  Number.isFinite(prescription.leftSphere)  ? prescription.leftSphere  : 0,
    };
    // a found pair arrives as itself, not as the sum of your own lens grime
    this.obstruction.droplets = 0; this.obstruction.fog = 0;
    this.obstruction.salt = 0; this.obstruction.scratches = prescription.scratches || 0;
  }

  usePinhole(on){ this._pinholeOn = !!on; }

  // A bright light hitting the eyes: forces a hard bleach (dark
  // adaptation is largely undone) plus a transient dazzle/glare that
  // decays over DAZZLE_DECAY seconds. Not the pupil's own light-level
  // response (that happens continuously in update()) — this is the
  // "someone shone a lamp/flare in your face" event hook.
  flash(intensity = 1){
    intensity = clamp(intensity, 0, 2);
    this._darkAdapt = Math.max(0, this._darkAdapt - intensity*0.9);
    this._dazzle = Math.min(1, this._dazzle + intensity);
  }

  /* ── loss event hooks — plausible mechanisms only.
     Rejected: an aircraft's pressure wave (jet noise ≈200 Pa, an
     extreme sonic boom ≈1000 Pa; across a spectacle lens that's under
     2N — nowhere near enough, and a sonic boom breaks glass through
     PANE RESONANCE, which a lens clamped in a frame doesn't have).
     Modelled instead: violent whole-body events that can shake or
     knock frames off a face, which is the mechanism that actually
     works. Each returns whether the roll lost them, using the seeded
     RNG so a given seed replays identically. ────────────────────── */

  knockdown(severity = 1){
    if(!this.glassesOn) return false;
    if(this._rand() < clamp(0.30*clamp(severity,0,2), 0, 0.85)){ this.loseGlasses('knockdown'); return true; }
    return false;
  }
  blast(impulseNs){
    if(!this.glassesOn) return false;
    if(this._rand() < smoothstep(impulseNs, 40, 350)*0.9){ this.loseGlasses('blown off by the blast'); return true; }
    return false;
  }
  greenWater(intensity = 1){
    if(!this.glassesOn) return false;
    if(this._rand() < clamp(0.22*clamp(intensity,0,2), 0, 0.7)){ this.loseGlasses('green water over the deck'); return true; }
    return false;
  }
  enterWater(suddenness = 0.5){
    if(!this.glassesOn) return false;
    if(this._rand() < clamp(0.10+0.5*clamp(suddenness,0,1), 0, 0.6)){ this.loseGlasses('swept off in the water'); return true; }
    return false;
  }

  /* ── output for the post-processing composite ────────────────── */

  postUniforms(){
    const u = this._uOut;
    const toScreen = (mrad) => clamp((mrad/1000*0.5)/this._fovRad, 0, 0.06); // half-angle / vertical FOV, capped — a few taps only buys so much radius

    u.uBlur = toScreen(this.blurAt(2000));          // distance/background case — this is what the fullscreen pass should use
    u.uBlurNear = toScreen(this.blurAt(0.35));       // reading-distance case — informational, for a held-object/UI element the game renders separately; NOT applied fullscreen (see report)
    u.uDroplets = this.obstruction.droplets;
    u.uFog = this.obstruction.fog;
    u.uSalt = this.obstruction.salt;
    u.uScratches = this.obstruction.scratches;

    u.uVignette = this._pinholeOn ? PINHOLE_VIGNETTE : 0;
    u.uExposureMul = this._pinholeOn ? (PINHOLE_M/(this._pupilMm/1000))**2 : 1;   // light lost to the small aperture, relative to what the natural pupil is doing right now
    u.uSatMul = 1 - this._darkAdapt*0.4;             // rod vision carries little colour information
    u.uColourMatrix = this._colourMatrix;
    u.uDazzle = this._dazzle;
    u.uLensSeed = this._lensSeed;
    return u;
  }

  /* ── prose, never numbers ─────────────────────────────────────── */

  describe(){
    if(this._lightStarved() && this._pinholeOn) return "Cupped hand to your eye, and the dark just swallows everything past it.";
    if(this._lightStarved()) return "Too dark to make anything of it — shapes, maybe, nothing more.";
    if(this.obstruction.fog > 0.55) return "Your lenses have fogged solid; you're looking at the world through milk.";
    if(this.obstruction.droplets > 0.5) return "Rain beads across the glass, breaking every distant light into a smear.";
    if(this.obstruction.salt > 0.6) return "A crust of dried salt has turned the lenses hazy and grey.";
    if(this._pinholeOn) return "Squinting through the pinhole: sharp, narrow, and dim — fine for now, useless once the light goes.";
    if(!this.hasGlasses && this.needsCorrection) return this.dependence > 0.6
      ? "Without your glasses the world past a few paces is little more than colour and motion."
      : "Everything past arm's reach has gone soft at the edges.";
    if(this.isSpares) return "The borrowed glasses help, some — the world isn't quite the right size through them.";
    if(this._darkAdapt > 0.7) return "Your eyes have settled into the dark; colour has mostly drained out of everything.";
    return "Your vision is clear.";
  }
}

/* ────────────────────────────────────────────────────────────────
   GLSL chunk for post.js's composite pass. Self-contained: declare
   the uniforms below on the composite ShaderMaterial, call
   visionApply() once with the already-composited colour, screen uv,
   aspect and time. Cheap on purpose — a 6-tap variable-radius blur,
   procedural fog/scratches (no textures), one 3x3 colour
   multiply. See the report for exactly where this splices into
   post.js's existing comp shader.
   ──────────────────────────────────────────────────────────────── */
export const VISION_GLSL = /* glsl */`
// ── uniforms this chunk needs on the composite material ──
// uniform float uBlur;          // screen-space blur radius (fraction of height), far/background case
// uniform float uDroplets;      // 0..1
// uniform float uFog;           // 0..1
// uniform float uSalt;          // 0..1
// uniform float uScratches;     // 0..1
// uniform float uDazzle;        // 0..1, transient post-flash glare
// uniform float uLensSeed;      // stable per-instance pattern seed
// uniform mat3  uColourMatrix;  // colour-deficiency transform (identity when unaffected)

float vHash21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }

// A handful of taps on a small ring, radius in UV units — this is the
// "a few taps, radius from a uniform" blur the brief asked for, not a
// separable multi-pass gaussian. Good enough for a defocus look at the
// radii this ever reaches (a few % of screen height, capped in JS).
vec3 visionBlur(sampler2D tex, vec2 uv, float radius, float aspect){
  if(radius < 0.0008) return texture2D(tex, uv).rgb;
  vec3 sum = texture2D(tex, uv).rgb;
  float wsum = 1.0;
  const int TAPS = 6;
  for(int i = 0; i < TAPS; i++){
    float a = (float(i)/float(TAPS))*6.28318;
    vec2 o = vec2(cos(a)/aspect, sin(a))*radius;
    sum += texture2D(tex, uv+o).rgb;
    wsum += 1.0;
  }
  return sum/wsum;
}

// Fog: a soft low-frequency mask (denser low/center, where breath and
// contact warmth actually condense first) that both blurs and washes
// out contrast — condensation scatters light, it doesn't tint it.
vec3 visionFog(vec3 col, vec2 uv, float amt){
  if(amt < 0.01) return col;
  float n = vHash21(floor(uv*6.0))*0.5 + vHash21(floor(uv*13.0+11.0))*0.5;
  float mask = clamp(amt*1.3 - 0.15*n + 0.25*(1.0-uv.y), 0.0, 1.0);
  vec3 fogged = mix(col, vec3(dot(col, vec3(0.3333))), 0.85);
  return mix(col, fogged*1.08, mask);
}

// Salt haze: a warm-grey veil that lifts blacks and flattens contrast
// (crusted residue scatters ambient light across the lens) rather than
// blurring outright.
vec3 visionSalt(vec3 col, float amt){
  if(amt < 0.01) return col;
  vec3 veil = vec3(0.62,0.60,0.56);
  return mix(col, mix(col, veil, 0.5), amt*0.6) + veil*amt*0.05;
}

// Scratches: permanent hairline streaks, fixed per lens (seeded), only
// really visible as thin bright/dark lines — subtle, always-on rather
// than glare-gated to keep this a single cheap pass.
vec3 visionScratches(vec3 col, vec2 uv, float amt, float seed){
  if(amt < 0.01) return col;
  vec2 p = uv*vec2(140.0, 90.0);
  float lineU = fract(p.x*0.37 + p.y*0.02 + seed);
  float line = smoothstep(0.0,0.02,lineU)*(1.0-smoothstep(0.03,0.05,lineU));
  float has = step(0.94, vHash21(floor(p.yx*0.15)+seed));
  return col + vec3(line*has*amt*0.35);
}

vec3 visionColour(vec3 col, mat3 m){ return m * col; }

// Call once, after bloom/rays are added and before final grading —
// order matters: blur first (defocus happens before the light ever
// reaches anything on the lens), then the lens artefacts sitting
// physically on top of that blurred image, then the colour transform
// last (that one happens in the retina/brain, not the optics).
vec3 visionApply(sampler2D tex, vec2 uv, vec2 texel, float aspect,
                  float blurR, float droplets, float fog, float salt, float scratches,
                  float dazzle, float lensSeed, mat3 colourMatrix){
  // Screen-space droplet circles are intentionally omitted in every view.
  vec3 col = visionBlur(tex, uv, blurR, aspect);
  col = visionFog(col, uv, fog);
  col = visionSalt(col, salt);
  col = visionScratches(col, uv, scratches, lensSeed);
  col += dazzle*0.25;                    // residual glare veil from a recent flash
  col = visionColour(col, colourMatrix);
  return col;
}
`;
