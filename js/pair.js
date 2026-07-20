/* Account (local, device-saved) + phone pairing over Supabase Realtime broadcast.
   The game (this side) is the "host"; the phone joins the same channel (keyed by the
   account code) and broadcasts steering. Only steering crosses the wire. */
'use strict';

// shared with main.js (read there): steering from phone (-1..1) and connection state
let gyroSteer = 0;
let phoneConnected = false;

let account = null;
let sb = null;
let apexChannel = null;
let lastSteerAt = 0;

// ---------------------------------------------------------------- account
function loadAccount() {
  try { return JSON.parse(localStorage.getItem('apex_account') || 'null'); }
  catch (e) { return null; }
}
function genCode() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let c = '';
  const buf = new Uint32Array(6);
  crypto.getRandomValues(buf);
  for (let i = 0; i < 6; i++) c += alphabet[buf[i] % alphabet.length];
  return c;
}
function saveAccount(a) { localStorage.setItem('apex_account', JSON.stringify(a)); }

// Called from main.js boot(). onReady() opens the game menu.
function startAccountFlow(onReady) {
  account = loadAccount();
  const screen = document.getElementById('accountScreen');
  if (account) {
    screen.style.display = 'none';
    updateAccountChip();
    onReady();
    initPairing();
    return;
  }
  screen.style.display = 'flex';
  const input = document.getElementById('usernameInput');
  input.focus();
  window.submitAccount = () => {
    const name = (input.value || '').trim().slice(0, 16);
    if (!name) { input.focus(); input.classList.add('shake'); setTimeout(() => input.classList.remove('shake'), 400); return; }
    account = { username: name, code: genCode(), created: Date.now() };
    saveAccount(account);
    screen.style.display = 'none';
    updateAccountChip();
    onReady();
    initPairing();
  };
  input.addEventListener('keydown', e => { if (e.key === 'Enter') window.submitAccount(); });
}

function updateAccountChip() {
  const chip = document.getElementById('acctChip');
  if (!chip || !account) return;
  document.getElementById('acctName').textContent = account.username;
  document.getElementById('acctCode').textContent = account.code;
  updatePairStatusUI();
}

// ---------------------------------------------------------------- pairing / realtime
function initPairing() {
  try {
    if (!window.supabase || !window.APEX_CONFIG) return;
    sb = window.supabase.createClient(APEX_CONFIG.supabaseUrl, APEX_CONFIG.supabaseKey, {
      realtime: { params: { eventsPerSecond: 40 } },
    });
    const chanName = APEX_CONFIG.channelPrefix + account.code;
    apexChannel = sb.channel(chanName, {
      config: { broadcast: { self: false }, presence: { key: 'game' } },
    });

    apexChannel
      .on('broadcast', { event: 'steer' }, ({ payload }) => {
        gyroSteer = Math.max(-1, Math.min(1, payload.v || 0));
        lastSteerAt = performance.now();
        if (!phoneConnected) { phoneConnected = true; updatePairStatusUI(); }
      })
      .on('broadcast', { event: 'hello' }, () => {
        // phone announced itself — ack so it knows the game is listening
        apexChannel.send({ type: 'broadcast', event: 'host-ack', payload: { name: account.username } });
        phoneConnected = true; updatePairStatusUI();
      })
      .on('presence', { event: 'leave' }, () => {
        // if the phone left presence, drop the connection
        const state = apexChannel.presenceState();
        const hasPhone = Object.values(state).flat().some(p => p.role === 'phone');
        if (!hasPhone) { phoneConnected = false; gyroSteer = 0; updatePairStatusUI(); }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') apexChannel.track({ role: 'game', name: account.username });
      });

    // watchdog: if steering stops arriving for 2.5s, mark disconnected
    setInterval(() => {
      if (phoneConnected && performance.now() - lastSteerAt > 2500) {
        phoneConnected = false; gyroSteer = 0; updatePairStatusUI();
      }
    }, 1000);
  } catch (e) { console.warn('pairing init failed', e); }
}

// game -> phone haptics: broadcast a rumble level (0..1). Throttled to ~12Hz, but fires
// immediately on a meaningful change so surface transitions feel instant. main.js calls this.
let lastRumbleSent = 0, lastRumbleVal = -1;
function sendRumble(level) {
  if (!apexChannel || !phoneConnected) return;
  const now = performance.now();
  if (now - lastRumbleSent < 80 && Math.abs(level - lastRumbleVal) < 0.15) return;
  lastRumbleSent = now; lastRumbleVal = level;
  try { apexChannel.send({ type: 'broadcast', event: 'rumble', payload: { v: +level.toFixed(2) } }); } catch (e) {}
}

function updatePairStatusUI() {
  const dot = document.getElementById('acctDot');
  const modalStatus = document.getElementById('pairStatus');
  if (dot) dot.className = 'dot ' + (phoneConnected ? 'on' : 'off');
  if (modalStatus) {
    modalStatus.textContent = phoneConnected ? '✓ Phone connected — turn to steer' : 'Waiting for phone…';
    modalStatus.className = 'pairStatus ' + (phoneConnected ? 'ok' : '');
  }
}

// ---------------------------------------------------------------- pair modal
window.openPair = () => {
  if (!account) return;
  const url = location.origin + location.pathname.replace(/[^/]*$/, '') + 'phone.html';
  document.getElementById('pairUrl').textContent = url;
  document.getElementById('pairCodeBig').textContent = account.code;
  const qr = document.getElementById('pairQR');
  qr.src = 'https://api.qrserver.com/v1/create-qr-code/?size=180x180&margin=0&data=' + encodeURIComponent(url);
  updatePairStatusUI();
  document.getElementById('pairModal').style.display = 'flex';
};
window.closePair = () => { document.getElementById('pairModal').style.display = 'none'; };
