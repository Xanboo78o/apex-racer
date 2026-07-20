/* Phone controller: steering from the phone's ROLL relative to gravity.
   Gravity is absolute, so this never drifts and doesn't care which way you're facing
   or if the screen re-orients — "center" is just however you're holding it now.
   Broadcasts the steering value to the game over the paired Supabase channel. */
'use strict';

const $ = id => document.getElementById(id);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

let sb = null, channel = null;
let rumbleTarget = 0, rumbleAt = 0, rumbleActive = false, hapticsOn = false;   // vibration from the game
let sens = 28, invert = false;          // full lock at ±sens degrees of roll — small = reactive
let zero = null, steer = 0;
let fx = 0, fy = -9.8, primed = false;  // low-pass filtered gravity (device x, y)
const WHEEL_MAX_DEG = 95;               // on-screen wheel turns up to this at full lock

// prefill code from ?code= if present
const params = new URLSearchParams(location.search);
if (params.get('code')) $('code').value = params.get('code').toUpperCase();

$('connectBtn').addEventListener('click', connect);
$('code').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase(); });

async function connect() {
  const code = ($('code').value || '').trim().toUpperCase();
  if (code.length < 4) { $('connErr').textContent = 'Enter the code from your game screen.'; return; }
  $('connErr').textContent = '';

  // iOS 13+ needs an explicit motion-permission request from a user gesture (this tap)
  try {
    if (typeof DeviceMotionEvent !== 'undefined' &&
        typeof DeviceMotionEvent.requestPermission === 'function') {
      const res = await DeviceMotionEvent.requestPermission();
      if (res !== 'granted') { $('connErr').textContent = 'Motion access denied. Allow it and retry.'; return; }
    }
  } catch (e) { /* non-iOS: no prompt needed */ }

  // best-effort: go fullscreen + force landscape (Android). iOS Safari can't fullscreen a page
  // (Add to Home Screen gives standalone instead); the portrait notice covers orientation there.
  await goFullscreen();

  if (!window.supabase || !window.APEX_CONFIG) { $('connErr').textContent = 'Network config missing.'; return; }
  sb = window.supabase.createClient(APEX_CONFIG.supabaseUrl, APEX_CONFIG.supabaseKey, {
    realtime: { params: { eventsPerSecond: 40 } },
  });
  channel = sb.channel(APEX_CONFIG.channelPrefix + code, {
    config: { broadcast: { self: false }, presence: { key: 'phone' } },
  });

  channel
    .on('broadcast', { event: 'host-ack' }, ({ payload }) => setStatus('ok', '✓ Paired' + (payload && payload.name ? ' with ' + payload.name : '') + ' — roll to steer'))
    .on('broadcast', { event: 'rumble' }, ({ payload }) => { rumbleTarget = clamp((payload && payload.v) || 0, 0, 1); rumbleAt = performance.now(); })
    .on('broadcast', { event: 'track' }, ({ payload }) => buildPhoneTrack(payload))
    .on('broadcast', { event: 'hud' }, ({ payload }) => updatePhoneHud(payload))
    .subscribe(status => {
      if (status === 'SUBSCRIBED') {
        channel.track({ role: 'phone' });
        channel.send({ type: 'broadcast', event: 'hello', payload: {} });
        setStatus('', 'Connected — waiting for game…');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        setStatus('err', 'Connection problem — check signal and retry.');
      }
    });

  window.addEventListener('devicemotion', onMotion);
  startHaptics();                // the connect tap is the gesture that unlocks vibration on Android
  zero = null; primed = false;   // recenter to however it's held now

  $('connectView').classList.add('hidden');
  $('driveView').classList.remove('hidden');
  setStatus('', 'Connecting…');

  // keep-alive: resend latest steering ~20x/s so the game's watchdog stays happy
  setInterval(() => { if (channel) sendSteer(); }, 50);

  // re-announce a few times in case the game subscribes slightly after us
  let tries = 0;
  const hi = setInterval(() => {
    if (!channel || tries++ > 6) return clearInterval(hi);
    channel.send({ type: 'broadcast', event: 'hello', payload: {} });
  }, 700);
}

function setStatus(cls, text) { const s = $('status'); s.className = cls; s.textContent = text; }

// ---------------------------------------------------------------- gravity -> steering
function onMotion(e) {
  const g = e.accelerationIncludingGravity;
  if (!g) return;
  if (!primed) { fx = g.x || 0; fy = g.y || 0; primed = true; }
  else { fx += ((g.x || 0) - fx) * 0.35; fy += ((g.y || 0) - fy) * 0.35; }  // low-pass to kill jitter

  // roll of the phone within its own screen plane, referenced to gravity (absolute, no drift)
  const angle = Math.atan2(fx, fy) * 180 / Math.PI;
  if (zero === null) zero = angle;                     // center = however you're holding it now
  let d = angle - zero;
  if (d > 180) d -= 360; else if (d < -180) d += 360;

  let v = d / sens;
  if (invert) v = -v;
  steer = clamp(v, -1, 1);

  $('wheel').style.transform = `rotate(${(steer * WHEEL_MAX_DEG).toFixed(1)}deg)`;
  const fill = $('steerFill');
  const pct = Math.abs(steer) * 50;
  fill.style.width = pct + '%';
  fill.style.left = steer >= 0 ? '50%' : (50 - pct) + '%';
  fill.style.background = Math.abs(steer) > 0.95 ? '#e23b2e' : '#2f6fe0';

  sendSteer();
}

