export function create(engine) {
  // Swell bed: brown noise → lowpass → gain → ambienceBus
  const swellSrc = engine.loopSource(engine.noise.brown);
  const swellFilter = engine.ctx.createBiquadFilter();
  swellFilter.type = 'lowpass';
  swellFilter.frequency.value = 220;
  swellFilter.Q.value = 0.4;
  const swellGain = engine.ctx.createGain();
  swellGain.gain.value = 0;   // update() brings this up; silent until then, like every other bed

  swellSrc.connect(swellFilter);
  swellFilter.connect(swellGain);
  swellGain.connect(engine.ambienceBus);

  // Foam hiss: pink noise → bandpass → gain → ambienceBus
  const foamSrc = engine.loopSource(engine.noise.pink);
  const foamFilter = engine.ctx.createBiquadFilter();
  foamFilter.type = 'bandpass';
  foamFilter.frequency.value = 1400;
  foamFilter.Q.value = 1.2;
  const foamGain = engine.ctx.createGain();
  foamGain.gain.value = 0.01;

  foamSrc.connect(foamFilter);
  foamFilter.connect(foamGain);
  foamGain.connect(engine.ambienceBus);

  // Surf (optional): white noise → lowpass → gain → ambienceBus
  const surfSrc = engine.loopSource(engine.noise.white);
  const surfFilter = engine.ctx.createBiquadFilter();
  surfFilter.type = 'lowpass';
  surfFilter.frequency.value = 400;
  surfFilter.Q.value = 0.4;
  const surfGain = engine.ctx.createGain();
  surfGain.gain.value = 0;

  surfSrc.connect(surfFilter);
  surfFilter.connect(surfGain);
  surfGain.connect(engine.ambienceBus);

  let t = 0; // phase accumulator for breathing envelope

  function update(dt, ctx) {
    const now = engine.ctx.currentTime;
    const tc = 0.25; // time constant for parameter smoothing

    // Accumulate phase for organic breathing
    t += dt;

    // Breathing envelope: two sines at different rates (0.21 and 0.53 rad/s)
    // biased from -1..1 to 0.4..1.0 range for non-metronomic swell
    const breathe = (Math.sin(t * 0.21) + Math.sin(t * 0.53)) / 2;
    const breatheEnv = breathe * 0.3 + 0.7;

    // Swell: 220Hz calm → 520Hz stormy, gain 0.05..0.27, modulated by breathing
    if (ctx.sea !== undefined) {
      const sea = Math.max(0, Math.min(1, ctx.sea));
      const freq = 220 + (520 - 220) * sea;
      swellFilter.frequency.setTargetAtTime(freq, now, tc);
      const gain = (0.05 + sea * 0.22) * breatheEnv;
      swellGain.gain.setTargetAtTime(gain, now, tc);
    }

    // Foam: 1400Hz calm → 2600Hz stormy, gain 0.01..0.10 (brighter partner to swell)
    if (ctx.foam !== undefined) {
      const foam = Math.max(0, Math.min(1, ctx.foam));
      const freq = 1400 + (2600 - 1400) * foam;
      foamFilter.frequency.setTargetAtTime(freq, now, tc);
      const gain = 0.01 + foam * 0.09;
      foamGain.gain.setTargetAtTime(gain, now, tc);
    }

    // Surf (optional): rhythmic crash at ~0.15Hz, fades cleanly when shoreProximity absent
    const shoreProx = ctx.shoreProximity ?? 0;
    const rhythm = Math.sin(t * 0.15) * 0.5 + 0.5; // 0..1 crash envelope
    const gain = 0.12 * shoreProx * rhythm;
    surfGain.gain.setTargetAtTime(gain, now, tc);
  }

  function splash(size = 1) {
    // Boom: bandpassed brown-noise burst (low center, long tail)
    engine.burst({
      dur: 0.3 + 0.5 * size,
      freq: 150 - 80 * size,
      Q: 1,
      gain: 0.07 + 0.05 * size,
      buffer: 'brown',
      type: 'bandpass',
    });

    // Plip: bandpassed white-noise transient (high center, short and bright)
    engine.burst({
      dur: 0.12 + 0.08 * size,
      freq: 2200 - 600 * size,
      Q: 2,
      gain: 0.04 + 0.03 * size,
      buffer: 'white',
      type: 'bandpass',
    });
  }

  return { update, splash };
}
