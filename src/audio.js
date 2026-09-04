/* Everything you hear is synthesised — no samples, no downloads.
   Noise shaped into water, wind, rain, rigging and gulls. */

function noiseBuffer(ctx, seconds = 4, brown = false){
  const n = ctx.sampleRate*seconds;
  const b = ctx.createBuffer(1, n, ctx.sampleRate);
  const d = b.getChannelData(0);
  let last = 0;
  for(let i = 0; i < n; i++){
    const w = Math.random()*2 - 1;
    if(brown){ last = (last + 0.02*w)/1.02; d[i] = last*3.2; }
    else d[i] = w;
  }
  return b;
}

export class Audio {
  constructor(){
    this.ready = false;
    this.enabled = true;
    this._delayGeneration = 0;
    this._delayTimers = new Set();
  }

  start(){
    if(this.ready) return;
    const C = window.AudioContext || window.webkitAudioContext;
    if(!C) return;
    const ctx = this.ctx = new C();
    this.master = ctx.createGain();
    this.master.gain.value = 0.0;
    this.master.connect(ctx.destination);

    // one lowpass in front of everything, for going under
    this.dive = ctx.createBiquadFilter();
    this.dive.type = 'lowpass';
    this.dive.frequency.value = 20000;
    this.dive.connect(this.master);

    const src = (buf, loop = true) => {
      const s = ctx.createBufferSource();
      s.buffer = buf; s.loop = loop; s.start();
      return s;
    };
    this.white = noiseBuffer(ctx, 4, false);
    this.brown = noiseBuffer(ctx, 4, true);

    // swell — brown noise, slowly breathing
    this.swellG = ctx.createGain(); this.swellG.gain.value = 0.0;
    const swellF = ctx.createBiquadFilter();
    swellF.type = 'lowpass'; swellF.frequency.value = 420; swellF.Q.value = 0.6;
    src(this.brown).connect(swellF); swellF.connect(this.swellG); this.swellG.connect(this.dive);
    this.swellF = swellF;

    // the hiss of breaking crests
    this.foamG = ctx.createGain(); this.foamG.gain.value = 0.0;
    const foamF = ctx.createBiquadFilter();
    foamF.type = 'bandpass'; foamF.frequency.value = 1800; foamF.Q.value = 0.55;
    src(this.white).connect(foamF); foamF.connect(this.foamG); this.foamG.connect(this.dive);
    this.foamF = foamF;

    // wind through the rigging
    this.windG = ctx.createGain(); this.windG.gain.value = 0.0;
    const windF = ctx.createBiquadFilter();
    windF.type = 'bandpass'; windF.frequency.value = 620; windF.Q.value = 1.6;
    src(this.white).connect(windF); windF.connect(this.windG); this.windG.connect(this.dive);
    this.windF = windF;

    // rain
    this.rainG = ctx.createGain(); this.rainG.gain.value = 0.0;
    const rainF = ctx.createBiquadFilter();
    rainF.type = 'highpass'; rainF.frequency.value = 2600;
    src(this.white).connect(rainF); rainF.connect(this.rainG); this.rainG.connect(this.dive);

    this.ready = true;
    this.t = 0;
    this.lastCreak = 0;
  }

  /* Wall-clock callbacks must not leak from one mode (or a paused game) into
     the next. Keeping the token as well as the timer set makes cancellation
     safe even if a callback has already been dequeued by the browser. */
  _delay(fn, delayMs){
    const generation = this._delayGeneration;
    const id = setTimeout(() => {
      this._delayTimers.delete(id);
      if(generation !== this._delayGeneration || !this.ready || !this.enabled) return;
      fn();
    }, Math.max(0, delayMs));
    this._delayTimers.add(id);
    return id;
  }

  resetDelayed(){
    this._delayGeneration++;
    for(const id of this._delayTimers) clearTimeout(id);
    this._delayTimers.clear();
  }

  resume(){ if(this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  fade(to, time = 1.2){
    if(!this.ready) return;
    const g = this.master.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(this.enabled ? to : 0, this.ctx.currentTime, time/3);
  }

  /* short, shaped one-shots */
  blip({ freq = 440, type = 'sine', dur = 0.25, gain = 0.2, sweep = 1, detune = 0 }){
    if(!this.ready) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(40, freq*sweep), t+dur);
    o.detune.value = detune;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t+0.012);
    g.gain.exponentialRampToValueAtTime(0.0005, t+dur);
    o.connect(g); g.connect(this.dive); o.start(t); o.stop(t+dur+0.05);
  }

