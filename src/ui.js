const $ = (id) => document.getElementById(id);

function applyUiPolish(){
  if(!document.querySelector('link[data-ui-polish]')){
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../ui-polish.css', import.meta.url).href;
    link.dataset.uiPolish = '';
    document.head.appendChild(link);
  }

  const live = (id, role, politeness = 'polite') => {
    const el = $(id); if(!el) return;
    el.setAttribute('role', role);
    el.setAttribute('aria-live', politeness);
    el.setAttribute('aria-atomic', 'true');
  };
  live('loadmsg', 'status');
  live('multi-status', 'status');
  live('multi-error', 'alert', 'assertive');

  const toasts = $('toasts');
  if(toasts){
    toasts.setAttribute('aria-live', 'polite');
    toasts.setAttribute('aria-relevant', 'additions text');
  }

  const cards = $('cards');
  if(cards){
    cards.setAttribute('role', 'group');
    cards.setAttribute('aria-label', 'Game mode');
  }

  const roles = document.querySelector('.role-cards');
  if(roles){
    roles.setAttribute('role', 'group');
    roles.setAttribute('aria-label', 'Two player role');
  }

  document.querySelectorAll('textarea.code, input.code-input').forEach(el => {
    el.setAttribute('autocomplete', 'off');
    el.setAttribute('autocapitalize', 'off');
    el.setAttribute('autocorrect', 'off');
  });
}

export class UI {
  constructor(){
    applyUiPolish();
    this.el = {
      loading:$('loading'), loadmsg:$('loadmsg'), menu:$('menu'), hud:$('hud'),
      stats:$('stats'), obj:$('objective'), objText:$('obj-text'), objDist:$('obj-dist'),
      readout:$('readout'), prompt:$('prompt'), toasts:$('toasts'), compass:$('cstrip'),
      marker:$('marker'), pause:$('pause'), pauseSub:$('pause-sub'), over:$('over'),
      overTitle:$('over-title'), overSub:$('over-sub'), reader:$('reader'),
      readTitle:$('read-title'), readBody:$('read-body'), crosshair:$('crosshair'),
      vignette:$('fx-vignette'), flash:$('fx-flash'), damage:$('fx-damage'),
    };
    this.bars = {};
    document.querySelectorAll('#stats .bar').forEach(b => this.bars[b.dataset.k] = b);
    this.buildCompass();
    this.toastList = [];
    this._lastPrompt = null;
  }

  buildCompass(){
    const strip = this.el.compass;
    strip.innerHTML = '';
    const labels = { 0:'N', 45:'NE', 90:'E', 135:'SE', 180:'S', 225:'SW', 270:'W', 315:'NW' };
    this.ticks = [];
    for(let a = 0; a < 360; a += 15){
      const s = document.createElement('span');
      const cardinal = labels[a];
      s.textContent = cardinal || '·';
      s.className = cardinal ? (a%90===0 ? 'cdir' : 'cdir sub') : 'tick';
      strip.appendChild(s);
      this.ticks.push({ el:s, angle:a });
    }
    const g = document.createElement('span');
    g.className = 'goal'; g.textContent = '◆'; g.style.display = 'none';
    strip.appendChild(g);
    this.goalTick = g;
  }

  /* heading in radians, goalBearing in radians or null */
  updateCompass(heading, goalBearing){
    const w = this.el.compass.parentElement.clientWidth;
    const pxPerDeg = w/150;
    const hdg = ((heading*180/Math.PI)%360 + 360)%360;
    for(const t of this.ticks){
      let d = t.angle - hdg;
      d = ((d+180)%360+360)%360 - 180;
      const x = w/2 + d*pxPerDeg;
      if(x < -40 || x > w+40){ t.el.style.visibility = 'hidden'; continue; }
      t.el.style.visibility = 'visible';
      t.el.style.left = x+'px';
    }
    if(goalBearing == null){ this.goalTick.style.display = 'none'; return; }
    let d = (goalBearing*180/Math.PI) - hdg;
    d = ((d+180)%360+360)%360 - 180;
    this.goalTick.style.display = '';
    this.goalTick.style.left = (w/2 + d*pxPerDeg)+'px';
  }

  setStats(s, show){
    this.el.stats.classList.toggle('hidden', !show);
    if(!show) return;
    const set = (k, v) => {
      const b = this.bars[k]; if(!b) return;
      b.querySelector('i').style.setProperty('--v', Math.max(0,Math.min(100,v))+'%');
      b.classList.toggle('low', v < 25);
    };
    set('health', s.health); set('food', s.food); set('water', s.water);
    set('vitamin', s.vitamin); set('sanity', s.sanity);
  }

  setObjective(o){
    if(!o){ this.el.obj.classList.add('hidden'); return; }
    this.el.obj.classList.remove('hidden');
    this.el.objText.textContent = o.text;
    let sub = '';
    if(o.sub) sub += o.sub;
    if(o.dist != null) sub += (sub ? ' · ' : '') + this.fmtDist(o.dist);
    if(o.hint) sub += (sub ? ' · ' : '') + o.hint;
    this.el.objDist.textContent = sub;
  }

  fmtDist(d){ return d > 1200 ? (d/1000).toFixed(1)+' km' : Math.round(d)+' m'; }

  setReadout(lines){
    this.el.readout.innerHTML = lines.filter(Boolean).join('<br>');
  }

  setPrompt(text){
    if(text === this._lastPrompt) return;
    this._lastPrompt = text;
    this.el.prompt.classList.toggle('hidden', !text);
    if(text) this.el.prompt.innerHTML = text;
  }

  toast(text, kind = ''){
    const d = document.createElement('div');
    d.className = 'toast ' + kind;
    d.textContent = text;
    this.el.toasts.appendChild(d);
    setTimeout(()=>{ d.classList.add('out'); setTimeout(()=>d.remove(), 700); }, 4200);
    while(this.el.toasts.children.length > 5) this.el.toasts.firstChild.remove();
  }

  showReader(L, onClose){
    this.el.readTitle.textContent = L.title;
    this.el.readBody.innerHTML = L.body.map(([c,t]) => `<p class="${c}">${t}</p>`).join('');
    this.el.reader.classList.remove('hidden');
    this._readerClose = onClose;
  }
  hideReader(){
    this.el.reader.classList.add('hidden');
    if(this._readerClose){ const f = this._readerClose; this._readerClose = null; f(); }
  }

  screenMarker(visible, x, y){
    this.el.marker.classList.toggle('hidden', !visible);
    if(visible){ this.el.marker.style.left = x+'px'; this.el.marker.style.top = y+'px'; }
  }

  setFx({ vignette = 0, damage = 0 }){
    this.el.vignette.style.opacity = vignette;
    this.el.damage.style.opacity = damage;
  }
}
