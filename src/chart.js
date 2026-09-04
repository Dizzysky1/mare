/* ────────────────────────────────────────────────────────────────
   A paper chart of the archipelago.

   Coastlines are traced from each island's own height function rather
   than drawn by hand, so the outline you navigate by is the outline
   you actually run aground on. Only islands you have been near are
   drawn — the sea has to be earned before it is charted.
   ──────────────────────────────────────────────────────────────── */

const INK = '#3a2d1c';
const INK_SOFT = 'rgba(58,45,28,.45)';
const SAND = '#d8c290';
const LAND = '#b9b183';
const HIGH = '#a9a179';

/* Walk outward along a bearing until the terrain drops below the
   waterline; that crossing is the coast. */
function traceCoast(island, spokes = 72){
  const pts = [];
  const max = island.radius*1.5;
  for(let i = 0; i < spokes; i++){
    const a = (i/spokes)*Math.PI*2;
    const cx = Math.cos(a), cz = Math.sin(a);
    let lo = 0, hi = max;
    // coarse march to bracket the crossing, then bisect
    let found = false;
    for(let r = max; r > 0; r -= max/48){
      if(island.height(island.pos.x + cx*r, island.pos.z + cz*r) > 0){ lo = r; hi = r + max/48; found = true; break; }
    }
    if(!found){ pts.push(null); continue; }
    for(let k = 0; k < 14; k++){
      const mid = (lo+hi)/2;
      if(island.height(island.pos.x + cx*mid, island.pos.z + cz*mid) > 0) lo = mid; else hi = mid;
    }
    pts.push({ x: island.pos.x + cx*lo, z: island.pos.z + cz*lo });
  }
  return pts.filter(Boolean);
}

export class Chart {
  constructor(canvas){
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.outlines = null;
    this.world = null;
  }

  /* Tracing every coast costs a few thousand noise samples, so do it
     once, lazily, the first time the chart is opened. */
  build(world){
    if(this.outlines && this.world === world) return;
    this.world = world;
    this.outlines = world.islands.map(i => ({ island:i, coast:traceCoast(i) }));
  }

