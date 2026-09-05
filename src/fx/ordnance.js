import * as THREE from 'three';

/* ────────────────────────────────────────────────────────────────
   Ordnance: the bombs themselves. Each kind is built from a handful
   of shared LatheGeometry / primitive pieces, cached once at module
   scope — buildBomb() just hands out a new Group of Meshes that all
   point at the same geometry/material objects, so a dozen falling
   plus a rack hanging on pylons costs nothing extra on the GPU.

   Long axis +Z, nose toward +Z, origin at the centre of mass (a bit
   forward of the geometric middle, like a real filled casing) so a
   caller can quaternion-align one straight onto a velocity vector.

   Two silhouette families share that contract:
     - "bomb"     mk82/mk83/gbu12 — slick ogive nose, cylindrical
                  body, boat-tailed fin-can. See buildOgiveKit().
     - "canister" napalm/gas — a fat, blunt-ended tank. No ogive, no
                  boat-tail, because these aren't aerodynamic stores;
                  they're read at a glance, which is the whole point
                  of giving them a different silhouette. See
                  buildCanisterKit().
   ──────────────────────────────────────────────────────────────── */

export const KINDS = ['mk82', 'mk83', 'gbu12', 'napalm', 'gas', 'cluster', 'cluster_gas'];

const SPEC = {
  nuke: {length:3.2,calibre:0.6,bodyColor:0xc9c4b2,bandColor:0x393b36,stripeColor:0xffbb33,finScale:1.1},
  mk82:  { length:2.20, calibre:0.27, bodyColor:0x41483a, bandColor:0x737866, stripeColor:0xaa8c2c, finScale:1.00 },
  mk83:  { length:3.00, calibre:0.36, bodyColor:0x353b3e, bandColor:0x6b706b, stripeColor:0xaa8c2c, finScale:1.05 },
  gbu12: { length:3.30, calibre:0.27, bodyColor:0x353b3e, bandColor:0x6b706b, stripeColor:0xaa8c2c, finScale:1.30, seeker:true, wings:true },

  /* Incendiary: thin-walled, finless — it tumbles rather than flies,
     so there's nothing tail-can-shaped to put fins on. Bare metal
     with a single yellow ID stripe reads as "not a bomb" instantly,
     which matters because the player cannot outrun this one's burn. */
  napalm: { length:3.35, calibre:0.48, style:'canister',
             bodyColor:0x8f8a7a, bandColor:0x57544a, stripeColor:0xd1a92c },

  /* Area denial: a blunt air-burst canister, small fixed stabiliser
     fins (it doesn't need to fold anything — it isn't captive-carried
     folded and it isn't guided). The pale hazard band is deliberately
     the loudest colour in the whole set: reading it is the mechanic. */
  gas: { length:2.40, calibre:0.36, style:'canister', fins:true,
          bodyColor:0x47513e, bandColor:0x2d3226, stripeColor:0xccd766 },
  cluster: {length:2.6,calibre:0.42,style:'canister',fins:true,
    bodyColor:0x454b3d,bandColor:0x292c25,stripeColor:0xd4ae46},
  cluster_gas: {length:2.7,calibre:0.44,style:'canister',fins:true,
    bodyColor:0x415448,bandColor:0x252e29,stripeColor:0xb6d28b},
  cluster_helet: {length:0.32,calibre:0.12,style:'canister',fins:true,
    bodyColor:0x4c5140,bandColor:0x30332c,stripeColor:0xd1b354},
  cluster_gaslet: {length:0.42,calibre:0.16,style:'canister',fins:true,
    bodyColor:0x4c6250,bandColor:0x28372b,stripeColor:0xb6d28b},
  cluster_casing: {length:1.3,calibre:0.45,style:'canister',
    bodyColor:0x55594d,bandColor:0x30332c,stripeColor:0x44483b},

};

function kindName(kind){ return SPEC[kind] ? kind : 'mk83'; }

/* Tangent-ogive nose profile — the classic low-drag bomb-nose curve.
   x is measured back from the tip over 0..L; R is the body radius. */
function ogiveRadius(x, L, R){
  const rho = (R*R + L*L) / (2*R);
  return Math.sqrt(Math.max(0, rho*rho - (L-x)*(L-x))) - rho + R;
}

/* All the derived lengths for a kind, worked out from calibre so the
   proportions hold up whatever size store we're asked to build. */
