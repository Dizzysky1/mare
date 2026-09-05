import * as THREE from 'three';
import { stream } from './rng.js';

/* Yellow-legged gulls: boids that loiter over islands, then peel off to
   follow whichever boat looks most like it is hauling nets. */

function gullGeometry(){
  // body: a stretched, flattened teardrop
  const body = new THREE.SphereGeometry(0.16, 10, 7);
  body.scale(1.0, 0.85, 2.5);
  const head = new THREE.SphereGeometry(0.105, 8, 6);
  head.translate(0, 0.055, 0.42);
  const tail = new THREE.ConeGeometry(0.11, 0.34, 4);
  tail.rotateX(Math.PI/2); tail.scale(1.6,0.35,1); tail.translate(0,0.01,-0.52);
  return { body, head, tail };
}

function wingGeometry(){
  const shape = new THREE.Shape();
  shape.moveTo(0, -0.06);
  shape.quadraticCurveTo(0.55, -0.20, 1.05, -0.10);
  shape.quadraticCurveTo(0.95, 0.02, 0.62, 0.09);
  shape.quadraticCurveTo(0.30, 0.13, 0, 0.09);
  const g = new THREE.ShapeGeometry(shape, 8);
  g.rotateX(-Math.PI/2);
  return g;
}

export class Gulls {
  constructor(scene, field, opts = {}){
    const gr = stream('gulls');
    this.field = field;
    this.count = opts.count || 70;
    this.birds = [];
    this.group = new THREE.Group();
    scene.add(this.group);

    const G = gullGeometry();
    const white = new THREE.MeshStandardMaterial({ color:0xf3f4f2, roughness:0.85, side:THREE.DoubleSide });
    const grey  = new THREE.MeshStandardMaterial({ color:0xa9b3bb, roughness:0.9, side:THREE.DoubleSide });
    const beak  = new THREE.MeshStandardMaterial({ color:0xe0a52c, roughness:0.6 });
    const wingGeo = wingGeometry();
    const beakGeo = new THREE.ConeGeometry(0.035, 0.16, 5);
    beakGeo.rotateX(Math.PI/2); beakGeo.translate(0, 0.045, 0.55);

    for(let i = 0; i < this.count; i++){
      const g = new THREE.Group();
      const b = new THREE.Mesh(G.body, white);
      const h = new THREE.Mesh(G.head, white);
      const t = new THREE.Mesh(G.tail, grey);
      const bk = new THREE.Mesh(beakGeo, beak);
      b.castShadow = h.castShadow = true;
      g.add(b,h,t,bk);
      const wl = new THREE.Group(), wr = new THREE.Group();
      const mwl = new THREE.Mesh(wingGeo, i%5===0 ? grey : white);
      const mwr = mwl.clone();
      mwr.scale.x = -1;
      mwl.castShadow = mwr.castShadow = true;
      wl.add(mwl); wr.add(mwr);
      wl.position.set(0.10, 0.05, 0.05); wr.position.set(-0.10, 0.05, 0.05);
      g.add(wl, wr);
      const s = 0.85 + gr.next()*0.5;
      g.scale.setScalar(s);
      this.group.add(g);
      this.birds.push({
        obj:g, wl, wr,
        pos:new THREE.Vector3(), vel:new THREE.Vector3((gr.next()-0.5)*8, 0, (gr.next()-0.5)*8),
        phase:gr.next()*10, flap:0.5+gr.next()*0.6, glide:gr.next(),
        target:new THREE.Vector3(), mode:'roam', timer:gr.next()*8, call:gr.next()*20,
      });
    }
    this._a = new THREE.Vector3(); this._b = new THREE.Vector3(); this._c = new THREE.Vector3();
    this.onCall = null;
  }

  reseed(center, world, boats){
    const gr = stream('gulls');
    for(const b of this.birds){
      const a = gr.next()*Math.PI*2, r = 40 + gr.next()*600;
      b.pos.set(center.x + Math.cos(a)*r, 14 + gr.next()*45, center.z + Math.sin(a)*r);
      b.obj.position.copy(b.pos);
      b.target.copy(b.pos);
    }
  }

