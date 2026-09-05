import * as THREE from 'three';
import { Aircraft } from './fx/aircraft.js';
import { Ship } from './boats.js';

/* ────────────────────────────────────────────────────────────────
   The other seat.

   The pilot flies the aircraft that has, until now, only ever flown
   itself. `fx/aircraft.js` was already a complete six-degree-of-freedom
   flight model with stall, spiral stability, compressible drag and a
   barometric altimeter that can be wrong; this is the seat bolted into
   it — controls, a camera, and an instrument panel.

   What is deliberately NOT here is as important as what is:

     · No target marker, box, diamond or lead pipper over any boat.
     · No CCIP or CCRP. No release cue. No impact prediction.
     · No damage readout, no kill confirmation, no score.
     · No map, no radar, no contact list.

   The pilot has an altimeter, an airspeed indicator, a compass, a fuel
   gauge, a stores count, and a window. Everything else — which of those
   wakes is a person, whether the last stick landed anywhere near it — has
   to come out of the window. The instruments are honest instruments,
   which means the altimeter reads what the pressure says it reads, and
   flying through a front without resetting the datum will lie to you by
   a hundred metres or more without ever telling you it has.

   The boats the pilot can see are replicated from the sailor's client
   with no identifying information at all, and they are rendered with the
   same hull the sailor's own boat uses, because anything else would give
   the answer away for free.
   ──────────────────────────────────────────────────────────────── */

const RAD2DEG = 180/Math.PI;

export class Pilot {
  constructor(opts = {}){
    this.scene = opts.scene;
    this.field = opts.field;
    this.camera = opts.camera;
    this.session = opts.session || null;
    this.onToast = opts.onToast || (()=>{});

    this.ac = new Aircraft(this.scene, {
      atmosphere: opts.atmosphere, weather: opts.weather, field: opts.field,
      pos: opts.pos || { x: 0, y: 1200, z: -6000 },
      heading: opts.heading ?? 0,
      speed: opts.speed ?? 210,
      loadout: opts.loadout || 'mixed',
    });

    this.controls = { pitch:0, roll:0, yaw:0, throttle:0.72, burner:0, airbrake:0 };
    this.view = 'cockpit';          // 'cockpit' | 'chase'
    this.gearOfInterest = 0;

    // stick position, so a keyboard behaves like a spring-centred stick
    // rather than a bang-bang switch
    this._stick = { p:0, r:0, y:0 };

    // Replicated contacts. Same hull as the sailor sails, on purpose.
    this._hulls = [];
    this._maxHulls = 14;

    this._fwd = new THREE.Vector3();
    this._up = new THREE.Vector3();
    this._camPos = new THREE.Vector3();
    this._look = new THREE.Vector3();
    this._q = new THREE.Quaternion();

    this.dead = false;
    this.cause = '';
    this._lastAlt = this.ac.pos.y;
  }

  /* ── controls ───────────────────────────────────────────────
     WASD is the stick, not a movement vector: W/S is pitch, A/D is roll.
     Q/E is the rudder, Shift/Ctrl is the throttle, Space releases. */
  applyInput(input, dt, keys){
    const rate = 2.6, centre = 3.4;
    const towards = (cur, want) => {
      if(want !== 0) return THREE.MathUtils.clamp(cur + want*rate*dt, -1, 1);
      // spring back to centre when nothing is held
      const s = Math.sign(cur), m = Math.abs(cur) - centre*dt;
      return m <= 0 ? 0 : s*m;
    };
    // Pull back to climb: the stick is inverted, as a stick is.
    this._stick.p = towards(this._stick.p, (input.back?1:0) - (input.fwd?1:0));
    this._stick.r = towards(this._stick.r, (input.right?1:0) - (input.left?1:0));
    this._stick.y = towards(this._stick.y, (keys?.rudderR?1:0) - (keys?.rudderL?1:0));

    this.controls.pitch = this._stick.p;
    this.controls.roll = this._stick.r;
    this.controls.yaw = this._stick.y;

    const t = this.controls;
    if(input.jump) t.throttle = THREE.MathUtils.clamp(t.throttle + dt*0.55, 0, 1);
    if(input.crouch) t.throttle = THREE.MathUtils.clamp(t.throttle - dt*0.55, 0, 1);
    // Burner only bites at the top of the throttle range, as it does.
    t.burner = (input.sprint && t.throttle > 0.98) ? 1 : 0;
    t.airbrake = keys?.airbrake ? 1 : 0;
  }