function dims(spec){
  const R = spec.calibre*0.5;
  const noseLen = spec.calibre * (spec.seeker ? 2.30 : 1.95);
  const boattailLen = spec.calibre*0.55;
  const tailR = R*0.62;                          // boat-tail necks down to the fin-can's diameter
  const adapterLen = spec.calibre*0.95*spec.finScale;
  const bodyLen = spec.length - adapterLen;       // nose + cylinder + boat-tail
  const cylLen = Math.max(spec.calibre*0.25, bodyLen - noseLen - boattailLen);
  return {
    calibre:spec.calibre, R, tailR, noseLen, boattailLen, cylLen, adapterLen, bodyLen,
    finSpan: spec.calibre*0.95*spec.finScale,
    finChord: spec.calibre*0.85*spec.finScale,
    finThick: Math.max(0.012, spec.calibre*0.035),
    wingSpan: spec.calibre*1.05,
    wingChord: spec.calibre*0.70,
    tipR: spec.seeker ? R*0.22 : 0,
  };
}

/* Lathe pieces are authored Y-up (Lathe's native axis) then rotated
   onto +Z — that single rotation is what makes "nose along +Z" free. */
function toAxial(geo){ geo.rotateX(Math.PI/2); return geo; }

function noseGeometry(d, comZ){
  const baseZ = d.bodyLen - d.noseLen;
  // Closely spaced rings keep the two ID bands crisp without a texture.
  const rings = [0, .12, .18, .24, .25, .29, .30, .50, .72, .88, 1];
  const pts = [];
  for(const t of rings){
    const xFromTip = d.noseLen*(1-t);
    const r = t >= 1 ? d.tipR : Math.max(d.tipR, ogiveRadius(xFromTip, d.noseLen, d.R));
    pts.push(new THREE.Vector2(r, baseZ + d.noseLen*t));
  }
  const g = toAxial(new THREE.LatheGeometry(pts, 12));
  g.translate(0, 0, -comZ);
  return g;
}

function bodyGeometry(d, comZ){
  const pts = [
    new THREE.Vector2(d.tailR, 0),
    new THREE.Vector2(d.R, d.boattailLen),
    new THREE.Vector2(d.R, d.boattailLen + d.cylLen),
  ];
  const g = toAxial(new THREE.LatheGeometry(pts, 12));
  g.translate(0, 0, -comZ);
  return g;
}

function adapterGeometry(d, comZ){
  const g = toAxial(new THREE.CylinderGeometry(d.tailR, d.tailR*0.82, d.adapterLen, 12));
  g.translate(0, 0, -d.adapterLen*0.5 - comZ);
  return g;
}

/* A fin/strake blade, root at the local origin (the hinge) so a pivot
   Group can fold it flush or swing it out radially with one rotation. */
function finGeometry(span, chord, thick){
  const g = new THREE.BoxGeometry(span, thick, chord);
  g.translate(span*0.5, 0, -chord*0.5);
  return g;
}

function seekerGeometry(d, comZ){
  const g = toAxial(new THREE.SphereGeometry(d.tipR, 10, 6, 0, Math.PI*2, 0, Math.PI*0.5));
  g.translate(0, 0, d.bodyLen - comZ);
  return g;
}

/* Explicit profile rings make the identification bands readable while
   leaving the ogive itself dark instead of bleaching its whole tip. */
function colourNose(geo, d, comZ, bodyColor, bandColor, stripeColor){
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count*3);
  const cB = new THREE.Color(bodyColor), cN = new THREE.Color(bandColor), cS = new THREE.Color(stripeColor), c = new THREE.Color();
  const baseZ = d.bodyLen - d.noseLen - comZ, tipZ = d.bodyLen - comZ;
  for(let i = 0; i < pos.count; i++){
    const z = pos.getZ(i);
    const t = THREE.MathUtils.clamp((z-baseZ)/(tipZ-baseZ), 0, 1);
    c.copy(cB).lerp(cN, 0.06 + t*0.10);
    if(t >= .12 && t <= .18) c.copy(cB).lerp(cN, 0.62);
    else if(t >= .25 && t <= .29) c.copy(cS);
    col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}
/* Body gets a faint scorch toward the tail — cheap, but it stops the
   cylinder reading as a flat plastic capsule. */
