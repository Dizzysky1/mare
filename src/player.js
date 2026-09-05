import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   Four ways to be in this world:
     fly   — spectator, no body, no consequences
     deck  — standing on a hull that is itself being thrown about
     swim  — in the water, which is a bad place to be
     land  — ashore on a heightfield
   The deck case is the interesting one: you live in the ship's local
   frame, and the ship's acceleration and heel show up as real forces
   on your feet.
   ──────────────────────────────────────────────────────────────── */

const EYE = 1.62;

export function buildBody(){
  const g = new THREE.Group();
  const skin  = new THREE.MeshStandardMaterial({ color:0xc99b6e, roughness:0.85 });
  const shirt = new THREE.MeshStandardMaterial({ color:0xe6e2d4, roughness:0.92 });
  const pants = new THREE.MeshStandardMaterial({ color:0x3d4a55, roughness:0.95 });
  const boot  = new THREE.MeshStandardMaterial({ color:0x4a3729, roughness:0.95 });
  const hair  = new THREE.MeshStandardMaterial({ color:0x2c2118, roughness:1 });

  const seg = (w,h,d,mat, cy=-h/2) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w,h,d), mat);
    m.position.y = cy; m.castShadow = true; m.receiveShadow = true;
    const p = new THREE.Group(); p.add(m); return p;
  };

  const hips = new THREE.Group();
  const pelvis = new THREE.Mesh(new THREE.BoxGeometry(0.34,0.22,0.22), pants);
  pelvis.castShadow = true; hips.add(pelvis);

  const torso = new THREE.Group();
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.40,0.56,0.24), shirt);
  chest.position.y = 0.30; chest.castShadow = true; chest.receiveShadow = true;
  torso.add(chest);
  torso.position.y = 0.11;
  hips.add(torso);

  const neck = new THREE.Group();
  neck.position.y = 0.60;
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.20,0.24,0.21), skin);
  head.position.y = 0.13; head.castShadow = true;
  const cap = new THREE.Mesh(new THREE.BoxGeometry(0.215,0.10,0.222), hair);
  cap.position.y = 0.215;
  neck.add(head, cap);
  torso.add(neck);

  const mkArm = (side) => {
    const sh = new THREE.Group();
    sh.position.set(0.245*side, 0.52, 0);
    const up = seg(0.115,0.30,0.115, shirt);
    sh.add(up);
    const el = new THREE.Group(); el.position.y = -0.30;
    const lo = seg(0.10,0.30,0.10, skin);
    el.add(lo); up.add(el);
    torso.add(sh);
    return { sh, el };
  };
  const mkLeg = (side) => {
    const hp = new THREE.Group();
    hp.position.set(0.115*side, -0.10, 0);
    const up = seg(0.145,0.42,0.15, pants);
    hp.add(up);
    const kn = new THREE.Group(); kn.position.y = -0.42;
    const lo = seg(0.125,0.40,0.13, pants);
    kn.add(lo); up.add(kn);
    const ft = new THREE.Mesh(new THREE.BoxGeometry(0.14,0.09,0.26), boot);
    ft.position.set(0,-0.435,0.05); ft.castShadow = true;
    kn.add(ft);
    hips.add(hp);
    return { hp, kn };
  };

  const armL = mkArm(1), armR = mkArm(-1);
  const legL = mkLeg(1), legR = mkLeg(-1);

  hips.position.y = 0.92;
  g.add(hips);
  return { root:g, hips, torso, neck, head, armL, armR, legL, legR, eyeHeight:EYE };
}

