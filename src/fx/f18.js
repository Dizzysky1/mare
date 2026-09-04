import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   Procedural F/A-18 Hornet. Nose along +Z, up +Y, right wing +X.
   Everything the player will actually resolve at 200m+ is silhouette:
   the canted twin tails, the LERX sweeping into the cockpit, the
   trapezoid wing. So geometry is built once at module scope and
   shared across every instance — repeated buildF18() calls just add
   new Mesh wrappers (and the handful of parts that need independent
   motion: control surfaces, burners, pylons).
   ──────────────────────────────────────────────────────────────── */

const L = 17.1, HALF = L*0.5;
const SPAN = 12.3;

/* ── fuselage loft ──────────────────────────────────────────────
   station table: t (-1 tail … 1 nose), half-width, height above and
   below the centreline. Radome tapers to a point, tail pinches down
   to the slim boat-tail between the two nacelles. */
const FUS_STATIONS = [
  [-1.00, 0.20, 0.20, 0.18],
  [-0.82, 0.34, 0.32, 0.26],
  [-0.55, 0.60, 0.46, 0.36],
  [-0.20, 0.88, 0.58, 0.44],
  [ 0.05, 1.00, 0.60, 0.46],
  [ 0.30, 0.94, 0.60, 0.42],
  [ 0.50, 0.74, 0.56, 0.36],
  [ 0.68, 0.54, 0.50, 0.30],
  [ 0.84, 0.30, 0.30, 0.22],
  [ 1.00, 0.02, 0.02, 0.02],
];
function fuselageAt(t){
  for(let i = 1; i < FUS_STATIONS.length; i++){
    const a = FUS_STATIONS[i-1], b = FUS_STATIONS[i];
    if(t <= b[0]){
      const f = (t-a[0])/(b[0]-a[0]);
      return { hw: THREE.MathUtils.lerp(a[1],b[1],f), hTop: THREE.MathUtils.lerp(a[2],b[2],f), hBot: THREE.MathUtils.lerp(a[3],b[3],f) };
    }
  }
  const l = FUS_STATIONS[FUS_STATIONS.length-1];
  return { hw:l[1], hTop:l[2], hBot:l[3] };
}
function fusPoint(a, hw, hTop, hBot){
  const cx = Math.cos(a), sy = Math.sin(a);
  const x = hw*Math.sign(cx)*Math.pow(Math.abs(cx), 0.85);
  const hh = sy >= 0 ? hTop : hBot;
  const y = hh*Math.sign(sy)*Math.pow(Math.abs(sy), sy >= 0 ? 0.85 : 1.3);
  return [x, y];
}
function buildFuselage(){
  const NS = 16, NR = 14;
  const pos = [], col = [], idx = [];
  const cAir = new THREE.Color(0x6f767d), cPanel = new THREE.Color(0x5b6268), cRadome = new THREE.Color(0x4a5055);
  const c = new THREE.Color();
  for(let i = 0; i <= NS; i++){
    const t = (i/NS)*2 - 1;
    const st = fuselageAt(t);
    const z = t*HALF;
    for(let j = 0; j <= NR; j++){
      const a = (j/NR)*Math.PI*2;
      const [x, y] = fusPoint(a, st.hw, st.hTop, st.hBot);
      pos.push(x, y, z);
      c.copy(cAir);
      if(t > 0.74) c.lerp(cRadome, THREE.MathUtils.clamp((t-0.74)/0.22, 0, 1));
      const top = Math.sin(a);                       // dorsal spine accent
      if(top > 0.55 && t < 0.65 && t > -0.85) c.lerp(cPanel, (top-0.55)/0.45*0.5);
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

/* ── flat-panel helpers for wings, tails, LERX, control surfaces ──
   outline is a simple polygon (fan-triangulates fine for our convex
   trapezoids); panelGeometry extrudes along Y (horizontal surfaces),
   finGeometry along X (vertical surfaces). DoubleSide materials mean
   winding direction never costs us a disappearing face. */
function capAndWalls(n){
  const idx = [];
  for(let i = 1; i < n-1; i++) idx.push(0, i, i+1);
  for(let i = 1; i < n-1; i++) idx.push(n, n+i+1, n+i);
  for(let i = 0; i < n; i++){
    const a = i, b = (i+1)%n, c = n+i, d = n+((i+1)%n);
    idx.push(a,b,d, a,d,c);
  }
  return idx;
}
function panelGeometry(outline, thickness){
  const h = thickness*0.5, pos = [];
  for(const [x,z] of outline) pos.push(x, h, z);
  for(const [x,z] of outline) pos.push(x, -h, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setIndex(capAndWalls(outline.length));
  g.computeVertexNormals();
  return g;
}
function finGeometry(outline, thickness){
  const h = thickness*0.5, pos = [];
  for(const [z,y] of outline) pos.push(h, y, z);
  for(const [z,y] of outline) pos.push(-h, y, z);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos,3));
  g.setIndex(capAndWalls(outline.length));
  g.computeVertexNormals();
  return g;
}

/* wing planform in absolute aircraft space (right side; left is a
   mirrored clone). LE sweep ~26°, TE nearly straight. */
const WING_ROOT_X = 0.85, WING_TIP_X = 6.15;
const WING_OUTLINE = [[WING_ROOT_X,1.7],[WING_TIP_X,-1.0],[WING_TIP_X,-1.9],[WING_ROOT_X,-2.2]];
const WING_Y = 0.12, WING_THICK = 0.22;
function wingLE(x){ return THREE.MathUtils.lerp(1.7, -1.0, (x-WING_ROOT_X)/(WING_TIP_X-WING_ROOT_X)); }
function wingTE(x){ return THREE.MathUtils.lerp(-2.2, -1.9, (x-WING_ROOT_X)/(WING_TIP_X-WING_ROOT_X)); }

const LERX_OUTLINE = [[0.85,1.6],[0.55,5.0],[0.62,2.1]];   // sweeps from wing root to beside the cockpit
const LERX_Y = 0.20, LERX_THICK = 0.05;

const AIL_HINGE_Z = -1.98;
const AILERON_OUTLINE = [[3.5,0],[5.9,0],[5.9,-0.35],[3.5,-0.35]];
const AIL_THICK = 0.05;

const STAB_HINGE_Z = -6.8, STAB_Y = -0.2;
const STAB_OUTLINE = [[0.55,0.6],[2.6,-0.8],[2.6,-1.3],[0.55,-0.7]];
const STAB_THICK = 0.16;

const FIN_MOUNT = { x:0.62, y:0.42, z:-5.0 };
const FIN_CANT = THREE.MathUtils.degToRad(20);
const FIN_OUTLINE = [[1.0,0.0],[-0.6,2.3],[-1.2,2.3],[-2.0,0.0]];
const FIN_THICK = 0.12;
const RUDDER_HINGE_Z = -1.6;
const RUDDER_OUTLINE = [[0,0],[0,2.3],[-0.5,2.3],[-0.5,0]];
const RUDDER_THICK = 0.05;

const NACELLE_X = 0.62, NACELLE_Y = -0.05;
const NACELLE_Z0 = -1.0, NACELLE_Z1 = -8.2;
const NOZZLE_Z = -8.55;

/* ── shared geometries (built once) ─────────────────────────── */
const G_FUSELAGE = buildFuselage();
const G_WING = panelGeometry(WING_OUTLINE, WING_THICK);
const G_LERX = panelGeometry(LERX_OUTLINE, LERX_THICK);
const G_AILERON = panelGeometry(AILERON_OUTLINE, AIL_THICK);
const G_STAB = panelGeometry(STAB_OUTLINE, STAB_THICK);
const G_FIN = finGeometry(FIN_OUTLINE, FIN_THICK);
const G_RUDDER = finGeometry(RUDDER_OUTLINE, RUDDER_THICK);
const G_INTAKE = new THREE.BoxGeometry(0.34, 0.42, 0.95);
const G_CANOPY = new THREE.SphereGeometry(0.60, 14, 10, 0, Math.PI*2, 0, Math.PI*0.62);
const G_NACELLE = new THREE.CylinderGeometry(0.40, 0.52, NACELLE_Z0-NACELLE_Z1, 12, 1, true);
G_NACELLE.rotateX(Math.PI/2);
G_NACELLE.translate(0, 0, (NACELLE_Z0+NACELLE_Z1)/2);
const G_NOZZLE = new THREE.CylinderGeometry(0.32, 0.38, 0.42, 12, 1, true);
G_NOZZLE.rotateX(Math.PI/2);
const G_NOZZLE_CAVITY = new THREE.CylinderGeometry(0.27, 0.27, 0.10, 12);
G_NOZZLE_CAVITY.rotateX(Math.PI/2);
const G_PYLON = new THREE.BoxGeometry(0.10, 0.40, 0.55);
const G_BURNER_CORE = new THREE.ConeGeometry(0.20, 1.3, 8, 1, true);
G_BURNER_CORE.rotateX(-Math.PI/2); G_BURNER_CORE.translate(0, 0, -0.65);
const G_BURNER_PLUME = new THREE.ConeGeometry(0.36, 2.0, 8, 1, true);
G_BURNER_PLUME.rotateX(-Math.PI/2); G_BURNER_PLUME.translate(0, 0, -1.0);
const G_SHOCK_RING = new THREE.TorusGeometry(0.24, 0.045, 3, 8);
G_SHOCK_RING.rotateY(Math.PI/2);

/* ── shared materials ───────────────────────────────────────── */
const M_FUSELAGE = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.55, metalness:0.25, side:THREE.DoubleSide });
const M_AIRFRAME = new THREE.MeshStandardMaterial({ color:0x6f767d, roughness:0.6, metalness:0.2, side:THREE.DoubleSide });
const M_PANEL = new THREE.MeshStandardMaterial({ color:0x5b6268, roughness:0.65, metalness:0.2, side:THREE.DoubleSide });
const M_CANOPY = new THREE.MeshStandardMaterial({ color:0x141a1e, roughness:0.12, metalness:0.6 });
const M_NOZZLE = new THREE.MeshStandardMaterial({ color:0x2b2d30, roughness:0.35, metalness:0.85, side:THREE.DoubleSide });
const M_NOZZLE_CAVITY = new THREE.MeshStandardMaterial({ color:0x0d0e10, roughness:0.9 });
const SHARED_MATS = new Set([M_FUSELAGE, M_AIRFRAME, M_PANEL, M_CANOPY, M_NOZZLE, M_NOZZLE_CAVITY]);