function colourBody(geo, bodyColor){
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count*3);
  const cB = new THREE.Color(bodyColor), cDark = cB.clone().multiplyScalar(0.72), c = new THREE.Color();
  let minZ = Infinity;
  for(let i = 0; i < pos.count; i++) minZ = Math.min(minZ, pos.getZ(i));
  for(let i = 0; i < pos.count; i++){
    const t = THREE.MathUtils.clamp((pos.getZ(i)-minZ)/0.6, 0, 1);
    c.copy(cDark).lerp(cB, t);
    col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

/* ── canister family: napalm / gas ──────────────────────────────
   One LatheGeometry for the whole tank — a blunt dome at each end
   (quarter-ellipse rings, shallower than a bomb's tangent ogive) with
   a straight cylindrical run between them. `gas` necks the tail down
   to a small burster-fitting stub instead of mirroring the nose dome,
   because that end carries a fitting and fins, not a second cap. */
function canisterDims(spec){
  const R = spec.calibre*0.5;
  const finned = !!spec.fins;
  const noseCapLen = spec.calibre*0.62;
  const tailCapLen = finned ? spec.calibre*0.30 : spec.calibre*0.52;   // gas: short taper to the fitting; napalm: flatter dome (the lozenge's blunter end)
  const cylLen = Math.max(spec.calibre*0.5, spec.length - noseCapLen - tailCapLen);
  return {
    calibre:spec.calibre, R, noseCapLen, tailCapLen, cylLen,
    length: noseCapLen + cylLen + tailCapLen,
    fitR: R*0.26, fitLen: spec.calibre*(finned ? 0.34 : 0.22),
    finSpan: spec.calibre*0.62, finChord: spec.calibre*0.50, finThick: Math.max(0.010, spec.calibre*0.03),
  };
}

function domeRing(R, capLen, t, poleAtZero){
  // t=0 is the pole (tip), t=1 is the equator (full body radius) — or
  // the reverse, per poleAtZero. A quarter-ellipse, not a true ogive:
  // that's what makes the cap read as blunt/rounded instead of sharp.
  const ang = t*Math.PI/2;
  const r = poleAtZero ? R*Math.sin(ang) : R*Math.cos(ang);
  const dz = poleAtZero ? capLen*(1-Math.cos(ang)) : capLen*Math.sin(ang);
  return { r, dz };
}

function canisterProfile(d, spec){
  const rings = [0, .2, .4, .6, .75, .87, .95, 1];
  const pts = [];
  if(spec.fins){
    // gas: taper from the fitting root up to full body radius — no dome
    pts.push(new THREE.Vector2(d.fitR, 0));
    pts.push(new THREE.Vector2(d.R*0.7, d.tailCapLen*0.6));
    pts.push(new THREE.Vector2(d.R, d.tailCapLen));
  } else {
    // napalm: rounded tail dome, pole at z=0
    for(const t of rings){
      const { r, dz } = domeRing(d.R, d.tailCapLen, t, true);
      pts.push(new THREE.Vector2(Math.max(0.004, r), dz));
    }
  }
  pts.push(new THREE.Vector2(d.R, d.tailCapLen + d.cylLen));
  const base = d.tailCapLen + d.cylLen;
  for(const t of rings){
    const { r, dz } = domeRing(d.R, d.noseCapLen, t, false);
    pts.push(new THREE.Vector2(Math.max(0.004, r), base + dz));
  }
  return pts;
}

function canisterBodyGeometry(d, spec, comZ){
  const g = toAxial(new THREE.LatheGeometry(canisterProfile(d, spec), 10));
  g.translate(0, 0, -comZ);
  return g;
}

/* Burster fitting (gas): a stub protruding straight off the tail,
   on-axis — same toAxial trick as the bomb's fin adapter. */
function tailFittingGeometry(d, comZ){
  const g = toAxial(new THREE.CylinderGeometry(d.fitR, d.fitR*0.8, d.fitLen, 8));
  g.translate(0, 0, -d.fitLen*0.5 - comZ);
  return g;
}

/* Filler cap (napalm): a stub proud of the body's "top", mounted at a
   fixed radial angle. Left in its native Y-up orientation on purpose
   — at that mount point the outward surface normal already points
   along +Y, so the cylinder's own axis needs no extra rotation. */
function fillerCapGeometry(d, capZ){
  const g = new THREE.CylinderGeometry(d.fitR*1.15, d.fitR*1.05, d.fitLen, 8);
  g.translate(0, d.R + d.fitLen*0.5, capZ);
  return g;
}

/* Canister colouring: mostly a flat body tone, plus whatever band
   tells the two kinds apart at a glance. `gas` gets one loud hazard
   band because reading it in the second before it bursts is the
   point; `napalm` gets a thin ID stripe near each cap, the way a
   plain unpainted canister would carry a stencilled marking. */
function colourCanister(geo, d, spec){
  const pos = geo.attributes.position;
  const col = new Float32Array(pos.count*3);
  const cB = new THREE.Color(spec.bodyColor), cBand = new THREE.Color(spec.bandColor), cStripe = new THREE.Color(spec.stripeColor), c = new THREE.Color();
  const total = d.length;
  for(let i = 0; i < pos.count; i++){
    const t = THREE.MathUtils.clamp(pos.getZ(i)/total, 0, 1);
    if(spec.fins){
      c.copy(cB);
      if(t >= 0.30 && t <= 0.48) c.copy(cStripe);        // the hazard band
      else if(t < 0.08) c.copy(cBand);                    // dark fitting root
    } else {
      c.copy(cB).lerp(cBand, 0.16*Math.abs(Math.sin(t*Math.PI)));  // faint scorched-metal shading
      if((t >= 0.09 && t <= 0.12) || (t >= 0.88 && t <= 0.91)) c.copy(cStripe);
    }
    col[i*3]=c.r; col[i*3+1]=c.g; col[i*3+2]=c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

function buildCanisterKit(kind, spec){
  const d = canisterDims(spec);
  const comZ = d.length*0.50;                    // roughly uniform-density tank — CoM near geometric centre

  const bodyGeo = canisterBodyGeometry(d, spec, comZ);
  colourCanister(bodyGeo, d, spec);
  const axialFitGeo = spec.fins ? tailFittingGeometry(d, comZ) : null;
  const radialFitGeo = spec.fins ? null : fillerCapGeometry(d, d.tailCapLen + d.cylLen*0.5 - comZ);
  const finGeo = spec.fins ? finGeometry(d.finSpan, d.finChord, d.finThick) : null;
  const lugGeo = new THREE.BoxGeometry(d.calibre*0.10, d.calibre*0.16, d.calibre*0.16);

  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors:true, roughness: spec.fins ? 0.70 : 0.32, metalness: spec.fins ? 0.12 : 0.55 });
  const fitMat = new THREE.MeshStandardMaterial({ color:0x24261f, roughness:0.5, metalness:0.6 });
  const finMat = new THREE.MeshStandardMaterial({ color:0x2f332e, roughness:0.72, metalness:0.25 });
  const lugMat = fitMat;

  return {
    spec, d, comZ, style:'canister',
    bodyGeo, axialFitGeo, radialFitGeo, finGeo, lugGeo,
    bodyMat, fitMat, finMat, lugMat,
    finCount: spec.fins ? 3 : 0,
    finMountR: d.R*0.92, finMountZ: d.tailCapLen*0.55 - comZ,
    lugZ: [d.tailCapLen + d.cylLen*0.32 - comZ, d.tailCapLen + d.cylLen*0.68 - comZ],
  };
}

/* ── shared per-kind geometry/material kit, built once ─────────── */
function buildOgiveKit(kind, spec){
  const d = dims(spec);
  const comZ = d.bodyLen - 0.42*spec.length;      // CoM forward of geometric centre — filled nose, light fins

  const noseGeo = noseGeometry(d, comZ);
  colourNose(noseGeo, d, comZ, spec.bodyColor, spec.bandColor, spec.stripeColor);
  const bodyGeo = bodyGeometry(d, comZ);
  colourBody(bodyGeo, spec.bodyColor);
  const adapterGeo = adapterGeometry(d, comZ);
  const finGeo = finGeometry(d.finSpan, d.finChord, d.finThick);
  const lugGeo = new THREE.BoxGeometry(d.calibre*0.10, d.calibre*0.16, d.calibre*0.16);
  const wingGeo = spec.wings ? finGeometry(d.wingSpan, d.wingChord, d.finThick*0.8) : null;
  const seekerGeo = spec.seeker ? seekerGeometry(d, comZ) : null;

  const noseMat = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.55, metalness:0.12 });
  const bodyMat = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.88, metalness:0.05 });
  const tailMat = new THREE.MeshStandardMaterial({ color:0x2f332e, roughness:0.72, metalness:0.25 });
  const lugMat  = new THREE.MeshStandardMaterial({ color:0x24261f, roughness:0.5, metalness:0.6 });
  const seekerMat = spec.seeker ? new THREE.MeshStandardMaterial({ color:0x14161a, roughness:0.32, metalness:0.2 }) : null;

  return {
    spec, d, comZ, style:'bomb',
    noseGeo, bodyGeo, adapterGeo, finGeo, lugGeo, wingGeo, seekerGeo,
    noseMat, bodyMat, tailMat, lugMat, seekerMat,
    finMountR: d.tailR*0.90, finMountZ: -d.adapterLen*0.05 - comZ,
    wingMountR: d.R, wingMountZ: d.boattailLen + d.cylLen*0.42 - comZ,
    lugZ: [d.boattailLen + d.cylLen*0.30 - comZ, d.boattailLen + d.cylLen*0.66 - comZ],
  };
}

