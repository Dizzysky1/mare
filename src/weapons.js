import { LOADOUTS } from './fx/munitions.js';

// Fictional multiplayer balance, shared by the cockpit and receiving peer.
export const GUN = Object.freeze({ ammo:600, burst:5, interval:0.1, speed:1000, lifetime:2.5 });
export const DROP_INTERVAL = 0.25;
export const PROTOCOL = 2;
export function sortieLoadout(random = Math.random){
  return random() < 0.1 ? ['nuke', ...LOADOUTS.mixed] : [...LOADOUTS.mixed];
}
export const finite = (v, max = 100000) => Number.isFinite(v) && Math.abs(v) <= max;
export const vector = (v, max) => Array.isArray(v) && v.length === 3 && v.every(n => finite(n, max));
export function validWorld(w){
  return w && w.protocol === PROTOCOL && Number.isInteger(w.seed) && w.seed >= 0 && w.seed <= 0xffffffff
    && finite(w.hour, 24) && w.hour >= 0 && finite(w.swell, 10) && w.swell > 0
    && finite(w.windDeg, 360) && finite(w.windSpeed, 100) && finite(w.storm, 1)
    && finite(w.chop, 2) && Array.isArray(w.loadout)
    && [LOADOUTS.mixed, ['nuke', ...LOADOUTS.mixed]].some(a =>
      a.length === w.loadout.length && a.every((id, i) => id === w.loadout[i]));
}

// Only the sailor consumes this ledger. Peer timestamps never set cooldowns.
export class WeaponLedger {
  constructor(loadout){
    this.stores = [...loadout]; this.ammo = GUN.ammo; this.seq = 0;
    this.lastGun = -Infinity;
    this.gunTokens=2;
  }
  accept(type, p, now, jet){
    if(!p || !Number.isInteger(p.seq) || p.seq < this.seq || p.seq>10000 || !vector(p.p, 100000) || !vector(p.v, 1800)) return false;
    if(!jet || now - jet.at > 2 || Math.hypot(p.p[0]-jet.x, p.p[1]-jet.y, p.p[2]-jet.z) > 500) return false;
    if(type === 'drop'){
      if(!this.stores.length || typeof p.id !== 'string' || p.id !== this.stores[0]
        || !finite(p.windX, 150) || !finite(p.windZ, 150) || !finite(p.simTime, 1e8)) return false;
      this.stores.shift();
    } else if(type === 'gun'){
      this.gunTokens=Math.min(2,this.gunTokens+(now-this.lastGun)/GUN.interval);
      this.lastGun=now;
      if(this.ammo < GUN.burst || this.gunTokens<1) return false;
      this.gunTokens--;
      this.ammo -= GUN.burst;
    } else return false;
    this.seq=p.seq+1;
    return true;
  }
}
