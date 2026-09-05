import * as THREE from 'three';
import { WeaponLedger, validWorld, finite } from './weapons.js';

/* ────────────────────────────────────────────────────────────────
   Asymmetric session: SAILOR against PILOT.

   The governing rule, and the reason this is worth building at all:

       The simulation knows everything. The players only know what they
       can actually observe or measure.

   So there is no shared HUD, no marker over the other player, no health
   bar, no target box. What crosses the wire is physical state — where
   things are and how fast they are going — and each side is left to work
   out what that means with their own eyes.

   The single most important thing in this file is that the sailor sends
   EVERY boat, unlabelled and in a fixed shuffled order. The pilot's
   client is not told which contact is the human, and cannot be, because
   the information is not in the packet. Working out which wake belongs
   to a person is the pilot's entire job, and the only way to do it is to
   watch what a boat does when it thinks it has been seen. That is a
   gameplay property enforced by the protocol rather than by the UI
   politely declining to draw something.

   Authority is split along the line of who can observe what:

     SAILOR is authoritative for the sea state, every hull, and all
            damage taken on the water. They are the one who can see it.
     PILOT  is authoritative for the aircraft: its position, attitude,
            fuel and stores. Nobody else can fly it.

   A release is an event from the pilot carrying the store's exact
   position and velocity at the instant it left the pylon. Both sides
   then integrate the same store through the same drag model in the same
   deterministic wind, so both see it fall in the same place — but only
   the sailor's answer counts for damage.
   ──────────────────────────────────────────────────────────────── */

/* Render remote entities this far in the past, so there is always a pair
   of real samples to interpolate between instead of extrapolating into a
   guess. One and a half send intervals covers a single dropped packet. */
const INTERP_DELAY = 0.10;   // s
const SEND_HZ = 16;
const BUFFER_MAX = 24;

const lerp = (a, b, t) => a + (b - a)*t;

/* A small ring of timestamped samples with interpolated lookup. Used for
   both directions; the shape of the payload differs, the timing does not. */
class Track {
  constructor(){ this.samples = []; }
  push(t, v){
    const s = this.samples;
    if(s.length && t <= s[s.length-1].t) return;   // out of order: unreliable channel, so expected
    s.push({ t, v });
    while(s.length > BUFFER_MAX) s.shift();
  }
  /* Interpolate to time `at`. Returns null until there is anything to
     show; clamps to the ends rather than extrapolating, because a
     confidently wrong position is worse than a slightly stale one. */
  at(at, blend){
    const s = this.samples;
    if(!s.length) return null;
    if(s.length === 1 || at <= s[0].t) return s[0].v;
    if(at >= s[s.length-1].t) return s[s.length-1].v;
    for(let i = s.length-1; i > 0; i--){
      if(at >= s[i-1].t && at <= s[i].t){
        const span = s[i].t - s[i-1].t;
        const u = span > 1e-6 ? (at - s[i-1].t)/span : 0;
        return blend(s[i-1].v, s[i].v, u);
      }
    }
    return s[s.length-1].v;
  }
  get last(){ return this.samples.length ? this.samples[this.samples.length-1].v : null; }
}

function blendPose(a, b, u){
  return {
    x: lerp(a.x, b.x, u), y: lerp(a.y, b.y, u), z: lerp(a.z, b.z, u),
    h: blendAngle(a.h, b.h, u),
    r: lerp(a.r ?? 0, b.r ?? 0, u),
    p: lerp(a.p ?? 0, b.p ?? 0, u),
  };
}
function blendAngle(a, b, u){
  const d = ((b-a+Math.PI)%(Math.PI*2)+Math.PI*2)%(Math.PI*2)-Math.PI;
  return a + d*u;
}
function blendJet(a, b, u){
  const q = new THREE.Quaternion(a.qx, a.qy, a.qz, a.qw);
  q.slerp(new THREE.Quaternion(b.qx, b.qy, b.qz, b.qw), u);
  return {
    x: lerp(a.x,b.x,u), y: lerp(a.y,b.y,u), z: lerp(a.z,b.z,u),
    qx:q.x, qy:q.y, qz:q.z, qw:q.w,
    vx: lerp(a.vx,b.vx,u), vy: lerp(a.vy,b.vy,u), vz: lerp(a.vz,b.vz,u),
    burner: lerp(a.burner||0, b.burner||0, u),
  };
}

