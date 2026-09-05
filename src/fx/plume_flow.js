/* Local incompressible plume solver in metres and seconds.
   Velocity and temperature are advected on a fixed Eulerian grid, then
   buoyancy and vorticity confinement add momentum. A pressure projection
   removes divergence before particles sample the result. This is the
   stable-fluids discretisation of incompressible Navier-Stokes; thermal
   expansion enters as a buoyancy force rather than an acoustic wave.

   One bounded grid belongs to each preallocated hazard slot. All fields,
   ping-pong buffers and pressure scratch are allocated in the constructor.
   Semi-Lagrangian advection is unconditionally stable, but dissipative;
   confinement restores resolved rolling motion without independent jitter.
   Open boundaries let wind and rising smoke leave the local domain. */
const NX=16, NY=24, NZ=16, N=NX*NY*NZ, ROW=NX, SLAB=NX*NY;
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function relaxVelocity(velocity,target,rate,dt){
  return target+(velocity-target)*Math.exp(-rate*dt);
}
export class PlumeGrid {
  constructor(){
    this.u=new Float32Array(N);this.v=new Float32Array(N);this.w=new Float32Array(N);
    this.t=new Float32Array(N);this.d=new Float32Array(N);
    this.u0=new Float32Array(N);this.v0=new Float32Array(N);this.w0=new Float32Array(N);
    this.t0=new Float32Array(N);this.d0=new Float32Array(N);
    this.p=new Float32Array(N);this.div=new Float32Array(N);
    this.cx=new Float32Array(N);this.cy=new Float32Array(N);this.cz=new Float32Array(N);this.cmag=new Float32Array(N);
    this.originX=0;this.originY=0;this.originZ=0;this.dx=1;this.dy=1;this.dz=1;
    this.time=0;this.acc=0;this.remaining=0;this.version=0;this.shiftX=0;this.shiftZ=0;
  }
  reset(point,radius){
    this.dx=this.dz=Math.max(1,radius*3.2/(NX-1));
    this.dy=Math.max(1,radius*3.0/(NY-1));
    this.originX=point.x-this.dx*(NX-1)*0.5;
    this.originZ=point.z-this.dz*(NZ-1)*0.5;this.originY=point.y;
    this.radius=radius;this.shiftX=this.shiftZ=0;this.time=0;this.acc=0;this.remaining=16;this.version++;
    this.u.fill(0);this.v.fill(0);this.w.fill(0);this.t.fill(0);this.d.fill(0);this.p.fill(0);
  }
  moveSource(point){
    // Recenter moving gas volumes without resetting their fluid history.
    // The next backward trace accounts for the change of grid coordinates.
    const x=point.x-this.dx*(NX-1)*0.5,z=point.z-this.dz*(NZ-1)*0.5;
    this.shiftX+=(x-this.originX)/this.dx;this.shiftZ+=(z-this.originZ)/this.dz;
    this.originX=x;this.originZ=z;
  }
  _sample(a,x,y,z){
    x=clamp(x,0,NX-1.001);y=clamp(y,0,NY-1.001);z=clamp(z,0,NZ-1.001);
    const ix=x|0,iy=y|0,iz=z|0,fx=x-ix,fy=y-iy,fz=z-iz,i=ix+iy*ROW+iz*SLAB;
    const a0=a[i]*(1-fx)+a[i+1]*fx,a1=a[i+ROW]*(1-fx)+a[i+ROW+1]*fx;
    const b0=a[i+SLAB]*(1-fx)+a[i+SLAB+1]*fx,b1=a[i+SLAB+ROW]*(1-fx)+a[i+SLAB+ROW+1]*fx;
    return (a0*(1-fy)+a1*fy)*(1-fz)+(b0*(1-fy)+b1*fy)*fz;
  }
  sample(x,y,z,out){
    x=(x-this.originX)/this.dx;y=(y-this.originY)/this.dy;z=(z-this.originZ)/this.dz;
    if(x<0||x>NX-1||y<0||y>NY-1||z<0||z>NZ-1){out.x=out.y=out.z=out.heat=out.density=0;return false;}
    out.x=this._sample(this.u,x,y,z);out.y=this._sample(this.v,x,y,z);out.z=this._sample(this.w,x,y,z);
    out.heat=this._sample(this.t,x,y,z);out.density=this._sample(this.d,x,y,z);return true;
  }
  advance(dt,type,intensity,windX,windZ){
    if(!(dt>0)||!Number.isFinite(dt))return;
    if(intensity>0)this.remaining=16;else this.remaining-=dt;
    if(this.remaining<=0)return;
    this.acc+=Math.min(dt,0.25);
    while(this.acc+1e-9>=1/30){this.step(1/30,type,intensity,windX,windZ);this.acc-=1/30;}
  }
  step(dt,type,intensity,windX,windZ){
    this.time+=dt;
    const u=this.u,v=this.v,w=this.w,t=this.t,d=this.d;
    const cool=Math.exp(-0.32*dt),dilute=Math.exp(-0.10*dt);
    // Midpoint backtracing reduces trajectory error versus an Euler trace.
    for(let z=0;z<NZ;z++)for(let y=0;y<NY;y++)for(let x=0;x<NX;x++){
      const i=x+y*ROW+z*SLAB;
      if(x===0||x===NX-1||z===0||z===NZ-1||y===0||y===NY-1){
        this.u0[i]=windX;this.w0[i]=windZ;
        this.v0[i]=y===NY-1?Math.max(0,v[i-ROW]):0;
        this.t0[i]=0;this.d0[i]=0;continue;
      }
      const mx=x+this.shiftX-u[i]*dt/(2*this.dx),my=y-v[i]*dt/(2*this.dy),mz=z+this.shiftZ-w[i]*dt/(2*this.dz);
      const bx=x+this.shiftX-this._sample(u,mx,my,mz)*dt/this.dx;
      const by=y-this._sample(v,mx,my,mz)*dt/this.dy;
      const bz=z+this.shiftZ-this._sample(w,mx,my,mz)*dt/this.dz;
      this.u0[i]=this._sample(u,bx,by,bz);this.v0[i]=this._sample(v,bx,by,bz);this.w0[i]=this._sample(w,bx,by,bz);
      this.t0[i]=this._sample(t,bx,by,bz)*cool;this.d0[i]=this._sample(d,bx,by,bz)*dilute;
      // The burning footprint injects heat and smoke, not pre-scripted
      // rising trajectories. Their velocity follows buoyancy and pressure.
      const rx=(x-(NX-1)*0.5)*this.dx,rz=(z-(NZ-1)*0.5)*this.dz;
      const footprint=Math.max(0,1-(rx*rx+rz*rz)/(this.radius*this.radius));
      const source=footprint*footprint*Math.exp(-Math.pow((y-1)*this.dy/2.0,2))*intensity;
      if(type==='fire')this.t0[i]+=source*650*dt;
      this.d0[i]=Math.min(3,this.d0[i]+source*(type==='fire'?1.5:2.2)*dt);
      const heat=this.t0[i];
      this.v0[i]+=dt*(9.81*heat/(288.15+heat)-(type==='cloud'?0.12*this.d0[i]:0));
    }
    this.u=this.u0;this.u0=u;this.v=this.v0;this.v0=v;this.w=this.w0;this.w0=w;
    this.t=this.t0;this.t0=t;this.d=this.d0;this.d0=d;
    this.shiftX=this.shiftZ=0;
    this._confinement(dt);
    this.project();
  }
  _confinement(dt){
    const u=this.u,v=this.v,w=this.w,cx=this.cx,cy=this.cy,cz=this.cz,m=this.cmag;
    const hx=0.5/this.dx,hy=0.5/this.dy,hz=0.5/this.dz;
    m.fill(0);
    for(let z=1;z<NZ-1;z++)for(let y=1;y<NY-1;y++)for(let x=1;x<NX-1;x++){
      const i=x+y*ROW+z*SLAB;
      cx[i]=(w[i+ROW]-w[i-ROW])*hy-(v[i+SLAB]-v[i-SLAB])*hz;
      cy[i]=(u[i+SLAB]-u[i-SLAB])*hz-(w[i+1]-w[i-1])*hx;
      cz[i]=(v[i+1]-v[i-1])*hx-(u[i+ROW]-u[i-ROW])*hy;
      m[i]=Math.hypot(cx[i],cy[i],cz[i]);
    }
    const strength=0.16*Math.min(this.dx,this.dy,this.dz)*dt;
    for(let z=1;z<NZ-1;z++)for(let y=1;y<NY-1;y++)for(let x=1;x<NX-1;x++){
      const i=x+y*ROW+z*SLAB;
      const nx=(m[i+1]-m[i-1])*hx,ny=(m[i+ROW]-m[i-ROW])*hy,nz=(m[i+SLAB]-m[i-SLAB])*hz;
      const k=strength/(Math.hypot(nx,ny,nz)+1e-6);
      u[i]+=(ny*cz[i]-nz*cy[i])*k;v[i]+=(nz*cx[i]-nx*cz[i])*k;w[i]+=(nx*cy[i]-ny*cx[i])*k;
    }
  }
  project(){
    const u=this.u,v=this.v,w=this.w,p=this.p,div=this.div;
    const ax=1/(this.dx*this.dx),ay=1/(this.dy*this.dy),az=1/(this.dz*this.dz),den=2*(ax+ay+az);
    p.fill(0);
    // Backward divergence paired with forward pressure gradient gives
    // D(G(p)) exactly the seven-point Laplacian used by the Poisson solve.
    for(let z=1;z<NZ-1;z++)for(let y=1;y<NY-1;y++)for(let x=1;x<NX-1;x++){
      const i=x+y*ROW+z*SLAB;
      div[i]=(u[i]-u[i-1])/this.dx+(v[i]-v[i-ROW])/this.dy+(w[i]-w[i-SLAB])/this.dz;
    }
    for(let iter=0;iter<24;iter++)for(let color=0;color<2;color++)
      for(let z=1;z<NZ-1;z++)for(let y=1;y<NY-1;y++)for(let x=1+((y+z+color)&1);x<NX-1;x+=2){
        const i=x+y*ROW+z*SLAB;
        p[i]=((p[i-1]+p[i+1])*ax+(p[i-ROW]+p[i+ROW])*ay+(p[i-SLAB]+p[i+SLAB])*az-div[i])/den;
      }
    for(let z=1;z<NZ-1;z++)for(let y=1;y<NY-1;y++)for(let x=1;x<NX-1;x++){
      const i=x+y*ROW+z*SLAB;
      u[i]-=(p[i+1]-p[i])/this.dx;v[i]-=(p[i+ROW]-p[i])/this.dy;w[i]-=(p[i+SLAB]-p[i])/this.dz;
    }
  }
  divergenceRms(){
    let sum=0,n=0;
    for(let z=2;z<NZ-2;z++)for(let y=2;y<NY-2;y++)for(let x=2;x<NX-2;x++){
      const i=x+y*ROW+z*SLAB;
      const d=(this.u[i]-this.u[i-1])/this.dx+(this.v[i]-this.v[i-ROW])/this.dy+(this.w[i]-this.w[i-SLAB])/this.dz;
      sum+=d*d;n++;
    }
    return Math.sqrt(sum/n);
  }
}