  burst({ dur = 0.4, freq = 900, Q = 1, gain = 0.2, type = 'bandpass', buffer = 'white' }){
    if(!this.ready) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = buffer === 'brown' ? this.brown : this.white;
    s.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = type; f.frequency.value = freq; f.Q.value = Q;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t+0.02);
    g.gain.exponentialRampToValueAtTime(0.0005, t+dur);
    s.connect(f); f.connect(g); g.connect(this.dive);
    s.start(t); s.stop(t+dur+0.05);
  }

  gull(near = 1){
    if(!this.ready) return;
    const base = 900 + Math.random()*500;
    const n = 2 + Math.floor(Math.random()*3);
    for(let i = 0; i < n; i++){
      this._delay(()=>{
        this.blip({ freq: base*(1+i*0.06), type:'sawtooth', dur:0.18, gain:0.035*near, sweep:0.55 });
        this.blip({ freq: base*1.5, type:'triangle', dur:0.14, gain:0.018*near, sweep:0.6 });
      }, i*(150 + Math.random()*120));
    }
  }

  creak(force){
    if(!this.ready) return;
    const now = this.ctx.currentTime;
    if(now - this.lastCreak < 0.55) return;
    this.lastCreak = now;
    this.blip({ freq: 90 + Math.random()*110, type:'sawtooth', dur:0.35+Math.random()*0.4,
                gain:0.012*force, sweep:0.72 });
    this.burst({ dur:0.3, freq:280, Q:6, gain:0.02*force });
  }

  splash(size = 1){ this.burst({ dur:0.5*size, freq:1400, Q:0.5, gain:0.10*size }); }

  /* ── contested waters ───────────────────────────────────── */

  /* Turbofans: broadband roar that swells and passes overhead. */
  jet(gain = 0.3, dur = 9){
    if(!this.ready) return;
    const t = this.ctx.currentTime;
    const s = this.ctx.createBufferSource();
    s.buffer = this.brown; s.loop = true;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass'; bp.Q.value = 0.9;
    const passT = t + dur*0.87;
    bp.frequency.setValueAtTime(140, t);
    bp.frequency.linearRampToValueAtTime(520, passT);         // doppler up through overflight
    bp.frequency.linearRampToValueAtTime(180, t + dur);       // and down as it passes
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 60;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, passT);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(hp); hp.connect(g); g.connect(this.dive);
    s.start(t); s.stop(t + dur + 0.1);
    this.blip({ freq:2200, type:'sawtooth', dur:dur*0.6, gain:gain*0.03, sweep:0.35 });
  }

  /* Falling ordnance: the descending whistle. */
  whistle(delay = 0){
    if(!this.ready) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(1450, t);
    o.frequency.exponentialRampToValueAtTime(240, t + 3.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.07, t + 2.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
    o.connect(g); g.connect(this.dive);
    o.start(t); o.stop(t + 3.6);
  }

  /* Detonation, arriving late by however long the sound took to cross. */
  explosion(near = 1, delay = 0){
    if(!this.ready) return;
    this._delay(() => {
      this.burst({ dur:0.5, freq:190, Q:0.4, gain:0.42*near, type:'lowpass', buffer:'brown' });
      this.burst({ dur:0.16, freq:3200, Q:0.3, gain:0.22*near });
      this.burst({ dur:2.6 + near*1.8, freq:95, Q:0.35, gain:0.30*near, type:'lowpass', buffer:'brown' });
      this.blip({ freq:70, type:'sine', dur:1.1, gain:0.20*near, sweep:0.5 });
    }, Math.min(4000, delay*1000));
  }
  thunder(near = 1){
    this.burst({ dur:1.8+Math.random()*1.6, freq:110, Q:0.4, gain:0.30*near, type:'lowpass', buffer:'brown' });
    if(near > 0.7) this.burst({ dur:0.35, freq:2200, Q:0.3, gain:0.10*near });
  }
  whisper(){
    this.burst({ dur:1.4, freq:700+Math.random()*900, Q:9, gain:0.028 });
  }

  update(dt, s){
    if(!this.ready) return;
    this.t += dt;
    const at = (p, v, tc = 0.25) => p.setTargetAtTime(v, this.ctx.currentTime, tc);
    const breathe = 0.55 + 0.45*Math.sin(this.t*0.21) * 0.6 + 0.2*Math.sin(this.t*0.53);
    at(this.swellG.gain, (0.16 + s.sea*0.20)*breathe*(0.4+0.6*s.near));
    at(this.swellF.frequency, 260 + s.sea*260);
    at(this.foamG.gain, (0.012 + s.foam*0.075)*breathe);
    at(this.foamF.frequency, 1500 + s.sea*900);
    at(this.windG.gain, 0.010 + s.wind*0.085);
    at(this.windF.frequency, 380 + s.wind*900);
    at(this.rainG.gain, s.rain*0.09);
    at(this.dive.frequency, s.under ? 380 : 20000, 0.12);
  }
}
