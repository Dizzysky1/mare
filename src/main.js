import * as THREE from 'three';
import { WaveField } from './waves.js';
import { Ocean, TIERS, NISL, WAKE } from './ocean.js';
import { Sky } from './sky.js';
import { World, makeAmphora } from './islands.js';
import { Ship, Fleet } from './boats.js';
import { Gulls } from './birds.js';
import { Player } from './player.js';
import { Survival, Quest, LOGBOOK } from './survival.js';
import { Post } from './post.js';
import { Strikes } from './strikes.js';
import { Net } from './net.js';
import { Session } from './multiplayer.js';
import { Pilot } from './pilot.js';
import { buildF18 } from './fx/f18.js';
import { Chart } from './chart.js';
import { Cardio } from './physiology.js';
import { Weather } from './weather.js';
import { Atmosphere } from './atmosphere.js';
import { reseedWorld, worldSeed, stream } from './rng.js';
import { generateCharacter, cardioOptionsFor, knows, describe as describeCharacter } from './character.js';
import { Creative } from './creative.js';
import { Vision } from './vision.js';
import { UI } from './ui.js';
import { Audio } from './audio.js';

/* ────────────────────────────────────────────────────────────── */

const MODES = {
  easy: {
    key:'easy', name:'Drift', spectator:true, survival:false, dayCycle:false,
    hour:16.6, swell:0.78, windDeg:38, windSpeed:6.0, storm:0, chop:0.95,
    boats:7, gulls:90, dayLen:0, storminess:0.04, stormMin:0, stormMax:0.12,
  },
  medium: {
    key:'medium', name:'Deckhand', spectator:false, survival:false, dayCycle:true,
    hour:9.2, swell:1.05, windDeg:38, windSpeed:7.5, storm:0.04, chop:1.05,
    boats:6, gulls:80, dayLen:2400, storminess:0.14, stormMin:0, stormMax:0.35,
  },
  hard: {
    key:'hard', name:'Passage', spectator:false, survival:true, hard:true, decay:1,
    dayCycle:true, hour:6.4, swell:1.55, windDeg:52, windSpeed:9.5, storm:0.12, chop:1.15,
    boats:4, gulls:55, dayLen:1500, storminess:0.32, stormMin:0.02, stormMax:0.62,
  },
  insane: {
    key:'insane', name:'The unwelcoming side', spectator:false, survival:true, hard:true, decay:2.0,
    dayCycle:true, hour:19.6, swell:3.9, windDeg:200, windSpeed:18.0, storm:0.88, chop:1.35,
    boats:1, gulls:12, dayLen:1100, hostile:true, storminess:0.88, stormMin:0.55, stormMax:1,
  },
  /* ── two-player modes ──────────────────────────────────────
     The sailor's world is Insane+ with the scripted air force switched
     OFF: the aircraft overhead is a person now, so the game must not
     also be flying one at them. The pilot's world is the same sea,
     rebuilt from the seed the sailor sends, with no boat and no body. */
  mpSailor: {
    key:'mpSailor', name:'Contested waters — sailing', multiplayer:'sailor',
    spectator:false, survival:true, hard:true, decay:2.0,
    dayCycle:true, hour:17.4, swell:2.9, windDeg:200, windSpeed:14.0, storm:0.5, chop:1.3,
    boats:9, gulls:14, dayLen:1400, hostile:true, strikes:false,
    storminess:0.6, stormMin:0.3, stormMax:0.85,
  },
  mpPilot: {
    key:'mpPilot', name:'Contested waters — flying', multiplayer:'pilot',
    spectator:false, pilot:true, survival:false, hard:false, decay:1,
    dayCycle:true, hour:17.4, swell:2.9, windDeg:200, windSpeed:14.0, storm:0.5, chop:1.3,
    boats:0, gulls:0, dayLen:1400, hostile:true, strikes:false,
    storminess:0.6, stormMin:0.3, stormMax:0.85,
  },
  insanePlus: {
    key:'insanePlus', name:'Contested waters', spectator:false, survival:true, hard:true, decay:2.3,
    dayCycle:true, hour:18.2, swell:3.6, windDeg:200, windSpeed:17.0, storm:0.72, chop:1.35,
    boats:1, gulls:10, dayLen:1100, hostile:true, strikes:true, strikeInterval:88, storminess:0.74, stormMin:0.45, stormMax:0.95,
  },
};

/* How much sail a boat can carry in a given wind, as a fraction of full. */
const reefedFor = (v) => THREE.MathUtils.clamp(45/Math.max(1, v*v), 0.18, 0.70);

const SEA_COLOURS = {
  warm: { deep:[0.0040,0.031,0.062], mid:[0.014,0.170,0.250], shallow:[0.105,0.640,0.590], sss:[0.080,0.480,0.420] },
  cold: { deep:[0.0035,0.011,0.016], mid:[0.014,0.055,0.062], shallow:[0.055,0.150,0.140], sss:[0.030,0.110,0.105] },
};

/* ────────────────────────────────────────────────────────────── */

const canvas = document.getElementById('view');
const ui = new UI();
const audio = new Audio();
// ?mute=1 keeps the page silent for unattended/automated runs
if(new URLSearchParams(location.search).has('mute')){
  audio.enabled = false;
  const box = document.getElementById('opt-audio');
  if(box) box.checked = false;
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias:false, powerPreference:'high-performance', stencil:false });
renderer.setPixelRatio(1);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NoToneMapping;      // we tone map in the composite
renderer.setSize(innerWidth, innerHeight, false);

const gl = renderer.getContext();
const dbg = gl.getExtension('WEBGL_debug_renderer_info');
const gpuName = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : 'unknown';

// pick a starting tier from what we can see of the machine
let tierName = 'high';
if(/Apple M[1-9]\s*(Pro|Max|Ultra)/i.test(gpuName) || (navigator.hardwareConcurrency||4) >= 10) tierName = 'ultra';
if(/Apple M[1-9]\s*(Max|Ultra)/i.test(gpuName)) tierName = 'max';
if(/(Intel|Iris|UHD|Mali|Adreno)/i.test(gpuName)) tierName = 'low';
let tier = TIERS[tierName];
const maxTier = TIERS.max;

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x9fb8c4, 0.00016);
const camera = new THREE.PerspectiveCamera(62, innerWidth/innerHeight, 0.08, 26000);
camera.position.set(0, 12, 40);

const sky = new Sky(scene, camera);
// Compile the expensive sea path once at maximum capacity. Presets still
// change live wave count, geometry, render resolution and ray work.
const field = new WaveField(maxTier.waves);
const ocean = new Ocean(scene, field, sky.uniforms, maxTier);
const post = new Post(renderer, scene, camera, maxTier);

let world = null, fleet = null, gulls = null, playerShip = null, player = null, creative = null;
let quest = null, survival = null, mode = MODES.easy, strikes = null;
/* two-player session state */
let net = null, session = null, pilotSeat = null, remoteJet = null;
let state = 'loading';           // loading | menu | play | pause | over
let hour = 16.6, storm = 0, wind = new THREE.Vector3(1,0,0.4), windSpeed = 6;
let sunInfo = { night:0, elevation:0.5, flash:0 };
let menuT = 0, elapsed = 0, runSeed = 0;

