import * as THREE from 'three';
import { Ship } from './boats.js';
import { Island, makeAmphora, makeBarrel } from './islands.js';
import { MUNITION_IDS, MUNITIONS, LOADOUTS } from './fx/munitions.js';

/* ────────────────────────────────────────────────────────────────
   Creative / sandbox mode.

   A self-contained overlay + spawner bolted onto the existing sim.
   It never touches another module's source — it reaches into public
   state (fleet.boats, world.islands, gulls.birds, strikes.storeKinds)
   the same way main.js already does, and it is the only thing
   responsible for cleaning up whatever it adds.

   The one intrusive thing it does is give the player's `fly` state a
   speed dial. player.js has no such knob and cannot be edited from
   here, so enter() shadows the instance's `updateFly` with a copy
   that reads a multiplier, and exit() deletes the shadow to restore
   the prototype method exactly. Everything else is additive.
   ──────────────────────────────────────────────────────────────── */

const clamp = THREE.MathUtils.clamp;

// Single stores plus named loadouts, offered together as one cycle —
// "mk83" drops the same thing five times, "mixed" reads which store is
// falling. See fx/munitions.js for what each one actually does.
const MUNITION_CHOICES = [...MUNITION_IDS, ...Object.keys(LOADOUTS)];
const LOADOUT_LABEL = {
  he:'HE stick', precision:'precision (GBU)', fire:'incendiary run',
  denial:'area denial', mixed:'mixed load',
};
const munitionLabel = (id) => MUNITIONS[id] ? MUNITIONS[id].name : (LOADOUT_LABEL[id] || id);

// A couple of hull liveries of our own — boats.js keeps its PALETTES
// private, and duplicating four colours here beats importing internals.
const HULL_PALETTES = [
  { hullColor:0xf2efe6, stripe:0x1f6f9c, boot:0x8f3a2e },
  { hullColor:0xeae4d2, stripe:0xc4562f, boot:0x2f4858 },
  { hullColor:0xdfe6e8, stripe:0x2b8f6f, boot:0x7a3b2c },
];

const BARREL_COLORS = [0x6d4c31, 0x5c7f8a, 0x7a5433];

// number-key → tool slot. Digit1..Digit9 map to slots 0..8, Digit0 → 9.
const DIGIT_SLOT = {
  Digit1:0, Digit2:1, Digit3:2, Digit4:3, Digit5:4,
  Digit6:5, Digit7:6, Digit8:7, Digit9:8, Digit0:9,
};
const OWNED_KEYS = new Set([
  ...Object.keys(DIGIT_SLOT), 'Minus','Equal','BracketLeft','BracketRight',
  'KeyF','KeyT','KeyX','KeyG','Backspace',
]);

const fmtHour = (h) => {
  const hh = Math.floor(h), mm = Math.floor((h % 1) * 60);
  return `${String(hh).padStart(2,'0')}:${String(mm).padStart(2,'0')}`;
};