// ---------------------------------------------------------------- haptics (game -> phone)
// Vibration amplitude isn't controllable on the web, so we fake intensity with a duty cycle:
// higher level = longer pulses + shorter gaps (offroad ≈ continuous shudder; dirt ≈ light patter).
// Re-issued on a short interval because navigator.vibrate is one-shot. (Android only; iOS no-ops.)
function startHaptics() {
  if (hapticsOn || !('vibrate' in navigator)) return;
  hapticsOn = true;
  setInterval(() => {
    const level = (performance.now() - rumbleAt < 500) ? rumbleTarget : 0;   // stale => stop
    if (level <= 0.03) {
      if (rumbleActive) { try { navigator.vibrate(0); } catch (e) {} rumbleActive = false; }
      return;
    }
    const on = Math.round(10 + level * 55);      // 10..65ms buzz
    const off = Math.round(105 - level * 85);    // 105..20ms gap
    const pat = [];
    for (let t = 0; t < 260; t += on + off) pat.push(on, off);
    try { navigator.vibrate(pat); rumbleActive = true; } catch (e) {}
  }, 210);
}

let lastSent = 0;
function sendSteer() {
  if (!channel) return;
  const now = performance.now();
  if (now - lastSent < 33) return;   // ~30Hz cap
  lastSent = now;
  channel.send({ type: 'broadcast', event: 'steer', payload: { v: +steer.toFixed(3) } });
}

// ---------------------------------------------------------------- controls
$('calibBtn').addEventListener('click', () => { zero = null; });   // recenter to current hold
$('sens').addEventListener('input', e => { sens = +e.target.value; });
$('invert').addEventListener('change', e => { invert = e.target.checked; });
$('discBtn').addEventListener('click', () => {
  try { channel && channel.unsubscribe(); } catch (e) {}
  channel = null;
  window.removeEventListener('devicemotion', onMotion);
  rumbleTarget = 0; try { navigator.vibrate && navigator.vibrate(0); } catch (e) {}   // stop buzzing
  try { document.exitFullscreen && document.fullscreenElement && document.exitFullscreen(); } catch (e) {}
  $('driveView').classList.add('hidden');
  $('connectView').classList.remove('hidden');
});

// ---------------------------------------------------------------- fullscreen
async function goFullscreen() {
  const el = document.documentElement;
  const req = el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || el.msRequestFullscreen;
  const fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsEl) {                                   // already fullscreen -> toggle off
    try { (document.exitFullscreen || document.webkitExitFullscreen).call(document); } catch (e) {}
    return;
  }
  if (!req) {                                   // iOS Safari has no page fullscreen API
    setStatus('', 'For fullscreen on iPhone: tap Share ⬆ → “Add to Home Screen”, then open from that icon.');
    return;
  }
  try { await req.call(el); }
  catch (e) { setStatus('err', 'Fullscreen blocked — tap it again, or use Add to Home Screen.'); return; }
  try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); }
  catch (e) { /* lock needs fullscreen / unsupported — CSS portrait notice covers it */ }
}
$('fsBtn').addEventListener('click', () => { goFullscreen(); });

// ---------------------------------------------------------------- HUD from the game (minimap + speed)
let trkBase = null, trkScale = null;   // offscreen track outline + its {s,ox,oz} transform
function buildPhoneTrack(payload) {
  if (!payload || !payload.points || !payload.points.length) return;
  const cv = $('pMini');
  trkBase = document.createElement('canvas');
  trkBase.width = cv.width; trkBase.height = cv.height;
  trkScale = drawTrackThumb(trkBase, payload.points, 'rgba(255,255,255,0.85)');
}
// mirrors main.js drawTrackThumb: fit the control-point loop into the canvas, return {s,ox,oz}.
function drawTrackThumb(cv, pts, color) {
  const ctx = cv.getContext('2d');
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of pts) { minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]); minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]); }
  const pad = 14;
  const s = Math.min((cv.width - pad * 2) / (maxX - minX), (cv.height - pad * 2) / (maxZ - minZ));
  const ox = (cv.width - (maxX - minX) * s) / 2 - minX * s;
  const oz = (cv.height - (maxZ - minZ) * s) / 2 - minZ * s;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = color; ctx.lineWidth = 4; ctx.lineJoin = 'round';
  const P = i => pts[(i + pts.length) % pts.length];
  ctx.beginPath();
  ctx.moveTo(P(0)[0] * s + ox, P(0)[1] * s + oz);
  for (let i = 0; i < pts.length; i++) {
    const a = P(i), b = P(i + 1);
    const mx = (a[0] + b[0]) / 2 * s + ox, mz = (a[1] + b[1]) / 2 * s + oz;
    ctx.quadraticCurveTo(a[0] * s + ox, a[1] * s + oz, mx, mz);
  }
  ctx.closePath(); ctx.stroke();
  ctx.fillStyle = '#ffd23e';
  ctx.beginPath(); ctx.arc(P(0)[0] * s + ox, P(0)[1] * s + oz, 4, 0, 7); ctx.fill();
  return { s, ox, oz };
}
function updatePhoneHud(p) {
  if (!p) return;
  $('pSpeed').textContent = p.s != null ? p.s : 0;
  $('pPos').textContent = p.mode === 'race' ? ('P' + p.pos + '/' + (p.cars ? p.cars.length : '')) : 'Time Trial';
  $('pLap').textContent = 'Lap ' + p.lap + (p.laps ? '/' + p.laps : '');
  const cv = $('pMini'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (trkBase) ctx.drawImage(trkBase, 0, 0);
  if (trkScale && p.cars) {
    for (const c of p.cars) {
      ctx.fillStyle = '#' + (c.c || 'ffffff');
      ctx.beginPath();
      ctx.arc(c.x * trkScale.s + trkScale.ox, c.z * trkScale.s + trkScale.oz, c.p ? 5 : 4, 0, 7);
      ctx.fill();
      if (c.p) { ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5; ctx.stroke(); }
    }
  }
}
