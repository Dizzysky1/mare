import * as THREE from 'three';
import { GUN } from '../weapons.js';

// A fixed pool: the gun cannot grow geometry or projectile arrays during play.
export class Minigun {
  constructor(scene, field, cb = {}){
    this.scene = scene; this.field = field; this.cb = cb;
    this.rounds = Array.from({length:160}, () => ({ age:0, live:false,
      p:new THREE.Vector3(), prev:new THREE.Vector3(), v:new THREE.Vector3() }));
    this.positions = new Float32Array(this.rounds.length*6);
    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.mat = new THREE.LineBasicMaterial({color:0xffd283, transparent:true, opacity:0.95, toneMapped:false});
    this.lines = new THREE.LineSegments(this.geo, this.mat); this.lines.frustumCulled = false;
    scene.add(this.lines); this.cursor = 0; this._closest = new THREE.Vector3();
    this._segment = new THREE.Vector3(); this._delta = new THREE.Vector3();
  }
  fire(p, v){
    for(let i=0; i<GUN.burst; i++){
      const r = this.rounds[this.cursor++ % this.rounds.length];
      r.live=true; r.age=0; r.p.set(...p); r.prev.copy(r.p); r.v.set(...v);
      // Small deterministic spread; both peers render the same burst.
      r.v.x += Math.sin(i*2.4)*3; r.v.y += Math.cos(i*2.4)*3;
      r.p.addScaledVector(r.v, i*0.003);
    }
  }
  update(dt, ship, playerPos){
    for(let i=0; i<this.rounds.length; i++){
      const r=this.rounds[i], j=i*6;
      if(r.live && dt>0){
        r.prev.copy(r.p); r.p.addScaledVector(r.v,dt); r.v.y-=9.81*dt; r.age+=dt;
        const target=ship?.pos || playerPos;
        if(target){
          this._segment.subVectors(r.p,r.prev);
          const u=THREE.MathUtils.clamp(this._delta.subVectors(target,r.prev).dot(this._segment)/Math.max(1,this._segment.lengthSq()),0,1);
          this._closest.copy(r.prev).addScaledVector(this._segment,u);
          if(this._closest.distanceTo(target) < (ship ? 6 : 1.5)){
            this.cb.damage?.(0.8,'The aircraft’s gun found you.'); r.live=false;
          }
        }
        const surface=Math.max(this.field.height(r.p.x,r.p.z),this.cb.landHeight?.(r.p.x,r.p.z) ?? -100);
        if(r.p.y<=surface || r.age>GUN.lifetime) r.live=false;
      }
      if(r.live){
        this.positions[j]=r.p.x; this.positions[j+1]=r.p.y; this.positions[j+2]=r.p.z;
        this.positions[j+3]=r.p.x-r.v.x*0.018; this.positions[j+4]=r.p.y-r.v.y*0.018; this.positions[j+5]=r.p.z-r.v.z*0.018;
      } else this.positions.fill(0,j,j+6);
    }
    this.geo.attributes.position.needsUpdate=true;
  }
  clear(){ for(const r of this.rounds) r.live=false; this.positions.fill(0); this.geo.attributes.position.needsUpdate=true; }
  dispose(){ this.scene.remove(this.lines); this.geo.dispose(); this.mat.dispose(); }
}