  update(dt, center, world, boats, night){
    const gr = stream('gulls');
    const B = this.birds;
    // recycle anything that has fallen behind
    for(const b of B){
      if(b.pos.distanceToSquared(center) > 1400*1400){
        const a = gr.next()*Math.PI*2, r = 300 + gr.next()*500;
        b.pos.set(center.x+Math.cos(a)*r, 18+gr.next()*40, center.z+Math.sin(a)*r);
        b.vel.set((gr.next()-0.5)*8, 0, (gr.next()-0.5)*8);
      }
    }

    for(let i = 0; i < B.length; i++){
      const b = B[i];
      b.timer -= dt;
      if(b.timer <= 0){
        b.timer = 4 + gr.next()*10;
        // pick something worth circling: a boat if one is close, else an island, else the sea
        let best = null, bd = 1e9;
        for(const s of boats){
          const d = s.pos.distanceToSquared(b.pos);
          if(d < bd && d < 900*900){ bd = d; best = s.pos; }
        }
        if(best && gr.next() < 0.72){
          b.mode = 'follow';
          b.target.copy(best);
        } else {
          const near = world && world.nearest(b.pos.x, b.pos.z);
          if(near && near.island && near.dist < 900 && gr.next() < 0.6){
            b.mode = 'roost';
            b.target.copy(near.island.pos);
          } else {
            b.mode = 'roam';
            const a = gr.next()*Math.PI*2, r = 150 + gr.next()*500;
            b.target.set(center.x+Math.cos(a)*r, 0, center.z+Math.sin(a)*r);
          }
        }
      }

      const steer = this._a.set(0,0,0);

      // circle the target rather than sitting on it
      const to = this._b.copy(b.target).sub(b.pos); to.y = 0;
      const dist = to.length() || 1;
      to.divideScalar(dist);
      const tangent = this._c.set(-to.z, 0, to.x);
      const ring = b.mode === 'follow' ? 34 : (b.mode === 'roost' ? 120 : 60);
      steer.addScaledVector(to, (dist - ring)*0.05);
      steer.addScaledVector(tangent, 3.2);

      // altitude: skim the swell when hunting, climb when roosting
      const seaY = this.field.height(b.pos.x, b.pos.z);
      let wantY = seaY + (b.mode === 'follow' ? 10 + 14*Math.sin(b.phase*0.4)
                        : b.mode === 'roost' ? 48 + 26*Math.sin(b.phase*0.25)
                        : 18 + 20*Math.sin(b.phase*0.3));
      if(world){
        const h = world.heightAt(b.pos.x, b.pos.z);
        if(h > 0) wantY = Math.max(wantY, h + 22);
      }
      steer.y += (wantY - b.pos.y)*1.35;

      // separation from the three nearest neighbours (cheap, strided)
      for(let k = 1; k <= 3; k++){
        const o = B[(i + k*7) % B.length];
        const d2 = o.pos.distanceToSquared(b.pos);
        if(d2 < 100 && d2 > 0.01){
          this._c.copy(b.pos).sub(o.pos).multiplyScalar(14/d2);
          steer.add(this._c);
        }
      }

      b.vel.addScaledVector(steer, dt);
      // Damp the vertical channel harder than the horizontal: a gull corrects
      // its height continuously, and without this the altitude spring
      // overshoots and drives it straight into the sea.
      b.vel.y -= b.vel.y*Math.min(1, dt*2.2);

      // Speed limits apply to the horizontal component only. Scaling the whole
      // velocity to enforce a minimum airspeed also scales any descent, which
      // is precisely how a bird ends up flying itself into the water.
      const hx = b.vel.x, hz = b.vel.z;
      let hs = Math.hypot(hx, hz);
      const maxS = b.mode === 'follow' ? 15 : 19;
      if(hs > maxS){ const k = maxS/hs; b.vel.x *= k; b.vel.z *= k; hs = maxS; }
      if(hs < 5.5){ const k = 5.5/Math.max(hs, 0.01); b.vel.x *= k; b.vel.z *= k; }
      b.vel.y = THREE.MathUtils.clamp(b.vel.y, -6, 8);

      b.vel.x *= 1 - dt*0.55; b.vel.z *= 1 - dt*0.55;
      b.pos.addScaledVector(b.vel, dt);

      // A hard floor, because no amount of steering should let one swim.
      const floorY = Math.max(seaY, world ? world.heightAt(b.pos.x, b.pos.z) : -1e9) + 2.5;
      if(b.pos.y < floorY){
        b.pos.y = floorY;
        if(b.vel.y < 0) b.vel.y = Math.max(0, -b.vel.y*0.35);
      }

      // orientation: face the flight path and bank into the turn
      b.obj.position.copy(b.pos);
      const yaw = Math.atan2(b.vel.x, b.vel.z);
      const climb = Math.asin(THREE.MathUtils.clamp(b.vel.y/Math.max(b.vel.length(),0.01), -1, 1));
      const turn = THREE.MathUtils.clamp((yaw - (b.lastYaw ?? yaw)), -1, 1);
      b.lastYaw = yaw;
      b.bank = (b.bank || 0)*0.88 + turn*14*0.12;
      b.obj.rotation.set(-climb*0.7, yaw, THREE.MathUtils.clamp(-b.bank, -0.9, 0.9));

      // flap when climbing, glide when descending
      const effort = THREE.MathUtils.clamp(0.35 + (wantY - b.pos.y)*0.05 + climb*0.9, 0, 1);
      b.glide = b.glide*0.94 + (effort < 0.32 ? 1 : 0)*0.06;
      b.phase += dt*(2.0 + effort*9.0)*(1 - b.glide*0.85);
      const a = b.glide > 0.6 ? 0.12 : Math.sin(b.phase)*0.85*(0.35+effort);
      b.wl.rotation.z = -a - 0.06;
      b.wr.rotation.z =  a + 0.06;
      b.wl.rotation.x = b.wr.rotation.x = -0.12 + a*0.18;

      // the occasional call
      b.call -= dt;
      if(b.call <= 0){
        b.call = 8 + gr.next()*35;
        const d = b.pos.distanceTo(center);
        if(d < 190 && this.onCall && !night) this.onCall(THREE.MathUtils.clamp(1 - d/190, 0, 1));
      }
    }
  }
}