const _kits = new Map();
function getKit(kind){
  kind = kindName(kind);
  let kit = _kits.get(kind);
  if(kit) return kit;
  const spec = SPEC[kind];
  kit = spec.style === 'canister' ? buildCanisterKit(kind, spec) : buildOgiveKit(kind, spec);
  kit.kind = kind;
  _kits.set(kind, kit);
  return kit;
}

/* Mounts n identical blades cruciform (or opposite-pair, for n=2)
   around the body axis, each on its own pivot Group so setFins() can
   fold/deploy them later with nothing but a rotation.z write. */
const FOLD = 78*Math.PI/180;
function addFinSet(group, geo, mat, mountR, mountZ, n, out){
  for(let i = 0; i < n; i++){
    const theta = (i/n)*Math.PI*2;
    const pivot = new THREE.Group();
    pivot.position.set(Math.cos(theta)*mountR, Math.sin(theta)*mountR, mountZ);
    pivot.rotation.z = theta;                     // deployed by default — ready to hang or fall
    const blade = new THREE.Mesh(geo, mat);
    blade.castShadow = true;
    pivot.add(blade);
    group.add(pivot);
    // One rotation sense preserves the radial spacing while the blades wrap.
    out.pivots.push(pivot); out.base.push(theta); out.sign.push(1);
  }
}