export class Session {
  constructor(opts = {}){
    this.net = opts.net;
    this.role = opts.role;                 // 'sailor' | 'pilot'
    this.onToast = opts.onToast || (()=>{});
    this.onWorld = opts.onWorld || null;   // sailor→pilot world handshake
    this.onDrop = opts.onDrop || null;     // a store left a pylon
    this.onHit = opts.onHit || null;       // the sailor confirms damage

    this.ready = false;                    // world handshake done
    this.world = null;                     // {seed, mode, hour, ...}

    this.boats = new Track();              // sailor → pilot, unlabelled
    this.jet = new Track();                // pilot  → sailor
    this.remoteBoats = [];                 // interpolated, for rendering
    this.remoteJet = null;

    this.clockOffset = 0;                  // remote clock → local clock
    this._offsetSeen = false;
    this._sendAcc = 0;
    this._order = null;                    // fixed shuffle, decided once

    this.stats = { sent:0, recv:0 };
    this.onGun=opts.onGun || null;
    this.weapons=null; this._weaponSeq=0; this._latestJet=null;

    this.net.onMessage = (type, p) => this._recv(type, p);
  }

  now(){ return performance.now()/1000; }

  /* Remote timestamps arrive on the peer's clock. Rather than run a
     protocol for it, take the first sample as the datum and then only
     ever ratchet the offset downward — the smallest observed transit is
     the closest thing to a true clock difference we can see without
     round-tripping every packet. */
  _mapTime(remoteT){
    const local = this.now();
    const offset = local - remoteT;
    if(!this._offsetSeen){ this.clockOffset = offset; this._offsetSeen = true; }
    else if(offset < this.clockOffset) this.clockOffset = offset;
    return remoteT + this.clockOffset;
  }

  _recv(type, p){
    if(!p || typeof p !== 'object' || Array.isArray(p)) return;
    this.stats.recv++;
    switch(type){
      case 'world':
        if(this.role !== 'pilot' || this.ready) return;
        if(!validWorld(p)){ this.onToast('Incompatible multiplayer invite. Both players need the latest game.','bad'); return; }
        this.world = p; this.ready = true; this.onWorld?.(p);
        break;
      case 'boats': {
        if(this.role !== 'pilot' || !this.ready || !finite(p.t,1e8) || !Array.isArray(p.b) || p.b.length>14
          || !p.b.every(b => b && ['x','y','z'].every(k=>finite(b[k])) && ['h','r','p'].every(k=>finite(b[k],Math.PI*4)))) return;
        const t = this._mapTime(p.t);
        this.boats.push(t, p.b);
        break;
      }
      case 'jet': {
        if(this.role !== 'sailor' || !this.ready || !finite(p.t,1e8)
          || !['x','y','z'].every(k=>finite(p[k])) || !['vx','vy','vz'].every(k=>finite(p[k],1800))
          || !['qx','qy','qz','qw'].every(k=>finite(p[k],1.01)) || !finite(p.burner,1)) return;
        this._latestJet={...p,at:this.now()};
        const t = this._mapTime(p.t);
        this.jet.push(t, p);
        break;
      }
      case 'drop':
        if(this.role !== 'sailor' || !this.weapons?.accept(type,p,this.now(),this._latestJet)) return;
        this.onDrop?.(p);
        break;
      case 'gun':
        if(this.role !== 'sailor' || !this.weapons?.accept(type,p,this.now(),this._latestJet)) return;
        this.onGun?.(p);
        break;
      case 'hit':
        this.onHit?.(p);
        break;
      case 'bye':
        this.onToast(p?.why || 'The other player has left.', 'bad');
        break;
    }
  }

