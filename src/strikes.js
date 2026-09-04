import * as THREE from 'three';
import { Flyover } from './fx/flyover.js';
import { buildBomb, setFins } from './fx/ordnance.js';
import { Blast } from './fx/blast.js';

/* Contested waters. Flight, stores and blast visuals live in focused
   modules; this is the gameplay seam that schedules runs, integrates
   released bombs, marks the water and applies consequences. */

const G = 9.81;
const FORWARD = new THREE.Vector3(0, 0, 1);

export class Strikes {
  constructor(scene, field, audio, cb = {}){
    this.scene = scene; this.field = field; this.audio = audio; this.cb = cb;
    this.active = false;
    this.timer = 55;
    this.interval = 95;
    this.wave = 0;
    this.bombs = [];
    this.flash = 0;

    this.blast = new Blast(scene, field);
    this.flyover = new Flyover(scene, {
      audio,
      makeStore: () => buildBomb('mk83'),
    });
    this.flyover.onRelease = (pos, vel, index) => this.release(pos, vel, index);
    this.flyover.onPass = () => this.cb.toast?.('The engines split the sky overhead.', 'bad');

    // The painted aiming rings are the player's fair warning. They follow
    // the moving wave surface until the corresponding store arrives.
    this.markerGeo = new THREE.RingGeometry(9.0, 10.6, 48);
    this.markers = [];
    for(let i = 0; i < 6; i++){
      const mat = new THREE.MeshBasicMaterial({
        color:0xff5a3c, transparent:true, opacity:0,
        blending:THREE.AdditiveBlending, depthWrite:false, side:THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.markerGeo, mat);
      mesh.rotation.x = -Math.PI/2;
      mesh.visible = false;
      mesh.renderOrder = 5;
      scene.add(mesh);
      this.markers.push({ mesh, impact:null, live:false, released:false, t:0 });
    }

    this._dir = new THREE.Vector3();
    this._aim = new THREE.Vector3();
    this._impact = new THREE.Vector3();
  }

  arm(on, interval = 95){
    this.active = on;
    this.interval = interval;
    this.timer = on ? 48 : 1e9;
    this.wave = 0;
    if(on) return;

    this.flyover.abort();
    for(const b of this.bombs) this.scene.remove(b.mesh);
    this.bombs.length = 0;
    for(const m of this.markers){
      m.live = false; m.released = false; m.impact = null;
      m.mesh.visible = false;
    }
  }

  launch(target, ship){
    this.wave++;
    const count = Math.min(5, 1 + Math.floor(this.wave/2) + (Math.random() < 0.4 ? 1 : 0));
    const heading = Math.random()*Math.PI*2;

    // Lead modestly. The long visible run-in is warning, not a perfect
    // prediction of a manoeuvring boat, so moving promptly still matters.
    this._aim.copy(target);
    if(ship) this._aim.addScaledVector(ship.vel, 5.5);
    this._aim.y = 0;

    this.flyover.start({
      target:this._aim,
      count,
      spacing:42 + Math.random()*18,
      heading,
      altitude:520 + Math.random()*130,
      speed:235 + Math.random()*35,
    });

    for(let i = 0; i < this.markers.length; i++){
      const m = this.markers[i];
      const p = this.flyover.plannedImpacts[i];
      m.live = !!p; m.released = false; m.t = 0; m.impact = p || null;
      m.mesh.visible = !!p;
      if(p){
        m.mesh.position.set(p.x, this.field.height(p.x,p.z)+0.12, p.z);
        m.mesh.scale.setScalar(1);
        m.mesh.material.opacity = 0.12;
      }
    }

    this.cb.toast?.('Aircraft — high, fast, unmarked. It has seen you.', 'bad');
  }

  release(pos, vel, index){
    const mesh = buildBomb(index%3 === 2 ? 'gbu12' : 'mk83');
    mesh.position.copy(pos);
    setFins(mesh, 0);
    this.scene.add(mesh);
    this.bombs.push({ mesh, vel:vel.clone(), index, age:0 });
    if(this.markers[index]) this.markers[index].released = true;
    if(this.bombs.length === 1)
      this.cb.toast?.('Something is coming down. Get out from under it.', 'bad');
  }

  update(dt, target, ship, playerPos){
    this.blast.update(dt, playerPos);
    this.flash = this.blast.flash;
    this.updateMarkers(dt);

    // Released stores and residual effects finish even if a mode switch
    // disarms future sorties midway through their fall.
    this.updateBombs(dt, ship, playerPos);
    if(!this.active) return;

    this.flyover.update(dt, playerPos);
    if(!this.flyover.active && this.bombs.length === 0){
      this.timer -= dt;
      if(this.timer <= 0){
        this.timer = this.interval*(0.65 + Math.random()*0.7)/(1 + this.wave*0.05);
        this.launch(target, ship);
      }
    }
  }

  updateMarkers(dt){
    for(const m of this.markers){
      if(!m.live || !m.impact) continue;
      m.t += dt;
      m.mesh.position.y = this.field.height(m.impact.x, m.impact.z) + 0.12;
      const rate = m.released ? 11 : 3.2;
      const pulse = 0.5 + 0.5*Math.abs(Math.sin(m.t*rate));
      m.mesh.material.opacity = (m.released ? 0.62 : 0.28)*(0.45 + pulse*0.55);
      m.mesh.scale.setScalar(m.released ? 0.82 + pulse*0.18 : 1);
    }
  }

  updateBombs(dt, ship, playerPos){
    for(let i = this.bombs.length-1; i >= 0; i--){
      const b = this.bombs[i];
      b.age += dt;
      b.vel.y -= G*dt;
      b.mesh.position.addScaledVector(b.vel, dt);
      setFins(b.mesh, Math.min(1, b.age*3.5));

      this._dir.copy(b.vel);
      if(this._dir.lengthSq() > 1e-6){
        this._dir.normalize();
        b.mesh.quaternion.setFromUnitVectors(FORWARD, this._dir);
      }

      const seaY = this.field.height(b.mesh.position.x, b.mesh.position.z);
      if(b.mesh.position.y > seaY) continue;

      this._impact.set(b.mesh.position.x, seaY, b.mesh.position.z);
      this.detonate(this._impact, ship, playerPos);
      const marker = this.markers[b.index];
      if(marker){ marker.live = false; marker.mesh.visible = false; }
      this.scene.remove(b.mesh);
      this.bombs.splice(i, 1);
    }
  }

  detonate(point, ship, playerPos){
    this.blast.water(point, 1);
    const d = playerPos ? playerPos.distanceTo(point) : 999;
    this.audio.explosion(THREE.MathUtils.clamp(1-d/700, 0.05, 1), d/340);

    if(ship){
      const force = Blast.impulseAt(point, ship.pos);
      if(force) ship.impulse(force, point);
    }
    if(d < 90) this.cb.shake?.(THREE.MathUtils.clamp(1-d/90, 0, 1));
    if(d < 55) this.cb.damage?.(THREE.MathUtils.clamp(1-d/55, 0, 1)*95,
      'A near miss. The water hit you like a wall.');
    if(d < 16) this.cb.damage?.(200, 'You were where it landed.');
  }

  dispose(){
    this.arm(false);
    this.flyover.dispose();
    this.blast.dispose();
    for(const m of this.markers){ this.scene.remove(m.mesh); m.mesh.material.dispose(); }
    this.markerGeo.dispose();
  }
}