function buildOgiveMesh(kit){
  const { d } = kit;
  const g = new THREE.Group();
  g.name = `bomb_${kit.kind}`;

  const nose = new THREE.Mesh(kit.noseGeo, kit.noseMat); nose.castShadow = true; g.add(nose);
  const body = new THREE.Mesh(kit.bodyGeo, kit.bodyMat); body.castShadow = true; g.add(body);
  const adapter = new THREE.Mesh(kit.adapterGeo, kit.tailMat); adapter.castShadow = true; g.add(adapter);

  for(const z of kit.lugZ){
    const lug = new THREE.Mesh(kit.lugGeo, kit.lugMat);
    lug.position.set(0, d.R*0.92, z);
    lug.castShadow = true;
    g.add(lug);
  }

  const fins = { pivots:[], base:[], sign:[], fold:FOLD };
  addFinSet(g, kit.finGeo, kit.tailMat, kit.finMountR, kit.finMountZ, 4, fins);
  if(kit.wingGeo) addFinSet(g, kit.wingGeo, kit.wingMountR, kit.wingMountZ, kit.tailMat, 2, fins);

  if(kit.seekerGeo){
    const seeker = new THREE.Mesh(kit.seekerGeo, kit.seekerMat);
    seeker.castShadow = true;
    g.add(seeker);
  }

  g.userData.fins = fins;
  g.userData.kind = kit.kind;
  g.userData.length = kit.spec.length;
  g.userData.calibre = kit.spec.calibre;
  return g;
}

/* Canisters have nothing to fold: napalm has no fins at all, and gas's
   stabilisers are small and fixed (it's dumb and unguided — nothing
   needs to hide flush against a rail). So no `userData.fins` here,
   which makes setFins() a safe no-op for both by the existing guard. */
