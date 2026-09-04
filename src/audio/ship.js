export function create(engine) {
  // Rigging/halyard bed: noise → bandpass filter → gain → ambienceBus
  // Driven by wind with subtle flutter from phase modulators
  const riggingSrc = engine.loopSource(engine.noise.pink);
  const riggingFilter = engine.ctx.createBiquadFilter();
  riggingFilter.type = 'bandpass';
  riggingFilter.frequency.value = 1100;
  riggingFilter.Q.value = 4;
  riggingSrc.connect(riggingFilter);

  const riggingGain = engine.ctx.createGain();
  riggingGain.gain.value = 0;
  riggingFilter.connect(riggingGain);
  riggingGain.connect(engine.ambienceBus);

  let riggingPhase1 = 0;
  let riggingPhase2 = 0;

  // Hull groan bed: brown noise → lowpass filter → gain → ambienceBus
  // Driven by sea state and roll as a low structural presence
  const groanSrc = engine.loopSource(engine.noise.brown);
  const groanFilter = engine.ctx.createBiquadFilter();
  groanFilter.type = 'lowpass';
  groanFilter.frequency.value = 130;
  groanFilter.Q.value = 0.3;
  groanSrc.connect(groanFilter);

  const groanGain = engine.ctx.createGain();
  groanGain.gain.value = 0;
  groanFilter.connect(groanGain);
  groanGain.connect(engine.ambienceBus);

  let lastCreakTime = -Infinity;

  function update(dt, ctx) {
    const now = engine.ctx.currentTime;

    // Wind-driven rigging gain
    const windGain = 0.005 + (ctx.wind || 0) * 0.045;
    riggingGain.gain.setTargetAtTime(windGain, now, 0.25);

    // Rigging flutter: two non-harmonic sine waves create an evolving pattern
    riggingPhase1 += dt * 2.3;
    riggingPhase2 += dt * 3.7;
    const flutter = Math.sin(riggingPhase1) * 0.06 + Math.sin(riggingPhase2) * 0.06;
    const modFreq = 1100 * (1 + flutter);
    riggingFilter.frequency.setTargetAtTime(modFreq, now, 0.08);

    // Sea and roll driven groan gain
    const seaRoll = (ctx.sea || 0) * 0.4 + (ctx.roll || 0) * 0.6;
    const groanTarget = seaRoll * 0.06;
    groanGain.gain.setTargetAtTime(Math.max(0, groanTarget), now, 0.25);
  }

  function creak(force = 1) {
    const now = engine.ctx.currentTime;

    // Rate limiting: ignore calls less than 0.5s apart
    if (now - lastCreakTime < 0.5) return;
    lastCreakTime = now;

    // Short sawtooth pitch-drop (randomized start freq and duration)
    const startFreq = 90 + Math.random() * 130;
    const blipDur = 0.3 + Math.random() * 0.5;
    const blipGain = (0.01 + Math.random() * 0.04) * force;

    engine.blip({
      freq: startFreq,
      type: 'sawtooth',
      dur: blipDur,
      gain: blipGain,
      sweep: 0.3,
      bus: engine.fxBus
    });

    // Short bandpass-noise crack (resonant transient)
    const crackDur = 0.2 + Math.random() * 0.2;
    const crackGain = (0.015 + Math.random() * 0.03) * force;

    engine.burst({
      dur: crackDur,
      freq: 250 + Math.random() * 100,
      Q: 5 + Math.random() * 3,
      gain: crackGain,
      type: 'bandpass',
      buffer: 'white',
      bus: engine.fxBus
    });

    // For hard slams, add a longer low groan tail
    if (force > 0.75) {
      const groanDur = 0.8 + Math.random() * 0.4;
      const groanGain = 0.03 * force;

      engine.burst({
        dur: groanDur,
        freq: 100 + Math.random() * 50,
        Q: 0.5,
        gain: groanGain,
        type: 'lowpass',
        buffer: 'brown',
        bus: engine.fxBus
      });
    }
  }

  return { update, creak };
}