  release(){
    if(this.dead) return null;
    const rel = this.ac.release();
    if(!rel){ this.onToast('Pylons empty. Nothing left to drop.', 'bad'); return null; }
    this.session?.sendDrop(rel);
    this.onToast(`Away — ${this.ac.storesCount} left.`, '');
    return rel;
  }

  setAltimeter(hPa){
    this.ac.setAltimeterDatum(hPa);
    this.onToast(`Altimeter set ${Math.round(hPa)} hPa.`, '');
  }

  toggleView(){ this.view = this.view === 'cockpit' ? 'chase' : 'cockpit'; }

  update(dt, ctx = {}){
    if(!this.dead){
      this.ac.update(dt, this.controls);

      // The sea is not scenery. Flying into it ends the sortie.
      const sea = this.field.height(this.ac.pos.x, this.ac.pos.z);
      const ground = ctx.world ? Math.max(sea, ctx.world.heightAt(this.ac.pos.x, this.ac.pos.z)) : sea;
      if(this.ac.pos.y <= ground + 2.5 || this.ac.crashed){
        this.dead = true;
        this.cause = this.ac.pos.y <= sea + 2.5
          ? 'You flew it into the sea.'
          : 'You flew it into the ground.';
      }
      if(this.ac.fuel <= 0 && !this._fuelWarned){
        this._fuelWarned = true;
        this.onToast('Flame-out. You are a glider now.', 'bad');
      }
    }

    this._syncContacts(ctx.contacts || []);
    this._camera(dt);
  }

  /* Replicated hulls. Pooled, and every one identical — the pilot is not
     being told which is which, so they must not look it either. */
  _syncContacts(list){
    while(this._hulls.length < Math.min(list.length, this._maxHulls)){
      const s = new Ship(this.scene, this.field, {});
      // Purely a puppet: never stepped, never given physics. The sailor's
      // client owns where it is; this end only draws it.
      s.group.visible = false;
      this._hulls.push(s);
    }
    for(let i = 0; i < this._hulls.length; i++){
      const h = this._hulls[i], v = list[i];
      if(!v){ h.group.visible = false; continue; }
      h.group.visible = true;
      h.group.position.set(v.x, v.y, v.z);
      h.group.rotation.set(v.p || 0, v.h || 0, v.r || 0, 'YXZ');
      if(h.spray) h.spray.visible = false;
    }
  }

  _camera(dt){
    const ac = this.ac;
    ac.group.updateMatrixWorld(true);
    this._fwd.set(0,0,1).applyQuaternion(ac.quat);
    this._up.set(0,1,0).applyQuaternion(ac.quat);

    if(this.view === 'cockpit'){
      // Eye position: up on the spine, forward of the wing, so the nose
      // sits low in frame the way it does from a real seat.
      this._camPos.copy(ac.pos)
        .addScaledVector(this._fwd, 4.2)
        .addScaledVector(this._up, 0.75);
      ac.group.visible = false;
    } else {
      this._camPos.copy(ac.pos)
        .addScaledVector(this._fwd, -26)
        .addScaledVector(this._up, 6.5);
      ac.group.visible = true;
    }
    this.camera.position.lerp(this._camPos, Math.min(1, dt*18));
    this._look.copy(ac.pos).addScaledVector(this._fwd, 260);
    this.camera.up.copy(this._up);
    this.camera.lookAt(this._look);
  }

  /* Instruments only. Everything here is something a panel could show. */
  readout(){
    const i = this.ac.instruments;
    const kt = i.indicatedAirspeed*1.94384;
    return {
      altitude: Math.round(i.altitude),
      ias: Math.round(kt),
      heading: ((i.heading % 360) + 360) % 360,
      vsi: Math.round(i.vsi*196.85),         // m/s → ft/min, as an altimeter's needle reads
      fuel: Math.max(0, Math.round(this.ac.fuel)),
      fuelPct: THREE.MathUtils.clamp(this.ac.fuel/this.ac.fuelCapacity, 0, 1),
      stores: this.ac.storesCount,
      g: i.g, aoa: i.aoa,
      stalled: this.ac.stalled,
      mach: this.ac.trueAirspeed/(this.ac.atmosphere?.speedOfSound || 340),
    };
  }

  dispose(){
    try { this.scene.remove(this.ac.group); } catch {}
    for(const h of this._hulls){
      try { this.scene.remove(h.group); if(h.spray) this.scene.remove(h.spray); } catch {}
    }
    this._hulls.length = 0;
  }
}