/* ── quality governor ───────────────────────────────────────── */
const gov = { q:10, acc:0, frames:0, fps:60, cooldown:1.5, manual:false };
function applyQuality(){
  const q = gov.q;
  const pr = Math.min(devicePixelRatio || 1, THREE.MathUtils.lerp(0.80, tier.pr, q/10));
  renderer.setPixelRatio(pr);
  renderer.setSize(innerWidth, innerHeight, false);
  post.setSize(innerWidth, innerHeight, pr);
  renderer.toneMapping = post.enabled ? THREE.NoToneMapping : THREE.ACESFilmicToneMapping;
  ocean.uniforms.uRTSteps.value = q >= 7 ? tier.rt : q >= 4 ? Math.floor(tier.rt*0.5) : 0;
  const activeWaves = field.activeCount || field.waves.length;
  ocean.uniforms.uWaveCut.value = (q >= 5 ? activeWaves : Math.max(6, Math.floor(activeWaves*0.55))) - 1;
  ocean.uniforms.uDetail.value = q >= 3 ? 1 : 0.35;
  post.god = tier.god && q >= 6;
  gov.rays = q >= 8 ? 36 : 22;
  const wantShadow = tier.shadow > 0 && q >= 4;
  const shadowSize = wantShadow ? tier.shadow : 0;
  if(renderer.shadowMap.enabled !== wantShadow || sky.shadowSize !== shadowSize){
    sky.enableShadows(wantShadow, renderer, shadowSize || 2048);
    scene.traverse(o=>{ if(o.isMesh) o.material && (o.material.needsUpdate = true); });
  }
}

function setQualityTier(name, refreshSea = true){
  tierName = TIERS[name] ? name : 'high';
  tier = TIERS[tierName];
  ocean.setTier(tier);
  post.setQuality(tier, renderer.capabilities.maxSamples);
  if(refreshSea){
    field.configure({ swell:mode.swell, windDeg:mode.windDeg, chop:mode.chop, count:tier.waves });
    ocean.syncSpectrum();
  }
  gov.q = 10; gov.cooldown = 2.5;
  applyQuality();
}
function governor(dt){
  gov.acc += dt; gov.frames++;
  if(gov.acc < 0.55) return;
  gov.fps = gov.frames/gov.acc;
  gov.acc = 0; gov.frames = 0;
  if(gov.manual) return;
  gov.cooldown -= 0.55;
  if(gov.cooldown > 0) return;
  const before = gov.q;
  if(gov.fps < 33 && gov.q > 0) gov.q--;
  else if(gov.fps > 57 && gov.q < 10) gov.q++;
  if(gov.q !== before){ applyQuality(); gov.cooldown = 1.6; }
}

/* ── input ──────────────────────────────────────────────────── */
const input = { fwd:0, back:0, left:0, right:0, jump:0, crouch:0, sprint:0, slow:0 };
let sens = 0.0022;
const KEYS = {
  KeyW:'fwd', KeyS:'back', KeyA:'left', KeyD:'right', ArrowUp:'fwd', ArrowDown:'back',
  ArrowLeft:'left', ArrowRight:'right', Space:'jump', ShiftLeft:'sprint', ShiftRight:'sprint',
  ControlLeft:'crouch', KeyC:'crouch', AltLeft:'slow',
};
addEventListener('keydown', e => {
  if(creative && creative.active && creative.handleKey(e.code, true)) return;
  if(KEYS[e.code]){ input[KEYS[e.code]] = 1; if(e.code === 'Space') e.preventDefault(); }
  if(state === 'play' && mode.pilot && pilotSeat){
    if(e.code === 'KeyQ') pilotKeys.rudderL = 1;
    if(e.code === 'KeyR') pilotKeys.rudderR = 1;
    if(e.code === 'KeyX') pilotKeys.airbrake = 1;
    if(e.code === 'KeyF'){
      // The pilot must watch their own store fall too. sendDrop only tells
      // the OTHER end; without this the bomb exists on the sailor's screen
      // and nowhere on the pilot's, which is exactly backwards.
      const rel = pilotSeat.release();
      if(rel && strikes) strikes.dropStore(rel.munitionId, rel.pos, rel.vel);
      e.preventDefault();
    }
    if(e.code === 'KeyV') pilotSeat.toggleView();
    // Reset the altimeter to the pressure here and now. Nothing forces
    // you to, and nothing tells you when it has gone stale.
    if(e.code === 'KeyB') pilotSeat.setAltimeter(atmos?.pressure ?? 1013.25);
  }
  if(state === 'play'){
    if(e.code === 'KeyE') interact();
    if(e.code === 'KeyV' && player) player.thirdPerson = !player.thirdPerson;
    if(e.code === 'KeyM') toggleChart();
    if(e.code === 'KeyQ' && playerShip) playerShip.sail = Math.max(0, playerShip.sail - 0.2);
    if(e.code === 'KeyR' && playerShip) playerShip.sail = Math.min(1, playerShip.sail + 0.2);
    if(e.code === 'KeyF') gov.manual = !gov.manual;
  }
  if(e.code === 'Escape'){
    if(!chartEl.classList.contains('hidden')) closeChart();
    else if(!ui.el.reader.classList.contains('hidden')) ui.hideReader();
    else if(state === 'play') pause();
    else if(state === 'pause') resume();
  }
});
addEventListener('keyup', e => {
  if(creative && creative.active && creative.handleKey(e.code, false)) return;
  if(KEYS[e.code]) input[KEYS[e.code]] = 0;
  if(e.code === 'KeyQ') pilotKeys.rudderL = 0;
  if(e.code === 'KeyR') pilotKeys.rudderR = 0;
  if(e.code === 'KeyX') pilotKeys.airbrake = 0;
});
addEventListener('blur', () => { for(const k in input) input[k] = 0;
  for(const k in pilotKeys) pilotKeys[k] = 0; });

document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === canvas;
  if(!locked && state === 'play' && ui.el.reader.classList.contains('hidden')
     && chartEl.classList.contains('hidden')) pause();
});
addEventListener('mousemove', e => {
  if(document.pointerLockElement !== canvas || !player) return;
  player.look(e.movementX, e.movementY, sens);
});
canvas.addEventListener('mousedown', () => {
  if(state === 'play' && document.pointerLockElement !== canvas) canvas.requestPointerLock();
});
addEventListener('resize', () => {
  camera.aspect = innerWidth/innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight, false);
  applyQuality();
});

/* steering: A/D turn the rudder when you are at the tiller */
function steer(dt){
  if(!playerShip) return;
  const atHelm = player && player.state === 'deck' && player.local.z < -playerShip.length*0.22;
  let want = 0;
  if(atHelm){ want = (input.right?1:0) - (input.left?1:0); }
  playerShip.rudder += (want - playerShip.rudder)*Math.min(1, dt*3.2);
  playerShip.atHelm = atHelm;
}

/* ── build the world ────────────────────────────────────────── */
async function boot(){
  const step = (msg) => new Promise(r => { ui.el.loadmsg.textContent = msg; setTimeout(r, 16); });

  await step('raising islands…');
  world = new World(scene, { seed:4210, count:Math.min(NISL, 13), spread:4300,
                             detail: tier.rings > 300 ? 190 : 120 });
  ocean.setIslands(world.islands);

  await step('launching boats…');
  fleet = new Fleet(scene, field, world, { count:7, radius:1500 });

  await step('calling the gulls…');
  gulls = new Gulls(scene, field, { count: tier.rings > 300 ? 90 : 45 });
  gulls.onCall = (near) => audio.gull(near);

  await step('waiting for the light…');
  player = new Player(scene, field, world);
  player.pos.set(0, 45, 120);

  // the thing that keeps pace, for later
  buildFollower();

  strikes = new Strikes(scene, field, audio, {
    toast: (t, k) => ui.toast(t, k),
    shake: (a) => { if(player) player.shake = Math.max(player.shake, a); },
    damage: (amount, why) => {
      if(!survival || !survival.on || survival.dead) return;
      survival.health = Math.max(0, survival.health - amount);
      survival.hurtT = 1.0;
      survival.sanity = Math.max(0, survival.sanity - amount*0.25);
      // Against an epsilon, not zero: damage that exactly consumes the
      // bar leaves a float residue of ~1e-14, which left the player
      // standing on nothing after a lethal dose of fire.
      if(survival.health <= 1e-6){ survival.health = 0; survival.dead = true; survival.cause = why; }
      else ui.toast(why, 'bad');
    },
    impact: (point, dist) => {
      if(session && mode.multiplayer === 'sailor') session.sendHit('store', dist < 70);
    },
    // A near miss is violent enough to take spectacles off a face — the
    // mechanism is being knocked about, not the pressure itself acting on
    // the lens, which is nowhere near strong enough to matter.
    blastWave: (impulseNs, dist) => {
      if(!vision || state !== 'play') return;
      if(vision.blast(impulseNs)) ui.toast('Your glasses are gone — off your face and over the side.', 'bad');
      if(dist < 120) vision.flash(THREE.MathUtils.clamp(1.6 - dist/120, 0, 1.4));
    },
  });

  creative = new Creative({ scene, camera, field, world, player, ocean, sky, strikes, fleet, gulls, ui, gov });

  ui.el.loading.classList.add('hidden');
  ui.el.menu.classList.remove('hidden');
  state = 'menu';
  const qualityEl = document.getElementById('opt-quality');
  qualityEl.value = tierName === 'low' ? 'low' : tierName === 'high' ? 'med' : 'high';
  setQualityTier(tierName);
}

