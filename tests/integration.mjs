import * as THREE from 'three';
import {Strikes} from '../src/strikes.js';
export function integrationChecks(){
 const check=(ok,msg)=>{if(!ok)throw new Error(msg);},reports=[];
 for(const kind of ['cluster','cluster_gas']){
  const scene=new THREE.Scene(),field={time:0,height:()=>0};let impactCount=0;
  const strikes=new Strikes(scene,field,{explosion(){}},{impact(){impactCount++;}});
  const p=new THREE.Vector3(10000,2,10000);
  strikes.dropStore(kind,{x:0,y:200,z:0},{x:0,y:-10,z:100},{windX:2,windZ:0,simTime:0});
  for(let i=0;i<12*60;i++){field.time+=1/60;strikes.update(1/60,p,null,p,{x:2,z:0});}
  check(impactCount===(kind==='cluster'?24:12),'Cluster did not reach gameplay detonation path');
  check(strikes.hazards.length===(kind==='cluster'?0:12),'Incorrect gas cloud count');
  if(kind==='cluster_gas')check(strikes.hazards.every(h=>h.radius===15&&h.ttl===65),'Bomblets created full-size canister clouds');
  strikes.arm(false);check(strikes.clusters.live===0&&strikes.hazards.length===0,'Rearming left cluster bodies or hazards');
  check(strikes.hazardFX._stateSlots.every(s=>!s.owner&&s.flow.remaining===0),'Plume sources survived reset');
  strikes.dispose();reports.push({kind,impactCount,reset:'clean'});
 }
 return reports;
}
