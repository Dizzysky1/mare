/* ────────────────────────────────────────────────────────────────
   Seeded randomness.

   Two machines can only agree on a world if nothing in the simulation
   consults `Math.random()`. Every simulation path draws from a named,
   seeded stream instead, so a run is reproducible from its seed alone
   — which is what makes a shared world possible at all, and which also
   makes a bug reproducible instead of a ghost story.

   Streams are named and independent on purpose: if the fleet draws a
   different number of values one frame, the weather must not shift
   underneath it. Purely cosmetic randomness (a particle's jitter) may
   still use Math.random — it does not have to agree between machines,
   and keeping it out of the seeded streams keeps them in step.
   ──────────────────────────────────────────────────────────────── */

export function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/* Mix a string into a seed so streams named differently start apart. */
function hashName(str, seed){
  let h = seed >>> 0;
  for(let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 0x01000193) >>> 0;
  return h >>> 0;
}

export class Rng {
  constructor(seed = 1){ this.seed = seed >>> 0; this._next = mulberry32(this.seed); }
  reseed(seed){ this.seed = seed >>> 0; this._next = mulberry32(this.seed); }
  next(){ return this._next(); }
  range(a, b){ return a + this._next()*(b - a); }
  int(n){ return Math.floor(this._next()*n); }
  pick(arr){ return arr[Math.floor(this._next()*arr.length)]; }
  chance(p){ return this._next() < p; }
  /* symmetric about zero, the shape most call sites actually wanted */
  spread(m = 1){ return (this._next()*2 - 1)*m; }
}

const streams = new Map();
let rootSeed = 20240;

/* Named stream — same name and root seed always gives the same sequence. */
export function stream(name){
  let s = streams.get(name);
  if(!s){ s = new Rng(hashName(name, rootSeed)); streams.set(name, s); }
  return s;
}

/* Start a run. Every named stream is rebuilt from the new root. */
export function reseedWorld(seed){
  rootSeed = seed >>> 0;
  for(const [name, s] of streams) s.reseed(hashName(name, rootSeed));
  return rootSeed;
}

export function worldSeed(){ return rootSeed; }
