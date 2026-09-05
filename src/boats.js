import * as THREE from 'three';
import { makeBarrel } from './islands.js';

/* ────────────────────────────────────────────────────────────────
   A caique. The hull is generated station by station, then floated
   with per-probe buoyancy against the same wave field the shader
   draws, so it really does sit in the water rather than on it.
   ──────────────────────────────────────────────────────────────── */

const RHO = 1025;          // kg/m³, seawater
const RHO_AIR = 1.225;     // kg/m³, air — drives the sail
const G = 9.81;

// Hull form-drag coefficients (quadratic, ½ρCdA·v|v|), standing in for a real
// resistance curve: broadside is a bluff flat-plate-ish shape (and carries the
// keel's job, since there's no separate keel model), fore-aft is slender and
// slips through easily, and heave picks up extra so waves aren't fought by
// added mass and righting stiffness alone.
// A displacement hull's resistance is mostly wave-making, not form drag, so
// the fore-and-aft coefficient is far lower than a bluff-body figure would
// suggest — calibrated to put her at hull speed in a working breeze.
const CD_LAT = 1.1, CD_FWD = 0.055, CD_HEAVE = 1.7;

// Sail aerodynamics: a simple lift/drag polar. Lift peaks at AOA_OPT and has
// mostly separated (stalled) flow past AOA_STALL; drag rises through both.
const AOA_OPT = 0.34;      // ~20°, best angle of attack before the sail stalls
const AOA_STALL = 0.68;    // ~39°, lift peaks here and starts falling off
const CL_MAX = 1.35, CD0_SAIL = 0.05, CD_MAX_SAIL = 1.8;
const BOOM_MAX = 1.35;     // ~77°, the shrouds stop the boom going further out

// Rudder: a small lift-generating blade, not a paddle.
const RUDDER_MAX = 0.61;   // ±35°, the physical stop on the tiller

function hullHalfWidth(t, beam){           // t: -1 stern … +1 bow
  const a = Math.max(0, 1 - t*t);
  return beam*0.5*Math.pow(a, 0.40)*(1 - 0.52*Math.pow(Math.max(t,0), 2.6))*(1 - 0.16*Math.pow(Math.max(-t,0),2));
}
function sheerHeight(t, free){             // deck edge rises fore and aft
  return free*(1 + 0.55*t*t + 0.30*Math.max(t,0)**3);
}

