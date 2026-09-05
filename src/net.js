/* ────────────────────────────────────────────────────────────────
   The wire.

   MARE is served as static files off GitHub Pages, so there is no
   server to broker a match and there is not going to be one. This is a
   direct peer-to-peer WebRTC link with the signalling done by hand: the
   host produces a code, the guest pastes it and produces a reply code,
   the host pastes that back, and from then on the two browsers talk
   straight to each other with nothing in between.

   Two channels, because the traffic is two different kinds:

     'state'  unreliable, unordered. Positions, sixteen times a second.
              A dropped packet is worth less than a late one — the next
              is already on its way, and re-sending a stale position to
              guarantee delivery would be actively worse.

     'event'  reliable, ordered. Things that happen once and must not be
              lost: a store released, a hit, the seed, the handshake.

   The signalling codes are deflate-compressed before base64 because a
   raw SDP offer runs to a few kilobytes, which is miserable to paste
   into a chat window. Compressed they land around a quarter of that.
   ──────────────────────────────────────────────────────────────── */

const ICE = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
];

/* ── code packing ──────────────────────────────────────────────
   TextEncoder → deflate-raw → base64url. CompressionStream is in every
   browser that can run the rest of this, but fall back to plain base64
   if it is missing rather than failing the connection over it. */
async function pack(obj){
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let out = bytes;
  if(typeof CompressionStream === 'function'){
    try {
      const cs = new CompressionStream('deflate-raw');
      const w = cs.writable.getWriter(); w.write(bytes); w.close();
      out = new Uint8Array(await new Response(cs.readable).arrayBuffer());
    } catch { out = bytes; }
  }
  const flag = out === bytes ? 'u' : 'z';
  let s = '';
  for(let i = 0; i < out.length; i++) s += String.fromCharCode(out[i]);
  return flag + btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
}

async function unpack(code){
  if(typeof code !== 'string' || code.length>32768) throw new Error('That link code is too large.');
  const trimmed = String(code || '').trim().replace(/\s+/g, '');
  if(trimmed.length < 2) throw new Error('That code is too short to be a MARE link.');
  const flag = trimmed[0];
  if(flag !== 'z' && flag !== 'u') throw new Error('That does not look like a MARE link code.');
  const b64 = trimmed.slice(1).replace(/-/g,'+').replace(/_/g,'/');
  let bin;
  try { bin = atob(b64 + '==='.slice((b64.length + 3) % 4)); }
  catch { throw new Error('That code is damaged — it looks like part of it was cut off.'); }
  let bytes = new Uint8Array(bin.length);
  for(let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  if(flag === 'z'){
    const ds = new DecompressionStream('deflate-raw');
    const w = ds.writable.getWriter(); w.write(bytes).catch(()=>{}); w.close().catch(()=>{});
    const reader=ds.readable.getReader(), chunks=[]; let size=0;
    while(true){
      const {value,done}=await reader.read(); if(done) break;
      size+=value.length;
      if(size>65536){ await reader.cancel(); throw new Error('That link code expands to too much data.'); }
      chunks.push(value);
    }
    bytes=new Uint8Array(size); let offset=0;
    for(const chunk of chunks){ bytes.set(chunk,offset); offset+=chunk.length; }
  }
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new Error('That code is damaged — it did not decode to anything readable.'); }
}

/* Wait for ICE to finish gathering. There is no trickle here: the whole
   description has to be in the code the player pastes, so we block until
   the candidates are in. Capped, because a peer behind a firewall that
   never resolves would otherwise hang the menu forever — a partial
   candidate set still connects on most networks. */