let follower = null;
function buildFollower(){
  const g = new THREE.Group();
  const fin = new THREE.Mesh(
    new THREE.ConeGeometry(0.9, 2.4, 3),
    new THREE.MeshStandardMaterial({ color:0x0b1418, roughness:0.6 }));
  fin.rotation.x = -0.25;
  fin.scale.set(0.35, 1, 1.6);
  g.add(fin);
  g.visible = false;
  scene.add(g);
  follower = { group:g, angle:0, radius:60, active:false };
}

/* ── menu ───────────────────────────────────────────────────── */
document.querySelectorAll('#cards .card').forEach(c => {
  c.addEventListener('click', () => startMode(c.dataset.mode));
});
document.getElementById('opt-quality').addEventListener('change', e => {
  const map = { low:'low', med:'high', high:'max' };
  setQualityTier(map[e.target.value] || 'high');
  ui.toast(`Graphics set to ${e.target.options[e.target.selectedIndex].text}.`, 'dim');
});
document.getElementById('opt-sens').addEventListener('input', e => { sens = e.target.value/50000; });
document.getElementById('opt-audio').addEventListener('change', e => {
  audio.enabled = e.target.checked;
  audio.fade(e.target.checked ? 1 : 0, 0.4);
});
document.getElementById('read-close').addEventListener('click', () => ui.hideReader());
document.getElementById('chart-close').addEventListener('click', () => closeChart());
document.getElementById('btn-creative')?.addEventListener('click', startCreative);
document.getElementById('btn-resume').addEventListener('click', resume);
document.getElementById('btn-quit').addEventListener('click', toMenu);
document.getElementById('btn-menu').addEventListener('click', toMenu);
document.getElementById('btn-again').addEventListener('click', () => startMode(mode.key));

function startMode(key, mpWorld){
  mode = MODES[key];
  /* In a two-player game the sailor decides the world and the pilot is
     told it, so both are sailing and flying over the same sea rather
     than two plausible-looking different ones. */
  if(mpWorld) mode = Object.assign({}, mode, {
    hour: mpWorld.hour, swell: mpWorld.swell, windDeg: mpWorld.windDeg,
    windSpeed: mpWorld.windSpeed, storm: mpWorld.storm, chop: mpWorld.chop,
  });
  audio.start(); audio.resume();

  // the sea itself
  field.configure({ swell:mode.swell, windDeg:mode.windDeg, chop:mode.chop, count:tier.waves });
  ocean.syncSpectrum();
  const pal = mode.hostile ? SEA_COLOURS.cold : SEA_COLOURS.warm;
  ocean.uniforms.uDeep.value.setRGB(...pal.deep);
  ocean.uniforms.uMid.value.setRGB(...pal.mid);
  ocean.uniforms.uShallow.value.setRGB(...pal.shallow);
  ocean.uniforms.uSSS.value.setRGB(...pal.sss);
  ocean.uniforms.uFoamAmt.value = mode.hostile ? 1.35 : 1.0;

  hour = mode.hour;
  storm = mode.storm;
  windSpeed = mode.windSpeed;
  const wr = mode.windDeg*Math.PI/180;
  wind.set(Math.cos(wr), 0, Math.sin(wr)).multiplyScalar(windSpeed);
  sky.uniforms.uWindDir.value.set(Math.cos(wr), Math.sin(wr));
  elapsed = 0;

  weather = new Weather({
    // Weather needs no synchronisation at all: it is a pure function of
    // seed and elapsed time, so both clients drift through the same front
    // at the same moment without a single byte crossing the wire.
    seed: mpWorld ? mpWorld.seed : 1337 + Object.keys(MODES).indexOf(mode.key),
    climate: mode.hostile ? 'hostile' : 'mediterranean',
    storminess: mode.storminess ?? mode.storm,
    windDeg: mode.windDeg, windSpeed: mode.windSpeed,
  });
  atmos = new Atmosphere({
    climate: mode.hostile ? 'hostile' : 'mediterranean',
    seaTempC: mode.hostile ? 11 : 24.5,
    seed: 4242,
  });
  lastHs = mode.swell;

  // clear the old fleet
  for(const b of fleet.boats){ scene.remove(b.group); scene.remove(b.spray); }
  fleet.boats.length = 0;
  fleet.max = mode.boats;

  if(playerShip){ scene.remove(playerShip.group); scene.remove(playerShip.spray); playerShip = null; }

  // One number defines the entire run: fleet, gulls, jars, sorties.
  runSeed = mpWorld ? (mpWorld.seed >>> 0)
                    : ((Date.now() ^ (Math.random()*0xffffffff)) >>> 0);
  reseedWorld(runSeed);

  // A different person each run: their eyes, their constitution and what
  // they happen to know all come from this one seed.
  character = generateCharacter(runSeed);
  cardio = new Cardio(cardioOptionsFor(character));
  vision = new Vision(character);

  quest = new Quest(mode, world);
  discovered.clear();
  chartEl.classList.add('hidden');
  survival = new Survival(mode);

  if(mode.pilot){
    // No hull, no body, no needs. One aircraft, one tank, one sortie.
    disposePilot();
    pilotSeat = new Pilot({
      scene, field, camera, session, atmosphere:atmos, weather,
      onToast:(t,k)=>ui.toast(t,k),
      pos:{ x:0, y:1500, z:-7000 }, heading:0, speed:230, loadout:'mixed',
    });
    player.setState('fly');
    player.pos.set(0, 1500, -7000);
    ui.setObjective(null);
  } else if(mode.spectator){
    player.setState('fly');
    player.pos.set(-40, 26, 90);
    player.yaw = 2.6; player.pitch = -0.12;
    ui.setObjective(null);
  } else {
    playerShip = new Ship(scene, field, {
      player:true, x:0, z:0, heading: mode.hostile ? 2.4 : 0.6,
      hullColor:0xf2efe6, stripe:0x1f6f9c, boot:0x8f3a2e,
    });
    // Start under canvas you could actually carry. Heeling force goes as the
    // square of wind speed, so the sail you can stand up under goes as its
    // inverse — nobody sails into a gale with full working sail up.
    playerShip.sail = reefedFor(windSpeed);
    player.boardShip(playerShip);
    if(quest.need || mode.key !== 'easy') quest.placeAmphorae(scene, makeAmphora, 3);
    ui.setObjective(quest.status(player.pos));
  }

  gulls.count = mode.gulls;
  gulls.birds.forEach((b,i)=> b.obj.visible = i < mode.gulls);
  gulls.reseed(player.pos, world, []);

  follower.active = !!mode.hostile;
  follower.group.visible = false;
  if(strikes) strikes.arm(!!mode.strikes, mode.strikeInterval || 95);

  ui.el.menu.classList.add('hidden');
  ui.el.over.classList.add('hidden');
  ui.el.hud.classList.remove('hidden');
  ui.setStats(survival, mode.survival && !mode.pilot);
  ui.el.crosshair.style.display = mode.spectator ? 'none' : '';
  state = 'play';
  gov.q = 10; gov.cooldown = 2.5; applyQuality();
  audio.fade(1, 2.0);
  canvas.requestPointerLock();

  if(mode.pilot){
    // The controls are not the sailing controls and nothing else says so.
    ui.toast('W/S pitch · A/D roll · Q/R rudder · Space and Ctrl throttle', 'dim');
    setTimeout(() => ui.toast('F releases · V view · X airbrake · B resets the altimeter', 'dim'), 5200);
    setTimeout(() => ui.toast('Nothing will tell you which boat is the person.', 'bad'), 11000);
  } else ui.toast(mode.spectator
    ? 'Nothing to do. That is the point.'
    : 'You are aboard. Something on deck should explain why.', 'dim');
}

