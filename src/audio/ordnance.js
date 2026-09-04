/* Ordnance audio: jet flybys, falling whistles, and detonations.
   Everything is one-shot (no persistent ambience); all scheduling
   and disconnects use engine.delay to survive mode changes. */

export function create(engine){
  const { ctx, fxBus, blip, burst, delay } = engine;

  function jet(gain = 0.3, dur = 9){
    const t0 = ctx.currentTime;
    const peakT = dur*0.85;

    // Brown-noise body layers (body/roughness). Two slightly detuned
    // bandpass-filtered bursts, lower frequencies rise then fall for doppler.
    const bodyFreqs = [350, 550];
    for(const baseFreq of bodyFreqs){
      const s = ctx.createBufferSource();
      s.buffer = engine.noise.brown;
      s.loop = true;

      const f = ctx.createBiquadFilter();
      f.type = 'bandpass'; f.frequency.setValueAtTime(baseFreq, t0);
      f.Q.value = 0.9;
      // Peak the frequency rise at 85% of duration, then fall back.
      f.frequency.linearRampToValueAtTime(baseFreq*1.3, t0+peakT);
      f.frequency.linearRampToValueAtTime(baseFreq*0.6, t0+dur);

      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(gain*0.4, t0+0.08);
      g.gain.exponentialRampToValueAtTime(0.0005, t0+dur);

      s.connect(f); f.connect(g); g.connect(fxBus);
      s.start(t0); s.stop(t0+dur+0.1);
    }

    // Thin tonal whine (sawtooth, rides along with the roar).
    blip({
      freq: 950,
      type: 'sawtooth',
      dur,
      gain: gain*0.03,
      sweep: 1.35,
      bus: fxBus,
    });

    // Stereo panning: pass from left (-0.8) to right (+0.8) across duration.
    const panner = ctx.createStereoPanner();
    panner.pan.setValueAtTime(-0.8, t0);
    panner.pan.linearRampToValueAtTime(0.8, t0+dur);
    panner.connect(fxBus);

    // Disconnect the panner after the tail fades.
    delay(() => panner.disconnect(), dur*1000 + 200);
  }

  function whistle(delayS = 0){
    const t0 = ctx.currentTime + delayS;
    const dur = 3.3;

    const o = ctx.createOscillator();
    const g = ctx.createGain();

    o.type = 'sine';
    // Frequency falls exponentially from high to low.
    o.frequency.setValueAtTime(1500, t0);
    o.frequency.exponentialRampToValueAtTime(250, t0+dur);

    // Gain rises quickly, falls slowly (the decay of falling ordnance).
    g.gain.setValueAtTime(0, t0);
    g.gain.linearRampToValueAtTime(0.075, t0+0.08);
    g.gain.exponentialRampToValueAtTime(0.0005, t0+dur);

    o.connect(g); g.connect(fxBus);
    o.start(t0); o.stop(t0+dur+0.05);
  }

  function explosion(near = 1, delayS = 0, pan = null){
    // Clamp delay to avoid long silent queues; mirror the old code's behavior.
    const delayMs = Math.min(4000, delayS*1000);

    delay(() => {
      const t0 = ctx.currentTime;

      // Optional shared panner for all four layers if pan is provided.
      let panner = null;
      if(pan !== null){
        panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        panner.connect(fxBus);
      }

      const route = panner || fxBus;

      // 1. Transient: very short, sharp click/crack (high-freq burst).
      burst({
        dur: 0.08,
        freq: 3000,
        Q: 2,
        gain: 0.4*near,
        type: 'highpass',
        buffer: 'white',
        bus: route,
      });

      // 2. Body: punchy low-mid thump (the main impact).
      burst({
        dur: 0.5,
        freq: 180,
        Q: 1.2,
        gain: 0.42*near,
        type: 'lowpass',
        buffer: 'brown',
        bus: route,
      });

      // 3. Tail: long low rumble (sustained bass decay).
      const tailDur = 3 + near*1.5;
      burst({
        dur: tailDur,
        freq: 95,
        Q: 0.8,
        gain: 0.28*near,
        type: 'lowpass',
        buffer: 'brown',
        bus: route,
      });

      // 4. Delayed rumble return: echo off water surface, separate event.
      const echoDelayMs = 400 + Math.random()*400 + near*100;
      const echoDur = tailDur*0.9;
      delay(() => {
        burst({
          dur: echoDur,
          freq: 75,
          Q: 0.7,
          gain: 0.11*near, // ~0.4x tail's gain
          type: 'lowpass',
          buffer: 'brown',
          bus: route,
        });
      }, echoDelayMs);

      // Close hit stuns hearing and rings ears.
      if(near > 0.35){
        engine.duck(Math.min(0.85, near*0.9), 1.2 + near*0.6);
        engine.earRing(near);
      }

      // Disconnect panner once both the tail and the later echo have
      // finished — whichever outlasts the other.
      if(panner){
        const lastMs = Math.max((tailDur+0.1)*1000, echoDelayMs + (echoDur+0.1)*1000);
        delay(() => panner.disconnect(), lastMs + 200);
      }
    }, delayMs);
  }

  return { jet, whistle, explosion };
}
