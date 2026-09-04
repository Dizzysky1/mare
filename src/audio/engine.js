/* The audio engine: everything domain modules (sea, weather, ship,
   wildlife, ordnance, body) are built on top of. One bus graph, one
   set of noise buffers, one scheduling clock — so no domain module
   has to think about the underwater filter, clipping or leaking
   timers, only about what a sound should express.

   Bus graph:
     ambienceBus ─┐
                  ├─▶ waterFilter ─▶ duckBus ─▶ limiter ─▶ master ─▶ destination
     fxBus       ─┘                    ▲
     interfaceBus ──────────────────────┘   (bypasses the underwater filter —
                                              body cues stay legible when submerged)

   `master` is the exact node the old code faded; `fade()` still works
   on it unchanged. `waterFilter` is more than a lowpass: a two-stage
   filter (steeper when fully under) plus a highshelf cut plus a
   synthesised pressure-roar layer mixed in after the filter. `duckBus`
   dips on a nearby detonation and recovers on its own. */

function noiseBuffer(ctx, seconds, kind){
  const n = Math.max(1, Math.floor(ctx.sampleRate*seconds));
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  if(kind === 'brown'){
    let last = 0;
    for(let i = 0; i < n; i++){ const w = Math.random()*2-1; last = (last+0.02*w)/1.02; d[i] = last*3.2; }
  } else if(kind === 'pink'){
    // Paul Kellet's refined pink-noise filter — cheap, no per-frame cost.
    let b0=0,b1=0,b2=0,b3=0,b4=0,b5=0,b6=0;
    for(let i = 0; i < n; i++){
      const w = Math.random()*2-1;
      b0 = 0.99886*b0 + w*0.0555179; b1 = 0.99332*b1 + w*0.0750759;
      b2 = 0.96900*b2 + w*0.1538520; b3 = 0.86650*b3 + w*0.3104856;
      b4 = 0.55000*b4 + w*0.5329522; b5 = -0.7616*b5 - w*0.0168980;
      const out = b0+b1+b2+b3+b4+b5+b6+w*0.5362;
      b6 = w*0.115926;
      d[i] = out*0.11;
    }
  } else {
    for(let i = 0; i < n; i++) d[i] = Math.random()*2-1;
  }
  return b;
}