export function buildHull({ length = 13, beam = 4.1, draft = 1.35, free = 1.05,
                            hullColor = 0xf2efe6, stripe = 0x1f6f9c, boot = 0x8f3a2e } = {}){
  const NS = 26, NR = 22;
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();
  const cHull = new THREE.Color(hullColor), cStripe = new THREE.Color(stripe), cBoot = new THREE.Color(boot);

  for(let i = 0; i <= NS; i++){
    const t = (i/NS)*2 - 1;
    const hw = hullHalfWidth(t, beam) + 0.02;
    const sh = sheerHeight(t, free);
    const dr = draft*(1 - 0.35*Math.pow(Math.abs(t),2.4));
    for(let j = 0; j <= NR; j++){
      const s = (j/NR)*2 - 1;                       // -1 port sheer … +1 starboard sheer
      const as = Math.abs(s);
      const x = hw*Math.sign(s)*Math.pow(as, 0.72);
      const y = sh - (sh + dr)*(1 - Math.pow(as, 1.85));
      pos.push(x, y, t*length*0.5);
      if(y > free*0.55) c.copy(cHull);
      else if(y > -0.05) c.copy(cStripe).lerp(cHull, THREE.MathUtils.clamp((y)/ (free*0.55),0,1)*0.35);
      else c.copy(cBoot);
      col.push(c.r, c.g, c.b);
    }
  }
  for(let i = 0; i < NS; i++)
    for(let j = 0; j < NR; j++){
      const a = i*(NR+1)+j, b = a+1, d = a+NR+1, e = d+1;
      idx.push(a,d,b, b,d,e);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col,3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function deckGeometry(length, beam, free){
  const NS = 26;
  const pos = [], idx = [];
  for(let i = 0; i <= NS; i++){
    const t = (i/NS)*2 - 1;
    const hw = hullHalfWidth(t, beam)*0.94;
    const sh = sheerHeight(t, free);
    pos.push(-hw, sh-0.06, t*length*0.5);
    pos.push( hw, sh-0.06, t*length*0.5);
  }
  for(let i = 0; i < NS; i++){
    const a = i*2, b = a+1, c2 = a+2, d = a+3;
    idx.push(a,c2,b, b,c2,d);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export class Ship {
  constructor(scene, field, opts = {}){
    this.field = field;
    this.length = opts.length || 13;
    this.beam = opts.beam || 4.1;
    this.draft = opts.draft || 1.35;
    this.free = opts.free || 1.05;
    this.mass = opts.mass || 5200;
    this.player = !!opts.player;

    this.pos = new THREE.Vector3(opts.x || 0, 0, opts.z || 0);
    this.quat = new THREE.Quaternion();
    this.vel = new THREE.Vector3();
    this.angVel = new THREE.Vector3();
    this.rudder = 0;         // −1 … 1
    this.sail = 0.55;        // 0 furled … 1 full
    this.sailAngle = 0;      // radians from centreline
    this.rigForce = opts.rigForce ?? 1.15;   // rig efficiency/sail-plan multiplier, ~1 for one working sail
    this.rightingGM = opts.rightingGM ?? 1.25;
    this.rollDamping = opts.rollDamping ?? 5.2;
    this.heading = opts.heading || 0;
    this.quat.setFromAxisAngle(new THREE.Vector3(0,1,0), this.heading);
    // these are produced by step(); seed them so anything that steers on the
    // first frame (the fleet autopilot) has real numbers to work with
    this.headingAngle = this.heading;
    this.fwdSpeed = 0; this.submersion = 0; this.driveAmount = 0;

    // inertia of an equivalent box (x: pitch axis, y: yaw axis, z: roll axis)
    const L = this.length, B = this.beam, H = this.draft + this.free;
    this.I = new THREE.Vector3(
      this.mass/12*(H*H + L*L),
      this.mass/12*(B*B + L*L),
      this.mass/12*(B*B + H*H)
    );

    // Added mass: an accelerating hull drags a comparable mass of water along
    // with it. Sway and heave shove a lot of water aside/underneath (added
    // mass close to the hull's own displacement); surge barely disturbs
    // anything ahead of a slender bow. Strip-theory ballparks, not measured —
    // but anisotropic added mass, even approximate, is what actually fixes a
    // hull that used to snap upright or sideways far too sharply.
    this.addedMass = new THREE.Vector3(this.mass*0.75, this.mass*0.85, this.mass*0.10);
    this.addedI = new THREE.Vector3(this.I.x*0.55, this.I.y*0.08, this.I.z*0.30);

    // Sail area from the same proportions build() cuts the sail mesh to — a
    // triangular lateen is roughly half its bounding rectangle.
    const mastH = this.length*0.95;
    this.sailArea = 0.5*(this.length*0.60)*(mastH*0.62);

    this.group = new THREE.Group();
    this.build(opts);
    scene.add(this.group);

    // buoyancy probes spread over the wetted surface
    this.probes = [];
    const NSp = opts.probesLong || (this.player ? 9 : 6);
    const NBp = opts.probesLat || 3;
    for(let i = 0; i < NSp; i++){
      const t = -1 + 2*(i+0.5)/NSp;
      const hw = hullHalfWidth(t, this.beam);
      for(let j = 0; j < NBp; j++){
        const s = NBp === 1 ? 0 : -1 + 2*j/(NBp-1);
        this.probes.push(new THREE.Vector3(hw*s*0.78, -this.draft*0.55, t*this.length*0.5));
      }
    }
    // total displaced volume shared across probes, tuned so she floats on her lines
    this.probeVol = (this.mass/RHO)*1.9/this.probes.length;
    // per-probe share of the hull's profile area on each axis, for the
    // quadratic form-drag term in step() — derived from hull dimensions
    // rather than a flat fitted constant
    const nP = this.probes.length;
    this.dragArea = new THREE.Vector3(
      (this.draft*this.length*0.7)/nP,   // x: broadside (keel-like) profile
      (this.beam*this.length*0.7)/nP,    // y: waterplane-ish area resisting heave
      (this.draft*this.beam*0.5)/nP      // z: bow/stern frontal area — slender
    );

    this._v = new THREE.Vector3(); this._w = new THREE.Vector3();
    this._f = new THREE.Vector3(); this._lev = new THREE.Vector3();
    this._p = new THREE.Vector3(); this._rel = new THREE.Vector3();
    this._wp = new THREE.Vector3(); this._pv = new THREE.Vector3();
    this._fwd = new THREE.Vector3(); this._ax = new THREE.Vector3();
    this._dq = new THREE.Quaternion(); this._invQ = new THREE.Quaternion();
    this._acc = { force:new THREE.Vector3(), torque:new THREE.Vector3() };
    this._s = {};
    this.spray = this.makeSpray(scene);
    this.speed = 0;
    this.accel = new THREE.Vector3();
    this.prevVel = new THREE.Vector3();
  }

  build(opts){
    const hull = new THREE.Mesh(buildHull({
      length:this.length, beam:this.beam, draft:this.draft, free:this.free,
      hullColor:opts.hullColor, stripe:opts.stripe, boot:opts.boot }),
      new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.72, metalness:0.02, side:THREE.DoubleSide }));
    hull.castShadow = true; hull.receiveShadow = true;
    this.group.add(hull);

    const wood = new THREE.MeshStandardMaterial({color:0xb08957, roughness:0.85});
    const dark = new THREE.MeshStandardMaterial({color:0x6d5334, roughness:0.9});
    const deck = new THREE.Mesh(deckGeometry(this.length, this.beam, this.free), wood);
    deck.receiveShadow = true; deck.castShadow = false;
    this.group.add(deck);
    this.deckMesh = deck;

    // rail
    const railPts = [];
    const NS = 24;
    for(let i = 0; i <= NS; i++){
      const t = -1 + 2*i/NS;
      railPts.push(new THREE.Vector3(hullHalfWidth(t,this.beam)*0.96, sheerHeight(t,this.free)+0.10, t*this.length*0.5));
    }
    for(let i = NS; i >= 0; i--){
      const t = -1 + 2*i/NS;
      railPts.push(new THREE.Vector3(-hullHalfWidth(t,this.beam)*0.96, sheerHeight(t,this.free)+0.10, t*this.length*0.5));
    }
    const rail = new THREE.Mesh(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(railPts, true), 140, 0.065, 6, true), dark);
    rail.castShadow = true;
    this.group.add(rail);

    // mast, boom, lateen yard
    const mastH = this.length*0.95;
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.10,0.15,mastH,10), wood);
    mast.position.set(0, this.free + mastH/2 - 0.2, this.length*0.10);
    mast.castShadow = true;
    this.group.add(mast);
    this.mastTop = mastH + this.free - 0.2;

    this.rig = new THREE.Group();
    this.rig.position.set(0, this.free + 1.1, this.length*0.10);
    this.group.add(this.rig);

    const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.07,0.07,this.length*0.62,8), wood);
    boom.rotation.x = Math.PI/2;
    boom.position.set(0, 0, -this.length*0.26);
    boom.castShadow = true;
    this.rig.add(boom);

    const sailGeo = new THREE.PlaneGeometry(this.length*0.60, mastH*0.62, 12, 10);
    sailGeo.rotateY(Math.PI/2);
    sailGeo.translate(0, mastH*0.31, -this.length*0.26);
    this.sailGeo = sailGeo;
    this.sailBase = sailGeo.attributes.position.array.slice();
    this.sailMesh = new THREE.Mesh(sailGeo, new THREE.MeshStandardMaterial({
      color:0xf6f0e2, roughness:0.92, side:THREE.DoubleSide, transparent:true, opacity:0.97 }));
    this.sailMesh.castShadow = true;
    this.rig.add(this.sailMesh);

    // cabin + tiller aft
    const cabin = new THREE.Mesh(new THREE.BoxGeometry(this.beam*0.52, 0.95, this.length*0.18), wood);
    cabin.position.set(0, this.free + 0.42, -this.length*0.30);
    cabin.castShadow = cabin.receiveShadow = true;
    this.group.add(cabin);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(this.beam*0.58, 0.10, this.length*0.21),
      new THREE.MeshStandardMaterial({color:0x2a6ea8, roughness:0.8}));
    roof.position.set(0, this.free + 0.95, -this.length*0.30);
    roof.castShadow = true;
    this.group.add(roof);

    this.tiller = new THREE.Group();
    this.tiller.position.set(0, this.free + 0.35, -this.length*0.44);
    const stick = new THREE.Mesh(new THREE.CylinderGeometry(0.05,0.06,1.5,8), dark);
    stick.rotation.x = Math.PI/2 - 0.18; stick.position.z = 0.72;
    this.tiller.add(stick);
    this.group.add(this.tiller);

    if(this.player) this.addProps();
  }

  addProps(){
    const P = (obj, x, y, z) => { obj.position.set(x, this.free + y, z); this.group.add(obj); return obj; };
    this.props = {};
    this.props.water = P(makeBarrel(0x5c7f8a), -1.05, 0.46, -0.9);
    this.props.food  = P(makeBarrel(0x7a5433),  1.05, 0.46, -0.9);
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.8,0.6,0.8),
      new THREE.MeshStandardMaterial({color:0x8a6a42, roughness:0.9}));
    crate.castShadow = crate.receiveShadow = true;
    this.props.citrus = P(crate, -1.0, 0.30, 1.6);
    const lemons = new THREE.Group();
    for(let i = 0; i < 7; i++){
      const l = new THREE.Mesh(new THREE.SphereGeometry(0.09,8,6),
        new THREE.MeshStandardMaterial({color:0xe8c445, roughness:0.6}));
      l.position.set((Math.random()-0.5)*0.5, 0.33 + Math.random()*0.06, (Math.random()-0.5)*0.5);
      lemons.add(l);
    }
    crate.add(lemons);

    // the logbook, on a small table by the tiller
    const table = new THREE.Mesh(new THREE.BoxGeometry(0.9,0.06,0.6),
      new THREE.MeshStandardMaterial({color:0x8b6b45, roughness:0.85}));
    P(table, 1.0, 0.80, -2.6);
    const book = new THREE.Mesh(new THREE.BoxGeometry(0.34,0.07,0.26),
      new THREE.MeshStandardMaterial({color:0x6b3f2a, roughness:0.75}));
    book.position.set(0, 0.07, 0);
    book.castShadow = true;
    table.add(book);
    this.props.logbook = book;
    this.logbookWorld = new THREE.Vector3();

    // coil of rope + a lamp on the mast
    const rope = new THREE.Mesh(new THREE.TorusGeometry(0.26,0.055,6,16),
      new THREE.MeshStandardMaterial({color:0xc9b48a, roughness:1}));
    rope.rotation.x = Math.PI/2;
    P(rope, -1.4, 0.06, 2.6);
    this.lamp = new THREE.PointLight(0xffb85c, 0, 34, 1.5);
    this.lamp.position.set(0, this.free + 2.2, this.length*0.10);
    this.group.add(this.lamp);
    const lantern = new THREE.Mesh(new THREE.BoxGeometry(0.22,0.30,0.22),
      new THREE.MeshStandardMaterial({color:0x2a2a2a, roughness:0.6, emissive:0xffb85c, emissiveIntensity:0}));
    lantern.position.copy(this.lamp.position);
    this.group.add(lantern);
    this.lantern = lantern;
  }

  makeSpray(scene){
    const N = 260;
    const g = new THREE.BufferGeometry();
    const p = new Float32Array(N*3);
    g.setAttribute('position', new THREE.BufferAttribute(p,3));
    const m = new THREE.PointsMaterial({ color:0xffffff, size:0.20, transparent:true, opacity:0.55,
      depthWrite:false, sizeAttenuation:true });
    const pts = new THREE.Points(g, m);
    pts.frustumCulled = false;
    scene.add(pts);
    this.sprayData = [];
    for(let i = 0; i < N; i++) this.sprayData.push({ p:new THREE.Vector3(), v:new THREE.Vector3(), life:0 });
    return pts;
  }

  /* Is this body-space point over the deck? */
  onDeck(x, z){
    const t = THREE.MathUtils.clamp(z/(this.length*0.5), -1, 1);
    const hw = hullHalfWidth(t, this.beam)*0.90;
    return Math.abs(x) < hw && Math.abs(z) < this.length*0.5*0.97;
  }
  deckY(x, z){
    const t = THREE.MathUtils.clamp(z/(this.length*0.5), -1, 1);
    return sheerHeight(t, this.free) - 0.06;
  }

  /* f: force in world space, rel: application point relative to the centre of mass */
  applyForce(f, rel, out){
    out.force.add(f);
    this._lev.copy(rel).cross(f);
    out.torque.add(this._lev);
  }

  /* Put a newly launched hull on its waterline instead of dropping a level,
     motionless body into an already moving slope. The optional stability
     values let rough modes start reefed without changing fleet handling. */
  settleAtSurface({ sail = this.sail, rigForce = this.rigForce,
                    rightingGM = this.rightingGM, rollDamping = this.rollDamping } = {}){
    if(Number.isFinite(sail)) this.sail = THREE.MathUtils.clamp(sail, 0, 1);
    if(Number.isFinite(rigForce) && rigForce >= 0) this.rigForce = rigForce;
    if(Number.isFinite(rightingGM) && rightingGM >= 0) this.rightingGM = rightingGM;
    if(Number.isFinite(rollDamping) && rollDamping >= 0) this.rollDamping = rollDamping;

    // Fit the deck's up axis to the mean wave normal under the whole hull.
    this.quat.setFromAxisAngle(this._ax.set(0,1,0), this.heading);
    const n = this._f.set(0,0,0);
    for(const local of this.probes){
      this._rel.copy(local).applyQuaternion(this.quat);
      this.field.sample(this.pos.x + this._rel.x, this.pos.z + this._rel.z, this._s);
      n.x += this._s.nx; n.y += this._s.ny; n.z += this._s.nz;
    }
    if(n.lengthSq() > 1e-8){
      n.normalize();
      this._dq.setFromUnitVectors(this._v.set(0,1,0), n);
      this.quat.premultiply(this._dq).normalize();
    }

    // At rest, probeVol makes equilibrium submersion exactly 1/1.9.
    // Re-sample after tilting because each probe's vertical lever changed.
    const targetDepth = this.draft*0.9/1.9;
    let y = 0, vx = 0, vy = 0, vz = 0;
    for(const local of this.probes){
      this._rel.copy(local).applyQuaternion(this.quat);
      this.field.sample(this.pos.x + this._rel.x, this.pos.z + this._rel.z, this._s);
      y += this._s.y - this._rel.y - targetDepth;
      vx += this._s.vx; vy += this._s.vy; vz += this._s.vz;
    }
    const invN = 1/this.probes.length;
    this.pos.y = y*invN;
    this.vel.set(vx*invN, vy*invN, vz*invN);
    this.angVel.set(0,0,0);
    this.prevVel.copy(this.vel); this.accel.set(0,0,0);
    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
    return this;
  }

  step(dt, wind){
    const acc = this._acc;
    acc.force.set(0,0,0); acc.torque.set(0,0,0);
    const s = this._s;

    acc.force.y -= this.mass*G;

    const invQ = this._invQ;
    invQ.copy(this.quat).invert();
    let submerged = 0;

    // Wave-making resistance: a displacement hull digs into the trough of its
    // own bow wave as it nears hull speed, and resistance climbs steeply.
    // Without this she just keeps accelerating in a gale.
    const vHull = 1.25*Math.sqrt(this.length);
    const froude = Math.abs(this.fwdSpeed)/vHull;
    const wave = 1 + 9*Math.pow(Math.max(0, froude - 0.78), 2);

    const rel = this._rel, wp = this._wp, f = this._f, pv = this._pv;
    for(const local of this.probes){
      rel.copy(local).applyQuaternion(this.quat);
      wp.copy(rel).add(this.pos);
      this.field.sample(wp.x, wp.z, s);
      const depth = (s.y - wp.y);
      if(depth <= 0) continue;
      const sub = THREE.MathUtils.clamp(depth/(this.draft*0.9), 0, 1);
      submerged += sub;

      // buoyancy, tipped along the water's own normal a little so she surfs
      f.set(s.nx*0.30, 1, s.nz*0.30).normalize()
       .multiplyScalar(RHO*G*this.probeVol*sub);
      this.applyForce(f, rel, acc);

      // velocity of this point of the hull, relative to the water moving past it
      pv.copy(this.angVel).cross(rel).add(this.vel);
      pv.x -= s.vx; pv.y -= s.vy; pv.z -= s.vz;
      f.copy(pv).applyQuaternion(invQ);
      // quadratic form drag per body axis, ½ρCdA·v|v| — lateral resistance is
      // what actually lets her sail to windward (there's no separate keel);
      // fore-aft slips easily; heave drag damps wave response directly
      // instead of leaning on added mass and the righting term alone
      f.set(
        -0.5*RHO*CD_LAT  *this.dragArea.x*Math.abs(f.x)*f.x,
        -0.5*RHO*CD_HEAVE*this.dragArea.y*Math.abs(f.y)*f.y,
        -0.5*RHO*CD_FWD*wave*this.dragArea.z*Math.abs(f.z)*f.z
      ).multiplyScalar(sub);
      f.applyQuaternion(this.quat);
      this.applyForce(f, rel, acc);
    }
    this.submersion = submerged/this.probes.length;

    // ── rig ────────────────────────────────────────────────────
    const fwd = this._fwd.set(0,0,1).applyQuaternion(this.quat);
    const heading = Math.atan2(fwd.x, fwd.z);
    this.headingAngle = heading;

    // Apparent wind — what the sail actually feels — is true wind minus the
    // boat's own velocity. This alone changes behaviour on every point of
    // sail: beating to weather, the apparent wind swings forward and
    // strengthens as she speeds up; running, it drops away behind her.
    const aw = this._v.set(wind.x - this.vel.x, 0, wind.z - this.vel.z);
    const awSpeed = aw.length();
    // angle between the direction the apparent wind blows and the way the bow
    // points: 0 = wind dead astern (running), ±π = sailing straight into it
    const windRel = Math.atan2(aw.x, aw.z) - heading;
    const relN = Math.atan2(Math.sin(windRel), Math.cos(windRel));
    this.pointOfSail = relN;
    // the bearing the wind is blowing FROM, relative to the bow, signed by
    // which side it's on (0 = head to wind, ±π = dead run)
    const psi = Math.atan2(Math.sin(relN + Math.PI), Math.cos(relN + Math.PI));

    // Which side is leeward: the side the apparent wind has a component
    // toward, in the boat's own lateral axis. Everything below — boom trim
    // and which way lift pushes — is keyed off this one sign so they agree.
    const bx = this._ax.set(1,0,0).applyQuaternion(this.quat);
    const leewardSign = Math.sign(aw.x*bx.x + aw.z*bx.z) || 1;

    // Trim the boom toward the sail's best angle of attack until the shrouds
    // stop it going further out. Past that the sail can't hold its optimum
    // incidence any more and the angle of attack grows on its own — which is
    // exactly why a run is slower than a reach, without a special case for it.
    const trimTarget = leewardSign*THREE.MathUtils.clamp(Math.abs(psi) - AOA_OPT, 0, BOOM_MAX);
    this.sailAngle += (trimTarget - this.sailAngle)*Math.min(1, dt*2.2);
    const AoA = Math.max(0, Math.abs(psi) - Math.abs(this.sailAngle));

    // Lift/drag polar: lift rises to a peak at AOA_STALL then falls away as
    // flow separates; drag rises through the same range and dominates once
    // stalled (a stalled sail is just a sheet of cloth dragged by the wind).
    const clShape = AoA < AOA_STALL
      ? Math.sin(AoA/AOA_STALL*Math.PI/2)
      : Math.cos(Math.min(1, (AoA-AOA_STALL)/(Math.PI/2-AOA_STALL))*Math.PI/2);
    const Cl = CL_MAX*clShape;
    const Cd = CD0_SAIL + (CD_MAX_SAIL-CD0_SAIL)*Math.sin(AoA)*Math.sin(AoA);

    const q = 0.5*RHO_AIR*awSpeed*awSpeed;
    this.driveAmount = (Cl+Cd)*this.sail;   // sail-billow visual only, see update()

    // Drag acts along the apparent wind (downwind); lift acts perpendicular
    // to it, toward leeward. Applied at the centre of effort, above the
    // hull's lateral resistance, this is what actually makes her heel.
    const invAw = awSpeed > 1e-4 ? 1/awSpeed : 0;
    const dHatX = aw.x*invAw, dHatZ = aw.z*invAw;
    let perpX = dHatZ, perpZ = -dHatX;
    if(Math.sign(perpX*bx.x + perpZ*bx.z) !== leewardSign){ perpX = -perpX; perpZ = -perpZ; }
    // The rig is in the air, so only a hull that is swamping should lose its
    // drive — a boat floating on her lines must get all of it.
    const rigScale = q*this.sailArea*this.sail*this.rigForce
                     *Math.min(1, this.submersion*1.9);
    const Flift = rigScale*Cl, Fdrag = rigScale*Cd;
    const rigRel = this._rel.set(0, this.mastTop*0.45, this.length*0.10).applyQuaternion(this.quat);
    f.set(perpX*Flift + dHatX*Fdrag, 0, perpZ*Flift + dHatZ*Fdrag);
    this.applyForce(f, rigRel, acc);

    // ── rudder ─────────────────────────────────────────────────
    const fwdSpeed = this.vel.dot(fwd);
    this.fwdSpeed = fwdSpeed;
    const rudRel = this._rel.set(0, -this.draft*0.6, -this.length*0.48).applyQuaternion(this.quat);
    // a small lift-generating blade: force ∝ ½ρClA·v² with Cl from the same
    // sin(2·angle) shape a stalling foil follows — it just never reaches the
    // falling part of that curve because the tiller physically stops at ±35°
    const rudCl = Math.sin(2*this.rudder*RUDDER_MAX);
    const rudArea = this.draft*this.beam*0.10;
    f.set(1,0,0).applyQuaternion(this.quat)
     .multiplyScalar(-0.5*RHO*rudCl*rudArea*fwdSpeed*Math.abs(fwdSpeed)*this.submersion*6.0);
    this.applyForce(f, rudRel, acc);

    // ── damping and integration ────────────────────────────────
    // The render origin is above the ballast/keel centre, so represent its
    // metacentric righting moment explicitly. Probe buoyancy alone loses its
    // lever abruptly on steep crests and can leave the hull stable upside-down.
    const up = this._v.set(0,1,0).applyQuaternion(this.quat);
    acc.torque.add(this._lev.set(-up.z, 0, up.x).multiplyScalar(this.mass*G*this.rightingGM));
    acc.force.addScaledVector(this.vel, -this.mass*0.02);
    // Strong roll/pitch damping need not make the rudder's yaw response syrupy.
    f.copy(this.angVel).applyQuaternion(invQ);
    f.set(f.x*this.rollDamping, f.y*0.85, f.z*this.rollDamping)
     .applyQuaternion(this.quat).multiplyScalar(-this.mass);
    acc.torque.add(f);

    // Linear: convert to body axes so added mass can be anisotropic (heave
    // and sway drag far more water along than surge does) before integrating.
    const fb = this._v.copy(acc.force).applyQuaternion(invQ);
    fb.x /= (this.mass + this.addedMass.x);
    fb.y /= (this.mass + this.addedMass.y);
    fb.z /= (this.mass + this.addedMass.z);
    fb.applyQuaternion(this.quat);
    this.vel.addScaledVector(fb, dt);

    // torque → angular acceleration through the body-space inertia, inflated
    // by added inertia (pitch picks up the most — it's coupled to heave at
    // the bow and stern; yaw barely moves any extra water at all)
    const w = this._w.copy(acc.torque).applyQuaternion(invQ);
    w.set(w.x/(this.I.x+this.addedI.x), w.y/(this.I.y+this.addedI.y), w.z/(this.I.z+this.addedI.z));
    w.applyQuaternion(this.quat);
    this.angVel.addScaledVector(w, dt);

    const maxW = 1.4;
    if(this.angVel.length() > maxW) this.angVel.setLength(maxW);

    // a diverging hull would poison every consumer of its transform, so trap it
    if(!Number.isFinite(this.vel.x + this.vel.y + this.vel.z + this.angVel.x + this.angVel.y + this.angVel.z)){
      this.vel.set(0,0,0); this.angVel.set(0,0,0);
      if(!Number.isFinite(this.pos.x + this.pos.y + this.pos.z)) this.pos.set(0, 0, 0);
      this.quat.setFromAxisAngle(this._ax.set(0,1,0), this.heading);
      return;
    }

    this.pos.addScaledVector(this.vel, dt);
    const wl = this.angVel.length();
    if(wl > 1e-5){
      this._ax.copy(this.angVel).divideScalar(wl);
      this._dq.setFromAxisAngle(this._ax, wl*dt);
      this.quat.premultiply(this._dq).normalize();
    }
  }

  /* An instantaneous kick — a blast wave, a grounding, a wave slamming home.
     Added mass resists a shove just as it resists any other acceleration, so
     this goes through the same anisotropic effective mass/inertia as step(). */
  impulse(worldF, atWorld){
    const inv = this._invQ.copy(this.quat).invert();
    const fb = this._v.copy(worldF).applyQuaternion(inv);
    fb.x /= (this.mass+this.addedMass.x); fb.y /= (this.mass+this.addedMass.y); fb.z /= (this.mass+this.addedMass.z);
    fb.applyQuaternion(this.quat);
    this.vel.add(fb);
    this._rel.copy(atWorld).sub(this.pos).multiplyScalar(-1);
    this._lev.copy(this._rel).cross(worldF);
    this._w.copy(this._lev).applyQuaternion(inv);
    this._w.set(this._w.x/(this.I.x+this.addedI.x), this._w.y/(this.I.y+this.addedI.y), this._w.z/(this.I.z+this.addedI.z));
    this._w.applyQuaternion(this.quat);
    this.angVel.add(this._w);
    const wl = this.angVel.length();
    if(wl > 1.4) this.angVel.multiplyScalar(1.4/wl);
  }

  update(dt, wind, camPos){
    const sub = Math.min(4, Math.max(1, Math.ceil(dt/(1/140))));
    const h = dt/sub;
    this.prevVel.copy(this.vel);
    for(let i = 0; i < sub; i++) this.step(h, wind);
    this.accel.copy(this.vel).sub(this.prevVel).divideScalar(Math.max(dt,1e-4));
    this.speed = this.vel.length();

    this.group.position.copy(this.pos);
    this.group.quaternion.copy(this.quat);
    this.rig.rotation.y = this.sailAngle;
    this.tiller.rotation.y = -this.rudder*0.5;

    // billow the sail
    const p = this.sailGeo.attributes.position, base = this.sailBase;
    const bulge = THREE.MathUtils.clamp(this.driveAmount*0.35, 0.02, 1.0)*Math.sign(Math.cos(this.sailAngle)||1);
    const t = this.field.time;
    for(let i = 0; i < p.count; i++){
      const by = base[i*3+1], bz = base[i*3+2];
      const u = THREE.MathUtils.clamp((bz + this.length*0.26 + this.length*0.30)/(this.length*0.60), 0, 1);
      const v = THREE.MathUtils.clamp(by/(this.mastTop*0.62), 0, 1);
      const curve = Math.sin(u*Math.PI)*Math.sin(v*Math.PI*0.92);
      const flap = Math.sin(t*7 + u*6 + v*3)*0.06*(1 - Math.abs(bulge));
      p.array[i*3] = base[i*3] + (curve*bulge*0.9 + flap)*this.sail;
    }
    p.needsUpdate = true;
    this.sailMesh.scale.y = 0.28 + 0.72*this.sail;

    if(this.props) this.props.logbook.getWorldPosition(this.logbookWorld);
    this.updateSpray(dt, camPos);
  }

  updateSpray(dt, camPos){
    const arr = this.spray.geometry.attributes.position.array;
    const bow = this._p.set(0, 0, this.length*0.46).applyQuaternion(this.quat).add(this.pos);
    const near = !camPos || camPos.distanceToSquared(this.pos) < 40000;
    let emit = near ? Math.min(6, Math.floor(this.speed*this.speed*0.09)) : 0;
    for(let i = 0; i < this.sprayData.length; i++){
      const d = this.sprayData[i];
      if(d.life > 0){
        d.life -= dt;
        d.v.y -= 9.8*dt;
        d.p.addScaledVector(d.v, dt);
        if(d.p.y < this.field.height(d.p.x, d.p.z)) d.life = 0;
      } else if(emit > 0){
        emit--;
        d.p.copy(bow).add(new THREE.Vector3((Math.random()-0.5)*this.beam*0.7, -0.2+Math.random()*0.4, (Math.random()-0.4)*1.2));
        d.v.copy(this.vel).multiplyScalar(0.45);
        d.v.x += (Math.random()-0.5)*2.6; d.v.z += (Math.random()-0.5)*2.6;
        d.v.y += 1.4 + Math.random()*2.6;
        d.life = 0.6 + Math.random()*0.7;
      }
      const o = i*3;
      if(d.life > 0){ arr[o]=d.p.x; arr[o+1]=d.p.y; arr[o+2]=d.p.z; }
      else { arr[o]=0; arr[o+1]=-9999; arr[o+2]=0; }
    }
    this.spray.geometry.attributes.position.needsUpdate = true;
  }
}

