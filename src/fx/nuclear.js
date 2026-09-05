import * as THREE from 'three';

// Stylised game spectacle. Fixed meshes and a single active event bound cost.
export class NuclearFX {
  constructor(scene, field){
    this.scene=scene; this.field=field; this.age=100; this.flash=0;
    this.group=new THREE.Group(); scene.add(this.group);
    this.geo=new THREE.SphereGeometry(1,24,16);
    this.fireMat=new THREE.MeshBasicMaterial({color:0xffdb88,transparent:true,depthWrite:false,toneMapped:false,fog:false});
    this.smokeMat=new THREE.MeshLambertMaterial({color:0x928578,transparent:true,depthWrite:false,fog:false});
    this.core=new THREE.Mesh(this.geo,this.fireMat); this.group.add(this.core);
    this.cap=new THREE.Mesh(this.geo,this.smokeMat); this.group.add(this.cap);
    for(let i=0;i<12;i++){
      const lobe=new THREE.Mesh(this.geo,this.smokeMat),a=i*Math.PI/6;
      lobe.position.set(Math.cos(a)*0.8,0.1+Math.sin(i*2.3)*0.16,Math.sin(a)*0.8);
      lobe.scale.set(0.42,0.6,0.42); this.cap.add(lobe);
    }
    this.stem=new THREE.Mesh(this.geo,this.smokeMat); this.group.add(this.stem);
    this.ringGeo=new THREE.TorusGeometry(1,0.025,8,128);
    this.ringMat=new THREE.MeshBasicMaterial({color:0xffead0,transparent:true,depthWrite:false,toneMapped:false,fog:false});
    this.ring=new THREE.Mesh(this.ringGeo,this.ringMat); this.ring.rotation.x=Math.PI/2;
    this.group.add(this.ring); this.group.visible=false;
  }
  detonate(point){
    this.age=0; this.group.position.copy(point); this.group.visible=true;
    this.field.addTsunami?.(point.x,point.z);
  }
  update(dt, observer){
    this.age+=dt; const t=this.age;
    this.group.visible=t<40;
    const dist=observer ? observer.distanceTo(this.group.position) : 0;
    this.flash=t<6 ? 3.5*Math.exp(-t/1.15)/(1+dist/16000) : 0;
    if(!this.group.visible) return;
    this.core.scale.setScalar(30+230*(1-Math.exp(-t/1.4)));
    this.core.position.y=70+t*12; this.fireMat.opacity=Math.max(0,1-t/8);
    this.fireMat.color.setHSL(0.12-Math.min(t,6)*0.012,0.8,0.7);
    const growth=1-Math.exp(-t/6);
    this.cap.position.y=140+t*24; this.cap.scale.set(90+460*growth,45+170*growth,90+460*growth);
    this.stem.position.y=this.cap.position.y/2; this.stem.scale.set(45+80*growth,this.cap.position.y/2,45+80*growth);
    this.smokeMat.opacity=Math.min(0.85,t/3)*Math.max(0,1-t/40);
    this.ring.scale.setScalar(20+t*320); this.ring.position.y=25;
    this.ringMat.opacity=Math.max(0,0.9-t/8);
  }
  clear(){ this.age=100; this.flash=0; this.group.visible=false; this.field.clearTsunami?.(); }
  dispose(){ this.clear(); this.scene.remove(this.group); this.geo.dispose(); this.ringGeo.dispose();
    this.fireMat.dispose(); this.smokeMat.dispose(); this.ringMat.dispose(); }
}