/* ── the sky's mood, and the air in it ──────────────────────── */
let weather = null, atmos = null;
let lastHs = 0;

/* The sea does not answer the wind instantly, so the wave field is
   re-cut only when the weather's significant wave height has actually
   drifted — rebuilding the spectrum every frame would be wasted work
   and would fight the model's own fetch/duration lag. */
function updateWeather(dt){
  weather.update(dt, { hour, elapsed, nearLand: nearLandFactor(), latitudeish: 0.5 });
  atmos.update(dt, {
    hour, weather,
    playerWet: player ? (player.state === 'swim' ? 1 : player.wet || 0) : 0,
    exertion: player && input.sprint && player.speed > 1 ? 0.7 : 0.15,
    nearLand: nearLandFactor(),
  });

  // Keep each mode recognisably itself: weather may roam, but only inside
  // the band that mode promised on the menu card.
  storm = THREE.MathUtils.clamp(weather.storm, mode.stormMin ?? 0, mode.stormMax ?? 1);

  // Same bargain as `storm`: the wind may roam, but a mode has to stay the
  // mode it advertised — and the hull is only stable across a limited band.
  windSpeed = THREE.MathUtils.clamp(weather.windSpeed + weather.gust*0.4,
                                    mode.windSpeed*0.55, mode.windSpeed*1.30);
  wind.set(Math.cos(weather.windDir), 0, Math.sin(weather.windDir)).multiplyScalar(windSpeed);
  sky.uniforms.uWindDir.value.set(Math.cos(weather.windDir), Math.sin(weather.windDir));

  const hs = THREE.MathUtils.clamp(weather.seaState.hs, mode.swell*0.45, mode.swell*1.45);
  if(Math.abs(hs - lastHs) > Math.max(0.06, lastHs*0.07)){
    lastHs = hs;
    field.configure({ swell:hs, windDeg:weather.windDir*180/Math.PI,
                      chop:mode.chop, count:tier.waves });
    ocean.syncSpectrum();
  }
}

/* 0 well offshore, 1 close in — drives the thermal land breeze. */
function nearLandFactor(){
  if(!world || !player) return 0;
  const n = world.nearest(player.pos.x, player.pos.z);
  return THREE.MathUtils.clamp(1 - n.dist/1200, 0, 1);
}

/* ── the body ───────────────────────────────────────────────── */
let cardio = new Cardio();
let character = null, vision = null;

/* Feed the cardiovascular model what the game knows about the player. */
function updateCardio(dt){
  if(!player) return;
  const sw = player.state === 'swim';
  const surf = sw ? field.height(player.pos.x, player.pos.z) : 0;
  cardio.update(dt, {
    exertion: THREE.MathUtils.clamp((player.speed || 0)/(sw ? 2.4 : 5.4), 0, 1)
              * (input.sprint ? 1 : 0.75),
    fear: (mode.hostile ? 0.45 + (strikes && strikes.flash > 0.1 ? 0.5 : 0) : 0)
          + (strikes ? strikes.effects.fear : 0),
    health: survival ? survival.health : 100,
    water: survival ? survival.water : 100,
    food: survival ? survival.food : 100,
    cold: sw && mode.hostile ? 1 : (sw ? 0.35 : 0),
    submerged: sw,
    faceInWater: sw && player.pos.y + 1.5 < surf,
    breath: player.breath ?? 1,
    decay: mode.decay || 1,
    // heat stress steals from central circulation; cold drives shivering
    // Radiant heat and airway irritation are both real cardiac loads.
    heatStrain: Math.max(atmos ? atmos.strain.cardio : 0,
                         strikes ? strikes.effects.heatStrain : 0),
    bleeding: strikes ? strikes.effects.burn*0.5 : 0,
    coldExposure: atmos ? atmos.strain.coldExposure : 0,
  });
}

/* ── the eyes ───────────────────────────────────────────────── */
/* Everything the character's own eyes and lenses do to the image. The
   simulation knows the world exactly; this is the part they can see. */
function updateVision(dt){
  if(!vision || !player) return;
  const night = sunInfo.night;
  vision.update(dt, {
    weather, atmosphere: atmos,
    playerState: player.state,
    wet: player.state === 'swim' ? 1 : (player.wet || 0),
    lightLevel: THREE.MathUtils.clamp(1 - night*0.95, 0.03, 1),
    wearingGlasses: vision.hasGlasses,
  });
  const u = post.comp.uniforms, v = vision.postUniforms();
  u.uVisionOn.value = 1;
  u.uBlur.value = v.uBlur; u.uDroplets.value = v.uDroplets;
  u.uFog.value = v.uFog;   u.uSalt.value = v.uSalt;
  u.uScratches.value = v.uScratches; u.uDazzle.value = v.uDazzle;
  // Streaming eyes are not lens grime — they blur the image whether or
  // not anything is being worn, so this rides on top of the lens model.
  if(strikes){
    const irr = strikes.effects.eyeIrritation;
    u.uBlur.value = Math.max(u.uBlur.value, irr*2.6);
    u.uFog.value = Math.min(1, u.uFog.value + strikes.effects.veil*0.55);
  }
  u.uLensSeed.value = v.uLensSeed;
  u.uExposureMul.value = v.uExposureMul; u.uSatMul.value = v.uSatMul;
  if(v.uColourMatrix) u.uColourMatrix.value.fromArray(v.uColourMatrix);
  u.uTexel.value.set(1/Math.max(1, post.w||innerWidth), 1/Math.max(1, post.h||innerHeight));
}

/* A quiet caption, not a HUD element: whether the link is up and how
   long the round trip is. Nothing about the other player. */
function updateNetStatus(){
  const e = document.getElementById('net-status');
  if(!e) return;
  const on = !!(net && session && state === 'play');
  e.classList.toggle('hidden', !on);
  if(!on) return;
  const rtt = Math.round(net.rtt);
  e.classList.remove('ok','warn','bad');
  if(!net.connected){ e.classList.add('bad'); e.textContent = 'link lost'; return; }
  e.classList.add(rtt > 220 ? 'warn' : 'ok');
  e.textContent = `${mode.multiplayer === 'pilot' ? 'PILOT' : 'SAILOR'} · ${rtt} ms`;
}

/* ── the canopy ─────────────────────────────────────────────── */
/* The pilot looks through glass, not through nothing. Rain, condensation
   and cloud ride on top of whatever the pilot's own eyes are already
   doing to the image, because they are a separate surface. */
function updateCanopy(){
  if(!pilotSeat || !mode.pilot) return;
  const c = pilotSeat.canopy, u = post.comp.uniforms;
  u.uVisionOn.value = 1;
  u.uDroplets.value = Math.max(u.uDroplets.value, c.droplets);
  u.uFog.value = THREE.MathUtils.clamp(u.uFog.value + c.fog*0.8 + c.veil*0.7, 0, 1);
  // Inside cloud there is simply nothing to see, and the instruments are
  // the only thing left. This is the mechanic, not an effect.
  u.uBlur.value = Math.max(u.uBlur.value, c.inCloud*3.2);
}

