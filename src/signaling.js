import './multiplayer-fixes.js';

/* ────────────────────────────────────────────────────────────────
   Ephemeral signaling broker for frictionless invite links.

   Enables one-click invite links:
     1. Sailor clicks "Sail" → produces WebRTC offer and publishes
        it to an ephemeral match topic.
     2. Sailor shares invite link: https://domain/#join=m_...
     3. Pilot clicks link → automatically fetches the offer, creates
        an answer, publishes it to the reply topic.
     4. Sailor receives the answer and WebRTC peer connection opens.
     5. Signaling cleanly disconnects; all subsequent gameplay traffic
        is direct peer-to-peer WebRTC with zero server involvement.
   ──────────────────────────────────────────────────────────────── */

const RELAY_BASE = 'https://ntfy.sh';

export function createMatchId(){
  const bytes = new Uint8Array(8);
  if(typeof crypto !== 'undefined' && crypto.getRandomValues){
    crypto.getRandomValues(bytes);
  } else {
    for(let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let str = '';
  for(let i = 0; i < bytes.length; i++) str += (bytes[i] % 36).toString(36);
  return 'm_' + str;
}

export function parseJoinParam(raw){
  if(!raw) return null;
  let str = String(raw).trim();
  if(!str) return null;

  // Links are the primary matchmaking surface. Parse them as URLs first so
  // copied links keep working with extra query/hash parameters or encoding.
  try {
    const url = new URL(str, globalThis.location?.href || 'https://mare.invalid/');
    const hash = url.hash.startsWith('#') ? new URLSearchParams(url.hash.slice(1)).get('join') : null;
    const query = url.searchParams.get('join');
    if(hash || query) str = hash || query;
  } catch {}

  // Also accept a bare #join= / ?join= fragment and the existing manual
  // fallback codes for people who cannot use the relay.
  if(str.startsWith('#') || str.startsWith('?')){
    const value = new URLSearchParams(str.slice(1)).get('join');
    if(value) str = value;
  }

  try { str = decodeURIComponent(str); } catch { return null; }
  str = str.split('&')[0].split('#')[0].trim();

  if(/^m_[a-z0-9]{8}$/i.test(str)) return str.toLowerCase();
  if(/^[zu][A-Za-z0-9_-]+$/.test(str)) return str;
  return null;
}

export async function publishSignal(topic, message){
  const res = await fetch(`${RELAY_BASE}/${topic}`, {
    method: 'POST',
    body: message,
    headers: { 'Priority': 'high' }
  });
  if(!res.ok) throw new Error(`Signaling exchange failed (${res.status})`);
}

export class SignalWatcher {
  constructor(topic, onMessage, timeoutMs = 90000){
    this.topic = topic;
    this.onMessage = onMessage;
    this.timeoutMs = timeoutMs;
    this.done = false;
    this.pollTimer = null;
    this.timeoutTimer = null;
    this.es = null;
    this.start();
  }

  deliver(msg){
    if(this.done) return;
    this.close();
    this.onMessage?.(msg);
  }

  async checkPoll(){
    if(this.done) return;
    try {
      const res = await fetch(`${RELAY_BASE}/${this.topic}/json?poll=1&since=10m`);
      if(!res.ok) return;
      const text = await res.text();
      const lines = text.trim().split('\n');
      for(let i = lines.length - 1; i >= 0; i--){
        if(!lines[i]) continue;
        try {
          const item = JSON.parse(lines[i]);
          if(item.event === 'message' && item.message){
            this.deliver(item.message);
            return;
          }
        } catch {}
      }
    } catch {}
  }

  start(){
    this.checkPoll();
    this.pollTimer = setInterval(() => this.checkPoll(), 1500);

    try {
      if(typeof EventSource !== 'undefined'){
        this.es = new EventSource(`${RELAY_BASE}/${this.topic}/sse`);
        this.es.onmessage = e => {
          try {
            const item = JSON.parse(e.data);
            if(item.event === 'message' && item.message){
              this.deliver(item.message);
            }
          } catch {}
        };
        this.es.onerror = () => {
          // Polling continues if SSE has temporary issue
        };
      }
    } catch {}

    this.timeoutTimer = setTimeout(() => {
      if(!this.done){
        this.close();
        this.onTimeout?.();
      }
    }, this.timeoutMs);
  }

  close(){
    this.done = true;
    if(this.pollTimer){ clearInterval(this.pollTimer); this.pollTimer = null; }
    if(this.timeoutTimer){ clearTimeout(this.timeoutTimer); this.timeoutTimer = null; }
    if(this.es){ try { this.es.close(); } catch {} this.es = null; }
  }
}