/* ── other people's boats ───────────────────────────────────── */
const PALETTES = [
  { hullColor:0xf2efe6, stripe:0x1f6f9c, boot:0x8f3a2e },
  { hullColor:0xeae4d2, stripe:0xc4562f, boot:0x2f4858 },
  { hullColor:0xdfe6e8, stripe:0x2b8f6f, boot:0x7a3b2c },
  { hullColor:0xf0e2c8, stripe:0x9c3f5e, boot:0x38506b },
];

export class Fleet {
  constructor(scene, field, world, opts = {}){
    this.scene = scene; this.field = field; this.world = world;
    this.boats = [];
    this.max = opts.count || 6;
    this.radius = opts.radius || 1500;
  }

  spawn(around){
    const a = Math.random()*Math.PI*2;
    const r = this.radius*(0.55 + Math.random()*0.45);
    const pal = PALETTES[Math.floor(Math.random()*PALETTES.length)];
    const scale = 0.7 + Math.random()*0.7;
    const s = new Ship(this.scene, this.field, Object.assign({
      x: around.x + Math.cos(a)*r, z: around.z + Math.sin(a)*r,
      length: 10*scale + 3, beam: 3.4*scale + 0.6, draft: 1.1*scale + 0.2,
      mass: 3600*scale*scale, heading: Math.random()*Math.PI*2,
      probesLong: 6, probesLat: 3,
    }, pal));
    s.sailFull = 0.55 + Math.random()*0.45;   // what she'd carry in a soft breeze
    s.sail = s.sailFull;
    s.goal = new THREE.Vector3(around.x + (Math.random()-0.5)*3000, 0, around.z + (Math.random()-0.5)*3000);
    this.boats.push(s);
    return s;
  }

