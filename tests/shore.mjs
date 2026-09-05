import * as THREE from 'three';
import {Player} from '../src/player.js';
import {World} from '../src/islands.js';
import {WaveField} from '../src/waves.js';
export function shoreChecks(){
 const scene=new THREE.Scene(),world=new World(scene,{seed:4210,count:1,detail:24});
 const field=new WaveField(20);field.configure({swell:.45,windDeg:38});
 const island=world.islands[0];let chosen;
 for(let j=0;j<32&&!chosen;j++){
  const angle=j*Math.PI/16,dx=Math.cos(angle),dz=Math.sin(angle);let lo=0,hi=island.radius*1.4;
  for(let k=0;k<48;k++){const mid=(lo+hi)/2;if(world.heightAt(island.pos.x+dx*mid,island.pos.z+dz*mid)>0)lo=mid;else hi=mid;}
  const x=island.pos.x+dx*hi,z=island.pos.z+dz*hi;
  if(island.normalAt(x,z).y>.85)chosen={x,z,dx,dz};
 }
 if(!chosen)throw new Error('No gentle beach found');
 const p=new Player(scene,field,world),c=chosen;
 p.pos.set(c.x+c.dx*30,-1,c.z+c.dz*30);p.vel.set(0,0,0);p.setState('swim');p.ship=null;
 p.yaw=Math.atan2(c.dx,c.dz);
 const states=['swim'];let landed=false;
 for(let i=0;i<60*55;i++){
  field.update(1/60);p.update(1/60,{fwd:1},null);
  if(states.at(-1)!==p.state)states.push(p.state);
  if(p.state==='land'&&world.heightAt(p.pos.x,p.pos.z)>1){landed=true;break;}
 }
 if(!landed)throw new Error('Player failed to reach dry land');
 p.yaw+=Math.PI;let returned=false;
 for(let i=0;i<60*35;i++){
  field.update(1/60);p.update(1/60,{fwd:1},null);
  if(states.at(-1)!==p.state)states.push(p.state);
  if(p.state==='swim'){returned=true;break;}
 }
 if(!returned||states.join(',')!=='swim,land,swim')throw new Error('Shore transition chatters or does not return to swimming: '+states);
 scene.traverse(o=>{o.geometry?.dispose();if(Array.isArray(o.material))for(const m of o.material)m.dispose();else o.material?.dispose();});
 return {states,spawnDistanceFromShore:30,playerSeparatedFromShip:true,breath:p.breath};
}
