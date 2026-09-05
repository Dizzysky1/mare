import {munition} from './munitions.js';
import {dragAccel,AIR} from './aero.js';

const H=1/240, G=9.81;
const vec=()=>({x:0,y:0,z:0});
function copy(a,b){a.x=b.x;a.y=b.y;a.z=b.z;}
function seedFrom(p,v){return (Math.imul(Math.round(p.x*100),73856093)^Math.imul(Math.round(p.y*100),19349663)^Math.imul(Math.round(p.z*100),83492791)^Math.round(v.x*100+v.z*1000))>>>0;}

/* RK4 integrates gravity plus velocity-relative quadratic drag. Scratch
   belongs to the integrator, not the body or frame. Density decreases with
   altitude under the same standard-atmosphere scale used for every peer. */
export class StoreIntegrator {
 constructor(){this.a=vec();this.b=vec();this.c=vec();this.d=vec();this.v=vec();this.rel=vec();this.opts={age:0};}
 acceleration(body,v,y,age,out){
  this.rel.x=v.x-body.windX;this.rel.y=v.y;this.rel.z=v.z-body.windZ;this.opts.age=age;
  dragAccel(body.kind,this.rel,AIR.rho0*Math.exp(-Math.max(0,y)/8500),this.opts,out);
  // Casing mass varies with the carrier; retain the same drag area.
  const ratio=munition(body.kind).mass/body.mass;out.x*=ratio;out.y=out.y*ratio-G;out.z*=ratio;
 }
 step(s,h){
  const p=s.p,v=s.v,a=this.a,b=this.b,c=this.c,d=this.d,tmp=this.v;
  this.acceleration(s,v,p.y,s.age,a);
  tmp.x=v.x+a.x*h/2;tmp.y=v.y+a.y*h/2;tmp.z=v.z+a.z*h/2;
  this.acceleration(s,tmp,p.y+v.y*h/2,s.age+h/2,b);
  tmp.x=v.x+b.x*h/2;tmp.y=v.y+b.y*h/2;tmp.z=v.z+b.z*h/2;
  this.acceleration(s,tmp,p.y+v.y*h/2+a.y*h*h/4,s.age+h/2,c);
  tmp.x=v.x+c.x*h;tmp.y=v.y+c.y*h;tmp.z=v.z+c.z*h;
  this.acceleration(s,tmp,p.y+v.y*h+b.y*h*h/2,s.age+h,d);
  p.x+=v.x*h+(a.x+b.x+c.x)*h*h/6;p.y+=v.y*h+(a.y+b.y+c.y)*h*h/6;p.z+=v.z*h+(a.z+b.z+c.z)*h*h/6;
  v.x+=(a.x+2*b.x+2*c.x+d.x)*h/6;v.y+=(a.y+2*b.y+2*c.y+d.y)*h/6;v.z+=(a.z+2*b.z+2*c.z+d.z)*h/6;
  s.age+=h;
 }
}

/* Pool reservation makes a carrier's full payload atomic: if there isn't
   room for all its children and two casing sections, release is refused.
   No explosion ring is fabricated; impacts emerge from each body crossing
   the moving surface. Callbacks receive borrowed records valid until reuse. */