/* ── the instrument panel ───────────────────────────────────── */
const pel = id => document.getElementById(id);
function updatePilotHud(){
  const on = !!(pilotSeat && mode.pilot && state === 'play');
  pel('pilot-hud')?.classList.toggle('hidden', !on);
  if(!on) return;
  const r = pilotSeat.readout();
  const set = (id, v) => { const e = pel(id); if(e) e.textContent = v; };
  set('pi-alt', Math.round(r.altitude));
  set('pi-ias', r.ias);
  set('pi-hdg', String(Math.round(r.heading)).padStart(3,'0'));
  set('pi-vsi', r.vsi);
  set('pi-fuel', r.fuel);
  set('pi-stores', r.stores);
  set('pi-g', r.g.toFixed(1));
  set('pi-aoa', r.aoa.toFixed(1));
  const bar = pel('pi-fuel-bar');
  if(bar) bar.style.setProperty('--v', (r.fuelPct*100).toFixed(0) + '%');
  const warn = pel('pi-warn');
  if(warn){
    const msg = r.stalled ? 'STALL'
              : r.fuelPct < 0.12 ? 'BINGO FUEL'
              : r.inCloud ? 'IMC' : '';
    warn.textContent = msg;
    warn.classList.toggle('hidden', !msg);
    warn.classList.toggle('crit', r.stalled);          // red for the one that kills you
    pel('pi-fuel-bar')?.parentElement?.classList.toggle('low', r.fuelPct < 0.12);
  }
}

/* ── the wake ───────────────────────────────────────────────── */
/* A rolling record of where the hull has been, handed to the water
   shader as foam. Sampled by distance travelled rather than by time,
   so a drifting boat doesn't pile every sample on one spot. */
const wakeTrack = [];
let wakeLast = null;

function updateWake(dt){
  const src = playerShip;
  if(!src || dt <= 0){ ocean.setWake(wakeTrack, camera.position, false); return; }
  for(const s of wakeTrack) s.age += dt;
  while(wakeTrack.length && wakeTrack[0].age > 11) wakeTrack.shift();

  const speed = src.speed || 0;
  if(!wakeLast || Math.hypot(src.pos.x-wakeLast.x, src.pos.z-wakeLast.z) > 2.2){
    wakeLast = { x:src.pos.x, z:src.pos.z };
    wakeTrack.push({ x:src.pos.x, z:src.pos.z, age:0,
                     strength: THREE.MathUtils.clamp(speed/3.2, 0, 1) });
    while(wakeTrack.length > WAKE) wakeTrack.shift();
  }
  ocean.setWake(wakeTrack, src.pos, gov.q >= 4 && speed > 0.4);
}

/* ── the chart ──────────────────────────────────────────────── */
const chartEl = document.getElementById('chart');
const chart = new Chart(document.getElementById('chart-canvas'));
const chartNote = document.getElementById('chart-note');
const discovered = new Set();

/* You chart what you sail past. Hostile water gives up less of itself. */
function updateDiscovery(){
  if(!world || !player) return;
  const reach = mode.hostile ? 850 : 1500;
  for(const isl of world.islands){
    if(discovered.has(isl)) continue;
    if(Math.hypot(player.pos.x-isl.pos.x, player.pos.z-isl.pos.z) < isl.radius + reach)
      discovered.add(isl);
  }
}

function drawChart(){
  const known = quest && quest.stage > 0 && !mode.hostile;
  chart.draw({
    world, discovered,
    playerPos: player.pos,
    heading: camHeading(),
    goal: quest && quest.goal ? (quest.goal.lightPos || quest.goal.pos) : null,
    questKnown: known,
    jars: quest ? quest.amphorae : null,
    boats: fleet ? fleet.boats : null,
    hostile: !!mode.hostile,
  });
  chartNote.textContent = discovered.size === 0
    ? 'Blank. You have not been anywhere yet.'
    : mode.hostile
      ? `${discovered.size} landfall${discovered.size===1?'':'s'} drawn. No light is marked on this one.`
      : `${discovered.size} of the islands drawn. Only water you have sailed is charted.`;
}

function toggleChart(){
  if(chartEl.classList.contains('hidden')) openChart(); else closeChart();
}
function openChart(){
  if(state !== 'play' || !world) return;
  updateDiscovery();
  chartEl.classList.remove('hidden');
  document.exitPointerLock();
  drawChart();
}
function closeChart(){
  if(chartEl.classList.contains('hidden')) return;
  chartEl.classList.add('hidden');
  if(state === 'play') canvas.requestPointerLock();
}

/* A sandbox: free flight, spawn anything, drive the sky by hand. */
/* ── two players ─────────────────────────────────────────────
   Connection is peer-to-peer with the signalling done by hand, because
   the game is static files on GitHub Pages and there is no server to
   broker a match. The sailor generates an invite, the pilot answers it,
   and from then on the two browsers talk directly. */

const pilotKeys = { rudderL:0, rudderR:0, airbrake:0 };

const mel = id => document.getElementById(id);
function multiStatus(t){ const e = mel('multi-status'); if(e) e.textContent = t || ''; }
function multiError(t){
  const e = mel('multi-error'); if(!e) return;
  e.textContent = t || ''; e.classList.toggle('hidden', !t);
}
function multiStep(which){
  for(const id of ['multi-choose','multi-host','multi-join'])
    mel(id)?.classList.toggle('hidden', id !== which);
}
function openMulti(){
  multiError(''); multiStatus(''); multiStep('multi-choose');
  mel('multi')?.classList.remove('hidden');
}
function closeMulti(){ mel('multi')?.classList.add('hidden'); }

function makeNet(){
  leaveSession();
  net = new Net({
    onStatus: s => multiStatus(s),
    onClose: why => {
      ui.toast('The link to the other player has dropped.', 'bad');
      multiStatus('disconnected — ' + why);
    },
  });
  return net;
}

/* The sailor owns the world, so the sailor is the one who decides it and
   sends it. The pilot rebuilds the identical sea from that seed. */
function sessionWorld(){
  return {
    seed: runSeed >>> 0, hour, swell: mode.swell, windDeg: mode.windDeg,
    windSpeed: mode.windSpeed, storm: mode.storm, chop: mode.chop,
  };
}

function beginSession(role){
  session = new Session({
    net, role,
    onToast: (t,k) => ui.toast(t,k),
    onWorld: w => {
      // pilot only: the sailor has told us which sea this is
      if(role !== 'pilot') return;
      closeMulti();
      startMode('mpPilot', w);
      ui.toast('You are airborne. Somewhere down there is a person.', 'dim');
    },
    onDrop: d => {
      // Both ends fly the same store from the same release conditions.
      if(strikes) strikes.dropStore(d.id, { x:d.p[0], y:d.p[1], z:d.p[2] },
                                          { x:d.v[0], y:d.v[1], z:d.v[2] });
      if(role === 'sailor') ui.toast('Something has come off it.', 'bad');
    },
    onHit: h => {
      // The pilot's only feedback, and it is the sailor's word for it.
      if(role !== 'pilot') return;
      ui.toast(h.near ? 'Close. Something down there moved.' : 'Nothing. The sea took it.',
               h.near ? 'bad' : 'dim');
    },
  });
  if(pilotSeat) pilotSeat.session = session;
}

async function hostGame(){
  try {
    multiError(''); multiStep('multi-host'); multiStatus('preparing invite…');
    makeNet();
    const code = await net.host();
    mel('multi-offer').value = code;
    multiStatus('Send that to your pilot, then paste their reply below.');
    beginSession('sailor');
    net.onOpen = () => {
      closeMulti();
      startMode('mpSailor');
      session.sendWorld(sessionWorld());
      ui.toast('Your pilot is up. They cannot tell which boat is you.', 'dim');
    };
  } catch(e){ multiError(e.message || String(e)); }
}

