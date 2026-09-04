/* Seabirds — gulls and terns via Web Audio synthesis. One-shot calls only:
   laugh (cackle), cry (sustained waver), or distant flock. Each call gets
   its own stereo panner that disconnects after the sound finishes. No
   continuous ambience, no persistent nodes, no samples. */

export function create(engine) {
  function gull(near = 1, pan = null) {
    const { ctx, fxBus, blip, delay } = engine;

    // Resolve pan: use provided value, or random if not given
    if (pan === null || pan === undefined) {
      pan = Math.random() * 2 - 1;
    }

    // Build a stereo panner for this entire call
    const panner = ctx.createStereoPanner();
    panner.pan.value = pan;
    panner.connect(fxBus);

    // Pick call type: laugh (55%, if near>0.35), cry (30%), flock (15% or forced far)
    let callType;
    if (near < 0.35) {
      callType = 'flock';
    } else {
      const r = Math.random();
      callType = r < 0.55 ? 'laugh' : r < 0.85 ? 'cry' : 'flock';
    }

    let totalDur = 0;

    if (callType === 'laugh') {
      /* The cackle: 3–5 short sawtooth/triangle notes staggered in time,
         each swept down, varying in pitch to sound like laughter. */
      const noteCount = 3 + Math.floor(Math.random() * 3);
      const baseFreq = 700 + Math.random() * 800;
      let scheduleTime = 0;

      for (let i = 0; i < noteCount; i++) {
        const dur = 0.12 + Math.random() * 0.08;
        const freq = baseFreq * (0.95 + Math.random() * 0.15);
        const gain = (0.02 + Math.random() * 0.03) * near;
        const sweep = 0.5 + Math.random() * 0.2; // sweep down to 50–70%

        delay(() => {
          blip({
            freq,
            type: Math.random() > 0.5 ? 'sawtooth' : 'triangle',
            dur,
            gain,
            sweep,
            bus: panner
          });
        }, scheduleTime);

        totalDur = Math.max(totalDur, scheduleTime + dur*1000);

        if (i < noteCount - 1) {
          scheduleTime += 120 + Math.random() * 130; // stagger 120–250ms
        }
      }
    } else if (callType === 'cry') {
      /* A single longer note: two sine waves slightly detuned (2–6Hz apart)
         to create a beating/wavering effect that reads like vibrato. */
      const dur = 0.5 + Math.random() * 0.4;
      const baseFreq = 700 + Math.random() * 800;
      const freq1 = baseFreq;
      const freq2 = baseFreq + (2 + Math.random() * 4);
      const gain = (0.02 + Math.random() * 0.02) * near;

      blip({
        freq: freq1,
        type: 'sine',
        dur,
        gain,
        sweep: 0.9,
        bus: panner
      });

      blip({
        freq: freq2,
        type: 'sine',
        dur,
        gain: gain * 0.8,
        sweep: 0.9,
        bus: panner
      });

      totalDur = dur;
    } else if (callType === 'flock') {
      /* Many birds far away: 4–8 very quiet, scattered short calls,
         muted with lower frequencies and downward detune. */
      const callCount = 4 + Math.floor(Math.random() * 5);
      const scatter = 600 + Math.random() * 400;

      for (let i = 0; i < callCount; i++) {
        const offset = Math.random() * scatter;
        const dur = 0.1 + Math.random() * 0.05;
        const freq = 500 + Math.random() * 400;
        const detune = -5 - Math.random() * 10;
        const gain = (0.006 + Math.random() * 0.009) * near;

        delay(() => {
          blip({
            freq,
            type: 'sine',
            dur,
            gain,
            detune,
            bus: panner
          });
        }, offset);

        totalDur = Math.max(totalDur, offset + dur);
      }
    }

    // Schedule panner disconnect after all sound finishes, with margin
    delay(() => {
      panner.disconnect();
    }, totalDur + 150);
  }

  return { gull };
}
