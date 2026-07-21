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
    .on('broadcast', { event: 'brakecfg' }, ({ payload }) => setBrakeSide(payload && payload.side))
    .on('broadcast', { event: 'world' }, () => buildPhoneWorld())
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
  sizeMap();                          // size the full-screen map now that it's visible
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
$('phoneSetBtn').addEventListener('click', () => $('phoneSettings').classList.remove('hidden'));
$('closeSetBtn').addEventListener('click', () => $('phoneSettings').classList.add('hidden'));
$('calibBtn').addEventListener('click', () => { zero = null; $('phoneSettings').classList.add('hidden'); });   // recenter to current hold
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

// ---------------------------------------------------------------- brake pad (game -> phone config)
function setBrakeSide(side) {
  const b = $('brakeBtn');
  b.classList.remove('on', 'left', 'right');
  if (side === 'left' || side === 'right') b.classList.add('on', side);
}
function sendBrake(v) {
  if (channel) { try { channel.send({ type: 'broadcast', event: 'brake', payload: { v: v ? 1 : 0 } }); } catch (e) {} }
}
(function () {
  const b = $('brakeBtn');
  const press = e => { e.preventDefault(); b.classList.add('pressed'); sendBrake(1); };
  const release = e => { if (e) e.preventDefault(); b.classList.remove('pressed'); sendBrake(0); };
  b.addEventListener('pointerdown', press);
  b.addEventListener('pointerup', release);
  b.addEventListener('pointercancel', release);
  b.addEventListener('pointerleave', release);
})();

