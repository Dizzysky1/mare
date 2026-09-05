import * as THREE from 'three';

/* Bodies, and what the sea does to them. Rates are per second and were
   tuned so a careless passage kills you in roughly twenty minutes. */

export class Survival {
  constructor(mode){
    this.on = mode.survival;
    this.k = mode.decay || 1;
    this.health = 100; this.food = 100; this.water = 100;
    this.vitamin = 100; this.sanity = 100;
    this.dead = false; this.cause = '';
    this.supplies = { water: mode.hard ? 7 : 12, food: mode.hard ? 6 : 10, citrus: 4 };
    this.hurtT = 0; this.lowT = 0;
    this.warnings = new Set();
  }

  consume(kind){
    if(this.supplies[kind] <= 0) return null;
    this.supplies[kind]--;
    if(kind === 'water'){ this.water = Math.min(100, this.water + 42); return 'You drink. The water is warm and tastes of the cask.'; }
    if(kind === 'food'){ this.food = Math.min(100, this.food + 46); return 'Hard bread and salt fish. It sits like a stone, but it sits.'; }
    if(kind === 'citrus'){ this.vitamin = Math.min(100, this.vitamin + 55); this.food = Math.min(100, this.food+8);
      return 'A lemon, eaten to the pith. Your gums stop aching.'; }
    return null;
  }

  refill(kind, amount = 999){
    if(kind === 'water'){ this.supplies.water = Math.min(12, this.supplies.water + amount); this.water = 100; }
    if(kind === 'food'){ this.supplies.food = Math.min(12, this.supplies.food + amount); }
    if(kind === 'citrus'){ this.supplies.citrus = Math.min(8, this.supplies.citrus + amount); this.vitamin = Math.min(100, this.vitamin+30); }
  }

  update(dt, ctx){
    if(!this.on || this.dead) return null;
    const k = this.k, d = dt*k;
    let msg = null;

    this.food = Math.max(0, this.food - d*0.078*(ctx.exerting ? 1.7 : 1));
    this.water = Math.max(0, this.water - d*0.100*(ctx.hot ? 1.35 : 1)*(ctx.exerting ? 1.5 : 1)
                          *(ctx.dehydration ?? 1));
    this.vitamin = Math.max(0, this.vitamin - d*0.030);

    // sanity: the sea takes it, land and company give it back. Weighted so
    // that even the worst combination (storm, night, alone, on Insane's 2x
    // decay) takes on the order of twenty minutes to empty from full — long
    // enough to survive the longest sailing leg between islands, so a bad
    // stretch of weather is a real threat but not an automatic death by
    // itself. See islands.js for island spacing and the balance notes this
    // was checked against.
    let s = 0;
    s -= ctx.night ? 0.9 : 0;
    s -= ctx.storm*1.2;
    s -= ctx.alone ? 0.4 : 0;
    s -= (this.food < 25 || this.water < 25) ? 0.5 : 0;
    s += ctx.landNear ? 1.6 : 0;
    s += ctx.daylight ? 0.9 : 0;
    s += ctx.boatNear ? 1.0 : 0;
    s += ctx.gullNear ? 0.35 : 0;
    s += ctx.ashore ? 1.3 : 0;
    this.sanity = THREE.MathUtils.clamp(this.sanity + s*d*0.018, 0, 100);

    // damage
    let dmg = 0;
    if(this.water <= 0) dmg += 1.15;
    if(this.food <= 0) dmg += 0.62;
    if(this.vitamin <= 0) dmg += 0.48;
    if(ctx.drowning) dmg += 7.0;
    if(ctx.cold) dmg += 0.9;
    if(dmg > 0){ this.health = Math.max(0, this.health - dmg*d); this.hurtT = 0.6; }
    else if(this.food > 40 && this.water > 40 && this.vitamin > 20){
      this.health = Math.min(100, this.health + d*0.28);
    }
    this.hurtT = Math.max(0, this.hurtT - dt);

    const warn = (key, text) => { if(!this.warnings.has(key)){ this.warnings.add(key); msg = text; } };
    if(this.water < 25) warn('w','Your tongue is thick. You need water.');
    if(this.food < 25) warn('f','Your hands have started to shake with hunger.');
    if(this.vitamin < 30) warn('v','Your gums bleed when you press them. Scurvy — you need fruit.');
    if(this.sanity < 35) warn('s','You have started answering the gulls.');
    if(this.health < 30) warn('h','You are not going to last much longer like this.');
    if(this.water > 60) this.warnings.delete('w');
    if(this.food > 60) this.warnings.delete('f');
    if(this.vitamin > 60) this.warnings.delete('v');
    if(this.sanity > 60) this.warnings.delete('s');
    if(this.health > 60) this.warnings.delete('h');

    if(this.health <= 0){
      this.dead = true;
      this.cause = ctx.drowning ? 'You did not come back up.'
        : this.water <= 0 ? 'Thirst. Four days of blue in every direction.'
        : this.food <= 0 ? 'Hunger, in the end, and the cold that comes with it.'
        : this.vitamin <= 0 ? 'Scurvy. It takes its time and then it does not.'
        : ctx.cold ? 'The water was colder than it looked.'
        : 'The sea won on points.';
    }
    if(this.sanity <= 0 && !this.dead){
      this.dead = true;
      this.cause = 'You were quite sure the light was closer than it was. You went to meet it.';
    }
    return msg;
  }
}

