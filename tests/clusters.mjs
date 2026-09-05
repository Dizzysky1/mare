import {ClusterSimulation} from '../src/fx/cluster_physics.js';
import {munition} from '../src/fx/munitions.js';
export function clusterChecks(){
 const check=(ok,msg)=>{if(!ok)throw new Error(msg);};const reports=[];
 for(const kind of ['cluster','cluster_gas']){
  const spec=munition(kind),impacts=[],bursts=[];
  const surface=(x,z,t)=>0.4*Math.sin(x*.03+t*.5)+0.3*Math.cos(z*.04);
  const sim=new ClusterSimulation(surface,{burst(parent,n){
   let payloadMass=0,mx=0,my=0,mz=0,energy=0;
   for(let j=0;j<n;j++){const s=sim.nodes[parent.children[j]];payloadMass+=s.mass;mx+=s.mass*(s.v.x-parent.v.x);my+=s.mass*(s.v.y-parent.v.y);mz+=s.mass*(s.v.z-parent.v.z);energy+=s.mass*((s.v.x-parent.v.x)**2+(s.v.y-parent.v.y)**2+(s.v.z-parent.v.z)**2)/2;}
   check(Math.hypot(mx,my,mz)<1e-8,'Separation creates net payload momentum');
   check(Math.abs(energy-spec.cluster.separationEnergy*.9)<1e-7,'Separation energy mismatch');
   const other=sim.nodes[parent.children[n]];
   check(Math.abs(payloadMass+other.mass*2-spec.mass)<1e-9,'Mass lost during split');
   check(Math.abs(parent.p.y-surface(parent.p.x,parent.p.z,parent.startTime+parent.age)-spec.burstAlt)<0.001,'Burst height crossing is inaccurate');
   bursts.push({age:parent.age,altitude:parent.p.y,payloadMass});
  },impact(s,inert){if(!inert)impacts.push({kind:s.kind,x:s.p.x,y:s.p.y,z:s.p.z,t:s.age});}});
  check(sim.spawn(kind,{x:0,y:500,z:0},{x:0,y:0,z:188},{windX:5,windZ:0,simTime:10}),'Spawn failed');
  for(let i=0;i<60*60;i++)sim.update(1/60);
  check(bursts.length===1,'Carrier split more than once');check(impacts.length===spec.cluster.count,'Payload impacts missing');check(sim.live===0,'Debris did not clean up');
  const xs=impacts.map(p=>p.x),zs=impacts.map(p=>p.z);
  check(Math.max(...xs)-Math.min(...xs)>10,'Payload did not disperse');
  check(new Set(impacts.map(p=>p.t.toFixed(3))).size>3,'Impacts are a simultaneous scripted ring');
  const replay=[];const peer=new ClusterSimulation(surface,{impact(s,inert){if(!inert)replay.push({kind:s.kind,x:s.p.x,y:s.p.y,z:s.p.z,t:s.age});}});
  peer.spawn(kind,{x:0,y:500,z:0},{x:0,y:0,z:188},{windX:5,windZ:0,simTime:10});
  for(let i=0;i<30*60;i++)peer.update(1/30);
  check(JSON.stringify(replay)===JSON.stringify(impacts),'Peers diverged at different display frame rates');
  reports.push({kind,burst:bursts[0],impacts:impacts.length,width:Math.max(...xs)-Math.min(...xs),length:Math.max(...zs)-Math.min(...zs),firstImpact:Math.min(...impacts.map(p=>p.t)),lastImpact:Math.max(...impacts.map(p=>p.t)),replay:'identical'});
 }
 for(const altitude of [0.5,5,20]){
  let opened=0,inert=0;const low=new ClusterSimulation(()=>0,{burst(){opened++;},impact(s,safe){check(safe,'Unarmed carrier produced damage');inert++;}});
  low.spawn('cluster',{x:0,y:altitude,z:0},{x:0,y:-100,z:0});
  for(let i=0;i<120;i++)low.update(1/60);
  check(opened===0&&inert===1&&low.live===0,'Unarmed ground strike did not retire inert');
  check(low.nodes.every(s=>s.state===0),'Unarmed carrier leaked reserved payload');
 }
 const tiny=new ClusterSimulation(()=>0,{},4);check(!tiny.spawn('cluster',{x:0,y:500,z:0},{x:0,y:0,z:100}),'Partial payload accepted');check(tiny.live===0,'Failed spawn leaked a body');
 return reports;
}