async function joinGame(){
  try {
    multiError(''); multiStatus('reading invite…');
    const code = mel('multi-offer-in').value;
    if(!code || !code.trim()){ multiError('Paste the sailor\'s invite code first.'); return; }
    makeNet();
    const answer = await net.join(code);
    mel('multi-answer-out').value = answer;
    multiStatus('Send that reply back to your sailor and wait.');
    beginSession('pilot');
    net.onOpen = () => multiStatus('linked — waiting for the sea…');
  } catch(e){ multiError(e.message || String(e)); }
}

async function acceptAnswer(){
  try {
    multiError('');
    const code = mel('multi-answer').value;
    if(!code || !code.trim()){ multiError('Paste your pilot\'s reply code first.'); return; }
    await net.acceptAnswer(code);
  } catch(e){ multiError(e.message || String(e)); }
}

function leaveSession(){
  if(session) session.leave();
  if(net){ net.close(); net = null; }
  session = null;
  disposePilot();
  disposeRemoteJet();
}

function disposePilot(){
  if(pilotSeat){ pilotSeat.dispose(); pilotSeat = null; }
}

/* The sailor's view of the aircraft: a puppet driven by the interpolated
   state off the wire. It is the same model the scripted flyover uses, so
   there is nothing about it that says "this one is a person". */
function syncRemoteJet(dt){
  const v = session ? session.remoteJet : null;
  if(!v){ if(remoteJet) remoteJet.group.visible = false; return; }
  if(!remoteJet){
    const built = buildF18();
    scene.add(built.group);
    remoteJet = built;
  }
  remoteJet.group.visible = true;
  remoteJet.group.position.set(v.x, v.y, v.z);
  remoteJet.group.quaternion.set(v.qx, v.qy, v.qz, v.qw);
  remoteJet.setBurner?.(v.burner || 0);
}
function disposeRemoteJet(){
  if(remoteJet){ try { scene.remove(remoteJet.group); } catch {} remoteJet = null; }
}

mel('btn-multi')?.addEventListener('click', openMulti);
mel('btn-multi-close')?.addEventListener('click', closeMulti);
for(const id of ['btn-host-back','btn-join-back'])
  mel(id)?.addEventListener('click', () => { leaveSession(); multiError(''); multiStatus(''); multiStep('multi-choose'); });
mel('btn-be-sailor')?.addEventListener('click', hostGame);
mel('btn-be-pilot')?.addEventListener('click', () => { multiError(''); multiStep('multi-join'); });
mel('btn-make-answer')?.addEventListener('click', joinGame);
mel('btn-accept-answer')?.addEventListener('click', acceptAnswer);
mel('btn-copy-offer')?.addEventListener('click', () => {
  navigator.clipboard?.writeText(mel('multi-offer').value); multiStatus('Invite copied.');
});
mel('btn-copy-answer')?.addEventListener('click', () => {
  navigator.clipboard?.writeText(mel('multi-answer-out').value); multiStatus('Reply copied.');
});

function startCreative(){
  audio.start(); audio.resume();
  hour = 12; storm = 0.15; windSpeed = 6;
  wind.set(1,0,0.4).normalize().multiplyScalar(windSpeed);
  mode = { key:'creative', name:'Creative', spectator:true, survival:false,
           dayCycle:false, hostile:false, swell:1.0, chop:1.05, windDeg:22, dayLen:0 };
  weather = null; atmos = null;          // creative drives the sky itself
  quest = null; survival = null;
  if(playerShip){ scene.remove(playerShip.group); scene.remove(playerShip.spray); playerShip = null; }
  reseedWorld((Date.now() ^ 0x5eed) >>> 0);
  player.setState('fly');
  player.pos.set(0, 60, 140);
  discovered.clear();
  ui.el.menu.classList.add('hidden');
  ui.el.over.classList.add('hidden');
  ui.el.hud.classList.remove('hidden');
  ui.setStats(null, false);
  ui.setObjective(null);
  ui.el.crosshair.style.display = '';
  state = 'play';
  gov.q = 10; gov.cooldown = 2.5; applyQuality();
  creative.enter();
  canvas.requestPointerLock();
}

function pause(){
  if(state !== 'play') return;
  state = 'pause';
  document.exitPointerLock();
  ui.el.pause.classList.remove('hidden');
  ui.el.pauseSub.textContent = mode.spectator ? 'The sea keeps going without you.' : quest ? quest.text : '';
  audio.fade(0.25, 0.4);
}
function resume(){
  if(state !== 'pause') return;
  state = 'play';
  ui.el.pause.classList.add('hidden');
  audio.fade(1, 0.6);
  canvas.requestPointerLock();
}
function toMenu(){
  if(creative && creative.active) creative.exit();
  leaveSession();
  state = 'menu';
  if(strikes) strikes.arm(false);
  document.exitPointerLock();
  ui.el.pause.classList.add('hidden');
  ui.el.over.classList.add('hidden');
  ui.el.hud.classList.add('hidden');
  ui.el.menu.classList.remove('hidden');
  ui.setFx({ vignette:0, damage:0 });
  audio.fade(0.5, 1.0);
}
function gameOver(title, sub){
  state = 'over';
  if(strikes) strikes.arm(false);
  document.exitPointerLock();
  ui.el.overTitle.textContent = title;
  ui.el.overSub.textContent = sub;
  ui.el.over.classList.remove('hidden');
  audio.fade(0.3, 1.2);
}

/* ── interaction ────────────────────────────────────────────── */
let forageCool = 0;
function findInteraction(){
  if(!player || mode.spectator) return null;
  const p = player.pos;

  if(player.state === 'deck' && playerShip && playerShip.props){
    const P = playerShip.props;
    const near = (obj, r = 1.7) => {
      const w = new THREE.Vector3(); obj.getWorldPosition(w);
      return w.distanceTo(p) < r;
    };
    if(near(P.logbook, 2.0)){
      return quest.stage === 0
        ? { label:'read the logbook', act:() => readLogbook() }
        : { label:'read the logbook again', act:() => readLogbook(true) };
    }
    if(mode.survival){
      if(near(P.water)) return { label:`drink (${survival.supplies.water} left)`, act:() => sip('water') };
      if(near(P.food))  return { label:`eat (${survival.supplies.food} left)`, act:() => sip('food') };
      if(near(P.citrus))return { label:`take a lemon (${survival.supplies.citrus} left)`, act:() => sip('citrus') };
    }
  }

  if(player.state === 'swim' && playerShip){
    if(p.distanceTo(playerShip.pos) < playerShip.length*0.55 + 2.5)
      return { label:'climb aboard', act:() => {
        player.boardShip(playerShip);
        ui.toast('You haul yourself over the rail, streaming.');
        audio.splash(0.7);
      }};
  }

  if(player.state === 'land'){
    for(const a of quest.amphorae){
      if(!a.taken && a.pos.distanceTo(p) < 2.6)
        return { label:'take the amphora', act:() => {
          if(quest.take(a)){
            audio.blip({ freq:520, type:'triangle', dur:0.5, gain:0.09, sweep:1.6 });
            ui.toast(`Amphora recovered — ${quest.found} of ${quest.need}.`);
            if(quest.found >= quest.need) ui.toast('That is three. Now the light.', '');
          }
        }};
    }
    const near = world.nearest(p.x, p.z).island;
    if(near && near.wellPos && near.wellPos.distanceTo(p) < 3.2 && mode.survival)
      return { label:'drink from the cistern', act:() => {
        survival.refill('water', 6);
        ui.toast('Cold, and tasting of stone. You fill the skin as well.');
        audio.splash(0.35);
      }};
    if(mode.survival && forageCool <= 0 && world.heightAt(p.x,p.z) > 2.0)
      return { label:'forage', act:() => {
        forageCool = 12;
        const luck = stream('forage').next();
        if(luck < 0.42){ survival.refill('food', 2); ui.toast('Figs, mostly green. Better than nothing.'); }
        else if(luck < 0.68){ survival.refill('citrus', 1); ui.toast('A lemon tree, half wild. You strip what you can reach.'); }
        else ui.toast('Thorn scrub and dust. Nothing here.', 'dim');
      }};
    if(quest.stage > 0 && quest.goal.lightPos && quest.goal.lightPos.distanceTo(p) < 42){
      if(quest.need && quest.found < quest.need)
        return { label:`the door is barred — ${quest.need - quest.found} more amphorae`, act:()=>{} };
    }
  }
  return null;
}