/* ── the objective, which you are not told ──────────────────── */

export const LOGBOOK = {
  medium: {
    title:'Logbook of the Elpida',
    body:[
      ['','12th day. Wind steady from the north-west, sea a hand and a half.'],
      ['','We are carrying nothing and going nowhere in particular, which suits me.'],
      ['hand','Except: my father kept the light on the last island east, and it has been dark three weeks. Nobody has gone to look. I am going to look.'],
      ['','Make the lighthouse. Sail east until the island stands up out of the water, then go ashore and climb to the lamp.'],
    ],
    objective:'Reach the lighthouse on the far eastern island.',
    need:0,
  },
  hard: {
    title:'Logbook of the Elpida',
    body:[
      ['','40th day. Water in the cask is low and the lemons are going soft.'],
      ['','I have kept this boat off the rocks for six weeks. That is the whole of my news.'],
      ['hand','The keeper\'s rule, which my father repeated until I hated it: the lamp is not lit for nothing. Three offerings, carried up by hand, and the light answers.'],
      ['','The old jars are still scattered on the islands, where the sea put them. Three will do. Then east, to the light.'],
      ['','Islands have springs and fruit. Nothing out here does. Go ashore before you have to.'],
    ],
    objective:'Find three amphorae on the islands, then carry them to the lighthouse in the east.',
    need:3,
  },
  insane: {
    title:'Logbook — last legible page',
    body:[
      ['','I do not know the day. The sun has not been up properly since we came through.'],
      ['hand','This is not our sea. The water is the wrong colour and it is far too deep and something out here is keeping pace with the hull.'],
      ['hand','Three jars. Three. He said the light answers to three and I have none of them.'],
      ['','If you are reading this and the light is still dark, take the jars up yourself. Do not swim at night. Do not stop moving.'],
    ],
    objective:'Three amphorae. Then the light. Do not stop moving.',
    need:3,
  },
};

export class Quest {
  constructor(mode, world){
    this.mode = mode;
    this.world = world;
    this.stage = mode.survival || mode.key === 'medium' ? 0 : -1;   // -1 = no quest (easy)
    this.found = 0;
    this.need = 0;
    this.done = false;
    this.amphorae = [];
    this.goal = world.goal;
    this.text = 'Something aboard should say why you sailed. Look around the deck.';
  }

