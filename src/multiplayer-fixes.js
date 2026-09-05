/* Small multiplayer UX fixes that sit outside the simulation protocol.
   The network connection is intentionally left alive across local respawns.
*/

function mare(){ return globalThis.MARE || null; }

function multiplayerSession(){
  const m = mare();
  if(!m?.session || !m?.mode?.multiplayer) return null;
  return { m, session:m.session };
}

function updateRespawnUi(){
  const again = document.getElementById('btn-again');
  if(!again) return;
  again.textContent = multiplayerSession() ? 'Respawn' : 'Sail again';
}

function respawnMultiplayer(e){
  const ctx = multiplayerSession();
  if(!ctx) return;

  const { m, session } = ctx;
  const world = session.world;
  if(!world) return;

  // main.js also owns this button for single-player retries. Capture the
  // multiplayer click first so that handler cannot create a fresh random
  // world and desynchronise the two peers.
  e.preventDefault();
  e.stopImmediatePropagation();

  const key = session.role === 'pilot' ? 'mpPilot' : 'mpSailor';
  m.startMode(key, world);
}

function install(){
  const again = document.getElementById('btn-again');
  if(again) again.addEventListener('click', respawnMultiplayer, { capture:true });

  const over = document.getElementById('over');
  if(over){
    new MutationObserver(updateRespawnUi).observe(over, { attributes:true, attributeFilter:['class'] });
  }

  // Link navigation can happen without a full page reload (for example when
  // an invite is pasted into the address bar in an already-open tab). Let the
  // existing join UI consume it instead of leaving the player on the menu.
  addEventListener('hashchange', () => {
    if(!location.hash.includes('join=') || mare()?.session) return;
    document.getElementById('btn-multi')?.click();
    requestAnimationFrame(() => {
      document.getElementById('btn-be-pilot')?.click();
      const input = document.getElementById('multi-offer-in');
      if(input) input.value = location.href;
      document.getElementById('btn-join-link')?.click();
    });
  });

  updateRespawnUi();
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
else install();