export class Creative {
  /* Every dependency is optional so this can be built (and even entered,
     for wiring tests) before every system it reaches into exists. `gov`
     is not part of the constructor the brief lists — it's accepted here
     only so the quality-governor toggle has something to flip; wire it
     up if you want that key live, it's a silent no-op otherwise. */
  constructor({ scene, camera, field, world, player, ocean, sky, strikes,
                fleet, gulls, ui, gov } = {}){
    this.scene = scene; this.camera = camera; this.field = field;
    this.world = world; this.player = player; this.ocean = ocean;
    this.sky = sky; this.strikes = strikes; this.fleet = fleet;
    this.gulls = gulls; this.ui = ui; this.gov = gov;

    this.active = false;
    this.aimPoint = new THREE.Vector3();
    this._dir = new THREE.Vector3();          // scratch for the aim ray-march

    // spawned things we own and must dispose of ourselves
    this._boats = new Set();
    this._props = [];
    this._islands = [];
    this._baseGullCount = 0;
    this._extraGulls = 0;

    // flight speed, driven by the mouse wheel rather than a numbered slot —
    // a fly-cam speed dial is the one control a scroll wheel fits naturally
    this._speedScale = 1;
    this._onWheel = (e) => {
      if(!this.active) return;
      const factor = Math.pow(1.12, e.deltaY > 0 ? -1 : 1);
      this._speedScale = clamp(this._speedScale * factor, 0.1, 40);
      this._refresh();
    };

    // world overrides: value + whether it is currently "locked" (i.e.
    // included in `wants`). Untouched fields stay unlocked forever, so
    // entering creative and never touching a dial changes nothing.
    this._world = { hour:12, storm:0.2, windSpeed:8, windDeg:180, swell:1.2 };
    this._locks = { hour:false, storm:false, windSpeed:false, windDeg:false, swell:false };

    this.munitionIdx = Math.max(0, MUNITION_CHOICES.indexOf('mk83'));
    this.slot = 0;

    this.TOOLS = [
      { id:'boat',    label:'AI boat' },
      { id:'gulls',   label:'gull flock' },
      { id:'amphora', label:'amphora' },
      { id:'barrel',  label:'barrel' },
      { id:'island',  label:'island' },
      { id:'strike',  label:'air strike' },
      { id:'hour',    label:'time of day' },
      { id:'storm',   label:'storm strength' },
      { id:'wind',    label:'wind' },
      { id:'swell',   label:'sea state (Hs)' },
    ];

    this._statusAcc = 0;
    this._buildOverlay();
  }

  /* ── lifecycle ──────────────────────────────────────────────── */

  enter(){
    if(this.active) return;
    this.active = true;
    if(this.player){
      this.player.setState('fly');
      this._installFlyOverride();
    }
    this._baseGullCount = this.gulls ? this.gulls.count : 0;
    this._speedScale = 1;
    window.addEventListener('wheel', this._onWheel, { passive:true });
    this.root.classList.add('mc-active');
    this._refresh();
  }

  exit(){
    if(!this.active) return;
    this.reset();                    // clears spawns AND world locks
    this.active = false;
    if(this.player) delete this.player.updateFly;   // restores the prototype method
    window.removeEventListener('wheel', this._onWheel);
    this.root.classList.remove('mc-active');
  }

  /* Removes everything this session has spawned and drops every world
     override, without leaving fly mode. Bound to Backspace as an
     in-session "start over," and reused by exit() for the same effect. */
  reset(){
    for(const s of Array.from(this._boats)) this._removeBoat(s);
    for(const m of Array.from(this._props)) this._removeProp(m);
    for(const isl of Array.from(this._islands)) this._removeIsland(isl);
    if(this.gulls){
      this.gulls.count = this._baseGullCount;
      this.gulls.birds.forEach((b,i) => { b.obj.visible = i < this.gulls.count; });
    }
    this._extraGulls = 0;
    this._locks.hour = this._locks.storm = this._locks.windSpeed
      = this._locks.windDeg = this._locks.swell = false;
    this._toast('Sandbox reset.');
    this._refresh();
  }

  /* ── per frame ──────────────────────────────────────────────── */

  update(dt, ctx = {}){
    if(!this.active) return;
    const camera = ctx.camera || this.camera;
    if(ctx.aimPoint) this.aimPoint.copy(ctx.aimPoint);
    else if(camera) this._computeAim(camera);

    this._statusAcc += dt;
    if(this._statusAcc > 0.15){ this._statusAcc = 0; this._refreshStatus(); }
  }

  /* `wants` is null until something is actually locked, so a creative
     session that never touches a dial never nudges the sky or sea. */
  get wants(){
    const L = this._locks;
    if(!L.hour && !L.storm && !L.windSpeed && !L.windDeg && !L.swell) return null;
    const w = this._world;
    return {
      hour:      L.hour      ? w.hour      : null,
      storm:     L.storm     ? w.storm     : null,
      windSpeed: L.windSpeed ? w.windSpeed : null,
      windDeg:   L.windDeg   ? w.windDeg   : null,
      swell:     L.swell     ? w.swell     : null,
    };
  }

  /* ── input ──────────────────────────────────────────────────── */

