import * as THREE from 'three';
import {ClusterSimulation} from './cluster_physics.js';
import {bombAssets} from './ordnance.js';

/* Rendering is instanced by body type. A carrier opening into 24 independent
   trajectories adds one bomblet draw call, not 24 detailed mesh groups. */
export class ClusterSystem {
 constructor(scene,surface,callbacks={}){
  this.scene=scene;this.sim=new ClusterSimulation(surface,callbacks);
  this.meshes={};this.counts={};
  for(const kind of ['cluster','cluster_gas','cluster_helet','cluster_gaslet','cluster_casing']){
   const assets=bombAssets(kind);
   const mesh=new THREE.InstancedMesh(assets.geometry,assets.material,this.sim.nodes.length);
   mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);mesh.count=0;mesh.frustumCulled=false;scene.add(mesh);
   this.meshes[kind]=mesh;this.counts[kind]=0;
  }
  // Empty carrier sections visibly separate; they are harmless debris.
  const shell=new THREE.CylinderGeometry(.225,.225,1.3,12,1,true,0,Math.PI);shell.rotateX(Math.PI/2);
  this.shellGeo=shell;this.shellMat=new THREE.MeshStandardMaterial({color:0x555b4c,roughness:.65,metalness:.25,side:THREE.DoubleSide});
  this.meshes.cluster_casing.geometry=shell;this.meshes.cluster_casing.material=this.shellMat;
  this.matrix=new THREE.Matrix4();this.pos=new THREE.Vector3();this.dir=new THREE.Vector3();this.q=new THREE.Quaternion();this.scale=new THREE.Vector3(1,1,1);this.forward=new THREE.Vector3(0,0,1);
 }
 spawn(kind,p,v,env){return this.sim.spawn(kind,p,v,env);}
 get live(){return this.sim.live;}
 update(dt){this.sim.update(dt);this.sync();}
 sync(){
  for(const kind in this.counts)this.counts[kind]=0;
  for(const s of this.sim.nodes){
   if(!s.state||s.state===4)continue;
   this.pos.set(s.p.x,s.p.y,s.p.z);this.dir.set(s.v.x,s.v.y,s.v.z).normalize();this.q.setFromUnitVectors(this.forward,this.dir);
   this.matrix.compose(this.pos,this.q,this.scale);
   this.meshes[s.kind].setMatrixAt(this.counts[s.kind]++,this.matrix);
  }
  for(const kind in this.meshes){const mesh=this.meshes[kind];mesh.count=this.counts[kind];mesh.visible=mesh.count>0;mesh.instanceMatrix.needsUpdate=true;}
 }
 reset(){this.sim.reset();this.sync();}
 dispose(){this.reset();for(const kind in this.meshes){this.scene.remove(this.meshes[kind]);this.meshes[kind].dispose();}this.shellGeo.dispose();this.shellMat.dispose();}
}