export class ClusterSimulation {
 constructor(surface,callbacks={},capacity=384){
  this.surface=surface;this.callbacks=callbacks;this.integrator=new StoreIntegrator();this.acc=0;this.live=0;
  this.nodes=Array.from({length:capacity},()=>({state:0,kind:'',p:vec(),v:vec(),oldP:vec(),oldV:vec(),age:0,mass:1,windX:0,windZ:0,startTime:0,seed:0,count:0,children:new Int32Array(26),oldAge:0}));
  this._test={kind:'',p:vec(),v:vec(),age:0,mass:1,windX:0,windZ:0};
 }
 reset(){for(const s of this.nodes)s.state=0;this.acc=0;this.live=0;}
 spawn(kind,p,v,env={}){
  const spec=munition(kind);if(!spec.cluster||!Number.isFinite(p.x+p.y+p.z+v.x+v.y+v.z))return false;
  const count=spec.cluster.count;let free=0;for(const s of this.nodes)if(s.state===0)free++;
  if(free<count+2)return false;
  let parent=null;
  for(let i=0;i<this.nodes.length;i++){
   const s=this.nodes[i];if(s.state)continue;
   if(!parent){parent=s;s.state=1;s.count=0;}else{s.state=4;parent.children[parent.count++]=i;}
   if(parent.count===count+1)break;
  }
  parent.kind=kind;copy(parent.p,p);copy(parent.v,v);parent.age=0;parent.mass=spec.mass;
  parent.windX=Number.isFinite(env.windX)?env.windX:0;parent.windZ=Number.isFinite(env.windZ)?env.windZ:0;
  parent.startTime=Number.isFinite(env.simTime)?env.simTime:0;parent.seed=seedFrom(p,v);this.live++;
  return true;
 }
 _random(s){s.seed=(s.seed+0x6D2B79F5)|0;let t=Math.imul(s.seed^s.seed>>>15,1|s.seed);t=t+Math.imul(t^t>>>7,61|t)^t;return ((t^t>>>14)>>>0)/4294967296;}
 split(parent){
  const spec=munition(parent.kind),cluster=spec.cluster,childSpec=munition(cluster.child),n=cluster.count;
  const casingMass=(spec.mass-n*childSpec.mass)/2;
  // Opposite equal-mass pairs have zero total relative momentum and
  // torque. Their kinetic energy is exactly the declared separation work.
  const speed=Math.sqrt(2*cluster.separationEnergy*0.9/(n*childSpec.mass));
  for(let j=0;j<n;j+=2){
   const z=2*this._random(parent)-1,theta=this._random(parent)*Math.PI*2,r=Math.sqrt(1-z*z);
   const dx=r*Math.cos(theta),dy=z,dz=r*Math.sin(theta);
   for(let k=0;k<2;k++){
    const s=this.nodes[parent.children[j+k]],sign=k?-1:1;
    s.state=2;s.kind=cluster.child;s.mass=childSpec.mass;s.age=parent.age;s.startTime=parent.startTime;s.windX=parent.windX;s.windZ=parent.windZ;
    s.p.x=parent.p.x+sign*dx*0.18;s.p.y=parent.p.y+sign*dy*0.18;s.p.z=parent.p.z+sign*dz*0.18;
    s.v.x=parent.v.x+sign*dx*speed;s.v.y=parent.v.y+sign*dy*speed;s.v.z=parent.v.z+sign*dz*speed;
   }
  }
  const other=this.nodes[parent.children[n]],casingSpeed=Math.sqrt(cluster.separationEnergy*0.1/casingMass);
  other.state=3;other.kind='cluster_casing';other.mass=casingMass;other.age=parent.age;other.startTime=parent.startTime;other.windX=parent.windX;other.windZ=parent.windZ;
  copy(other.p,parent.p);copy(other.v,parent.v);other.v.x-=casingSpeed;
  this.callbacks.burst?.(parent,n);
  parent.kind='cluster_casing';parent.state=3;parent.mass=casingMass;parent.v.x+=casingSpeed;
  this.live+=n+1;
 }
 update(dt){
  if(!(dt>0)||!Number.isFinite(dt))return;this.acc+=Math.min(dt,0.25);
  while(this.acc+1e-10>=H){this._step(H);this.acc-=H;}
 }
 _step(h){
  // Two passes keep newly born payloads from accidentally receiving an
  // extra full step merely because their slot index follows the carrier.
  for(const s of this.nodes){
   if(s.state===0||s.state===4)continue;
   copy(s.oldP,s.p);copy(s.oldV,s.v);s.oldAge=s.age;
   this.integrator.step(s,h);
  }
  for(const s of this.nodes){
   if(s.state===0||s.state===4||s.oldAge>=s.age)continue;
   const spec=munition(s.kind),carrier=s.state===1;
   const ground=this.surface(s.p.x,s.p.z,s.startTime+s.age);
   let opens=carrier&&s.age>=spec.armTime&&s.v.y<0;
   const q=this._test;
   q.kind=s.kind;q.mass=s.mass;q.windX=s.windX;q.windZ=s.windZ;
   const armedAt=carrier?Math.max(0,spec.armTime-s.oldAge):0;
   if(opens){
    copy(q.p,s.oldP);copy(q.v,s.oldV);q.age=s.oldAge;
    this.integrator.step(q,Math.min(h,armedAt));
    // A carrier that reaches terrain before arming remains inert.
    opens=q.p.y>this.surface(q.p.x,q.p.z,s.startTime+q.age);
   }
   const offset=opens?spec.burstAlt:0;
   const level=ground+offset;
   if(s.p.y>level){
    if(s.age>120){this._retire(s);}continue;
   }
   // Bisect the event using actual integration, not an interpolation that
   // mistakes airburst height for sea level or snaps to an aiming marker.
   let lo=opens?armedAt:0,hi=h;
   for(let k=0;k<16;k++){
    const mid=(lo+hi)/2;copy(q.p,s.oldP);copy(q.v,s.oldV);q.age=s.oldAge;this.integrator.step(q,mid);
    if(q.p.y>this.surface(q.p.x,q.p.z,s.startTime+q.age)+offset)lo=mid;else hi=mid;
   }
   copy(s.p,s.oldP);copy(s.v,s.oldV);s.age=s.oldAge;this.integrator.step(s,hi);
   if(opens){
    this.split(s);
    // All new bodies cover the unused portion of the carrier's step.
    const remainder=h-hi;this.integrator.step(s,remainder);s.oldAge=s.age;
    for(let j=0;j<s.count;j++){const child=this.nodes[s.children[j]];this.integrator.step(child,remainder);child.oldAge=child.age;}
   }else{this.callbacks.impact?.(s,carrier||s.state===3);this._retire(s);}
  }
 }
 _retire(s){if(s.state===1)for(let j=0;j<s.count;j++)this.nodes[s.children[j]].state=0;s.state=0;this.live--;}
}