export class Player {
  constructor(scene, field, world){
    this.field = field; this.world = world;
    this.state = 'fly';
    this.pos = new THREE.Vector3(0, 60, 0);      // world position of the feet
    this.vel = new THREE.Vector3();
    this.local = new THREE.Vector3(0, 0, -1.6);  // deck-space position
    this.localVel = new THREE.Vector3();
    this.yaw = 0; this.pitch = 0;
    this.onGround = false;
    this.thirdPerson = false;
    this.bob = 0; this.stride = 0;
    this.breath = 1;                              // 0..1 lungs, matters when swimming
    this.stamina = 1;
    // Whole-body work capacity, 0..1. Driven down by things that stop a
    // person hauling on a rope — coughing, burns, exhaustion.
    this.effort = 1;
    this.ship = null;
    this.body = buildBody();
    this.body.root.visible = false;
    scene.add(this.body.root);
    this._q = new THREE.Quaternion(); this._v = new THREE.Vector3(); this._v2 = new THREE.Vector3();
    this.headWorld = new THREE.Vector3();
    this.shake = 0;
    this.wet = 0;
  }

  setState(s){
    if(this.state === s) return;
    this.state = s;
    this.body.root.visible = (s !== 'fly');
    if(s === 'swim') this.wet = 1;
  }

  boardShip(ship){
    this.ship = ship;
    this.setState('deck');
    // forward of the mast so the sail is not in your face, facing the bow
    // (yaw 0 looks along −Z, and the bow is +Z, so face the other way)
    this.local.set(0.5, 0, ship.length*0.22);
    this.localVel.set(0,0,0);
    this.yaw = Math.PI;
    this.pitch = -0.06;
  }

  /* ── input → motion ─────────────────────────────────────────── */
  update(dt, input, ship){
    this.ship = ship || this.ship;
    switch(this.state){
      case 'fly':  this.updateFly(dt, input); break;
      case 'deck': this.updateDeck(dt, input); break;
      case 'swim': this.updateSwim(dt, input); break;
      case 'land': this.updateLand(dt, input); break;
    }
    this.wet = Math.max(0, this.wet - dt*(this.state==='swim' ? 0 : 0.06));
    this.shake = Math.max(0, this.shake - dt*2.4);
    this.animate(dt, input);
  }

  moveDir(input, yaw){
    const f = (input.fwd?1:0) - (input.back?1:0);
    const s = (input.right?1:0) - (input.left?1:0);
    if(!f && !s) return this._v.set(0,0,0);
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    // forward is -Z rotated by yaw
    this._v.set(-sy*f + cy*s, 0, -cy*f - sy*s);
    return this._v.normalize();
  }

  updateFly(dt, input){
    const sp = (input.sprint ? 165 : 42)*(input.slow ? 0.22 : 1);
    const dir = this.moveDir(input, this.yaw).clone();
    // in spectator we fly where we look
    const look = new THREE.Vector3(0,0,-1).applyEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
    const flat = new THREE.Vector3(look.x, 0, look.z).normalize();
    const rightV = new THREE.Vector3(flat.z, 0, -flat.x);
    const f = (input.fwd?1:0) - (input.back?1:0);
    const s = (input.right?1:0) - (input.left?1:0);
    const acc = new THREE.Vector3();
    acc.addScaledVector(look, f).addScaledVector(rightV, -s);
    if(input.jump) acc.y += 1;
    if(input.crouch) acc.y -= 1;
    if(acc.lengthSq() > 0) acc.normalize();
    this.vel.lerp(acc.multiplyScalar(sp), Math.min(1, dt*4.5));
    this.pos.addScaledVector(this.vel, dt);
    const floor = Math.max(this.field.height(this.pos.x, this.pos.z) + 1.2,
                           this.world ? this.world.heightAt(this.pos.x, this.pos.z) + 1.6 : -99);
    if(this.pos.y < floor) this.pos.y = floor;
    if(this.pos.y > 2200) this.pos.y = 2200;
  }

