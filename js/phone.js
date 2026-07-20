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

  // best-effort: force landscape (Android). iOS ignores lock; the CSS notice enforces it there.
  try {
    if (document.documentElement.requestFullscreen) await document.documentElement.requestFullscreen();
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch (e) { /* unsupported / needs fullscreen — the portrait notice covers it */ }

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
  $('driveView').classList.add('hidden');
  $('connectView').classList.remove('hidden');
});