  update(dt, wind, around, camPos){
    // Other crews reef for the same reason you do, and are better at it.
    const carry = THREE.MathUtils.clamp(45/Math.max(1, wind.lengthSq()), 0.18, 1);
    while(this.boats.length < this.max) this.spawn(around);
    for(let i = this.boats.length-1; i >= 0; i--){
      const b = this.boats[i];
      const d = Math.hypot(b.pos.x-around.x, b.pos.z-around.z);
      if(d > this.radius*1.9){
        this.scene.remove(b.group); this.scene.remove(b.spray);
        b.group.traverse(o=>{ if(o.isMesh){ o.geometry.dispose?.(); } });
        this.boats.splice(i,1);
        continue;
      }
      // autopilot: steer for the waypoint, avoid running aground
      const toGoal = Math.atan2(b.goal.x-b.pos.x, b.goal.z-b.pos.z);
      const near = this.world.nearest(b.pos.x, b.pos.z);
      let want = toGoal;
      if(near.dist < 130){
        const away = Math.atan2(b.pos.x-near.island.pos.x, b.pos.z-near.island.pos.z);
        want = away;
      }
      let err = want - b.headingAngle;
      err = Math.atan2(Math.sin(err), Math.cos(err));
      b.rudder = THREE.MathUtils.clamp(-err*1.6, -1, 1);
      if(Math.hypot(b.goal.x-b.pos.x, b.goal.z-b.pos.z) < 120 || Math.random() < dt*0.02){
        b.goal.set(around.x + (Math.random()-0.5)*3200, 0, around.z + (Math.random()-0.5)*3200);
      }
      b.sail = Math.min(b.sailFull ?? b.sail, carry);
      b.update(dt, wind, camPos);
    }
  }
}