  updateDeck(dt, input){
    const ship = this.ship;
    if(!ship) return;
    const inv = this._q.copy(ship.quat).invert();

    // gravity and the ship's own acceleration, in deck coordinates
    const gLocal = this._v2.set(0,-9.81,0).applyQuaternion(inv);
    const aLocal = new THREE.Vector3().copy(ship.accel).applyQuaternion(inv);

    const deckY = ship.deckY(this.local.x, this.local.z);
    const standing = this.local.y <= deckY + 0.02;

    const dir = this.moveDir(input, this.yaw);
    const walk = (input.sprint ? 5.4 : 2.9)*this.effort;
    const control = standing ? 1 : 0.18;

    // your legs push you along the deck; the deck's tilt and surges push back
    this.localVel.x += (dir.x*walk - this.localVel.x)*Math.min(1, dt*9*control);
    this.localVel.z += (dir.z*walk - this.localVel.z)*Math.min(1, dt*9*control);
    this.localVel.x += (gLocal.x*0.62 - aLocal.x*0.85)*dt;
    this.localVel.z += (gLocal.z*0.62 - aLocal.z*0.85)*dt;
    this.localVel.y += (gLocal.y - aLocal.y)*dt;

    if(standing && input.jump && this.jumpCool <= 0){
      this.localVel.y = 4.4; this.jumpCool = 0.35;
    }
    this.jumpCool = Math.max(0, (this.jumpCool||0) - dt);

    this.local.addScaledVector(this.localVel, dt);

    const nd = ship.deckY(this.local.x, this.local.z);
    if(this.local.y < nd){
      if(ship.onDeck(this.local.x, this.local.z)){
        if(this.localVel.y < -6) this.shake = Math.min(1, -this.localVel.y/14);
        this.local.y = nd;
        this.localVel.y = 0;
        // friction from your feet
        const f = Math.pow(0.0016, dt);
        this.localVel.x *= f; this.localVel.z *= f;
      }
    }
    // over the side?
    if(!ship.onDeck(this.local.x, this.local.z) && this.local.y < nd - 0.5){
      const wp = this.local.clone().applyQuaternion(ship.quat).add(ship.pos);
      this.pos.copy(wp);
      this.vel.copy(this.localVel).applyQuaternion(ship.quat).add(ship.vel);
      this.setState('swim');
      return;
    }
    // walked off the bow into thin air but still inside the hull footprint
    this.local.x = THREE.MathUtils.clamp(this.local.x, -ship.beam, ship.beam);
    this.local.z = THREE.MathUtils.clamp(this.local.z, -ship.length*0.62, ship.length*0.62);

    this.pos.copy(this.local).applyQuaternion(ship.quat).add(ship.pos);
    this.speed = Math.hypot(this.localVel.x, this.localVel.z);
    this.onGround = standing;
  }

  updateSwim(dt, input){
    const s = this.field.sample(this.pos.x, this.pos.z, {});
    const surface = s.y;
    const submerged = THREE.MathUtils.clamp((surface - this.pos.y)/1.7, 0, 1);

    const dir = this.moveDir(input, this.yaw);
    const swim = (input.sprint && this.stamina > 0.05 ? 3.0 : 1.55)*this.effort;
    if(input.sprint && dir.lengthSq() > 0) this.stamina = Math.max(0, this.stamina - dt*0.22);
    else this.stamina = Math.min(1, this.stamina + dt*0.10);

    this.vel.x += (dir.x*swim + s.vx*0.9 - this.vel.x)*Math.min(1, dt*1.9);
    this.vel.z += (dir.z*swim + s.vz*0.9 - this.vel.z)*Math.min(1, dt*1.9);

    // float: strong upward push once your head is under
    const buoy = submerged*16.0 - 9.81;
    this.vel.y += buoy*dt;
    this.vel.y *= Math.pow(0.02, dt);
    if(input.jump) this.vel.y += dt*7.0;        // tread water / climb a wave
    if(input.crouch) this.vel.y -= dt*9.0;      // duck under

    this.pos.addScaledVector(this.vel, dt);

    // breath
    const under = this.pos.y + 1.5 < surface;
    this.breath = THREE.MathUtils.clamp(this.breath + (under ? -dt*0.14 : dt*0.5), 0, 1);

    // touch bottom?
    const ground = this.world ? this.world.heightAt(this.pos.x, this.pos.z) : -99;
    // Come onto your feet in genuinely wadeable water. The matching
    // land→swim threshold is deeper, leaving a small hysteresis band so
    // wave motion cannot flip the state every other frame at the beach.
    if(ground > this.pos.y - 0.2 && ground > -1.05){
      this.pos.y = ground;
      this.setState('land');
      this.vel.set(0,0,0);
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);
    this.submerged = submerged;
  }