function buildCanisterMesh(kit){
  const { spec, d } = kit;
  const g = new THREE.Group();
  g.name = `bomb_${kit.kind}`;

  // napalm tumbles end over end rather than flying nose-first, so its
  // meshes live under a spin root a caller can drive with setTumble()
  // without disturbing the outer Group's own velocity-aligned pose.
  const finless = !spec.fins;
  const visual = finless ? new THREE.Group() : g;
  if(finless) g.add(visual);

  const body = new THREE.Mesh(kit.bodyGeo, kit.bodyMat); body.castShadow = true; visual.add(body);

  if(spec.fins){
    const fit = new THREE.Mesh(kit.axialFitGeo, kit.fitMat); fit.castShadow = true; visual.add(fit);
    for(let i = 0; i < kit.finCount; i++){
      const theta = (i/kit.finCount)*Math.PI*2;
      const fin = new THREE.Mesh(kit.finGeo, kit.finMat);
      fin.position.set(Math.cos(theta)*kit.finMountR, Math.sin(theta)*kit.finMountR, kit.finMountZ);
      fin.rotation.z = theta;
      fin.castShadow = true;
      visual.add(fin);
    }
  } else {
    const cap = new THREE.Mesh(kit.radialFitGeo, kit.fitMat); cap.castShadow = true; visual.add(cap);
  }

  for(const z of kit.lugZ){
    const lug = new THREE.Mesh(kit.lugGeo, kit.lugMat);
    lug.position.set(0, d.R*0.92, z);
    lug.castShadow = true;
    visual.add(lug);
  }

  g.userData.kind = kit.kind;
  g.userData.length = spec.length;
  g.userData.calibre = spec.calibre;
  if(finless) g.userData.tumbleRoot = visual;
  return g;
}

/* ── the detailed, animatable store ────────────────────────────── */
export function buildBomb(kind = 'mk83'){
  kind = kindName(kind);
  const kit = getKit(kind);
  return kit.style === 'canister' ? buildCanisterMesh(kit) : buildOgiveMesh(kit);
}

/* Fold (0) ↔ deploy (1) the tail fins — and, on the GBU, the mid-body
   wings too, since they share the same pivot mechanism. Reads/writes
   plain numbers only, so it's safe to call every frame while falling.
   Stores with nothing to fold (napalm, gas) simply have no fin rig,
   so this is a safe no-op for them. */
export function setFins(bombObject, open){
  const fx = bombObject && bombObject.userData && bombObject.userData.fins;
  if(!fx) return;
  const o = THREE.MathUtils.clamp(open, 0, 1);
  for(let i = 0; i < fx.pivots.length; i++)
    fx.pivots[i].rotation.z = fx.base[i] + fx.sign[i]*fx.fold*(1-o);
}

/* A finless store (napalm) tumbles end over end instead of flying
   nose-first. `phase` is radians about the pitch axis, applied to an
   inner spin root kept separate from the object's own transform, so
   a caller is free to quaternion-align the outer Group onto velocity
   (as every other store expects) and layer the tumble on top. No-op,
   allocation-free, for anything that doesn't tumble. */
export function setTumble(obj, phase){
  const root = obj && obj.userData && obj.userData.tumbleRoot;
  if(!root) return;
  root.rotation.x = phase;
}

/* A short label for the HUD — lets the player's eye (and any warning
   UI) key off silhouette rather than the internal kind string. */
export function storeSilhouette(kind){
  return SPEC[kindName(kind)].style === 'canister' ? 'canister' : 'bomb';
}

/* ── cheap pooled variant: one geometry, one material ──────────── */
function bakedFin(geo, mountR, mountZ, theta){
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(Math.cos(theta)*mountR, Math.sin(theta)*mountR, mountZ),
    new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0,0,1), theta),
    new THREE.Vector3(1,1,1));
  return geo.clone().applyMatrix4(m);
}

/* Concatenates several BufferGeometries (position/normal[/color]) into
   one indexed geometry — a tiny hand-rolled stand-in for the addon
   merge util, since we can't import addons here. */