// ---------------------------------------------------------------- full-screen live map + HUD
// The phone draws a full-screen map: the whole town network (free-roam, from local PEMBROKE data)
// OR a race track outline. The game streams the player/car positions via the 'hud' telemetry.
let mapMode = null, mapT = null, baseCanvas = null, trackPts = null;
function sizeMap() {
  const cv = $('townMap'); if (!cv) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr);
  if (mapMode) rebuildBase();
}
window.addEventListener('resize', sizeMap);
function fit(minX, minZ, maxX, maxZ) {
  const cv = $('townMap'), pad = 18 * (window.devicePixelRatio || 1);
  const s = Math.min((cv.width - 2 * pad) / (maxX - minX || 1), (cv.height - 2 * pad) / (maxZ - minZ || 1));
  return { s, ox: (cv.width - (maxX - minX) * s) / 2 - minX * s, oz: (cv.height - (maxZ - minZ) * s) / 2 - minZ * s };
}
function buildPhoneTrack(payload) {
  if (!payload || !payload.points || !payload.points.length) return;
  mapMode = 'track'; trackPts = payload.points; rebuildBase();
}
function bbOf(pts) { let a = 1e9, b = 1e9, c = -1e9, d = -1e9; for (const p of pts) { if (p[0] < a) a = p[0]; if (p[1] < b) b = p[1]; if (p[0] > c) c = p[0]; if (p[1] > d) d = p[1]; } return [a, b, c, d]; }
function buildPhoneWorld() {
  if (!window.PEMBROKE) return;
  mapMode = 'world';
  const P = window.PEMBROKE;                          // precompute bboxes for view culling (once)
  if (!P._pre) { for (const e of P.edges) e._bb = bbOf(e.pts); for (const w of (P.waterways || [])) w._bb = bbOf(w.pts); for (const w of (P.water || [])) w._bb = bbOf(w.poly); P._pre = 1; }
}
function rebuildBase() {   // track view only (whole loop fits the screen); world draws live & centered
  const cv = $('townMap'); if (!cv.width || mapMode !== 'track' || !trackPts) return;
  baseCanvas = document.createElement('canvas'); baseCanvas.width = cv.width; baseCanvas.height = cv.height;
  const ctx = baseCanvas.getContext('2d'), dpr = window.devicePixelRatio || 1;
  ctx.fillStyle = '#0f151c'; ctx.fillRect(0, 0, cv.width, cv.height);
  let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9; for (const p of trackPts) { mnx = Math.min(mnx, p[0]); mxx = Math.max(mxx, p[0]); mnz = Math.min(mnz, p[1]); mxz = Math.max(mxz, p[1]); }
  mapT = fit(mnx, mnz, mxx, mxz); const T = mapT, X = x => x * T.s + T.ox, Z = z => z * T.s + T.oz, pts = trackPts;
  ctx.strokeStyle = 'rgba(255,255,255,.85)'; ctx.lineWidth = 5 * dpr; ctx.lineJoin = 'round'; ctx.beginPath();
  const G = i => pts[(i + pts.length) % pts.length]; ctx.moveTo(X(G(0)[0]), Z(G(0)[1]));
  for (let i = 0; i < pts.length; i++) { const a = G(i), b = G(i + 1); ctx.quadraticCurveTo(X(a[0]), Z(a[1]), X((a[0] + b[0]) / 2), Z((a[1] + b[1]) / 2)); }
  ctx.closePath(); ctx.stroke();
}
function bbNear(bb, px, pz, hx, hz) { return bb && !(bb[2] < px - hx || bb[0] > px + hx || bb[3] < pz - hz || bb[1] > pz + hz); }
function drawWorldFollow(p) {                          // GPS-style: player centred, zoomed in
  const cv = $('townMap'), ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1, P = window.PEMBROKE;
  const me = (p.cars || []).find(c => c.p) || { x: 0, z: 0 }, px = me.x, pz = me.z, ph = p.ph || 0;
  const scale = cv.height / 1800;                      // ~1.8 km visible top-to-bottom
  const cxp = cv.width / 2, czp = cv.height / 2, X = x => (x - px) * scale + cxp, Z = z => (z - pz) * scale + czp;
  const hx = cxp / scale + 80, hz = czp / scale + 80;
  ctx.fillStyle = '#0f151c'; ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.lineCap = 'round'; ctx.lineJoin = 'round';
  ctx.fillStyle = '#2f5f9e'; for (const w of (P.water || [])) { if (!bbNear(w._bb, px, pz, hx, hz)) continue; ctx.beginPath(); w.poly.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Z(q[1])) : ctx.moveTo(X(q[0]), Z(q[1]))); ctx.fill(); }
  ctx.strokeStyle = '#3a6fc0'; ctx.lineWidth = 4 * dpr; for (const w of (P.waterways || [])) { if (!bbNear(w._bb, px, pz, hx, hz)) continue; ctx.beginPath(); w.pts.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Z(q[1])) : ctx.moveTo(X(q[0]), Z(q[1]))); ctx.stroke(); }
  for (const e of P.edges) { if (!bbNear(e._bb, px, pz, hx, hz)) continue; const big = /motorway|trunk|primary|secondary/.test(e.cls); ctx.lineWidth = (big ? 5 : 3) * dpr; ctx.strokeStyle = big ? '#dbe3ee' : '#8a95a4'; ctx.beginPath(); e.pts.forEach((q, i) => i ? ctx.lineTo(X(q[0]), Z(q[1])) : ctx.moveTo(X(q[0]), Z(q[1]))); ctx.stroke(); }
  ctx.fillStyle = '#e2c34a'; for (const s of (P.schools || [])) { if (Math.abs(s.x - px) > hx || Math.abs(s.z - pz) > hz) continue; ctx.beginPath(); ctx.arc(X(s.x), Z(s.z), 8 * dpr, 0, 7); ctx.fill(); }
  // player arrow (big, at centre, pointing where the car faces)
  const fx = Math.sin(ph), fz = Math.cos(ph), rx = -fz, rz = fx, S = dpr;
  ctx.fillStyle = '#e23b2e'; ctx.strokeStyle = '#fff'; ctx.lineWidth = 3 * S;
  ctx.beginPath();
  ctx.moveTo(cxp + fx * 22 * S, czp + fz * 22 * S);
  ctx.lineTo(cxp - fx * 12 * S + rx * 14 * S, czp - fz * 12 * S + rz * 14 * S);
  ctx.lineTo(cxp - fx * 5 * S, czp - fz * 5 * S);
  ctx.lineTo(cxp - fx * 12 * S - rx * 14 * S, czp - fz * 12 * S - rz * 14 * S);
  ctx.closePath(); ctx.fill(); ctx.stroke();
}
function updatePhoneHud(p) {
  if (!p) return;
  $('pSpeed').textContent = p.s != null ? p.s : 0;
  $('pPos').textContent = p.mode === 'freeroam' ? 'Pembroke' : p.mode === 'race' ? ('P' + p.pos + '/' + (p.cars ? p.cars.length : '')) : 'Time Trial';
  $('pLap').textContent = p.mode === 'freeroam' ? 'Free Roam' : ('Lap ' + p.lap + (p.laps ? '/' + p.laps : ''));
  if (mapMode === 'world') { drawWorldFollow(p); return; }
  const cv = $('townMap'), ctx = cv.getContext('2d'), dpr = window.devicePixelRatio || 1;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (baseCanvas) ctx.drawImage(baseCanvas, 0, 0); else return;
  const T = mapT; if (!T || !p.cars) return;
  for (const c of p.cars) {
    const x = c.x * T.s + T.ox, z = c.z * T.s + T.oz;
    ctx.fillStyle = '#' + (c.c || 'ffffff'); ctx.beginPath(); ctx.arc(x, z, (c.p ? 6 : 4) * dpr, 0, 7); ctx.fill();
    if (c.p) { ctx.strokeStyle = '#111'; ctx.lineWidth = 1.5 * dpr; ctx.stroke(); }
  }
}
