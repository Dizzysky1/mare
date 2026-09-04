/* The player's body under stress: heartbeat quickening as health/breath drops,
   ragged breathing when drowning or exhausted, and whispers when sanity is low.
   Both heartbeat and breathing are silent at full health/breath — they add
   nothing to calm sailing. */

export function create(engine){
  const ctx = engine.ctx;

  // ── breathing texture ─────────────────────
  // persistent rasping noise, looped and bandpassed to roughly 400-1200 Hz
  const breathSrc = engine.loopSource(engine.noise.white);
  const breathFilter = ctx.createBiquadFilter();
  breathFilter.type = 'bandpass';
  breathFilter.frequency.value = 800;
  breathFilter.Q.value = 2.6;
  const breathGain = ctx.createGain();
  breathGain.gain.value = 0;
  breathSrc.connect(breathFilter);
  breathFilter.connect(breathGain);
  breathGain.connect(engine.interfaceBus);

  // phase accumulators for heart and breath cycles
  let beatPhase = 0, breathPhase = 0;

  function update(dt, ctx){
    // defaults: healthy, full breath, not drowning
    const health = ctx?.health ?? 1;
    const breath = ctx?.breath ?? 1;
    const drowning = ctx?.drowning ?? false;

    // ── heartbeat ────────────────────────────
    // stress: 0 when all good, up to ~1 when drowning or critical health/breath
    const stress = Math.max(1-health, 1-breath, drowning ? 0.9 : 0);
    const bpm = 60 + stress*90;  // 60 @ peace, ~150 @ crisis
    beatPhase += dt * bpm / 60;

    // trigger heartbeat thump once per cycle, only when actually stressed
    if(beatPhase >= 1.0 && stress > 0.04){
      beatPhase -= 1.0;

      // first thump: main beat, low frequency brown noise with moderate Q
      engine.burst({
        dur: 0.18,
        freq: 70 + Math.random()*20,
        Q: 1.2,
        gain: 0.05 + stress*0.12,
        type: 'lowpass',
        buffer: 'brown',
        bus: engine.interfaceBus
      });

      // second thump: the dub (lub-dub), slightly delayed and quieter
      engine.delay(() => {
        engine.burst({
          dur: 0.14,
          freq: 60 + Math.random()*15,
          Q: 1.1,
          gain: (0.05 + stress*0.12)*0.5,
          type: 'lowpass',
          buffer: 'brown',
          bus: engine.interfaceBus
        });
      }, 90);
    }

    // ── breathing ────────────────────────────
    // cycle rate: ~0.28 Hz calm, scales up when stressed
    const breathHz = 0.28 + stress * 0.5;  // 0.28 @ peace, ~0.78 @ crisis
    breathPhase += dt * breathHz;
    if(breathPhase >= 1.0) breathPhase -= 1.0;

    // swell: smooth pulse per breath, peak shaped and silent when healthy
    const swell = Math.pow(Math.max(0, Math.sin(breathPhase*Math.PI*2)), 3);
    const targetGain = swell * ((1-breath)*0.06 + (drowning ? 0.05 : 0));

    // smooth gain ramp with setTargetAtTime so pulses are distinct, not smeared
    const now = engine.ctx.currentTime;
    breathGain.gain.setTargetAtTime(targetGain, now, 0.07);
  }

  function whisper(){
    /* Low-sanity hallucination: two overlapping bandpassed white-noise bursts
       at different frequencies, creating a formant-like, almost-voice quality. */
    const dur1 = 1.0 + Math.random()*0.6;
    const freq1 = 600 + Math.random()*400;  // 600-1000 Hz

    engine.burst({
      dur: dur1,
      freq: freq1,
      Q: 8 + Math.random()*4,
      gain: 0.02 + Math.random()*0.015,
      type: 'bandpass',
      buffer: 'white',
      bus: engine.fxBus
    });

    // second layer starts after a small delay for richer texture
    const dur2 = 1.1 + Math.random()*0.5;
    const freq2 = 1000 + Math.random()*600;  // 1000-1600 Hz
    const delay2 = 50 + Math.random()*100;  // 50-150 ms offset

    engine.delay(() => {
      engine.burst({
        dur: dur2,
        freq: freq2,
        Q: 8 + Math.random()*4,
        gain: 0.025 + Math.random()*0.010,
        type: 'bandpass',
        buffer: 'white',
        bus: engine.fxBus
      });
    }, delay2);
  }

  return { update, whisper };
}