function readLogbook(again){
  const L = again ? null : quest.read();
  const key = mode.key === 'medium' ? 'medium' : mode.key === 'hard' ? 'hard' : 'insane';
  const book = L || LOGBOOK[key];
  document.exitPointerLock();
  ui.showReader(book, () => { if(state === 'play') canvas.requestPointerLock(); });
  if(L){
    ui.toast('Now you know why you sailed.');
    ui.setObjective(quest.status(player.pos));
  }
}
function sip(kind){
  const msg = survival.consume(kind);
  if(msg){ ui.toast(msg); audio.blip({ freq:220, type:'sine', dur:0.3, gain:0.05, sweep:0.8 }); }
  else ui.toast('Empty. You will have to find more ashore.', 'bad');
}
function interact(){
  const it = findInteraction();
  if(it) it.act();
}

/* ── the loop ───────────────────────────────────────────────── */
const clock = new THREE.Clock();
const tmp = new THREE.Vector3(), tmp2 = new THREE.Vector3(), tmp3 = new THREE.Vector3();
const sunUv = new THREE.Vector2(0.5,0.5);
const bearing = (dx, dz) => Math.atan2(dx, -dz);
const camHeading = () => {
  const f = camera.getWorldDirection(tmp2);
  return bearing(f.x, f.z);
};
const tint = new THREE.Color(1,1,1);
let lastFlash = 0;

