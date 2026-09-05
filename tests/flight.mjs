import * as THREE from 'three';
import { Aircraft } from '../src/fx/aircraft.js';
import { aircraftDrag } from '../src/fx/aero.js';

// Runs unchanged in the browser preview or Node with a Three.js resolver.
export function flightChecks(){
  const results = [];
  function check(ok, message){ if(!ok) throw new Error(message); }
  for(const [speed, density, fuel, loadout, wind] of [
    [188, 1.2, 4900, 'mixed', 0], [150, 1.0, 4900, 'mixed', 14],
    [220, 1.0, 4900, 'mixed', 0], [188, 0.9, 1200, [], 8],
  ]){
    const ac = new Aircraft(new THREE.Scene(), { speed, fuel, loadout,
      pos:{x:0,y:2000,z:0}, atmosphere:{density,speedOfSound:340},
      weather:{windSpeed:wind,windDir:0.4,gust:0} });
    const controls = {};
    check(ac.trimLevelFlight(controls, speed), `No trim at ${speed}`);
    const initialTrim = controls.trim, initialThrottle = controls.throttle;
    let maxAltitudeError = 0, maxSpeedError = 0;
    for(let i = 0; i < 60*60; i++){
      ac.update(1/60, controls);
      maxAltitudeError = Math.max(maxAltitudeError, Math.abs(ac.pos.y-2000));
      maxSpeedError = Math.max(maxSpeedError, Math.abs(ac.trueAirspeed-speed));
    }
    check(!ac.crashed && Number.isFinite(ac.pos.length()), 'Invalid flight state');
    check(maxAltitudeError < 20, `${speed}: altitude drift ${maxAltitudeError}`);
    check(maxSpeedError < 2, `${speed}: speed drift ${maxSpeedError}`);
    check(controls.trim === initialTrim && controls.throttle === initialThrottle, 'Hidden auto-trim during flight');
    results.push({speed,density,fuel,wind,trim:initialTrim,throttle:initialThrottle,maxAltitudeError,maxSpeedError});
    ac.dispose();
  }
  for(const speed of [150,188,220]){
    const ac=new Aircraft(new THREE.Scene(),{speed,pos:{x:0,y:2000,z:0}}),controls={};
    ac.trimLevelFlight(controls,speed);
    ac.quat.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1),-Math.PI/4));
    const right=new THREE.Vector3(),up=new THREE.Vector3();let bank10=0;
    for(let i=0;i<120*60;i++){
      ac.update(1/60,controls);
      if(i===599){right.set(1,0,0).applyQuaternion(ac.quat);up.set(0,1,0).applyQuaternion(ac.quat);bank10=Math.abs(Math.atan2(right.y,up.y)*180/Math.PI);}
    }
    right.set(1,0,0).applyQuaternion(ac.quat);up.set(0,1,0).applyQuaternion(ac.quat);
    const bank120=Math.abs(Math.atan2(right.y,up.y)*180/Math.PI);
    check(bank10>25,'Bank snapped level');check(bank120<5&&!ac.crashed,'Spiral diverged');
    results.push({speed,bank10,bank120,altitude120:ac.pos.y});ac.dispose();
  }
  const dry = aircraftDrag({ speed:188,density:1.2,loadFactor:1,storesCount:0,mass:10800 });
  const wet = aircraftDrag({ speed:188,density:1.2,loadFactor:1,storesCount:0,mass:15700 });
  check(wet.induced > dry.induced*2, 'Fuel mass not included in induced drag');
  check(wet.parasitic === dry.parasitic, 'Fuel changed parasitic drag');
  for(const direction of [-1,1]){
    const ac = new Aircraft(new THREE.Scene(), {speed:188,pos:{x:0,y:2000,z:0}});
    const controls = {}; ac.trimLevelFlight(controls,188);
    controls.trim += direction*0.1;
    for(let i=0;i<120;i++) ac.update(1/120,controls);
    check(ac.angVel.x*direction < 0, 'Trim direction reversed');
    ac.dispose();
  }
  const ac = new Aircraft(new THREE.Scene(), {speed:188,pos:{x:0,y:2000,z:0}});
  const controls = {}; ac.trimLevelFlight(controls,188);
  const before = ac.mass, release = ac.release();
  check(release && ac.mass < before, 'Store mass did not leave immediately');
  const saved = ac.quat.clone();
  check(!ac.trimLevelFlight(controls,20), 'Impossible low-speed trim accepted');
  check(ac.quat.equals(saved), 'Failed trim changed attitude');
  ac.dispose();
  return results;
}
