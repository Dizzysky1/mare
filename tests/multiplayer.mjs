import * as THREE from 'three';
import { Session } from '../src/multiplayer.js';
import { Net } from '../src/net.js';
import { sortieLoadout, WeaponLedger, GUN, validWorld, PROTOCOL } from '../src/weapons.js';
import { WaveField } from '../src/waves.js';
import { Minigun } from '../src/fx/minigun.js';
import { NuclearFX } from '../src/fx/nuclear.js';
import { Ocean, TIERS } from '../src/ocean.js';

export function multiplayerChecks(){
  const check=(v,msg)=>{if(!v)throw new Error(msg);};
  const world={protocol:PROTOCOL,seed:7,hour:15,swell:2,windDeg:30,windSpeed:15,storm:0.6,chop:1,loadout:sortieLoadout(()=>0.05)};
  check(validWorld(world),'valid handshake rejected');
  check(!validWorld({...world,loadout:['nuke','nuke']}),'arbitrary loadout accepted');
  let draws=0;
  for(let i=0;i<1000;i++) if(sortieLoadout(()=>i/1000).includes('nuke')) draws++;
  check(draws===100,'10% draw boundary');
  check(sortieLoadout(()=>0.1).filter(s=>s==='nuke').length===0,'upper boundary inclusive');

  const ledger=new WeaponLedger(world.loadout),jet={x:0,y:1000,z:0,at:0};
  const drop={seq:0,id:'nuke',p:[0,995,0],v:[0,0,180],windX:0,windZ:0,simTime:0};
  check(!ledger.accept('drop',{...drop,p:[9000,0,0]},0,jet),'teleported release accepted');
  check(ledger.accept('drop',drop,0,jet),'legitimate nuke rejected');
  check(!ledger.accept('drop',drop,0.3,jet),'replayed nuke accepted');
  check(!ledger.accept('drop',{...drop,seq:1},0.3,jet),'second nuke accepted');
  for(let i=0;i<5;i++){
    jet.at=(i+1)*0.3;
    check(ledger.accept('drop',{...drop,seq:i+1,id:world.loadout[i+1]},jet.at,jet),'normal store rejected');
  }
  check(!ledger.accept('drop',{...drop,seq:6,id:'mk83'},2,jet),'unlimited drops accepted');
  check(!ledger.accept('drop',{...drop,seq:6,id:undefined},2,jet),'missing ID bypassed exhausted stores');
  for(let i=0;i<GUN.ammo/GUN.burst;i++){
    jet.at=3+i*0.11;
    check(ledger.accept('gun',{seq:6+i,p:[0,1000,0],v:[0,0,1180]},jet.at,jet),'gun budget rejected');
  }
  check(!ledger.accept('gun',{seq:126,p:[0,1000,0],v:[0,0,1180]},17,jet),'gun ammo bypass');
  const cooldown=new WeaponLedger(world.loadout);
  check(cooldown.accept('gun',{seq:0,p:[0,1000,0],v:[0,0,1180]},jet.at,jet),'initial gun rejected');
  check(cooldown.accept('gun',{seq:1,p:[0,1000,0],v:[0,0,1180]},jet.at,jet),'network jitter allowance rejected');
  check(!cooldown.accept('gun',{seq:2,p:[0,1000,0],v:[0,0,1180]},jet.at,jet),'burst flood accepted');
  check(!cooldown.accept('gun',{seq:2,p:[NaN,0,0],v:[0,0,0]},jet.at,jet),'NaN accepted');

  let applied=0; const mock={send:()=>true};
  const host=new Session({net:mock,role:'sailor',onDrop:()=>applied++});
  host.now=()=>0; host.sendWorld(world);
  mock.onMessage('jet',{t:0,x:0,y:1000,z:0,qx:0,qy:0,qz:0,qw:1,vx:0,vy:0,vz:180,burner:0});
  mock.onMessage('drop',drop); mock.onMessage('drop',drop);
  check(applied===1,'receiver did not enforce ledger');
  const pilotNet={send:()=>true}; let starts=0;
  const pilot=new Session({net:pilotNet,role:'pilot',onWorld:()=>starts++,onDrop:()=>applied++});
  pilotNet.onMessage('world',world); pilotNet.onMessage('world',world);
  pilotNet.onMessage('drop',drop);
  check(starts===1 && applied===1,'role or repeated handshake accepted');
  pilotNet.onMessage('boats',{t:1,b:[{x:0,y:0,z:0,h:1e20,r:0,p:0}]});
  check(pilot.boats.samples.length===0,'infinite-loop heading accepted');
  pilotNet.onMessage('boats',{t:1,b:null}); pilot.update(0.1);
  const events={},net=new Net(); let received=0;
  net.onMessage=()=>received++;
  net._wire({label:'state',addEventListener:(name,fn)=>events[name]=fn});
  for(const data of ['null','[]','{"t":"__pong"}','x'.repeat(20000)]) events.message({data});
  check(received===0,'malformed transport envelope dispatched');

  const field=new WaveField(10),scene=new THREE.Scene(),fx=new NuclearFX(scene,field);
  const baseline=field.height(190,0,2);
  fx.detonate(new THREE.Vector3()); fx.update(2,new THREE.Vector3(0,1000,0));
  check(fx.flash>0 && fx.group.visible,'nuclear flash missing');
  const crest=field.height(190,0,2)-baseline;
  check(crest>15,'tsunami crest missing');
  check(Math.abs(field.sample(190,0,{},2).y-field.height(190,0,2))<1e-9,'buoyancy disagrees with surface');
  check(field.tsunamiHeight(190,0,100)===0,'tsunami never expires');
  fx.clear(); check(field.tsunami.w===0 && !fx.group.visible,'nuclear reset leaked wave'); fx.dispose();
  const env={uTime:{value:1000}},ocean=new Ocean(scene,field,env,{...TIERS.low,rings:8,sect:8});
  field.time=12; ocean.update(new THREE.PerspectiveCamera(),720);
  check(ocean.uniforms.uTime.value===12 && env.uTime.value===1000,'ocean followed paused sky clock instead of buoyancy');
  scene.remove(ocean.mesh); ocean.mesh.geometry.dispose(); ocean.mesh.material.dispose();
  let hits=0;
  const gun=new Minigun(scene,{height:()=>-100},{damage:()=>hits++});
  gun.fire([0,10,0],[0,0,1000]);
  gun.update(0.1,null,new THREE.Vector3(0,10,50));
  check(hits>0,'swept gun collision missed target');
  for(let i=0;i<100;i++) gun.fire([0,10,0],[0,0,1000]);
  check(gun.rounds.length===160,'gun pool unbounded');
  gun.update(3,null,null); check(!gun.rounds.some(r=>r.live),'rounds never expire');
  gun.clear(); gun.dispose();
  return {nukeDraws:draws,outOf:1000,acceptedStores:6,gunAmmo:GUN.ammo,replay:'rejected',heading:'rejected',crest};
}

export async function inviteChecks(){
  const raw=new TextEncoder().encode('x'.repeat(131072));
  const stream=new CompressionStream('deflate-raw'),writer=stream.writable.getWriter();
  const writes=writer.write(raw).then(()=>writer.close());
  const packed=new Uint8Array(await new Response(stream.readable).arrayBuffer()); await writes;
  const code='z'+btoa(String.fromCharCode(...packed)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
  let rejected=0;
  for(const input of ['u'+'a'.repeat(32768),code]){
    try{await new Net().join(input);}catch(e){if(/too large|too much data/.test(e.message))rejected++;else throw e;}
  }
  if(rejected!==2)throw new Error('Oversized invite was accepted');
  return {oversized: 'rejected', compressedExpansion:'rejected'};
}