  handleKey(code, down){
    if(!this.active || !OWNED_KEYS.has(code)) return false;
    if(!down) return true;             // swallow the matching keyup quietly

    if(code in DIGIT_SLOT){ this.slot = DIGIT_SLOT[code]; this._refresh(); return true; }
    switch(code){
      case 'Minus':        this._adjust(-1); break;
      case 'Equal':        this._adjust(1); break;
      case 'BracketLeft':  this._adjustSecondary(-1); break;
      case 'BracketRight': this._adjustSecondary(1); break;
      case 'KeyF':         this._act(); break;
      case 'KeyT':         this._teleport(); break;
      case 'KeyX':         this._deleteLookedAt(); break;
      case 'KeyG':
        if(this.gov){ this.gov.manual = !this.gov.manual; this._toast(`Quality governor ${this.gov.manual ? 'locked' : 'auto'}.`); }
        else this._toast('No quality governor wired up.');
        break;
      case 'Backspace':    this.reset(); break;
    }
    return true;
  }

  _adjust(dir){
    const id = this.TOOLS[this.slot].id;
    if(id === 'strike'){
      this.munitionIdx = (this.munitionIdx + dir + MUNITION_CHOICES.length) % MUNITION_CHOICES.length;
    } else if(id === 'hour'){
      this._world.hour = ((this._world.hour + dir*0.25) % 24 + 24) % 24;
    } else if(id === 'storm'){
      this._world.storm = clamp(this._world.storm + dir*0.05, 0, 1);
    } else if(id === 'wind'){
      this._world.windSpeed = clamp(this._world.windSpeed + dir*0.5, 0, 30);
    } else if(id === 'swell'){
      this._world.swell = clamp(this._world.swell + dir*0.1, 0.1, 8);
    } else return;
    this._refresh();
  }

  /* The only tool with a second axis: wind direction rides [ and ]
     while speed keeps -/=, so one row covers a 2D quantity. */
  _adjustSecondary(dir){
    if(this.TOOLS[this.slot].id !== 'wind') return;
    this._world.windDeg = ((this._world.windDeg + dir*10) % 360 + 360) % 360;
    this._refresh();
  }

  /* F is context-sensitive: it spawns/fires for the action tools, and
     toggles whether a world dial is actually overriding the sim for the
     control tools — turning a dial and having it "count" are separate
     decisions on purpose, so you can dial in a storm and only unleash
     it once you're ready. */
  _act(){
    const id = this.TOOLS[this.slot].id;
    const p = this.aimPoint;
    switch(id){
      case 'boat':    this._spawnBoat(p); break;
      case 'gulls':   this._spawnGulls(p); break;
      case 'amphora': this._spawnAmphora(p); break;
      case 'barrel':  this._spawnBarrel(p); break;
      case 'island':  this._spawnIsland(p); break;
      case 'strike':  this._launchStrike(p); break;
      case 'hour': case 'storm': case 'swell':
        this._locks[id] = !this._locks[id];
        this._refresh();
        break;
      case 'wind': {
        const on = !this._locks.windSpeed;
        this._locks.windSpeed = on; this._locks.windDeg = on;
        this._refresh();
        break;
      }
    }
  }

  /* ── the fly-speed override ─────────────────────────────────── */