function iceComplete(pc, timeoutMs = 4000){
  if(pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise(resolve => {
    let done = false;
    const finish = () => { if(done) return; done = true; clearTimeout(timer); resolve(); };
    const timer = setTimeout(finish, timeoutMs);
    pc.addEventListener('icegatheringstatechange', () => {
      if(pc.iceGatheringState === 'complete') finish();
    });
    // Safari can reach a full candidate set without ever firing the state
    // change, so watch for the null candidate too.
    pc.addEventListener('icecandidate', e => { if(!e.candidate) finish(); });
  });
}

export class Net {
  constructor(opts = {}){
    this.role = null;              // 'host' | 'guest'
    this.connected = false;
    this.closed = false;
    this.onOpen = opts.onOpen || null;
    this.onClose = opts.onClose || null;
    this.onMessage = opts.onMessage || null;   // (type, payload)
    this.onStatus = opts.onStatus || null;     // (humanReadableString)

    this.pc = null;
    this.stateCh = null;
    this.eventCh = null;

    this.rtt = 0;
    this._pingAt = 0;
    this._pingTimer = null;
    this.bytesOut = 0; this.bytesIn = 0;
    this._winOut = 0; this._winIn = 0; this._winAt = performance.now();
    this.rateOut = 0; this.rateIn = 0;
  }

  _status(s){ this.onStatus?.(s); }

  _makePc(){
    const pc = new RTCPeerConnection({ iceServers: ICE });
    pc.addEventListener('connectionstatechange', () => {
      const s = pc.connectionState;
      if(s === 'failed' || s === 'closed' || s === 'disconnected'){
        if(this.connected){ this.connected = false; this.onClose?.(s); }
      }
    });
    this.pc = pc;
    return pc;
  }

  _wire(ch){
    if(ch.label === 'state'){ this.stateCh = ch; ch.binaryType = 'arraybuffer'; }
    else this.eventCh = ch;
    ch.addEventListener('open', () => {
      if(this.stateCh?.readyState === 'open' && this.eventCh?.readyState === 'open' && !this.connected){
        this.connected = true;
        this._startPing();
        this._status('connected');
        this.onOpen?.();
      }
    });
    ch.addEventListener('close', () => {
      if(this.connected){ this.connected = false; this.onClose?.('channel closed'); }
    });
    ch.addEventListener('message', e => {
      if(typeof e.data !== 'string' || e.data.length>16384) return;
      this._winIn += (typeof e.data === 'string' ? e.data.length : e.data.byteLength || 0);
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if(!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;
      if(msg.t === '__ping'){ if(Number.isFinite(msg.p?.at)) this.send('__pong', { at: msg.p.at }, true); return; }
      if(msg.t === '__pong'){ if(Number.isFinite(msg.p?.at)) this.rtt = performance.now() - msg.p.at; return; }
      this.onMessage?.(msg.t, msg.p);
    });
  }

  /* ── host: produce an invite, then take the reply ─────────── */
  async host(){
    this.role = 'host';
    const pc = this._makePc();
    // The host opens both channels; the guest picks them up via ondatachannel.
    this._wire(pc.createDataChannel('state', {
      ordered: false, maxRetransmits: 0,       // stale positions are worthless
    }));
    this._wire(pc.createDataChannel('event', { ordered: true }));
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    this._status('gathering routes…');
    await iceComplete(pc);
    return pack({ v: 1, r: 'offer', d: pc.localDescription.sdp });
  }

  async acceptAnswer(code){
    const msg = await unpack(code);
    if(msg.r !== 'answer') throw new Error('That is an invite code, not a reply code. You need the code your pilot sent back.');
    await this.pc.setRemoteDescription({ type: 'answer', sdp: msg.d });
    this._status('linking…');
  }

  /* ── guest: take an invite, produce the reply ─────────────── */
  async join(code){
    const msg = await unpack(code);
    if(msg.r !== 'offer') throw new Error('That is a reply code, not an invite. You need the code the sailor generated.');
    this.role = 'guest';
    const pc = this._makePc();
    pc.addEventListener('datachannel', e => this._wire(e.channel));
    await pc.setRemoteDescription({ type: 'offer', sdp: msg.d });
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    this._status('gathering routes…');
    await iceComplete(pc);
    return pack({ v: 1, r: 'answer', d: pc.localDescription.sdp });
  }

  /* ── traffic ──────────────────────────────────────────────── */
  /* reliable=false goes down the lossy channel. Anything that must not be
     lost — a release, a hit, the seed — must pass reliable=true. */
  send(type, payload, reliable = true){
    const ch = reliable ? this.eventCh : this.stateCh;
    if(!ch || ch.readyState !== 'open') return false;
    // A saturated send buffer means the link cannot keep up. Dropping a
    // position update is correct here; dropping an event is not, so those
    // are allowed through and will queue.
    if(!reliable && ch.bufferedAmount > 64 * 1024) return false;
    const s = JSON.stringify({ t: type, p: payload });
    try { ch.send(s); } catch { return false; }
    this._winOut += s.length;
    return true;
  }

  _startPing(){
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if(!this.connected) return;
      this.send('__ping', { at: performance.now() }, true);
      const now = performance.now(), dt = (now - this._winAt) / 1000;
      if(dt >= 1){
        this.rateOut = this._winOut / dt; this.rateIn = this._winIn / dt;
        this.bytesOut += this._winOut; this.bytesIn += this._winIn;
        this._winOut = 0; this._winIn = 0; this._winAt = now;
      }
    }, 1000);
  }

  close(){
    this.closed = true;
    clearInterval(this._pingTimer);
    try { this.stateCh?.close(); } catch {}
    try { this.eventCh?.close(); } catch {}
    try { this.pc?.close(); } catch {}
    this.connected = false;
  }
}