export function createEngine(ctx){
  const master = ctx.createGain(); master.gain.value = 0.0;
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -7; limiter.knee.value = 6;
  limiter.ratio.value = 14; limiter.attack.value = 0.003; limiter.release.value = 0.22;
  limiter.connect(master); master.connect(ctx.destination);

  const duckBus = ctx.createGain(); duckBus.gain.value = 1.0;
  duckBus.connect(limiter);

  // two-stage underwater lowpass + a highshelf cut, in series
  const lp1 = ctx.createBiquadFilter(); lp1.type = 'lowpass'; lp1.frequency.value = 20000; lp1.Q.value = 0.4;
  const lp2 = ctx.createBiquadFilter(); lp2.type = 'lowpass'; lp2.frequency.value = 20000; lp2.Q.value = 0.4;
  const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1100; shelf.gain.value = 0;
  lp1.connect(lp2); lp2.connect(shelf); shelf.connect(duckBus);

  const ambienceBus = ctx.createGain(); ambienceBus.connect(lp1);
  const fxBus = ctx.createGain(); fxBus.connect(lp1);
  const interfaceBus = ctx.createGain(); interfaceBus.connect(duckBus);

  // the pressure/roar of being submerged — a separate low rumble, not just
  // a filtered version of the surface mix, mixed in after the filter chain
  const roarSrc = ctx.createBufferSource();
  roarSrc.buffer = noiseBuffer(ctx, 4, 'brown'); roarSrc.loop = true;
  const roarF = ctx.createBiquadFilter(); roarF.type = 'bandpass'; roarF.frequency.value = 110; roarF.Q.value = 0.7;
  const roarG = ctx.createGain(); roarG.gain.value = 0;
  roarSrc.connect(roarF); roarF.connect(roarG); roarG.connect(duckBus);
  roarSrc.start();

  const noise = {
    white: noiseBuffer(ctx, 4, 'white'),
    pink: noiseBuffer(ctx, 4, 'pink'),
    brown: noiseBuffer(ctx, 4, 'brown'),
  };

  function loopSource(buffer){
    const s = ctx.createBufferSource();
    s.buffer = buffer; s.loop = true; s.start();
    return s;
  }

  function blip({ freq = 440, type = 'sine', dur = 0.25, gain = 0.2, sweep = 1, detune = 0, bus = fxBus } = {}){
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq*sweep), t+dur);
    o.detune.value = detune;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t+0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t+dur);
    o.connect(g); g.connect(bus); o.start(t); o.stop(t+dur+0.05);
  }

  function burst({ dur = 0.4, freq = 900, Q = 1, gain = 0.2, type = 'bandpass', buffer = 'white', bus = fxBus } = {}){
    const t = ctx.currentTime;
    const s = ctx.createBufferSource();
    s.buffer = noise[buffer] || noise.white;
    s.loop = true;
    const f = ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = Q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t+0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, t+dur);
    s.connect(f); f.connect(g); g.connect(bus);
    s.start(t); s.stop(t+dur+0.05);
  }

  /* amount: 0 (surface) .. 1 (fully under). Smoothed so a transition isn't
     an audible click, and shaped so the second filter stage and the
     highshelf only really bite once you're all the way under. */
  let underAmt = 0;
  function setUnderwater(amount){
    const target = amount ? 1 : 0;
    if(target === underAmt) return;
    underAmt = target;
    const tc = 0.15;
    const now = ctx.currentTime;
    lp1.frequency.setTargetAtTime(target ? 350 : 20000, now, tc);
    lp2.frequency.setTargetAtTime(target ? 900 : 20000, now, tc);
    shelf.gain.setTargetAtTime(target ? -16 : 0, now, tc);
    roarG.gain.setTargetAtTime(target ? 0.05 : 0, now, tc*1.4);
  }

  /* A nearby detonation dips everything briefly and recovers on its own —
     one call, no follow-up needed. */
  function duck(strength = 0.6, recoverSec = 1.2){
    const t = ctx.currentTime;
    duckBus.gain.cancelScheduledValues(t);
    duckBus.gain.setValueAtTime(duckBus.gain.value, t);
    duckBus.gain.linearRampToValueAtTime(Math.max(0.05, 1-strength), t+0.03);
    duckBus.gain.setTargetAtTime(1, t+0.03, Math.max(0.05, recoverSec)/3);
  }

  /* Tinnitus: a thin, detuned pair that rings and fades, into the bus that
     survives the underwater filter (it's inside your head, not outside). */
  function earRing(intensity = 1){
    const t = ctx.currentTime;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.05*intensity, t+0.01);
    g.gain.exponentialRampToValueAtTime(0.0003, t+2.6);
    g.connect(interfaceBus);
    for(const f of [4200, 4330]){
      const o = ctx.createOscillator();
      o.type = 'sine'; o.frequency.value = f;
      o.connect(g); o.start(t); o.stop(t+2.7);
    }
  }

  /* Bearing of a world-space delta relative to listener yaw, using the same
     convention as main.js's bearing()/camHeading(): atan2(dx, -dz), 0 = the
     way the camera is looking. Returns a stereo pan in [-1, 1]. */
  function relativePan(dx, dz, listenerYaw = 0){
    const rel = Math.atan2(dx, -dz) - listenerYaw;
    return Math.max(-1, Math.min(1, Math.sin(rel)));
  }
  function distanceGain(dist, refDist = 30, rolloff = 1.2){
    return refDist/(refDist + rolloff*Math.max(0, dist-refDist));
  }

  /* Wall-clock callbacks (a gull's second and third note, a whistle's
     delayed detonation) must not leak from one mode — or a pause — into
     the next. The generation token makes cancellation safe even for a
     callback the browser has already dequeued. */
  let delayGeneration = 0;
  const delayTimers = new Set();
  function delayCall(fn, delayMs){
    const generation = delayGeneration;
    const id = setTimeout(() => {
      delayTimers.delete(id);
      if(generation !== delayGeneration) return;
      fn();
    }, Math.max(0, delayMs));
    delayTimers.add(id);
    return id;
  }
  function resetDelayed(){
    delayGeneration++;
    for(const id of delayTimers) clearTimeout(id);
    delayTimers.clear();
  }

  return {
    ctx, master, ambienceBus, fxBus, interfaceBus, noise,
    loopSource, blip, burst, setUnderwater, duck, earRing,
    relativePan, distanceGain, delay: delayCall, resetDelayed,
  };
}