  /* A byte-for-byte copy of Player.updateFly with one addition — the
     `self._speedScale` factor — installed as an own property so it
     shadows the prototype method without editing player.js. `delete`
     on exit() removes the shadow and the prototype method is exactly
     what runs again. Pre-scratched vectors keep it allocation-free,
     matching the original. */
  _installFlyOverride(){
    const self = this;
    if(!this._flyScratch){
      this._flyScratch = {
        look:new THREE.Vector3(), euler:new THREE.Euler(), flat:new THREE.Vector3(),
        right:new THREE.Vector3(), acc:new THREE.Vector3(),
      };
    }
    const S = this._flyScratch;
    this.player.updateFly = function(dt, input){
      const sp = (input.sprint ? 165 : 42) * (input.slow ? 0.22 : 1) * self._speedScale;
      S.euler.set(this.pitch, this.yaw, 0, 'YXZ');
      S.look.set(0,0,-1).applyEuler(S.euler);
      S.flat.set(S.look.x, 0, S.look.z).normalize();
      S.right.set(S.flat.z, 0, -S.flat.x);
      const f = (input.fwd?1:0) - (input.back?1:0);
      const s = (input.right?1:0) - (input.left?1:0);
      S.acc.set(0,0,0).addScaledVector(S.look, f).addScaledVector(S.right, -s);
      if(input.jump) S.acc.y += 1;
      if(input.crouch) S.acc.y -= 1;
      if(S.acc.lengthSq() > 0) S.acc.normalize();
      this.vel.lerp(S.acc.multiplyScalar(sp), Math.min(1, dt*4.5));
      this.pos.addScaledVector(this.vel, dt);
      const floor = Math.max(this.field.height(this.pos.x, this.pos.z) + 1.2,
                             this.world ? this.world.heightAt(this.pos.x, this.pos.z) + 1.6 : -99);
      if(this.pos.y < floor) this.pos.y = floor;
      if(this.pos.y > 2200) this.pos.y = 2200;
    };
  }

  /* ── aim: where the camera ray meets the sea ───────────────────
     A short ray-march down the view vector, refined with a few
     bisection steps once it crosses the (moving) surface. Looking at
     or above the horizon has no honest intersection, so that case
     just parks the point out along the flat bearing instead. All
     scratch is scalar or the one pre-allocated `_dir`/`aimPoint`
     vector — nothing new is allocated per call. */
  _computeAim(camera){
    const o = camera.position, f = this.field;
    camera.getWorldDirection(this._dir);
    const dx = this._dir.x, dy = this._dir.y, dz = this._dir.z;

    if(dy > -0.02){
      const ax = o.x + dx*1600, az = o.z + dz*1600;
      this.aimPoint.set(ax, f ? f.height(ax,az) : 0, az);
      return this.aimPoint;
    }
    const maxDist = 6000, step = 40;
    let t = 0, prevT = 0, hitT = maxDist;
    while(t < maxDist){
      t += step;
      const py = o.y + dy*t;
      const sea = f ? f.height(o.x+dx*t, o.z+dz*t) : 0;
      if(py <= sea){ hitT = t; break; }
      prevT = t;
    }
    let lo = prevT, hi = Math.min(hitT, maxDist);
    for(let i = 0; i < 6; i++){
      const mid = (lo+hi)*0.5;
      const sea = f ? f.height(o.x+dx*mid, o.z+dz*mid) : 0;
      if(o.y + dy*mid > sea) lo = mid; else hi = mid;
    }
    const fx = o.x+dx*hi, fz = o.z+dz*hi;
    this.aimPoint.set(fx, f ? f.height(fx,fz) : 0, fz);
    return this.aimPoint;
  }

  /* ── spawning ───────────────────────────────────────────────── */

  _spawnBoat(pos){
    if(!this.fleet){ this._toast('No fleet to spawn into.'); return; }
    const pal = HULL_PALETTES[Math.floor(Math.random()*HULL_PALETTES.length)];
    const scale = 0.7 + Math.random()*0.6;
    const s = new Ship(this.scene, this.field, Object.assign({
      x:pos.x, z:pos.z, length:10*scale+3, beam:3.4*scale+0.6, draft:1.1*scale+0.2,
      mass:3600*scale*scale, heading:Math.random()*Math.PI*2, probesLong:6, probesLat:3,
    }, pal));
    // same fields Fleet.update() reads for every other boat it drives —
    // pushing straight into fleet.boats gets this one full autopilot,
    // sailing and eventual far-away cleanup for free.
    s.sailFull = 0.5 + Math.random()*0.4;
    s.sail = s.sailFull;
    s.goal = new THREE.Vector3(pos.x + (Math.random()-0.5)*3000, 0, pos.z + (Math.random()-0.5)*3000);
    this.fleet.boats.push(s);
    this._boats.add(s);
    this._toast('Boat launched.');
    this._refresh();
  }