  updateLand(dt, input){
    const dir = this.moveDir(input, this.yaw);
    const walk = (input.sprint && this.stamina > 0.02 ? 6.2 : 3.3)*this.effort;
    if(input.sprint && dir.lengthSq() > 0) this.stamina = Math.max(0, this.stamina - dt*0.16);
    else this.stamina = Math.min(1, this.stamina + dt*0.13);

    this.vel.x += (dir.x*walk - this.vel.x)*Math.min(1, dt*11);
    this.vel.z += (dir.z*walk - this.vel.z)*Math.min(1, dt*11);
    this.vel.y -= 22*dt;
    if(this.onGround && input.jump){ this.vel.y = 6.4; this.onGround = false; }

    this.pos.addScaledVector(this.vel, dt);
    const h = this.world.heightAt(this.pos.x, this.pos.z);

    // slopes you cannot climb push you back down
    if(this.pos.y <= h){
      const e = 0.9;
      const nx = this.world.heightAt(this.pos.x-e, this.pos.z) - this.world.heightAt(this.pos.x+e, this.pos.z);
      const nz = this.world.heightAt(this.pos.x, this.pos.z-e) - this.world.heightAt(this.pos.x, this.pos.z+e);
      const n = new THREE.Vector3(nx, 2*e, nz).normalize();
      this.pos.y = h;
      this.vel.y = 0;
      this.onGround = true;
      if(n.y < 0.62){
        this.vel.x += n.x*22*dt;
        this.vel.z += n.z*22*dt;
      }
      const f = Math.pow(0.0009, dt);
      this.vel.x *= f; this.vel.z *= f;
    } else this.onGround = false;

    const seaY = this.field.height(this.pos.x, this.pos.z);
    if(h < -1.35 && this.pos.y < seaY + 0.3){
      this.setState('swim');
    }
    this.speed = Math.hypot(this.vel.x, this.vel.z);
  }