  /* scatter jars over the non-goal islands. Positions are re-rolled every
     run (Math.random(), not the world's seeded rng), so a height check
     alone is not enough — the same roll that clears the height band can
     still land on a cliff face steeper than the player can stand on
     (player.js pushes you back down slopes where normal.y < 0.62). Require
     a safely climbable normal too, with margin, and simply skip a jar
     rather than ever place one somewhere it cannot be reached on foot. */
  placeAmphorae(scene, makeAmphora, count){
    const pool = this.world.islands.filter(i => !i.hasLight);
    const CLIMBABLE = 0.70;
    for(const isl of pool){
      const n = 1 + (Math.random() < 0.4 ? 1 : 0);
      for(let j = 0; j < n; j++){
        let x, z, h, ok = false, tries = 0;
        do {
          const a = Math.random()*Math.PI*2, r = Math.sqrt(Math.random())*isl.radius*0.9;
          x = isl.pos.x + Math.cos(a)*r; z = isl.pos.z + Math.sin(a)*r;
          h = isl.height(x,z);
          ok = h >= 1.0 && h <= isl.peak*0.75 && isl.normalAt(x,z,0.9).y >= CLIMBABLE;
        } while(++tries < 80 && !ok);
        if(!ok) continue;
        const m = makeAmphora();
        m.position.set(x, h + 0.05, z);
        m.rotation.set((Math.random()-0.5)*0.4, Math.random()*6, (Math.random()-0.5)*0.4);
        scene.add(m);
        this.amphorae.push({ mesh:m, taken:false, pos:m.position.clone(), island:isl });
      }
    }
    // Belt and braces: with 12+ islands this should never come up, but if an
    // unlucky run leaves fewer jars than the quest needs, the light would be
    // unreachable through no fault of the player. Fall back to the flattest
    // spot found on any remaining island rather than leave the run unwinnable.
    let guard = 0;
    while(this.amphorae.length < count && guard++ < 40){
      const isl = pool[Math.floor(Math.random()*pool.length)];
      let best = null, bestNy = -1;
      for(let i = 0; i < 40; i++){
        const a = Math.random()*Math.PI*2, r = Math.sqrt(Math.random())*isl.radius*0.9;
        const x = isl.pos.x + Math.cos(a)*r, z = isl.pos.z + Math.sin(a)*r;
        const h = isl.height(x,z);
        if(h < 1.0 || h > isl.peak*0.9) continue;
        const ny = isl.normalAt(x,z,0.9).y;
        if(ny > bestNy){ bestNy = ny; best = {x,z,h}; }
      }
      if(!best || bestNy < CLIMBABLE) continue;
      const m = makeAmphora();
      m.position.set(best.x, best.h + 0.05, best.z);
      m.rotation.set((Math.random()-0.5)*0.4, Math.random()*6, (Math.random()-0.5)*0.4);
      scene.add(m);
      this.amphorae.push({ mesh:m, taken:false, pos:m.position.clone(), island:isl });
    }
  }

  read(){
    if(this.stage !== 0) return null;
    const key = this.mode.key === 'medium' ? 'medium' : this.mode.key === 'hard' ? 'hard' : 'insane';
    const L = LOGBOOK[key];
    this.stage = 1;
    this.need = L.need;
    this.text = L.objective;
    return L;
  }

  take(a){
    if(a.taken) return false;
    a.taken = true;
    a.mesh.visible = false;
    this.found++;
    return true;
  }

  status(playerPos){
    if(this.stage <= 0) return { text:this.text, dist:null, marker:null };
    if(this.need && this.found < this.need){
      // point at the nearest jar still out there
      let best = null, bd = Infinity;
      for(const a of this.amphorae){
        if(a.taken) continue;
        const d = a.pos.distanceTo(playerPos);
        if(d < bd){ bd = d; best = a; }
      }
      return {
        text:`${this.text}`,
        sub:`Amphorae ${this.found}/${this.need}`,
        dist: best ? bd : null,
        marker: best ? best.pos : null,
        hint: bd < 4000 ? null : 'The islands are scattered. Sail.',
      };
    }
    const lp = this.goal.lightPos || this.goal.pos;
    return {
      text:this.text,
      sub: this.need ? `Amphorae ${this.found}/${this.need} — carry them up` : null,
      dist: lp.distanceTo(playerPos),
      marker: lp,
    };
  }

  checkWin(playerPos, ashore){
    if(this.done || this.stage <= 0) return false;
    if(this.need && this.found < this.need) return false;
    const lp = this.goal.lightPos || this.goal.pos;
    if(playerPos.distanceTo(lp) < 42 && ashore){ this.done = true; return true; }
    return false;
  }
}