  _removeBoat(s){
    const i = this.fleet ? this.fleet.boats.indexOf(s) : -1;
    if(i >= 0) this.fleet.boats.splice(i, 1);
    this.scene.remove(s.group); this.scene.remove(s.spray);
    s.group.traverse(o => { if(o.isMesh){ o.geometry?.dispose(); o.material?.dispose(); } });
    s.spray.geometry.dispose(); s.spray.material.dispose();
    this._boats.delete(s);
  }

  /* The gull pool is fixed-size (birds.js has no add/remove); "spawning"
     more means waking up birds that were sitting hidden past the mode's
     visible count and dropping them in near the aim point. */
  _spawnGulls(pos){
    if(!this.gulls){ this._toast('No gulls to call in.'); return; }
    const g = this.gulls, start = g.count;
    const add = Math.min(8, g.birds.length - start);
    if(add <= 0){ this._toast('The sky is already full.'); return; }
    for(let i = 0; i < add; i++){
      const b = g.birds[start+i];
      const a = Math.random()*Math.PI*2, r = 10 + Math.random()*60;
      b.pos.set(pos.x + Math.cos(a)*r, pos.y + 12 + Math.random()*20, pos.z + Math.sin(a)*r);
      b.obj.position.copy(b.pos); b.obj.visible = true;
      b.target.copy(b.pos); b.mode = 'roam'; b.timer = Math.random()*2;
    }
    g.count = start + add;
    this._extraGulls += add;
    this._toast(`${add} more gulls overhead.`);
    this._refresh();
  }

  _spawnAmphora(pos){
    const mesh = makeAmphora();
    mesh.position.set(pos.x, this.field ? this.field.height(pos.x,pos.z) : pos.y, pos.z);
    mesh.rotation.y = Math.random()*Math.PI*2;
    this.scene.add(mesh);
    this._props.push(mesh);
    this._toast('Amphora dropped.');
    this._refresh();
  }

  _spawnBarrel(pos){
    const color = BARREL_COLORS[Math.floor(Math.random()*BARREL_COLORS.length)];
    const mesh = makeBarrel(color);
    mesh.position.set(pos.x, this.field ? this.field.height(pos.x,pos.z) : pos.y, pos.z);
    mesh.rotation.y = Math.random()*Math.PI*2;
    this.scene.add(mesh);
    this._props.push(mesh);
    this._toast('Barrel dropped.');
    this._refresh();
  }

  _removeProp(mesh){
    this.scene.remove(mesh);
    mesh.traverse(o => { if(o.isMesh){ o.geometry?.dispose(); o.material?.dispose(); } });
    const i = this._props.indexOf(mesh);
    if(i >= 0) this._props.splice(i, 1);
  }

  /* Deliberately small and bare (no village, no light) — an Island's
     build() cuts a detailed heightfield mesh and scatters instances
     synchronously, so a full-size one would stall a frame. This is
     "island, cheaply, on demand," not a second World.generate(). */
  _spawnIsland(pos){
    if(!this.world){ this._toast('No world to place it in.'); return; }
    const seed = Math.floor(Math.random()*1e6);
    const radius = 110 + Math.random()*60;
    const isl = new Island({
      pos:new THREE.Vector3(pos.x, 0, pos.z), radius, seed,
      peak:radius*(0.30 + Math.random()*0.25), village:false, hasLight:false, detail:48,
    });
    this.scene.add(isl.group);
    this.world.islands.push(isl);
    this._islands.push(isl);
    this._toast('Land, where there was none.');
    this._refresh();
  }

  _removeIsland(isl){
    if(this.world){
      const i = this.world.islands.indexOf(isl);
      if(i >= 0) this.world.islands.splice(i, 1);
    }
    this.scene.remove(isl.group);
    isl.group.traverse(o => { if(o.isMesh){ o.geometry?.dispose(); o.material?.dispose(); } });
    const j = this._islands.indexOf(isl);
    if(j >= 0) this._islands.splice(j, 1);
  }