  draw({ world, discovered, playerPos, heading, goal, questKnown, jars, boats, hostile }){
    this.build(world);
    const cv = this.canvas, ctx = this.ctx;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = cv.clientWidth, h = cv.clientHeight;
    if(cv.width !== Math.floor(w*dpr) || cv.height !== Math.floor(h*dpr)){
      cv.width = Math.floor(w*dpr); cv.height = Math.floor(h*dpr);
    }
    ctx.setTransform(dpr,0,0,dpr,0,0);
    ctx.clearRect(0,0,w,h);

    // ── extent: everything charted so far, plus you, with a floor ──
    let minX = playerPos.x, maxX = playerPos.x, minZ = playerPos.z, maxZ = playerPos.z;
    for(const o of this.outlines){
      if(!discovered.has(o.island)) continue;
      const r = o.island.radius*1.2;
      minX = Math.min(minX, o.island.pos.x-r); maxX = Math.max(maxX, o.island.pos.x+r);
      minZ = Math.min(minZ, o.island.pos.z-r); maxZ = Math.max(maxZ, o.island.pos.z+r);
    }
    if(questKnown && goal){
      minX = Math.min(minX, goal.x-400); maxX = Math.max(maxX, goal.x+400);
      minZ = Math.min(minZ, goal.z-400); maxZ = Math.max(maxZ, goal.z+400);
    }
    const pad = 220;
    let cx = (minX+maxX)/2, cz = (minZ+maxZ)/2;
    let span = Math.max(maxX-minX, maxZ-minZ) + pad*2;
    span = Math.max(span, 1800);

    const scale = Math.min(w, h)/span;                 // pixels per metre
    const X = x => w/2 + (x-cx)*scale;
    const Y = z => h/2 + (z-cz)*scale;                 // −Z is north, so +Z goes down

    // ── paper ─────────────────────────────────────────────────
    ctx.fillStyle = '#e9dcbe';
    ctx.fillRect(0,0,w,h);
    ctx.strokeStyle = 'rgba(58,45,28,.10)';
    ctx.lineWidth = 1;
    const grid = 500*scale;
    if(grid > 26){
      ctx.beginPath();
      for(let gx = X(Math.ceil(minX/500)*500) % grid; gx < w; gx += grid){ ctx.moveTo(gx,0); ctx.lineTo(gx,h); }
      for(let gy = Y(Math.ceil(minZ/500)*500) % grid; gy < h; gy += grid){ ctx.moveTo(0,gy); ctx.lineTo(w,gy); }
      ctx.stroke();
    }

    // ── islands ───────────────────────────────────────────────
    for(const o of this.outlines){
      if(!discovered.has(o.island) || o.coast.length < 3) continue;
      ctx.beginPath();
      ctx.moveTo(X(o.coast[0].x), Y(o.coast[0].z));
      for(let i = 1; i < o.coast.length; i++) ctx.lineTo(X(o.coast[i].x), Y(o.coast[i].z));
      ctx.closePath();
      ctx.fillStyle = SAND; ctx.fill();
      ctx.strokeStyle = INK; ctx.lineWidth = 1.4; ctx.stroke();

      // a rough interior, shrunk toward the peak, to read as ground rising
      ctx.save();
      ctx.clip();
      ctx.fillStyle = LAND;
      const ip = o.island.pos;
      ctx.beginPath();
      for(let i = 0; i < o.coast.length; i++){
        const p = o.coast[i];
        const px = ip.x + (p.x-ip.x)*0.72, pz = ip.z + (p.z-ip.z)*0.72;
        i ? ctx.lineTo(X(px), Y(pz)) : ctx.moveTo(X(px), Y(pz));
      }
      ctx.closePath(); ctx.fill();
      if(o.island.peak > 60){
        ctx.fillStyle = HIGH;
        ctx.beginPath();
        for(let i = 0; i < o.coast.length; i++){
          const p = o.coast[i];
          const px = ip.x + (p.x-ip.x)*0.40, pz = ip.z + (p.z-ip.z)*0.40;
          i ? ctx.lineTo(X(px), Y(pz)) : ctx.moveTo(X(px), Y(pz));
        }
        ctx.closePath(); ctx.fill();
      }
      ctx.restore();

      if(o.island.village){
        const v = o.island.villagePos || o.island.pos;
        ctx.fillStyle = INK;
        ctx.fillRect(X(v.x)-2, Y(v.z)-2, 4, 4);
      }
    }

    // ── the light ─────────────────────────────────────────────
    if(questKnown && goal){
      const gx = X(goal.x), gy = Y(goal.z);
      ctx.strokeStyle = '#a8452c'; ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.arc(gx, gy, 9, 0, Math.PI*2); ctx.stroke();
      ctx.beginPath();
      for(let i = 0; i < 8; i++){
        const a = i*Math.PI/4;
        ctx.moveTo(gx + Math.cos(a)*11, gy + Math.sin(a)*11);
        ctx.lineTo(gx + Math.cos(a)*15, gy + Math.sin(a)*15);
      }
      ctx.stroke();
      ctx.fillStyle = '#a8452c';
      ctx.font = 'italic 12px Georgia, serif';
      ctx.fillText('the light', gx+18, gy+4);
    }

    // ── jars still ashore, on ground you have walked ──────────
    if(jars) for(const j of jars){
      if(j.taken || !discovered.has(j.island)) continue;
      ctx.strokeStyle = '#7a5a2e'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(X(j.pos.x), Y(j.pos.z), 3.2, 0, Math.PI*2); ctx.stroke();
    }

    // ── other boats you can presently see ─────────────────────
    if(boats) for(const b of boats){
      if(Math.hypot(b.pos.x-playerPos.x, b.pos.z-playerPos.z) > 1400) continue;
      ctx.fillStyle = INK_SOFT;
      ctx.beginPath(); ctx.arc(X(b.pos.x), Y(b.pos.z), 2, 0, Math.PI*2); ctx.fill();
    }

    // ── you ───────────────────────────────────────────────────
    const px = X(playerPos.x), py = Y(playerPos.z);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(heading);                       // 0 = north = up
    ctx.fillStyle = '#a8452c';
    ctx.beginPath();
    ctx.moveTo(0,-9); ctx.lineTo(5.5,7); ctx.lineTo(0,4); ctx.lineTo(-5.5,7);
    ctx.closePath(); ctx.fill();
    ctx.restore();

    // ── rose, scale, cartouche ────────────────────────────────
    const rx = w-52, ry = 52;
    ctx.strokeStyle = INK; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(rx, ry, 20, 0, Math.PI*2); ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(rx, ry-26); ctx.lineTo(rx-5, ry); ctx.lineTo(rx+5, ry);
    ctx.closePath(); ctx.fillStyle = INK; ctx.fill();
    ctx.font = 'bold 11px Georgia, serif'; ctx.textAlign = 'center';
    ctx.fillText('N', rx, ry-30);
    ctx.textAlign = 'left';

    const barM = span > 6000 ? 2000 : span > 2600 ? 1000 : 500;
    const barPx = barM*scale;
    ctx.strokeStyle = INK; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(20, h-22); ctx.lineTo(20+barPx, h-22);
    ctx.moveTo(20, h-26); ctx.lineTo(20, h-18);
    ctx.moveTo(20+barPx, h-26); ctx.lineTo(20+barPx, h-18);
    ctx.stroke();
    ctx.fillStyle = INK; ctx.font = '11px Georgia, serif';
    ctx.fillText(barM >= 1000 ? `${barM/1000} km` : `${barM} m`, 24+barPx, h-18);

    ctx.font = 'italic 13px Georgia, serif';
    ctx.fillStyle = INK_SOFT;
    ctx.fillText(hostile ? 'chart of an unknown sea' : 'chart of the archipelago', 20, 26);
  }
}
