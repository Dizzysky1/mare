import {PlumeGrid,relaxVelocity} from '../src/fx/plume_flow.js';
export function plumeChecks(){
 const check=(ok,msg)=>{if(!ok)throw new Error(msg);};
 const f=new PlumeGrid();f.reset({x:0,y:0,z:0},14);
 for(let i=0;i<f.u.length;i++){f.u[i]=Math.sin(i*.713);f.v[i]=Math.cos(i*.429);f.w[i]=Math.sin(i*.23);}
 const before=f.divergenceRms();f.project();const after=f.divergenceRms();
 check(after<before*0.001,'Pressure projection did not remove divergence');
 f.reset({x:0,y:0,z:0},14);
 const start=performance.now();for(let i=0;i<120;i++)f.advance(1/30,'fire',1,2,0);
 const msPerStep=(performance.now()-start)/120;
 const maxHeat=Math.max(...f.t),maxUp=Math.max(...f.v);
 check(maxHeat>100&&maxUp>1,'No buoyant plume from heat source');
 for(let i=0;i<120;i++)f.advance(1/30,'fire',0,2,0);
 check(Math.max(...f.t)<maxHeat*0.6,'Plume failed to cool after source removal');
 const a=new PlumeGrid(),b=new PlumeGrid();a.reset({x:0,y:0,z:0},14);b.reset({x:0,y:0,z:0},14);
 for(let i=0;i<120;i++)a.advance(1/60,'fire',1,2,0);
 for(let i=0;i<60;i++)b.advance(1/30,'fire',1,2,0);
 let difference=0;for(let i=0;i<a.u.length;i++)difference=Math.max(difference,Math.abs(a.v[i]-b.v[i]));
 check(difference<1e-6,'Fluid motion depends on display frame rate');
 const whole=relaxVelocity(10,2,0.8,1),half=relaxVelocity(relaxVelocity(10,2,0.8,0.5),2,0.8,0.5);
 check(Math.abs(whole-half)<1e-12,'Drag response depends on step count');
 f.moveSource({x:20,y:0,z:-10});f.advance(1/30,'cloud',1,2,0);
 check(f.u.every(Number.isFinite)&&f.t.every(Number.isFinite),'Moving volume produced non-finite fields');
 return {divergenceBefore:before,divergenceAfter:after,removedPercent:100*(1-after/before),maxHeat,maxUp,msPerStep,frameRateDifference:difference};
}