function frame(){
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  governor(dt);

  if(state === 'loading'){ renderer.render(scene, camera); return; }

  const playing = state === 'play';
  const simDt = (playing || state === 'menu') ? dt : 0;
  elapsed += simDt;

  field.update(simDt);

  if(mode.dayLen > 0 && playing) hour = (hour + simDt*24/mode.dayLen) % 24;

  // weather drifts, and in the hostile sea it never really lets up
  if(playing && weather) updateWeather(simDt);

  if(creative && creative.active && playing){
    creative.update(dt, { camera });
    const w = creative.wants;
    if(w){
      if(w.hour != null) hour = w.hour;
      if(w.storm != null) storm = w.storm;
      if(w.windSpeed != null || w.windDeg != null){
        if(w.windSpeed != null) windSpeed = w.windSpeed;
        const wr = (w.windDeg ?? Math.atan2(wind.z, wind.x)*180/Math.PI)*Math.PI/180;
        wind.set(Math.cos(wr), 0, Math.sin(wr)).multiplyScalar(windSpeed);
        sky.uniforms.uWindDir.value.set(Math.cos(wr), Math.sin(wr));
      }
      if(w.swell != null && Math.abs(w.swell - lastHs) > 0.05){
        lastHs = w.swell;
        field.configure({ swell:w.swell, windDeg:w.windDeg ?? mode.windDeg,
                          chop:mode.chop || 1.05, count:tier.waves });
        ocean.syncSpectrum();
      }
    }
  }
  /* ── camera ─────────────────────────────────────────────── */
  if(state === 'menu'){
    menuT += dt;
    const r = 78, a = menuT*0.055;
    const tgt = fleet.boats.length ? fleet.boats[0].pos : tmp2.set(0,0,0);
    camera.position.set(tgt.x + Math.cos(a)*r, 9 + Math.sin(menuT*0.21)*3.2 + field.height(tgt.x, tgt.z), tgt.z + Math.sin(a)*r);
    camera.lookAt(tgt.x, tgt.y + 2.5, tgt.z);
  } else if(mode.pilot && pilotSeat){
    // The pilot's camera is the aircraft's, so the walking body and its
    // camera are bypassed entirely.
    if(playing){
      pilotSeat.applyInput(input, dt, pilotKeys);
      pilotSeat.update(dt, { world, contacts: session ? session.remoteBoats : [] });
      if(pilotSeat.dead && state === 'play') gameOver('Down', pilotSeat.cause);
    }
  } else if(player){
    if(playing){
      steer(dt);
      player.update(dt, {
        fwd:input.fwd, back:input.back,
        left: playerShip && player.state === 'deck' && playerShip.atHelm ? 0 : input.left,
        right: playerShip && player.state === 'deck' && playerShip.atHelm ? 0 : input.right,
        jump:input.jump, crouch:input.crouch, sprint:input.sprint, slow:input.slow,
      }, playerShip);
    }
    player.applyCamera(camera, dt);
  }

  const focus = camera.position;

  /* ── world sim ──────────────────────────────────────────── */
  if(playerShip && simDt > 0) playerShip.update(simDt, wind, focus);
  if(simDt > 0){
    fleet.update(simDt, wind, focus, focus);
    const allBoats = playerShip ? [playerShip, ...fleet.boats] : fleet.boats;
    gulls.update(simDt, focus, world, allBoats, sunInfo.night);
    world.update(simDt, sunInfo.night);
  }

  sunInfo = sky.update(hour, storm, dt, playerShip ? playerShip.pos : focus);

  // the deck lamp, lit when it earns its keep
  if(playerShip && playerShip.lamp){
    const on = THREE.MathUtils.clamp(sunInfo.night*1.5 + storm*0.55, 0, 1);
    playerShip.lamp.intensity = 38*on;
    playerShip.lantern.material.emissiveIntensity = 2.6*on;
  }
  updateCardio(simDt);
  updateVision(simDt);
  updateCanopy();
  updatePilotHud();
  updateNetStatus();
  updateWake(simDt);
  ocean.update(camera, post.h || innerHeight);

  /* ── survival & quest ───────────────────────────────────── */
  let underwater = false;
  const seaAtCam = field.height(camera.position.x, camera.position.z);
  underwater = camera.position.y < seaAtCam - 0.05;

  if(playing && mode.survival && survival){
    const nearIsl = world.nearest(player.pos.x, player.pos.z);
    let boatNear = false;
    for(const b of fleet.boats) if(b.pos.distanceToSquared(player.pos) < 300*300){ boatNear = true; break; }
    const msg = survival.update(dt, {
      night: sunInfo.night > 0.5,
      daylight: sunInfo.elevation > 0.12 && storm < 0.5,
      storm,
      alone: !boatNear && nearIsl.dist > 900,
      landNear: nearIsl.dist < 260,
      ashore: player.state === 'land',
      boatNear,
      gullNear: false,
      hot: sunInfo.elevation > 0.5 && storm < 0.3,
      // a hot dry wind takes far more out of you than a cool damp calm
      dehydration: atmos ? atmos.strain.dehydrationRate : 1,
      exerting: input.sprint && player.speed > 1,
      drowning: player.state === 'swim' && player.breath <= 0.01,
      cold: player.state === 'swim' && !!mode.hostile,
    });
    if(msg) ui.toast(msg, 'bad');
    ui.setStats(survival, true);
    if(survival.dead) gameOver('Lost with all hands', survival.cause);
  }

  if(playing && quest && !mode.spectator){
    const st = quest.status(player.pos);
    ui.setObjective(st);
    if(quest.checkWin(player.pos, player.state === 'land')){
      const t = Math.floor(elapsed/60);
      gameOver('The lamp is lit',
        mode.hostile
          ? `You got the jars up the stairs and the light caught. Whatever was keeping pace turned away. ${t} minutes.`
          : `You climbed to the lamp and the light caught. It can be seen for thirty miles. ${t} minutes.`);
    }
    // compass: bearings are clockwise from −Z ("north")
    const heading = camHeading();
    if(st.marker && !mode.hostile){
      ui.updateCompass(heading, bearing(st.marker.x - player.pos.x, st.marker.z - player.pos.z));
      tmp.copy(st.marker).project(camera);
      const on = tmp.z < 1 && Math.abs(tmp.x) < 0.98 && Math.abs(tmp.y) < 0.98;
      ui.screenMarker(on, (tmp.x*0.5+0.5)*innerWidth, (-tmp.y*0.5+0.5)*innerHeight);
    } else {
      ui.updateCompass(heading, null);
      ui.screenMarker(false);
    }
  } else if(playing){
    ui.updateCompass(camHeading(), null);
    ui.screenMarker(false);
  }

  /* ── ordnance ───────────────────────────────────────────── */
  if(strikes && simDt > 0){
    strikes.update(simDt, playerShip ? playerShip.pos : focus, playerShip,
      player ? player.pos : focus, wind, {
        submerged: !!(player && player.state === 'swim'
                      && player.pos.y + 1.4 < field.height(player.pos.x, player.pos.z)),
        rain: storm > 0.4 ? (storm-0.4)*1.6 : 0,
        washing: playerShip ? THREE.MathUtils.clamp((playerShip.submersion||0)-0.55, 0, 1)*storm : 0,
      });
    // Coughing and burns cost you the ability to work the boat.
    if(player) player.effort = THREE.MathUtils.clamp(
      strikes.effects.exertionCap*(1 - strikes.effects.burn*0.45), 0.3, 1);
  }

  /* ── the other player ───────────────────────────────────── */
  if(session && playing){
    session.update(simDt, {
      playerShip, fleet: fleet.boats,
      aircraft: pilotSeat ? pilotSeat.ac : null,
      burner: pilotSeat ? pilotSeat.controls.burner : 0,
    });
    if(mode.multiplayer === 'sailor') syncRemoteJet(simDt);
  }

  /* ── the thing that keeps pace ──────────────────────────── */
  if(follower.active && playerShip && playing){
    const scare = survival ? 1 - survival.sanity/100 : 0;
    follower.angle += dt*(0.10 + scare*0.22);
    follower.radius = THREE.MathUtils.lerp(follower.radius, 26 + (1-scare)*70, dt*0.2);
    const x = playerShip.pos.x + Math.cos(follower.angle)*follower.radius;
    const z = playerShip.pos.z + Math.sin(follower.angle)*follower.radius;
    follower.group.position.set(x, field.height(x,z) - 0.15, z);
    follower.group.rotation.y = -follower.angle + Math.PI/2;
    follower.group.visible = scare > 0.18 || sunInfo.night > 0.4;
    if(follower.group.visible && Math.random() < dt*0.06) audio.whisper();
  }

  /* ── interaction prompt ─────────────────────────────────── */
  if(playing){
    forageCool = Math.max(0, forageCool - dt);
    const it = findInteraction();
    ui.setPrompt(it ? `<key>E</key>${it.label}` : null);
  }

  /* ── audio ──────────────────────────────────────────────── */
  if(playing){
    const rough = THREE.MathUtils.clamp(field.swell/2.2, 0, 1);
    audio.update(dt, {
      sea: rough, foam: rough*0.7 + storm*0.5, wind: THREE.MathUtils.clamp(windSpeed/20,0,1)*(0.5+storm),
      rain: storm > 0.4 ? (storm-0.4)*1.6 : 0, under: underwater, near: 1,
      health: survival ? survival.health/100 : 1,
      breath: player ? player.breath : 1,
      bpm: cardio.bpm, heartStress: cardio.danger,
    });
    if(playerShip && Math.abs(playerShip.angVel.x) + Math.abs(playerShip.angVel.z) > 0.22)
      audio.creak(THREE.MathUtils.clamp((Math.abs(playerShip.angVel.x)+Math.abs(playerShip.angVel.z))*2, 0, 1));
    if(sky.flash > 0.9 && sky.flash > lastFlash) setTimeout(()=>audio.thunder(0.6+Math.random()*0.4), 400+Math.random()*2200);
    lastFlash = sky.flash;
  }

  /* ── the chart, which stays live while you read it ──────── */
  if(playing){
    updateDiscovery();
    if(!chartEl.classList.contains('hidden')) drawChart();
  }

  /* ── readout ────────────────────────────────────────────── */
  if(playing){
    const kn = playerShip ? (playerShip.fwdSpeed*1.94384).toFixed(1) : null;
    const h = Math.floor(hour), m = Math.floor((hour%1)*60);
    ui.setReadout([
      `<b>${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}</b>`,
      playerShip ? `${kn} kn · sail ${Math.round(playerShip.sail*100)}%` : null,
      playerShip && playerShip.atHelm ? '<b>at the tiller</b> — A/D to steer' : null,
      player.state === 'swim' ? `breath ${Math.round(player.breath*100)}%` : null,
      `${Math.round(gov.fps)} fps${gov.manual?' (locked)':''} · q${gov.q}`,
    ]);
  }

  /* ── post ───────────────────────────────────────────────── */
  const sunDir = sky.uniforms.uSunDir.value;
  const fwdV = camera.getWorldDirection(tmp3);
  const sunFront = sunDir.dot(fwdV) > 0.05;
  tmp.copy(camera.position).addScaledVector(sunDir, 4000).project(camera);
  sunUv.set(tmp.x*0.5+0.5, -tmp.y*0.5+0.5);
  const sunVisible = sunFront && sunUv.x > -0.6 && sunUv.x < 1.6 && sunUv.y > -0.6 && sunUv.y < 1.6;

  const insanity = survival && mode.survival ? THREE.MathUtils.clamp(1 - survival.sanity/60, 0, 1) : 0;
  const hurt = survival ? THREE.MathUtils.clamp(1 - survival.health/45, 0, 1) : 0;
  tint.setRGB(1,1,1);
  if(mode.hostile) tint.setRGB(0.93, 0.97, 1.06);
  if(insanity > 0) tint.lerp(new THREE.Color(1.06, 0.92, 0.92), insanity*0.7);

  post.render(dt, {
    bloom: 0.42 + (mode.hostile?0.10:0) ,
    bloomThresh: 1.02,
    exposure: underwater ? 0.85 : 1.0,
    vignette: 0.30 + insanity*0.35 + hurt*0.2,
    grain: 0.030 + insanity*0.05,
    chroma: insanity*0.8,
    under: underwater ? 1 : 0,
    sat: 1 - insanity*0.35 - (survival && survival.vitamin < 30 ? (1-survival.vitamin/30)*0.4 : 0),
    warp: insanity,
    flash: sky.flash*0.30*storm + (strikes ? strikes.flash*0.55 : 0),
    rain: storm > 0.42 ? (storm-0.42)*1.5 : 0,
    tint,
    sunUv, sunAmt: sunVisible ? 0.5*(1-storm*0.8)*Math.max(0, sunDir.y+0.15) : 0,
    rays: gov.rays,
  });

  ui.setFx({
    vignette: state === 'play' ? Math.max(0, insanity*0.25) : 0,
    damage: hurt*0.7 + (survival && survival.hurtT > 0 ? 0.25 : 0),
  });
}

boot();
frame();

// expose a little for tinkering from the console
window.MARE = { scene, camera, renderer, field, ocean, sky, gov, THREE,
  get player(){return player;}, get ship(){return playerShip;},
  get fleet(){return fleet;}, get world(){return world;},
  get strikes(){return strikes;}, get mode(){return mode;}, get state(){return state;},
  get quest(){return quest;}, get survival(){return survival;}, get wind(){return wind;},
  get weather(){return weather;}, get atmos(){return atmos;},
  get runSeed(){return runSeed;}, reseedWorld, worldSeed, get gulls(){return gulls;},
  get character(){return character;}, get cardio(){return cardio;}, knows, describeCharacter,
  get vision(){return vision;}, post,
  // two-player handles, mostly so a session can be driven from a console
  startMode, get net(){return net;}, get session(){return session;},
  get pilot(){return pilotSeat;}, hostGame, joinGame, acceptAnswer, leaveSession,
  get hour(){return hour;}, set hour(v){hour = v;} };
