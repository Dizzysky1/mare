/* Everything you hear is synthesised — no samples, no downloads.
   This file is a thin facade: it owns context lifecycle (start/resume/
   fade/enabled) and the public API every caller already depends on,
   and delegates the actual sound design to src/audio/*. See
   src/audio/engine.js for the bus graph and shared primitives. */

import { createEngine } from './audio/engine.js';
import { create as createSea } from './audio/sea.js';
import { create as createWeather } from './audio/weather.js';
import { create as createShip } from './audio/ship.js';
import { create as createWildlife } from './audio/wildlife.js';
import { create as createOrdnance } from './audio/ordnance.js';
import { create as createBody } from './audio/body.js';

export class Audio {
  constructor(){
    this.ready = false;
    this.enabled = true;
  }

  start(){
    if(this.ready) return;
    const C = window.AudioContext || window.webkitAudioContext;
    if(!C) return;
    const ctx = this.ctx = new C();
    const engine = this.engine = createEngine(ctx);

    this.sea = createSea(engine);
    this.weather = createWeather(engine);
    this.ship = createShip(engine);
    this.wildlife = createWildlife(engine);
    this.ordnance = createOrdnance(engine);
    this.body = createBody(engine);

    this.ready = true;
  }

  resume(){ if(this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); }

  /* Scheduled callbacks (a gull's next note, a bomb's delayed detonation)
     must not leak from one mode — or a pause — into the next. */
  resetDelayed(){ this.engine && this.engine.resetDelayed(); }

  fade(to, time = 1.2){
    if(!this.ready) return;
    const g = this.engine.master.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setTargetAtTime(this.enabled ? to : 0, this.ctx.currentTime, time/3);
  }

  /* generic shaped one-shots — used directly by main.js for pickups, and
     as the building blocks every domain module composes into its own
     sounds. Kept here so callers that reach for the raw primitive
     (rather than a domain sound) keep working unchanged. */
  blip(opts){ if(this.ready) this.engine.blip(opts); }
  burst(opts){ if(this.ready) this.engine.burst(opts); }

  gull(near, pan){ if(this.ready) this.wildlife.gull(near, pan); }
  creak(force){ if(this.ready) this.ship.creak(force); }
  splash(size){ if(this.ready) this.sea.splash(size); }
  whisper(){ if(this.ready) this.body.whisper(); }
  thunder(near, pan){ if(this.ready) this.weather.thunder(near, pan); }

  /* ── contested waters ───────────────────────────────────── */
  jet(gain, dur){ if(this.ready) this.ordnance.jet(gain, dur); }
  whistle(delay){ if(this.ready) this.ordnance.whistle(delay); }
  explosion(near, delay, pan){ if(this.ready) this.ordnance.explosion(near, delay, pan); }

  /* Per-frame ambience drive. `s` carries the contract's required keys
     (sea, foam, wind, rain, under, near) plus optional extras a caller
     may start passing later (health, breath, sanity, drowning, roll,
     shoreProximity, listenerYaw) — anything omitted degrades to the
     "calm, healthy, centred" default so old call sites need no changes. */
  update(dt, s){
    if(!this.ready) return;
    const ctx = {
      sea: s.sea || 0, foam: s.foam || 0, wind: s.wind || 0, rain: s.rain || 0,
      under: !!s.under, near: s.near ?? 1,
      roll: s.roll || 0, shoreProximity: s.shoreProximity || 0,
      health: s.health ?? 1, breath: s.breath ?? 1, sanity: s.sanity ?? 1,
      drowning: s.drowning ?? (s.under && s.breath !== undefined && s.breath <= 0.02),
      listenerYaw: s.listenerYaw || 0,
    };
    this.engine.setUnderwater(ctx.under);
    this.sea.update(dt, ctx);
    this.weather.update(dt, ctx);
    this.ship.update(dt, ctx);
    this.body.update(dt, ctx);
  }
}
