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
        if (typeof mode !== 'undefined' && mode === 'freeroam') sendWorldToPhone();
        else sendTrackToPhone();                 // give a freshly-joined phone the current map
        sendBrakeConfig();                       // tell the phone whether/where to show a brake button
      })
      .on('broadcast', { event: 'brake' }, ({ payload }) => {
        phoneBrake = !!(payload && payload.v);   // phone brake button pressed/released
      })
      .on('presence', { event: 'leave' }, () => {
        // if the phone left presence, drop the connection
        const state = apexChannel.presenceState();
        const hasPhone = Object.values(state).flat().some(p => p.role === 'phone');
        if (!hasPhone) { phoneConnected = false; gyroSteer = 0; phoneBrake = false; updatePairStatusUI(); }
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') apexChannel.track({ role: 'game', name: account.username });
      });

    // watchdog: if steering stops arriving for 2.5s, mark disconnected
    setInterval(() => {
      if (phoneConnected && performance.now() - lastSteerAt > 2500) {
        phoneConnected = false; gyroSteer = 0; phoneBrake = false; updatePairStatusUI();
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

// game -> phone: send the current track's shape ONCE so the phone can draw its own minimap.
// (track / cars / player / mode / SPEED_DISPLAY_SCALE are globals from main.js — shared scope.)
function sendTrackToPhone() {
  if (!apexChannel || !phoneConnected) return;
  if (typeof track === 'undefined' || !track || !track.def) return;
  try {
    apexChannel.send({ type: 'broadcast', event: 'track', payload: {
      points: track.def.points, laps: track.def.laps || 0, name: track.def.name || '',
    } });
  } catch (e) {}
}

// game -> phone: stream speed + car positions for the phone's HUD (throttled ~12Hz).
let lastTelemAt = 0;
function sendTelemetry() {
  if (!apexChannel || !phoneConnected) return;
  if (typeof player === 'undefined' || !player || typeof cars === 'undefined' || !cars.length) return;
  const now = performance.now();
  if (now - lastTelemAt < 80) return;
  lastTelemAt = now;
  const spd = Math.round(Math.hypot(player.velX, player.velZ) * 3.6 * SPEED_DISPLAY_SCALE);
  let pos = 1;
  if (mode === 'race' && track) {
    const order = [...cars].sort((a, b) => (b.lap * track.N + b.distAcc) - (a.lap * track.N + a.distAcc));
    pos = order.indexOf(player) + 1;
  }
  const cs = cars.map(car => ({
    x: +car.x.toFixed(1), z: +car.z.toFixed(1),
    c: car.isPlayer ? 'ffffff' : car.color.toString(16).padStart(6, '0'),
    p: car.isPlayer ? 1 : 0,
  }));
  try {
    apexChannel.send({ type: 'broadcast', event: 'hud', payload: {
      s: spd, pos, lap: Math.max(1, player.lap + 1),
      laps: track && track.def ? track.def.laps : 0, mode, cars: cs, ph: +player.heading.toFixed(3),
    } });
  } catch (e) {}
}

// game -> phone: switch the phone map to the whole-town view (free-roam). Phone has PEMBROKE locally.
function sendWorldToPhone() {
  if (!apexChannel || !phoneConnected) return;
  try { apexChannel.send({ type: 'broadcast', event: 'world', payload: {} }); } catch (e) {}
}

// game -> phone: where to show the brake button ('off' | 'left' | 'right'), from brakeMode (main.js global).
function sendBrakeConfig() {
  if (!apexChannel || !phoneConnected) return;
  const side = brakeMode === 'phoneL' ? 'left' : brakeMode === 'phoneR' ? 'right' : 'off';
  try { apexChannel.send({ type: 'broadcast', event: 'brakecfg', payload: { side } }); } catch (e) {}
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
