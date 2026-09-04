/* Wind: three asynchronous noise layers with independent LFOs create gusts
   without repeating patterns. Rain: water/deck with separate textures, both
   scaled by ctx.rain. Thunder: distance-aware one-shot with spectral shift. */

export function create(engine){
  const ctx = engine.ctx;

  // ── Wind ─────────────────────────────────────────────────────────
  // Three persistent noise layers at different frequencies, each with
  // its own slow LFO so they swell/fade independently (async gusting).
  const windLayers = [
    { src: engine.loopSource(engine.noise.white), centerFreq: 350, lfoRate: 0.06 },
    { src: engine.loopSource(engine.noise.pink), centerFreq: 650, lfoRate: 0.11 },
    { src: engine.loopSource(engine.noise.white), centerFreq: 1100, lfoRate: 0.19 },
  ];

  for(const layer of windLayers){
    layer.filter = ctx.createBiquadFilter();
    layer.filter.type = 'bandpass';
    layer.filter.frequency.value = layer.centerFreq;
    layer.filter.Q.value = 0.7;
    layer.gain = ctx.createGain();
    layer.gain.gain.value = 0;
    layer.src.connect(layer.filter);
    layer.filter.connect(layer.gain);
    layer.gain.connect(engine.ambienceBus);
  }

  // ── Rain ─────────────────────────────────────────────────────────
  // Water: dense steady highpass. Deck: textured with resonance bump
  // for percussive patter on hard surfaces.
  const rainWater = {
    src: engine.loopSource(engine.noise.white),
  };
  rainWater.filter = ctx.createBiquadFilter();
  rainWater.filter.type = 'highpass';
  rainWater.filter.frequency.value = 3000;
  rainWater.filter.Q.value = 0.7;
  rainWater.gain = ctx.createGain();
  rainWater.gain.gain.value = 0;
  rainWater.src.connect(rainWater.filter);
  rainWater.filter.connect(rainWater.gain);
  rainWater.gain.connect(engine.ambienceBus);

  const rainDeck = {
    src: engine.loopSource(engine.noise.pink),
  };
  rainDeck.hp = ctx.createBiquadFilter();
  rainDeck.hp.type = 'highpass';
  rainDeck.hp.frequency.value = 3200;
  rainDeck.hp.Q.value = 0.6;
  rainDeck.peak = ctx.createBiquadFilter();
  rainDeck.peak.type = 'peaking';
  rainDeck.peak.frequency.value = 4500;
  rainDeck.peak.gain.value = 4;
  rainDeck.peak.Q.value = 1.8;
  rainDeck.gain = ctx.createGain();
  rainDeck.gain.gain.value = 0;
  rainDeck.src.connect(rainDeck.hp);
  rainDeck.hp.connect(rainDeck.peak);
  rainDeck.peak.connect(rainDeck.gain);
  rainDeck.gain.connect(engine.ambienceBus);

  // ── State ────────────────────────────────────────────────────────
  let t = 0;

  function update(dt, context){
    t += dt;
    const now = ctx.currentTime;
    const tc = 0.2;

    // Gust: sum of slow irrational-rate sines mapped to 0.7..1.3.
    // Irrational rates (0.031, 0.047, 0.073 rad/s) prevent repeating patterns.
    const gust = 0.7 + 0.3*(
      Math.sin(t*0.031)*0.4 +
      Math.sin(t*0.047)*0.35 +
      Math.sin(t*0.073)*0.25
    );

    // Each wind layer: own LFO + gust modulation + wind scalar.
    // LFO rates (0.06, 0.11, 0.19 rad/s) don't harmonize, so they drift in/out of phase.
    for(const layer of windLayers){
      const lfo = 0.4 + 0.6*Math.sin(t*layer.lfoRate);
      const windG = Math.max(0, Math.pow(context.wind, 0.8));
      const gain = windG * lfo * gust * 0.045;
      layer.gain.gain.setTargetAtTime(gain, now, tc);

      // Brighten filter during gust peaks (more turbulent).
      const freqShift = layer.centerFreq + Math.max(0, (gust-1)*50);
      layer.filter.frequency.setTargetAtTime(freqShift, now, tc);
    }

    // Rain: both layers scaled by rain intensity.
    const rainG = Math.max(0, Math.pow(context.rain, 0.9));
    rainWater.gain.gain.setTargetAtTime(rainG*0.045, now, tc);
    rainDeck.gain.gain.setTargetAtTime(rainG*0.035, now, tc);
  }

  function thunder(near = 1){
    const t = ctx.currentTime;
    near = Math.max(0, Math.min(1, near));

    if(near > 0.35){
      // Sharp bright crack: only emerges close. Highs attenuate over distance.
      engine.burst({
        dur: 0.08 + 0.04*Math.random(),
        freq: 4500,
        Q: 2,
        type: 'bandpass',
        buffer: 'white',
        gain: 0.12*near,
        bus: engine.fxBus,
      });
    }

    // Main rumble: softer and longer as near → 0. Atmospheric absorption
    // of highs is expressed by the absence of the crack and dominance of low freq.
    const dur = 1.3 + (1-near)*2.2 + Math.random()*0.4;
    const freq = 65 + (1-near)*30;
    const gain = 0.10 + 0.13*near;
    engine.burst({
      dur,
      freq,
      Q: 0.5,
      type: 'lowpass',
      buffer: 'brown',
      gain,
      bus: engine.fxBus,
    });
  }

  return { update, thunder };
}