function mergeGeoms(parts){
  let vCount = 0, iCount = 0;
  for(const p of parts){
    vCount += p.geo.attributes.position.count;
    iCount += p.geo.index ? p.geo.index.count : p.geo.attributes.position.count;
  }
  const pos = new Float32Array(vCount*3), nrm = new Float32Array(vCount*3), col = new Float32Array(vCount*3);
  const idx = vCount > 65535 ? new Uint32Array(iCount) : new Uint16Array(iCount);
  let vOff = 0, iOff = 0, base = 0;
  const c = new THREE.Color();
  for(const p of parts){
    const posAttr = p.geo.attributes.position, nrmAttr = p.geo.attributes.normal, colAttr = p.geo.attributes.color;
    pos.set(posAttr.array, vOff*3);
    nrm.set(nrmAttr.array, vOff*3);
    if(colAttr){
      col.set(colAttr.array, vOff*3);
    } else {
      c.set(p.color);
      for(let i = 0; i < posAttr.count; i++){ col[(vOff+i)*3]=c.r; col[(vOff+i)*3+1]=c.g; col[(vOff+i)*3+2]=c.b; }
    }
    if(p.geo.index){
      const ia = p.geo.index.array;
      for(let i = 0; i < ia.length; i++) idx[iOff+i] = ia[i]+base;
      iOff += ia.length;
    } else {
      for(let i = 0; i < posAttr.count; i++) idx[iOff+i] = base+i;
      iOff += posAttr.count;
    }
    vOff += posAttr.count; base += posAttr.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.setIndex(new THREE.BufferAttribute(idx, 1));
  return g;
}

function buildOgiveAssetGeo(kit){
  const parts = [
    { geo:kit.noseGeo, color:0xffffff },
    { geo:kit.bodyGeo, color:0xffffff },
    { geo:kit.adapterGeo, color:0x2f332e },
  ];
  const temps = [];
  for(const z of kit.lugZ){
    const lg = kit.lugGeo.clone().translate(0, kit.d.R*0.92, z);
    temps.push(lg); parts.push({ geo:lg, color:0x24261f });
  }
  for(let i = 0; i < 4; i++){
    const theta = (i/4)*Math.PI*2;
    const fg = bakedFin(kit.finGeo, kit.finMountR, kit.finMountZ, theta);
    temps.push(fg); parts.push({ geo:fg, color:0x2f332e });
  }
  if(kit.wingGeo){
    for(let i = 0; i < 2; i++){
      const theta = i*Math.PI;
      const wg = bakedFin(kit.wingGeo, kit.wingMountR, kit.wingMountZ, theta);
      temps.push(wg); parts.push({ geo:wg, color:0x2f332e });
    }
  }
  if(kit.seekerGeo) parts.push({ geo:kit.seekerGeo, color:0x14161a });

  const geo = mergeGeoms(parts);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  for(const t of temps) t.dispose();
  return geo;
}

function buildCanisterAssetGeo(kit){
  const { spec, d } = kit;
  const parts = [{ geo:kit.bodyGeo, color:0xffffff }];   // vertex colours already baked in
  const temps = [];
  if(spec.fins){
    parts.push({ geo:kit.axialFitGeo, color:0x24261f });
    for(let i = 0; i < kit.finCount; i++){
      const theta = (i/kit.finCount)*Math.PI*2;
      const fg = bakedFin(kit.finGeo, kit.finMountR, kit.finMountZ, theta);
      temps.push(fg); parts.push({ geo:fg, color:0x2f332e });
    }
  } else {
    parts.push({ geo:kit.radialFitGeo, color:0x24261f });
  }
  for(const z of kit.lugZ){
    const lg = kit.lugGeo.clone().translate(0, d.R*0.92, z);
    temps.push(lg); parts.push({ geo:lg, color:0x24261f });
  }
  const geo = mergeGeoms(parts);
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  for(const t of temps) t.dispose();
  return geo;
}

const _assetGeo = new Map();
const POOL_MAT = new THREE.MeshStandardMaterial({ vertexColors:true, roughness:0.8, metalness:0.12 });

/* Hundreds of these can exist (background traffic, a full rack on
   every pylon) so it's one draw call: fins baked deployed, one shared
   material across every kind. */
export function bombAssets(kind = 'mk83'){
  kind = kindName(kind);
  const kit = getKit(kind);
  let geo = _assetGeo.get(kind);
  if(!geo){
    geo = kit.style === 'canister' ? buildCanisterAssetGeo(kit) : buildOgiveAssetGeo(kit);
    _assetGeo.set(kind, geo);
  }
  return { geometry:geo, material:POOL_MAT, length:kit.spec.length, calibre:kit.spec.calibre };
}