  /* ── the body ───────────────────────────────────────────────── */
  animate(dt, input){
    const b = this.body;
    if(this.state === 'fly') return;

    const onShip = this.state === 'deck' && this.ship;
    if(onShip){
      b.root.position.copy(this.ship.pos);
      b.root.quaternion.copy(this.ship.quat);
      const off = this._v.copy(this.local);
      b.root.position.add(off.applyQuaternion(this.ship.quat));
      b.root.quaternion.multiply(this._q.setFromAxisAngle(new THREE.Vector3(0,1,0), this.yaw + Math.PI));
    } else {
      b.root.position.copy(this.pos);
      b.root.quaternion.setFromAxisAngle(new THREE.Vector3(0,1,0), this.yaw + Math.PI);
    }

    const sp = this.speed || 0;
    const swimming = this.state === 'swim';

    if(swimming){
      this.stride += dt*3.2;
      b.hips.position.y = 0.92;
      b.hips.rotation.set(-1.15, 0, Math.sin(this.stride*0.5)*0.12);
      const a = this.stride;
      b.armL.sh.rotation.set(-2.2 + Math.sin(a)*1.5, 0.25, 0.35);
      b.armR.sh.rotation.set(-2.2 + Math.sin(a+Math.PI)*1.5, -0.25, -0.35);
      b.armL.el.rotation.x = -0.5 - Math.max(0,Math.sin(a))*0.6;
      b.armR.el.rotation.x = -0.5 - Math.max(0,Math.sin(a+Math.PI))*0.6;
      b.legL.hp.rotation.x = Math.sin(a*1.6)*0.55 - 0.15;
      b.legR.hp.rotation.x = Math.sin(a*1.6+Math.PI)*0.55 - 0.15;
      b.legL.kn.rotation.x = 0.4 + Math.sin(a*1.6)*0.3;
      b.legR.kn.rotation.x = 0.4 + Math.sin(a*1.6+Math.PI)*0.3;
      b.neck.rotation.x = 0.9;
      return;
    }

    // walk cycle
    const cadence = THREE.MathUtils.clamp(sp/1.35, 0, 6);
    this.stride += dt*(2.4 + cadence*1.6)*(sp > 0.15 ? 1 : 0);
    const a = this.stride;
    const amp = THREE.MathUtils.clamp(sp*0.30, 0, 0.95);

    b.legL.hp.rotation.x = Math.sin(a)*amp;
    b.legR.hp.rotation.x = Math.sin(a+Math.PI)*amp;
    b.legL.kn.rotation.x = Math.max(0, -Math.sin(a-0.6))*amp*1.35;
    b.legR.kn.rotation.x = Math.max(0, -Math.sin(a+Math.PI-0.6))*amp*1.35;

    // arms counter-swing; when the deck heels hard, they come out for balance
    let heel = 0, pitchT = 0, surge = 0;
    if(onShip){
      const up = this._v.set(0,1,0).applyQuaternion(this.ship.quat);
      heel = Math.asin(THREE.MathUtils.clamp(this._v2.set(1,0,0).applyQuaternion(this.ship.quat).y, -1, 1));
      pitchT = Math.asin(THREE.MathUtils.clamp(this._v2.set(0,0,1).applyQuaternion(this.ship.quat).y, -1, 1));
      surge = THREE.MathUtils.clamp(this.ship.accel.length()/6, 0, 1);
    }
    const brace = THREE.MathUtils.clamp(Math.abs(heel)*1.9 + surge*0.7, 0, 0.85);

    b.armL.sh.rotation.set(Math.sin(a+Math.PI)*amp*0.85 - brace*0.25, 0, 0.10 + brace*0.72);
    b.armR.sh.rotation.set(Math.sin(a)*amp*0.85 - brace*0.25, 0, -0.10 - brace*0.72);
    b.armL.el.rotation.x = -0.25 - amp*0.35 - brace*0.4;
    b.armR.el.rotation.x = -0.25 - amp*0.35 - brace*0.4;

    // hips bob, torso counter-rotates, head stays level with the horizon
    this.bob += dt*(2.4 + cadence*1.6)*(sp > 0.15 ? 1 : 0);
    const stand = this.state === 'land' ? this.world.heightAt(this.pos.x, this.pos.z) : 0;
    b.hips.position.y = 0.92 + Math.abs(Math.sin(this.bob))*amp*0.055
                      + (this.state === 'deck' ? Math.sin(this.field.time*1.3)*0.012 : 0);
    b.hips.rotation.set(-brace*0.18, Math.sin(a)*amp*0.12, -heel*0.55);
    b.torso.rotation.set(pitchT*0.35, -Math.sin(a)*amp*0.20, heel*0.30);
    b.neck.rotation.set(-this.pitch*0.5 - pitchT*0.55, 0, -heel*0.25);
  }

  /* Where the camera goes. */
  applyCamera(camera, dt){
    const b = this.body;
    if(this.state === 'fly'){
      camera.position.copy(this.pos);
      camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
      return;
    }
    b.neck.getWorldPosition(this.headWorld);
    const eye = this.headWorld.clone();
    eye.y += 0.14;

    // look direction is relative to the deck you are standing on
    const q = new THREE.Quaternion();
    if(this.state === 'deck' && this.ship) q.copy(this.ship.quat);
    q.multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ')));

    if(this.thirdPerson){
      const back = new THREE.Vector3(0,0.55,4.6).applyQuaternion(q);
      eye.add(back);
    }
    if(this.shake > 0.001){
      eye.x += (Math.random()-0.5)*this.shake*0.16;
      eye.y += (Math.random()-0.5)*this.shake*0.16;
    }
    camera.position.copy(eye);
    camera.quaternion.copy(q);
    b.head.visible = this.thirdPerson;
    b.neck.children[1].visible = this.thirdPerson;
  }

  look(dx, dy, sens){
    this.yaw -= dx*sens;
    this.pitch -= dy*sens;
    const lim = Math.PI/2 - 0.02;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -lim, lim);
  }
}