const AIL_MAX = 0.35, ELEV_MAX = 0.32, RUD_MAX = 0.45;

export function buildF18(opts = {}){
  const scale = opts.scale || 1;
  const group = new THREE.Group();

  const add = (geo, mat, x=0, y=0, z=0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    return m;
  };
  const mirror = (mesh) => {
    const m = mesh.clone();
    m.position.x *= -1;
    m.scale.x *= -1;
    group.add(m);
    return m;
  };

  add(G_FUSELAGE, M_FUSELAGE);
  add(G_CANOPY, M_CANOPY, 0, 0.55, 4.15);

  // intakes, one each side, tucked under the LERX root
  const intakeR = add(G_INTAKE, M_PANEL, 0.78, -0.05, 2.55);
  mirror(intakeR);

  // LERX
  const lerxR = add(G_LERX, M_AIRFRAME, 0, LERX_Y, 0);
  mirror(lerxR);

  // wings (fixed portion; aileron is a separate hinged panel)
  const wingR = add(G_WING, M_AIRFRAME, 0, WING_Y, 0);
  mirror(wingR);

  // ailerons — pivot at the hinge line so rotation.x deflects the trailing edge
  const ailPivotR = new THREE.Group();
  ailPivotR.position.set(0, WING_Y, AIL_HINGE_Z);
  const ailR = new THREE.Mesh(G_AILERON, M_AIRFRAME);
  ailR.castShadow = true; ailR.receiveShadow = true;
  ailPivotR.add(ailR);
  group.add(ailPivotR);
  const ailPivotL = ailPivotR.clone(false);
  ailPivotL.position.x = 0;
  const ailL = ailR.clone();
  ailL.scale.x = -1;
  ailPivotL.add(ailL);
  group.add(ailPivotL);

  // stabilators — the whole surface pivots (real Hornets have no separate elevator)
  const stabPivotR = new THREE.Group();
  stabPivotR.position.set(0, STAB_Y, STAB_HINGE_Z);
  const stabR = new THREE.Mesh(G_STAB, M_AIRFRAME);
  stabR.castShadow = true; stabR.receiveShadow = true;
  stabPivotR.add(stabR);
  group.add(stabPivotR);
  const stabPivotL = stabPivotR.clone(false);
  const stabL = stabR.clone();
  stabL.scale.x = -1;
  stabPivotL.add(stabL);
  group.add(stabPivotL);

  // twin tails, canted outward — rudder nested inside so it inherits the cant
  const buildFin = (side) => {
    const finGroup = new THREE.Group();
    finGroup.position.set(FIN_MOUNT.x*side, FIN_MOUNT.y, FIN_MOUNT.z);
    finGroup.rotation.z = -FIN_CANT*side;
    const fin = new THREE.Mesh(G_FIN, M_AIRFRAME);
    fin.castShadow = true; fin.receiveShadow = true;
    finGroup.add(fin);
    const rudPivot = new THREE.Group();
    rudPivot.position.set(0, 0, RUDDER_HINGE_Z);
    const rud = new THREE.Mesh(G_RUDDER, M_AIRFRAME);
    rud.castShadow = true; rud.receiveShadow = true;
    rudPivot.add(rud);
    finGroup.add(rudPivot);
    group.add(finGroup);
    return rudPivot;
  };
  const rudderR = buildFin(1);
  const rudderL = buildFin(-1);

  // nacelles + nozzles, straddling the boat-tail
  for(const side of [1,-1]){
    add(G_NACELLE, M_AIRFRAME, NACELLE_X*side, NACELLE_Y, 0);
    add(G_NOZZLE, M_NOZZLE, NACELLE_X*side, NACELLE_Y, NOZZLE_Z);
    add(G_NOZZLE_CAVITY, M_NOZZLE_CAVITY, NACELLE_X*side, NACELLE_Y, NOZZLE_Z-0.16);
  }

  // pylons: fixed visual stub + an anchor tip for other code to hang ordnance off
  const pylons = [];
  const HARDPOINTS = [5.9, 4.2, 2.4];
  const addPylon = (x) => {
    const le = wingLE(x), te = wingTE(x);
    const z = le - 0.35*(le-te);
    const topY = WING_Y - WING_THICK*0.5;
    add(G_PYLON, M_PANEL, x, topY-0.20, z);
    const anchor = new THREE.Object3D();
    anchor.position.set(x, topY-0.42, z);
    group.add(anchor);
    return anchor;
  };
  const left = HARDPOINTS.slice().reverse().map(x => addPylon(-x));
  const right = HARDPOINTS.map(x => addPylon(x));
  pylons.push(...left, ...right);

  // afterburners — additive cones + a couple of thin rings for a cheap shock-diamond read
  const burners = [];
  for(const side of [1,-1]){
    const bg = new THREE.Group();
    bg.position.set(NACELLE_X*side, NACELLE_Y, NOZZLE_Z-0.2);
    const coreMat = new THREE.MeshBasicMaterial({ color:0xbfe3ff, transparent:true, opacity:0, blending:THREE.AdditiveBlending, depthWrite:false });
    const plumeMat = new THREE.MeshBasicMaterial({ color:0xff8a3c, transparent:true, opacity:0, blending:THREE.AdditiveBlending, depthWrite:false });
    const ringMat = new THREE.MeshBasicMaterial({ color:0xeaf6ff, transparent:true, opacity:0, blending:THREE.AdditiveBlending, depthWrite:false });
    const core = new THREE.Mesh(G_BURNER_CORE, coreMat); core.castShadow = false;
    const plume = new THREE.Mesh(G_BURNER_PLUME, plumeMat); plume.castShadow = false;
    const ring1 = new THREE.Mesh(G_SHOCK_RING, ringMat); ring1.castShadow = false; ring1.position.z = -0.55;
    const ring2 = new THREE.Mesh(G_SHOCK_RING, ringMat); ring2.castShadow = false; ring2.position.z = -1.05; ring2.scale.setScalar(0.78);
    bg.add(core, plume, ring1, ring2);
    bg.visible = false;
    group.add(bg);
    burners.push({ group:bg, core, plume, mats:[coreMat, plumeMat, ringMat] });
  }

  group.scale.setScalar(scale);

  return {
    group,
    pylons,
    length: L*scale,
    span: SPAN*scale,

    setBurner(v){
      v = v < 0 ? 0 : (v > 1 ? 1 : v);
      const on = v > 0.01;
      for(let i = 0; i < burners.length; i++){
        const b = burners[i];
        b.group.visible = on;
        if(!on) continue;
        b.core.scale.z = 0.5 + 0.7*v;
        b.plume.scale.z = 0.4 + 1.0*v;
        b.mats[0].opacity = v*0.95;
        b.mats[1].opacity = v*0.75;
        b.mats[2].opacity = v*0.55;
      }
    },

    setSurfaces({ aileron = 0, elevator = 0, rudder = 0 } = {}){
      ailPivotR.rotation.x = aileron*AIL_MAX;
      ailPivotL.rotation.x = -aileron*AIL_MAX;
      stabPivotR.rotation.x = elevator*ELEV_MAX;
      stabPivotL.rotation.x = elevator*ELEV_MAX;
      rudderR.rotation.y = rudder*RUD_MAX;
      rudderL.rotation.y = rudder*RUD_MAX;
    },

    dispose(){
      // geometries and the non-burner materials live at module scope and are
      // shared with every other jet in the sky — only the per-instance
      // burner materials are ours to free here.
      for(const b of burners) for(const m of b.mats) m.dispose();
    },
  };
}
