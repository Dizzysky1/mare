/* ────────────────────────────────────────────────────────────────
   The munitions registry.

   One table, read by every part of the strike pipeline: the model that
   builds it, the aerodynamics that fly it, the trajectory that aims it,
   the effects it has on the player, and the vfx/sfx it throws off. Each
   of those lives in its own module and keys off `id`, so a new store is
   added here once and every system picks it up.

   These are game hazards. The numbers below are the coarse public
   figures a flight-sim would use — mass, calibre, a drag coefficient —
   and nothing here describes how anything is made or works internally.
   ──────────────────────────────────────────────────────────────── */

export const FAMILIES = {
  he:          'high explosive',
  incendiary:  'incendiary',
  chemical:    'area denial',
};

export const MUNITIONS = {
  mk82: {
    id:'mk82', name:'Mk 82', family:'he',
    mass: 227, calibre: 0.273, length: 2.21,
    // low-drag general purpose: slick body, fins aft
    Cd: 0.28, finsDeploy: 0.0,
    fuze: 'impact',
    blast:  { power: 1.0, lethalR: 13, woundR: 42, shockR: 190 },
    audio:  { boom: 1.0 },
  },
  mk83: {
    id:'mk83', name:'Mk 83', family:'he',
    mass: 454, calibre: 0.357, length: 3.00,
    Cd: 0.28, finsDeploy: 0.0,
    fuze: 'impact',
    blast:  { power: 1.8, lethalR: 18, woundR: 58, shockR: 240 },
    audio:  { boom: 1.35 },
  },
  gbu12: {
    id:'gbu12', name:'GBU-12', family:'he',
    mass: 277, calibre: 0.273, length: 3.28,
    // seeker head and mid-body wings: more drag, but it steers
    Cd: 0.42, finsDeploy: 1.0, guided: true, turnRate: 0.55,
    fuze: 'impact',
    blast:  { power: 1.1, lethalR: 14, woundR: 45, shockR: 200 },
    audio:  { boom: 1.05 },
  },

  /* Incendiary: a thin-walled canister that tumbles, bursts low and lays
     a long burning footprint down the line of flight. Dangerous for as
     long as it burns, which is the point of it — you cannot simply wait
     out the impact the way you can with a high-explosive store. */
  napalm: {
    id:'napalm', name:'incendiary canister', family:'incendiary',
    mass: 340, calibre: 0.48, length: 3.35,
    Cd: 0.95, tumbles: true,          // no fins: it goes end over end
    fuze: 'impact',
    blast:  { power: 0.35, lethalR: 6, woundR: 20, shockR: 60 },
    spread: { length: 64, width: 24 },   // footprint along the flight line
    burn:   { duration: 78, damage: 26, radius: 3.2 },
    audio:  { boom: 0.7, roar: 1.0 },
  },

  /* Area denial: an air-burst canister that leaves a drifting cloud.
     No blast to speak of — the hazard is the volume it denies you and
     how long it lingers on the wind. */
  gas: {
    id:'gas', name:'area-denial canister', family:'chemical',
    mass: 200, calibre: 0.36, length: 2.4,
    Cd: 0.55,
    fuze: 'airburst', burstAlt: 55,
    blast:  { power: 0.10, lethalR: 0, woundR: 8, shockR: 25 },
    cloud:  { radius: 58, rise: 9, duration: 135, damage: 14, driftWithWind: true },
    audio:  { boom: 0.35, hiss: 1.0 },
  },

  // Fictional game carriers. Payloads are independent simulated bodies;
  // these values define gameplay scale, not a real weapon specification.
  cluster: {
    id:'cluster', name:'cluster bomb', family:'he', mass:360, calibre:0.42, length:2.6, Cd:0.38,
    fuze:'cluster', burstAlt:120, armTime:0.4,
    cluster:{ child:'cluster_helet', count:24, separationEnergy:16000 },
    blast:{ power:0, lethalR:0, woundR:0, shockR:0 }, audio:{boom:0.15},
  },
  cluster_gas: {
    id:'cluster_gas', name:'cluster gas bomb', family:'chemical', mass:280, calibre:0.44, length:2.7, Cd:0.42,
    fuze:'cluster', burstAlt:100, armTime:0.4,
    cluster:{ child:'cluster_gaslet', count:12, separationEnergy:9000 },
    blast:{ power:0, lethalR:0, woundR:0, shockR:0 }, audio:{boom:0.12},
  },
  cluster_helet: {
    id:'cluster_helet', name:'explosive bomblet', internal:true, family:'he',
    mass:8, calibre:0.12, length:0.32, Cd:0.72, fuze:'impact',
    blast:{power:0.18,lethalR:2.5,woundR:12,shockR:38},audio:{boom:0.25},
  },
  cluster_gaslet: {
    id:'cluster_gaslet', name:'gas bomblet', internal:true, family:'chemical',
    mass:12, calibre:0.16, length:0.42, Cd:0.82, fuze:'impact',
    blast:{power:0.04,lethalR:0,woundR:0,shockR:12},
    cloud:{radius:15,rise:3,duration:65,damage:5,driftWithWind:true},audio:{boom:0.12,hiss:0.4},
  },
  cluster_casing: {
    id:'cluster_casing',name:'empty carrier section',internal:true,family:'debris',
    mass:60,calibre:0.45,length:1.3,Cd:1.1,fuze:'inert',
    blast:{power:0,lethalR:0,woundR:0,shockR:0},audio:{boom:0},
  },

};

export const MUNITION_IDS = Object.keys(MUNITIONS).filter(id => !MUNITIONS[id].internal);

export function munition(id){ return MUNITIONS[id] || MUNITIONS.mk83; }

/* A loadout is what a single aircraft carries on one run. Mixed loads
   are deliberate — reading which store is falling is half the fight. */
export const LOADOUTS = {
  he:        ['mk83','mk83','mk82','mk82','mk83'],
  precision: ['gbu12','gbu12','mk83'],
  fire:      ['napalm','napalm','napalm','mk82'],
  denial:    ['gas','gas','mk82'],
  mixed:     ['mk83','napalm','gas','cluster','cluster_gas'],
  cluster:   ['cluster','cluster','mk82'],
  clusterGas:['cluster_gas','cluster_gas','gas'],
};

/* Chosen per sortie; later waves get nastier. */
export function loadoutForWave(wave, rng = Math.random){
  if(wave <= 1) return LOADOUTS.he;
  const pool = wave < 3 ? ['he','he','precision','fire']
             : wave < 5 ? ['he','precision','fire','denial']
                        : ['fire','denial','mixed','precision','cluster','clusterGas'];
  return LOADOUTS[pool[Math.floor(rng()*pool.length)]] || LOADOUTS.he;
}