  /* ── sailor → pilot ────────────────────────────────────────
     Every hull on the water in one packet, with nothing in it that says
     which is which. The order is privately shuffled by the sailor and
     then held, so a contact keeps its slot frame to frame (interpolation
     needs that) without the slot ever meaning anything. */
  sendBoats(playerShip, fleetBoats){
    const all = [];
    if(playerShip) all.push(playerShip);
    for(const b of fleetBoats) all.push(b);

    if(!this._order || this._order.length !== all.length){
      this._order = all.map((_, i) => i);
      // Keep the permutation independent of the world seed sent to the pilot.
      const random = new Uint32Array(1);
      const rnd = () => { crypto.getRandomValues(random); return random[0]/4294967296; };
      for(let i = this._order.length-1; i > 0; i--){
        const j = Math.floor(rnd()*(i+1));
        [this._order[i], this._order[j]] = [this._order[j], this._order[i]];
      }
    }

    const b = [];
    for(const idx of this._order){
      const s = all[idx];
      if(!s) continue;
      b.push({
        x:+s.pos.x.toFixed(2), y:+s.pos.y.toFixed(2), z:+s.pos.z.toFixed(2),
        h:+(s.headingAngle ?? 0).toFixed(3),
        r:+(s.roll ?? 0).toFixed(3), p:+(s.pitch ?? 0).toFixed(3),
      });
    }
    this.net.send('boats', { t: this.now(), b }, false);
    this.stats.sent++;
  }

  /* ── pilot → sailor ──────────────────────────────────────── */
  sendJet(ac, burner, reliable = false){
    this.net.send('jet', {
      t: this.now(),
      x:+ac.pos.x.toFixed(2), y:+ac.pos.y.toFixed(2), z:+ac.pos.z.toFixed(2),
      qx:+ac.quat.x.toFixed(4), qy:+ac.quat.y.toFixed(4),
      qz:+ac.quat.z.toFixed(4), qw:+ac.quat.w.toFixed(4),
      vx:+ac.vel.x.toFixed(1), vy:+ac.vel.y.toFixed(1), vz:+ac.vel.z.toFixed(1),
      burner: +(burner||0).toFixed(2),
    }, reliable);
    this.stats.sent++;
  }

  /* A store leaving a pylon is a one-shot fact both sides must agree on,
     so it goes reliable and carries the exact release conditions. */
  sendDrop(rel){
    const sent=this.net.send('drop', {
      seq:this._weaponSeq,
      t: this.now(), id: rel.munitionId,
      p: [rel.pos.x,rel.pos.y,rel.pos.z],
      v: [rel.vel.x,rel.vel.y,rel.vel.z],
      windX:rel.windX,windZ:rel.windZ,simTime:rel.simTime,
    }, true);
    if(sent) this._weaponSeq++;
    return sent;
  }

  sendGun(p,v){
    const sent=this.net.send('gun',{seq:this._weaponSeq,p,v},true);
    if(sent) this._weaponSeq++;
    return sent;
  }

  /* The sailor telling the pilot what a store actually did. This is the
     ONLY feedback the pilot gets, it is deliberately coarse, and it is
     the sailor's word — the pilot never sees a health bar because the
     pilot could never see one. */
  sendHit(kind, near){
    this.net.send('hit', { kind, near: !!near }, true);
  }

  sendWorld(world){
    this.weapons=new WeaponLedger(world.loadout);
    this.net.send('world', world, true); this.world = world; this.ready = true;
  }

  /* ── per-frame ────────────────────────────────────────────── */
  update(dt, ctx = {}){
    const at = this.now() - INTERP_DELAY;

    if(this.role === 'pilot'){
      const b = this.boats.at(at, (A, B, u) => A.map((a, i) => B[i] ? blendPose(a, B[i], u) : a));
      this.remoteBoats = b || [];
    } else {
      this.remoteJet = this.jet.at(at, blendJet);
    }

    // outbound at a fixed rate, independent of frame rate
    this._sendAcc += dt;
    const interval = 1/SEND_HZ;
    if(this._sendAcc >= interval){
      this._sendAcc = this._sendAcc % interval;
      if(this.role === 'sailor' && ctx.playerShip) this.sendBoats(ctx.playerShip, ctx.fleet || []);
      else if(this.role === 'pilot' && ctx.aircraft) this.sendJet(ctx.aircraft, ctx.burner);
    }
  }

  leave(why = 'left the game'){
    try { this.net.send('bye', { why: 'The other player has ' + why + '.' }, true); } catch {}
  }
}