  /* Calling strikes.launch() directly bypasses the interval scheduler
     in strikes.update() entirely — it fires now, regardless of arm().
     storeKinds is swapped in and back out synchronously (launch() reads
     it once, before returning), so a mode's own armed strikes are never
     left carrying our munition choice. */
  _launchStrike(pos){
    if(!this.strikes){ this._toast('No strike controller wired up.'); return; }
    const id = MUNITION_CHOICES[this.munitionIdx];
    const pattern = LOADOUTS[id] || [id];
    const prevKinds = this.strikes.storeKinds;
    this.strikes.storeKinds = Array.from({ length:6 }, (_, i) => pattern[i % pattern.length]);
    this.strikes.launch(pos, null);
    this.strikes.storeKinds = prevKinds;
    this._toast(`Strike called — ${munitionLabel(id)}.`, 'bad');
  }

  /* ── manipulate ─────────────────────────────────────────────── */

  _teleport(){
    if(!this.player) return;
    const p = this.aimPoint;
    this.player.pos.set(p.x, p.y + 8, p.z);
    this.player.vel.set(0,0,0);
    this._toast('Teleported.');
  }

  /* "The thing you are looking at" among things WE spawned — deleting
     the ambient fleet or the hand-authored islands isn't this tool's
     job. Angle-to-view-ray rather than a real raycast: our spawns are
     wildly different shapes (a hull, a barrel, an island), and picking
     whatever is nearest the crosshair by bearing is honest and cheap. */
  _deleteLookedAt(){
    if(!this.camera) return;
    const camPos = this.camera.position;
    this.camera.getWorldDirection(this._dir);
    let best = null, bestCos = 0.93;   // ~21° half-cone
    const consider = (obj, pos, kind) => {
      const vx = pos.x-camPos.x, vy = pos.y-camPos.y, vz = pos.z-camPos.z;
      const dist = Math.hypot(vx,vy,vz);
      if(dist < 0.5 || dist > 5000) return;
      const cos = (vx*this._dir.x + vy*this._dir.y + vz*this._dir.z)/dist;
      if(cos > bestCos){ bestCos = cos; best = { obj, kind }; }
    };
    for(const s of this._boats) consider(s, s.pos, 'boat');
    for(const m of this._props) consider(m, m.position, 'prop');
    for(const isl of this._islands) consider(isl, isl.pos, 'island');
    if(!best){ this._toast('Nothing of yours there.'); return; }
    if(best.kind === 'boat') this._removeBoat(best.obj);
    else if(best.kind === 'prop') this._removeProp(best.obj);
    else this._removeIsland(best.obj);
    this._toast('Removed.');
    this._refresh();
  }

  _toast(msg, kind){ this.ui?.toast?.(msg, kind || 'dim'); }

  /* ── overlay ────────────────────────────────────────────────── */

