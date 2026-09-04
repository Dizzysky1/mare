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
   ──────────────────────────────────────────────────────────────── */

export const KINDS = ['mk82', 'mk83', 'gbu12'];

const SPEC = {
  mk82:  { length:2.20, calibre:0.27, bodyColor:0x41483a, bandColor:0x737866, stripeColor:0xaa8c2c, finScale:1.00 },
  mk83:  { length:3.00, calibre:0.36, bodyColor:0x353b3e, bandColor:0x6b706b, stripeColor:0xaa8c2c, finScale:1.05 },
  gbu12: { length:3.30, calibre:0.27, bodyColor:0x353b3e, bandColor:0x6b706b, stripeColor:0xaa8c2c, finScale:1.30, seeker:true, wings:true },
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

/* ── shared per-kind geometry/material kit, built once ─────────── */
const _kits = new Map();
function getKit(kind){
  kind = kindName(kind);
  let kit = _kits.get(kind);
  if(kit) return kit;
  const spec = SPEC[kind];
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

  kit = {
    spec, d, comZ,
    noseGeo, bodyGeo, adapterGeo, finGeo, lugGeo, wingGeo, seekerGeo,
    noseMat, bodyMat, tailMat, lugMat, seekerMat,
    finMountR: d.tailR*0.90, finMountZ: -d.adapterLen*0.05 - comZ,
    wingMountR: d.R, wingMountZ: d.boattailLen + d.cylLen*0.42 - comZ,
    lugZ: [d.boattailLen + d.cylLen*0.30 - comZ, d.boattailLen + d.cylLen*0.66 - comZ],
  };
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

/* ── the detailed, animatable store ────────────────────────────── */
export function buildBomb(kind = 'mk83'){
  kind = kindName(kind);
  const kit = getKit(kind);
  const { d } = kit;
  const g = new THREE.Group();
  g.name = `bomb_${kind}`;

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
  if(kit.wingGeo) addFinSet(g, kit.wingGeo, kit.tailMat, kit.wingMountR, kit.wingMountZ, 2, fins);

  if(kit.seekerGeo){
    const seeker = new THREE.Mesh(kit.seekerGeo, kit.seekerMat);
    seeker.castShadow = true;
    g.add(seeker);
  }

  g.userData.fins = fins;
  g.userData.kind = kind;
  g.userData.length = kit.spec.length;
  g.userData.calibre = kit.spec.calibre;
  return g;
}

/* Fold (0) ↔ deploy (1) the tail fins — and, on the GBU, the mid-body
   wings too, since they share the same pivot mechanism. Reads/writes
   plain numbers only, so it's safe to call every frame while falling. */
export function setFins(bombObject, open){
  const fx = bombObject && bombObject.userData && bombObject.userData.fins;
  if(!fx) return;
  const o = THREE.MathUtils.clamp(open, 0, 1);
  for(let i = 0; i < fx.pivots.length; i++)
    fx.pivots[i].rotation.z = fx.base[i] + fx.sign[i]*fx.fold*(1-o);
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

    geo = mergeGeoms(parts);
    geo.computeBoundingBox();
    geo.computeBoundingSphere();
    for(const t of temps) t.dispose();
    _assetGeo.set(kind, geo);
  }
  return { geometry:geo, material:POOL_MAT, length:kit.spec.length, calibre:kit.spec.calibre };
}