  _buildOverlay(){
    if(document.getElementById('mc-style')) { this._wireOverlay(); return; }
    const style = document.createElement('style');
    style.id = 'mc-style';
    style.textContent = `
      .mare-creative{position:fixed;top:16px;right:16px;z-index:15;pointer-events:none;
        font-family:var(--sans,sans-serif);color:var(--ink,#f4ece0);
        opacity:0;transform:translateX(10px);transition:opacity .25s ease,transform .25s ease;}
      .mare-creative.mc-active{opacity:1;transform:translateX(0);}
      .mc-panel{width:264px;background:var(--panel,rgba(9,26,33,.72));
        border:1px solid var(--edge,rgba(232,180,92,.28));border-radius:3px;
        padding:12px 14px 10px;}
      .mc-panel h3{font-family:var(--serif,serif);font-size:11px;letter-spacing:.32em;
        text-transform:uppercase;color:var(--gold,#e8b45c);margin:0 0 8px;text-align:center;}
      .mc-tools{list-style:none;display:flex;flex-direction:column;gap:1px;
        margin:0 0 8px;padding:0;}
      .mc-tools li{display:flex;align-items:center;gap:8px;font-size:11.5px;
        letter-spacing:.02em;padding:3px 6px;border-radius:2px;color:var(--ink-dim,#c9bcab);}
      .mc-tools li.on{background:rgba(232,180,92,.16);color:var(--ink,#f4ece0);}
      .mc-tools li .k{display:inline-block;min-width:14px;text-align:center;font-size:9.5px;
        border:1px solid var(--gold,#e8b45c);color:var(--gold,#e8b45c);border-radius:2px;
        padding:1px 3px;flex:none;}
      .mc-tools li .lbl{flex:1;white-space:nowrap;}
      .mc-tools li .val{color:var(--gold,#e8b45c);font-size:10.5px;white-space:nowrap;}
      .mc-status{border-top:1px solid rgba(255,255,255,.10);padding-top:6px;
        font-size:10.5px;color:var(--ink-dim,#c9bcab);line-height:1.6;}
      .mc-status b{color:var(--gold,#e8b45c);font-weight:600;}
      .mc-help{margin-top:6px;font-size:9.5px;line-height:1.55;color:#7d8f95;}
      .mc-help b{color:var(--gold,#e8b45c);}
    `;
    document.head.appendChild(style);

    const root = document.createElement('div');
    root.className = 'mare-creative';
    root.innerHTML = `
      <div class="mc-panel">
        <h3>Creative</h3>
        <ol class="mc-tools"></ol>
        <div class="mc-status">
          <div>flight ×<b class="mc-speed">1.0</b> · aim <b class="mc-aim">—</b></div>
          <div class="mc-counts">boats 0 · props 0 · islands 0 · gulls +0</div>
        </div>
        <div class="mc-help"><b>F</b> act · <b>-/=</b> adjust · <b>[/]</b> wind dir ·
          <b>T</b> teleport · <b>X</b> delete looked-at · <b>G</b> quality · <b>⌫</b> reset</div>
      </div>`;
    document.body.appendChild(root);
    this.root = root;
    this._wireOverlay();
  }

  _wireOverlay(){
    const list = this.root.querySelector('.mc-tools');
    list.innerHTML = '';
    this._rows = this.TOOLS.map((tool, i) => {
      const li = document.createElement('li');
      const key = i === 9 ? '0' : String(i+1);
      li.innerHTML = `<span class="k">${key}</span><span class="lbl">${tool.label}</span><span class="val"></span>`;
      list.appendChild(li);
      return { li, val:li.querySelector('.val') };
    });
    this._speedEl = this.root.querySelector('.mc-speed');
    this._aimEl = this.root.querySelector('.mc-aim');
    this._countsEl = this.root.querySelector('.mc-counts');
    this._refresh();
  }

  _valueFor(id){
    switch(id){
      case 'strike': return munitionLabel(MUNITION_CHOICES[this.munitionIdx]);
      case 'hour':   return `${fmtHour(this._world.hour)}${this._locks.hour ? '' : ' (off)'}`;
      case 'storm':  return `${Math.round(this._world.storm*100)}%${this._locks.storm ? '' : ' (off)'}`;
      case 'wind':   return `${this._world.windSpeed.toFixed(1)} m/s @ ${Math.round(this._world.windDeg)}°${this._locks.windSpeed ? '' : ' (off)'}`;
      case 'swell':  return `${this._world.swell.toFixed(2)} m${this._locks.swell ? '' : ' (off)'}`;
      default: return '';
    }
  }

  _refresh(){
    if(!this._rows) return;
    this._rows.forEach((row, i) => {
      row.li.classList.toggle('on', i === this.slot);
      row.val.textContent = this._valueFor(this.TOOLS[i].id);
    });
    this._refreshStatus();
  }

  _refreshStatus(){
    if(!this._speedEl) return;
    this._speedEl.textContent = this._speedScale.toFixed(this._speedScale < 2 ? 2 : 1);
    const p = this.aimPoint;
    this._aimEl.textContent = `${p.x.toFixed(0)}, ${p.z.toFixed(0)}`;
    this._countsEl.textContent =
      `boats ${this._boats.size} · props ${this._props.length} · islands ${this._islands.length} · gulls +${this._extraGulls}`;
  }
}
