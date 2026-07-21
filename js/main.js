/* Apex Racer — cel-shaded 3D racing engine. */
'use strict';

// ---------------------------------------------------------------- constants
const CAR_COLORS = [0xe23b2e, 0x2f6fe0, 0xf0a821, 0x28b45a, 0xe6e8ee, 0x9b30e0, 0x14b8c4, 0xe85d9c,
  0xff7a1a, 0x1fd18b, 0x6c7ae0, 0xd4d21a, 0xb03a2e, 0x3ad0e6];
const HELMET_COLORS = [0xffffff, 0xffd23e, 0x111318, 0xe23b2e, 0x2f6fe0, 0x28b45a, 0x9b30e0, 0xf0a821,
  0xff7a1a, 0x1fd18b, 0xe6e8ee, 0x14b8c4, 0xe85d9c, 0x6c7ae0];
const AI_NAMES = ['Vettori', 'Okonkwo', 'Larsson', 'Tanaka', 'Moreau', 'Novak', 'Alvarez',
  'Bianchi', 'Kowalski', 'Nakamura', 'Ferreira', 'Haugen', 'Delacroix'];
const N_SAMPLES = 1400;
const SUBSTEPS = 3;
const SPEED_DISPLAY_SCALE = 0.45;   // the car really moves fast; show a friendlier number (~200 top)

// Terrain + banking tuning
const BANK_GAIN = 18;               // curvature -> cross-slope; higher = more banked corners
const BANK_MAX = 0.2;               // max cross-slope (tan of bank angle) ~11 degrees
const CORRIDOR = 90;                // metres of flat blend from track edge into the hills
// Hard mode: same displayed number, but the world rushes at you and the fog is tight.
let hardMode = localStorage.getItem('apex_hard') === '1';
let paceMul = 1, fogMul = 1;        // set per-race from hardMode
// Customization / control settings
let playerVehicle = localStorage.getItem('apex_vehicle') || 'f1';           // f1|kart|rally|bike|monster
let brakeMode = localStorage.getItem('apex_brakeMode') || 'mouse';          // mouse | phoneL | phoneR
// WebHID pedals (gas + brake), each a dedicated device read directly. We treat ONGOING report
// activity as "the pedal is being pushed" — a foot pressing a pedal jitters the mouse, so reports
// stream while pushed and STOP when the foot lifts; the pedal releases HID_TIMEOUT ms after the
// last report. This is the "check if still being pushed, else let off" behaviour.
const HID_TIMEOUT = 200;
let hidGasDev = null, hidBrakeDev = null, hidGasLast = -1e9, hidBrakeLast = -1e9;
let phoneBrake = false;                       // brake button on the phone controller
const COAST_BRAKE = 0.22;                      // gentle engine-braking when off the gas ("slow a little")

// camera modes
const CAM_CHASE = 0, CAM_COCKPIT = 1, CAM_FAR = 2;
const CAM_NAMES = ['Chase', 'Cockpit', 'Cinematic'];

const PHYS = {
  wheelbase: 3.1,
  engineAccel: 46,      // u/s^2 — genuinely fast; the HUD number is scaled for readout
  brakeAccel: 70,
  reverseAccel: 15,
  reverseMax: 22,
  drag: 0.0031,         // real top ~440 km/h of world speed; shown as ~200 via SPEED_DISPLAY_SCALE
  rolling: 0.7,
  aLatMax: 64,          // high grip -> planted, forgiving (arcade F1)
  steerOver: 1.08,      // little slack past grip -> predictable, few spins
  downforce: 0.16,      // grip gain per (u/s), sticks at speed
  handbrakeGrip: 0.3,   // rear grip multiplier while handbraking
  stability: 6.0,       // self-straightening when you're not steering
};

const SURFACES = {
  asphalt: { grip: 1.0, accelMul: 1.0, dragMul: 1.0 },
  dirt:    { grip: 0.66, accelMul: 0.9, dragMul: 1.05 },
  grass:   { grip: 0.4, accelMul: 0.42, dragMul: 2.8 },
  sand:    { grip: 0.34, accelMul: 0.36, dragMul: 3.6 },
};

const ENVS = {
  meadow: { ground: 0x62ab3e, ground2: 0x4d8a30, sky: 0x9fd2ff, top: 0x2f74cf, horizon: 0xcfe8ff, fog: 1700, scatter: 'trees', dense: 1.0 },
  forest: { ground: 0x4f9a3d, ground2: 0x3c7c2c, sky: 0x9fd2ff, top: 0x2c6ec6, horizon: 0xcbe6ff, fog: 1500, scatter: 'trees', dense: 1.4 },
  desert: { ground: 0xd6ad6a, ground2: 0xc09452, sky: 0xf3dcab, top: 0x6f9fd6, horizon: 0xf6e6bf, fog: 1500, scatter: 'rocks', dense: 0.6 },
  city:   { ground: 0x6a707a, ground2: 0x585e68, sky: 0xc2cee0, top: 0x6a7a94, horizon: 0xd4dde8, fog: 1300, scatter: 'buildings', dense: 0.5 },
  // rural New Hampshire: patchwork fields, forest, scattered farms, a river. Composite scatter.
  countryside: { ground: 0x6fae43, ground2: 0x548a31, sky: 0x9fd2ff, top: 0x2f74cf, horizon: 0xcfe8ff, fog: 2100, scatter: 'countryside', dense: 1.15 },
  oval:   { ground: 0x62ab3e, ground2: 0x4d8a30, sky: 0x9fd2ff, top: 0x2f74cf, horizon: 0xcfe8ff, fog: 2000, scatter: 'stands', dense: 0.7 },
};

// ---------------------------------------------------------------- globals
let renderer, scene, camera, dirLight;
let track = null;
let cars = [];
let player = null;
let state = 'menu';
let mode = 'race';
let countdownT = 0, raceTime = 0, pausedFrom = null;
let camMode = CAM_CHASE;
let muted = false;
let steerInvert = localStorage.getItem('apex_steerInvert') === '1';
let mouseThrottle = false, mouseBrake = false;   // click-and-hold pedals (held state)
let throttlePedal = 0, brakePedal = 0;           // analog pedal travel — eases in/out, not on/off
// gyroSteer + phoneConnected live in pair.js (phone controller)
let GRAD = null, OUTLINE_MAT = null;
const keys = {};
const clock = new THREE.Clock();
const tmpV = new THREE.Vector3();
const _n = new THREE.Vector3(), _f = new THREE.Vector3(), _r = new THREE.Vector3(), _m = new THREE.Matrix4();
let toastT = 0;

// ---------------------------------------------------------------- toon helpers
function makeGradientMap() {
  const steps = new Uint8Array([70, 130, 190, 245]);
  const t = new THREE.DataTexture(steps, steps.length, 1, THREE.RedFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter;
  t.needsUpdate = true;
  return t;
}
function toonMat(color, opts = {}) {
  return new THREE.MeshToonMaterial(Object.assign({ color, gradientMap: GRAD }, opts));
}

// Inverted-hull outline: clone each mesh, black back-faces, scaled a touch.
function addOutlines(group, thickness = 1.06) {
  const clones = [];
  group.traverse(o => {
    if (o.isMesh && !o.userData.isOutline) clones.push(o);
  });
  for (const m of clones) {
    const o = new THREE.Mesh(m.geometry, OUTLINE_MAT);
    o.position.copy(m.position);
    o.rotation.copy(m.rotation);
    o.scale.copy(m.scale).multiplyScalar(thickness);
    o.castShadow = false;
    o.userData.isOutline = true;
    m.parent.add(o);
  }
}

const rand01 = () => Math.random();
const rand = (a, b) => a + Math.random() * (b - a);

// ---------------------------------------------------------------- terrain field
// Smooth low-frequency "rolling hills" field, amplitude scaled per track (def.hills).
function ambientHills(x, z, amp) {
  if (!amp) return 0;
  return (Math.sin(x * 0.0022 + 0.3) * Math.cos(z * 0.0019 - 0.8) * 46 +
          Math.sin(x * 0.0051 - 1.1) * Math.cos(z * 0.0047 + 0.5) * 17 +
          Math.sin(x * 0.0115 + 2.0) * Math.sin(z * 0.0102 - 0.3) * 4.5) * amp;
}
// World surface height: follows the banked road surface near the track (so banking reads
// as an earth berm), then blends out into the open rolling hills.
function terrainHeight(x, z) {
  if (!track || !track.nearestInfo) return 0;
  const info = track.nearestInfo(x, z);
  const i = info.i, r = track.rights[i], sp = track.samples[i];
  const lat = (x - sp.x) * r.x + (z - sp.z) * r.z;
  const bankFall = THREE.MathUtils.clamp(1 - (info.d - track.halfW - 2) / 12, 0, 1);
  const base = sp.y + lat * track.bank[i] * bankFall;   // banked plane on/near the road
  const corr = track.halfW + 8;
  const t = THREE.MathUtils.clamp((info.d - corr) / CORRIDOR, 0, 1);
  const e = t * t * (3 - 2 * t);
  return base + ambientHills(x, z, track.def.hills || 0) * e;
}

// ---------------------------------------------------------------- boot
function boot() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setSize(innerWidth, innerHeight);
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  document.getElementById('game').appendChild(renderer.domElement);

  GRAD = makeGradientMap();
  OUTLINE_MAT = new THREE.MeshBasicMaterial({ color: 0x0a0b0d, side: THREE.BackSide });

  camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 5000);

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
  });
  addEventListener('keydown', e => {
    if (e.code === 'Space') e.preventDefault();
    if (e.repeat) return;
    keys[e.key.toLowerCase()] = true;
    if (e.code === 'Space') keys[' '] = true;
    onKey(e.key.toLowerCase());
    initAudio();
  });
  addEventListener('keyup', e => {
    keys[e.key.toLowerCase()] = false;
    if (e.code === 'Space') keys[' '] = false;
  });
  // click / press-and-hold = throttle (left button = gas, right button = brake).
  addEventListener('pointerdown', e => {
    initAudio();                                              // any gesture unlocks WebAudio
    if (e.target.closest && e.target.closest('button, a, input, select, textarea')) return;  // UI: don't rev
    if (e.button === 0) mouseThrottle = true;
    else if (e.button === 2) mouseBrake = true;
  });
  addEventListener('pointerup', e => {
    if (e.button === 0 || !(e.buttons & 1)) mouseThrottle = false;
    if (e.button === 2 || !(e.buttons & 2)) mouseBrake = false;
  });
  addEventListener('pointercancel', () => { mouseThrottle = mouseBrake = false; });
  // clear held state on focus loss (mouse + keyboard) so nothing sticks on
  const clearHeld = () => { mouseThrottle = mouseBrake = false; for (const k in keys) keys[k] = false; };
  addEventListener('blur', clearHeld);
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearHeld(); });
  addEventListener('contextmenu', e => { if (state === 'race' || state === 'tt') e.preventDefault(); });
  updateInvertBtn();
  initPedals();                                 // reconnect previously-paired WebHID gas/brake pedals
  startAccountFlow(() => buildMenu());
  requestAnimationFrame(loop);
}

function onKey(k) {
  if (k === 'escape') {
    if (state === 'race' || state === 'tt' || state === 'countdown') pauseGame();
    else if (state === 'paused') resumeGame();
    return;
  }
  if (state !== 'race' && state !== 'tt') return;
  if (k === 'r') resetCar(player);
  if (k === 'c') { camMode = (camMode + 1) % 3; toast('Camera: ' + CAM_NAMES[camMode]); }
  if (k === 'm') { muted = !muted; if (audio.master) audio.master.gain.value = muted ? 0 : 0.5; toast(muted ? 'Muted' : 'Sound on'); }
}

// Steering input: keyboard (A/D) plus the paired phone wheel (gyroSteer, -1..1).
function playerSteer() {
  let s = ((keys['a'] || keys['arrowleft']) ? 1 : 0) + ((keys['d'] || keys['arrowright']) ? -1 : 0);
  if (phoneConnected) s += gyroSteer;
  s = THREE.MathUtils.clamp(s, -1, 1);
  return steerInvert ? -s : s;
}

// ---------------------------------------------------------------- menu / ui
const $ = id => document.getElementById(id);

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.style.opacity = '1';
  toastT = 1.2;
}

function buildMenu() {
  const grid = $('trackGrid');
  grid.innerHTML = '';
  for (const def of TRACKS) {
    const card = document.createElement('div');
    card.className = 'card';
    const cv = document.createElement('canvas');
    cv.width = 180; cv.height = 110;
    drawTrackThumb(cv, def);
    const best = localStorage.getItem('apex_best_' + def.id);
    card.appendChild(cv);
    card.insertAdjacentHTML('beforeend',
      `<div class="cardName">${def.name}</div>
       <div class="cardDesc">${def.desc}</div>
       <div class="cardBest">${best ? 'Best lap: ' + fmtTime(+best) : 'No best lap yet'}</div>
       <div class="cardBtns">
         <button data-mode="race">Race</button>
         <button data-mode="tt">Time Trial</button>
       </div>`);
    card.querySelectorAll('button').forEach(b =>
      b.addEventListener('click', () => startGame(def, b.dataset.mode)));
    grid.appendChild(card);
  }
  $('menu').style.display = 'flex';
  $('acctChip').style.display = 'flex';
  updateHardBtn();
  if (typeof updateAccountChip === 'function') updateAccountChip();
}

function updateHardBtn() {
  const b = $('hardBtn');
  if (!b) return;
  b.textContent = 'Difficulty: ' + (hardMode ? 'Hard' : 'Normal');
  b.classList.toggle('hard', hardMode);
}
window.toggleHard = () => {
  hardMode = !hardMode;
  localStorage.setItem('apex_hard', hardMode ? '1' : '0');
  updateHardBtn();
  toast(hardMode ? 'Hard mode — it comes at you fast' : 'Normal mode');
};

// ---------------------------------------------------------------- settings modal
function buildSettings() {
  // vehicle picker
  const vg = $('vehicleGrid');
  if (vg) {
    vg.innerHTML = '';
    for (const v of VEHICLES) {
      const b = document.createElement('button');
      b.className = 'vehBtn' + (v === playerVehicle ? ' sel' : '');
      b.textContent = VEHICLE_LABELS[v];
      b.onclick = () => {
        playerVehicle = v; localStorage.setItem('apex_vehicle', v);
        [...vg.children].forEach(c => c.classList.remove('sel'));
        b.classList.add('sel');
      };
      vg.appendChild(b);
    }
  }
  // brake mode
  document.querySelectorAll('#brakeRow button').forEach(b => {
    b.classList.toggle('sel', b.dataset.brake === brakeMode);
    b.onclick = () => {
      brakeMode = b.dataset.brake; localStorage.setItem('apex_brakeMode', brakeMode);
      document.querySelectorAll('#brakeRow button').forEach(x => x.classList.toggle('sel', x === b));
      if (typeof sendBrakeConfig === 'function') sendBrakeConfig();   // tell the phone
    };
  });
  const noHid = !('hid' in navigator);
  const gs = $('gasStatus'), bs = $('brakeStatus');
  if (gs) gs.textContent = hidGasDev ? '✓ gas pedal paired' : (noHid ? 'needs Chrome/Edge' : '');
  if (bs) bs.textContent = hidBrakeDev ? '✓ brake pedal paired' : (noHid ? 'needs Chrome/Edge' : '');
}
window.openSettings = () => { buildSettings(); $('settingsModal').style.display = 'flex'; };
window.closeSettings = () => { $('settingsModal').style.display = 'none'; };

// ---------------------------------------------------------------- WebHID pedals (gas + brake)
function hidSig(d) { return `${d.vendorId}:${d.productId}:${d.productName || ''}`; }
async function connectHid(dev, which) {
  try {
    if (!dev.opened) await dev.open();
    if (which === 'gas') hidGasDev = dev; else hidBrakeDev = dev;
    // IMPORTANT: mice stream reports continuously even when idle, so we can't treat "a report
    // arrived" as "being pushed" (that never stops -> infinite throttle). Instead look at the
    // report CONTENT: a button held (byte0 low bits) OR real movement (any later byte nonzero).
    // Idle/zero reports do NOT count, so lifting off makes the content go quiet -> pedal releases.
    dev.oninputreport = (e) => {
      const d = e.data;
      let active = (d.byteLength ? d.getUint8(0) : 0) & 0x07;   // left|right|middle button held
      for (let i = 1; !active && i < d.byteLength; i++) if (d.getUint8(i) !== 0) active = 1;  // any movement/scroll
      if (active) { const t = performance.now(); if (which === 'gas') hidGasLast = t; else hidBrakeLast = t; }
      // live monitor (only while Settings is open) so we can see the raw report
      const mon = document.getElementById('pedalMon');
      if (mon && $('settingsModal').style.display === 'flex') {
        const bytes = []; for (let i = 0; i < Math.min(d.byteLength, 6); i++) bytes.push(d.getUint8(i).toString(16).padStart(2, '0'));
        mon._n = (mon._n || 0) + 1;
        mon.textContent = `${which}: rid=${e.reportId} bytes=[${bytes.join(' ')}] active=${active ? 1 : 0} reports=${mon._n}`;
      }
    };
    return true;
  } catch (e) { return false; }
}
async function pairHid(which) {
  if (!('hid' in navigator)) { toast('WebHID needs Chrome or Edge'); return; }
  try {
    const devs = await navigator.hid.requestDevice({ filters: [] });
    if (!devs || !devs.length) return;
    const ok = await connectHid(devs[0], which);
    if (ok) {
      localStorage.setItem(which === 'gas' ? 'apex_hidGas' : 'apex_hidBrake', hidSig(devs[0]));
      toast((which === 'gas' ? 'Gas' : 'Brake') + ' pedal paired ✓');
    } else toast('Could not read that device');
    buildSettings();
  } catch (e) { toast('Pairing cancelled'); }
}
window.pairPedal = () => pairHid('gas');
window.pairBrake = () => pairHid('brake');
async function initPedals() {
  if (!('hid' in navigator)) return;
  try {
    const devs = await navigator.hid.getDevices();
    if (!devs || !devs.length) return;
    const gasSig = localStorage.getItem('apex_hidGas');
    const brakeSig = localStorage.getItem('apex_hidBrake');
    const used = new Set();
    // match remembered device signatures; two identical mice just take first-available
    for (const d of devs) {
      if (gasSig && !hidGasDev && hidSig(d) === gasSig && !used.has(d)) { await connectHid(d, 'gas'); used.add(d); }
      else if (brakeSig && !hidBrakeDev && hidSig(d) === brakeSig && !used.has(d)) { await connectHid(d, 'brake'); used.add(d); }
    }
  } catch (e) {}
}

function drawTrackThumb(cv, def, color = '#e8e4da') {
  const ctx = cv.getContext('2d');
  const pts = def.points;
  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of pts) {
    minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
    minZ = Math.min(minZ, p[1]); maxZ = Math.max(maxZ, p[1]);
  }
  const pad = 12;
  const s = Math.min((cv.width - pad * 2) / (maxX - minX), (cv.height - pad * 2) / (maxZ - minZ));
  const ox = (cv.width - (maxX - minX) * s) / 2 - minX * s;
  const oz = (cv.height - (maxZ - minZ) * s) / 2 - minZ * s;
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  const P = i => pts[(i + pts.length) % pts.length];
  ctx.moveTo(P(0)[0] * s + ox, P(0)[1] * s + oz);
  for (let i = 0; i < pts.length; i++) {
    const a = P(i), b = P(i + 1);
    const mx = (a[0] + b[0]) / 2 * s + ox, mz = (a[1] + b[1]) / 2 * s + oz;
    ctx.quadraticCurveTo(a[0] * s + ox, a[1] * s + oz, mx, mz);
  }
  ctx.closePath();
  ctx.stroke();
  ctx.fillStyle = '#ffd23e';
  ctx.beginPath();
  ctx.arc(P(0)[0] * s + ox, P(0)[1] * s + oz, 3.4, 0, 7);
  ctx.fill();
  return { s, ox, oz };
}

function fmtTime(ms) {
  if (ms == null || !isFinite(ms)) return '--:--.---';
  const m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60, t = Math.floor(ms % 1000);
  return `${m}:${String(s).padStart(2, '0')}.${String(t).padStart(3, '0')}`;
}

function pauseGame() { pausedFrom = state; state = 'paused'; MUSIC.playing = false; $('pause').style.display = 'flex'; }
function resumeGame() {
  state = pausedFrom; $('pause').style.display = 'none'; clock.getDelta();
  if (audio.ctx && MUSIC.song && (state === 'race' || state === 'tt' || state === 'countdown')) { MUSIC.playing = true; MUSIC.nextT = audio.ctx.currentTime + 0.1; }
}

// ---------------------------------------------------------------- textures
function makeRoadTexture(surface) {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 256;
  const x = c.getContext('2d');
  if (surface === 'dirt') {
    x.fillStyle = '#7d5a34';
    x.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 1400; i++) {
      const v = 0.5 + Math.random() * 0.5;
      x.fillStyle = `rgba(${90 * v | 0},${64 * v | 0},${34 * v | 0},.5)`;
      x.fillRect(Math.random() * 64, Math.random() * 256, 2, 2);
    }
    // two darker tyre ruts
    x.fillStyle = 'rgba(60,42,22,.35)';
    x.fillRect(18, 0, 6, 256); x.fillRect(40, 0, 6, 256);
  } else {
    x.fillStyle = '#565a61';
    x.fillRect(0, 0, 64, 256);
    for (let i = 0; i < 1600; i++) {
      const g = 74 + Math.random() * 46 | 0;
      x.fillStyle = `rgba(${g},${g + 4},${g + 8},.25)`;
      x.fillRect(Math.random() * 64, Math.random() * 256, 2, 2);
    }
    // solid white edge lines
    x.fillStyle = '#eef0f2';
    x.fillRect(3, 0, 3, 256); x.fillRect(58, 0, 3, 256);
    // dashed centre line
    x.fillStyle = '#f2e14a';
    for (let y = 0; y < 256; y += 64) x.fillRect(30, y, 4, 34);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.anisotropy = renderer.capabilities.getMaxAnisotropy();
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------------------------------------------------------------- track build
function disposeScene() {
  if (!scene) return;
  scene.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    if (o.material && !o.userData.isOutline) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => m.dispose && m.dispose());
  });
}

function buildTrack(def) {
  disposeScene();
  scene = new THREE.Scene();
  const env = ENVS[def.env];
  scene.background = new THREE.Color(env.sky);
  scene.fog = new THREE.Fog(env.horizon || env.sky, env.fog * 0.85 * fogMul, env.fog * 2.3 * fogMul);

  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x4a5236, 0.72));
  dirLight = new THREE.DirectionalLight(0xfff4e2, 1.4);
  dirLight.position.set(120, 200, 90);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.bias = -0.0004;
  const sc = dirLight.shadow.camera;
  sc.left = -120; sc.right = 120; sc.top = 120; sc.bottom = -120;
  sc.near = 20; sc.far = 520;
  scene.add(dirLight, dirLight.target);

  // centerline samples — 'centripetal' (not uniform 'catmullrom') so unevenly-spaced
  // control points (long straight -> tight corner) can't overshoot into loops/cusps.
  const curvePts = def.points.map(p => new THREE.Vector3(p[0], p[2] || 0, p[1]));
  const curve = new THREE.CatmullRomCurve3(curvePts, true, 'centripetal');
  const raw = curve.getSpacedPoints(N_SAMPLES);
  raw.pop();
  const N = raw.length;
  const samples = [], tangents = [], rights = [];
  for (let i = 0; i < N; i++) {
    const p = raw[i], q = raw[(i + 1) % N];
    const t = tmpV.copy(q).sub(p); t.y = 0; t.normalize();
    samples.push(p.clone());
    tangents.push(t.clone());
    rights.push(new THREE.Vector3(t.z, 0, -t.x));
  }
  const ds = curve.getLength() / N;

  // elevation: bake the rolling-hills field into the centerline so the track climbs and
  // dips with the land (control-point y, e.g. Suzuka's bridge, is preserved and added to).
  for (let i = 0; i < N; i++)
    samples[i].y += ambientHills(samples[i].x, samples[i].z, def.hills || 0);

  // signed curvature (turn direction) + magnitude
  const kSigned = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const a = tangents[(i - 4 + N) % N], b = tangents[(i + 4) % N];
    const cross = a.z * b.x - a.x * b.z;            // (a × b).y
    const ang = Math.acos(THREE.MathUtils.clamp(a.dot(b), -1, 1));
    kSigned[i] = Math.sign(cross) * ang / (8 * ds);
  }
  const kappa = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = -6; j <= 6; j++) s += Math.abs(kSigned[(i + j + N) % N]);
    kappa[i] = s / 13;
  }

  // banking: corners tilt inward (cross-slope), smoothed so it eases in and out
  const bank = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = -18; j <= 18; j++) s += kSigned[(i + j + N) % N];
    bank[i] = THREE.MathUtils.clamp(-(s / 37) * BANK_GAIN, -BANK_MAX, BANK_MAX);
  }
  // longitudinal grade (for pitching the car nose up/down over crests and dips)
  const grade = new Float32Array(N);
  for (let i = 0; i < N; i++)
    grade[i] = (samples[(i + 3) % N].y - samples[(i - 3 + N) % N].y) / (6 * ds);

  // spatial hash of the centerline: nearest distance + road height at any (x,z)
  const cellSize = 44, hash = new Map();
  for (let i = 0; i < N; i++) {
    const p = samples[i];
    const k = Math.floor(p.x / cellSize) + ',' + Math.floor(p.z / cellSize);
    if (!hash.has(k)) hash.set(k, []);
    hash.get(k).push(i);
  }
  const nearestInfo = (x, z) => {
    let bestD = 1e9, bestI = 0;
    const cx = Math.floor(x / cellSize), cz = Math.floor(z / cellSize);
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) {
        const arr = hash.get((cx + i) + ',' + (cz + j));
        if (arr) for (const s of arr) {
          const p = samples[s], d = Math.hypot(p.x - x, p.z - z);
          if (d < bestD) { bestD = d; bestI = s; }
        }
      }
    if (bestD > 1e8) {   // far cell miss: fall back to a coarse full scan
      for (let s = 0; s < N; s += 5) {
        const p = samples[s], d = Math.hypot(p.x - x, p.z - z);
        if (d < bestD) { bestD = d; bestI = s; }
      }
    }
    return { d: bestD, y: samples[bestI].y, i: bestI };
  };

  const halfW = def.width / 2;

  // racing line: hug the inside of corners, smoothed into entry/exit
  const kRef = 0.012, maxOff = halfW * 0.72;
  const rawOff = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    // smooth signed curvature locally for a stable direction
    let s = 0;
    for (let j = -6; j <= 6; j++) s += kSigned[(i + j + N) % N];
    const ks = s / 13;
    rawOff[i] = THREE.MathUtils.clamp(ks / kRef, -1, 1) * maxOff;
  }
  const raceOffset = new Float32Array(N);
  const W = 45;
  for (let i = 0; i < N; i++) {
    let s = 0;
    for (let j = -W; j <= W; j++) s += rawOff[(i + j + N) % N];
    raceOffset[i] = s / (2 * W + 1);
  }

  // AI speed profile along the racing line — uses the SAME limits the player's car has,
  // so the field can actually keep up. Straight-line cap = the player's terminal velocity;
  // corner speed accounts for downforce grip (solved by iteration).
  const surf = SURFACES[def.surface];
  const vTerminal = Math.sqrt(PHYS.engineAccel * paceMul * surf.accelMul / (PHYS.drag * surf.dragMul));
  const vmax = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const k = Math.max(kappa[i], 1e-4);
    let v = Math.sqrt(PHYS.aLatMax * surf.grip / k);
    for (let it = 0; it < 2; it++) {
      const g = surf.grip * (1 + PHYS.downforce * Math.min(v / 40, 1.4));
      v = Math.sqrt(PHYS.aLatMax * g / k);
    }
    vmax[i] = Math.min(vTerminal * 1.1, v);   // headroom so the fast tier's cap (up to ~200) can bind, not this
  }
  for (let pass = 0; pass < 3; pass++)
    for (let i = 2 * N - 1; i >= 0; i--) {
      const j = i % N, k = (i + 1) % N;
      vmax[j] = Math.min(vmax[j], Math.sqrt(vmax[k] * vmax[k] + 2 * 42 * surf.grip * ds));
    }

  track = { def, samples, tangents, rights, kappa, kSigned, bank, grade, raceOffset, vmax, N, ds, halfW,
            nearestInfo,
            distToTrack: (x, z) => nearestInfo(x, z).d,
            lapLen: curve.getLength(),
            outerLimit: def.walls ? halfW + 1.1 : (def.env === 'oval' ? halfW + 2.4 : halfW + 30) };

  buildRoadMeshes(def, env);
  buildEnvironment(def, env);
  buildMinimap(def);
}

function stripGeometry(offA, offB, yOff, colorFn, uv) {
  const { samples, rights, bank, N, ds } = track;
  const pos = [], idx = [], col = [], uvs = [];
  const vScale = ds / 16;   // one texture tile ~16m along the road
  for (let i = 0; i <= N; i++) {
    const j = i % N;
    const p = samples[j], r = rights[j], b = bank[j];
    pos.push(p.x + r.x * offA, p.y + yOff + offA * b, p.z + r.z * offA,
             p.x + r.x * offB, p.y + yOff + offB * b, p.z + r.z * offB);
    if (colorFn) { const c = colorFn(j); col.push(c.r, c.g, c.b, c.r, c.g, c.b); }
    if (uv) uvs.push(0, i * vScale, 1, i * vScale);
    if (i < N) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (colorFn) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

function buildRoadMeshes(def, env) {
  const { halfW, kappa, N, samples, tangents, rights, bank } = track;
  const isDirt = def.surface === 'dirt';

  const roadTex = makeRoadTexture(def.surface);
  const road = new THREE.Mesh(
    stripGeometry(-halfW, halfW, 0.0, null, true),           // road sits on the ground
    toonMat(0xffffff, { map: roadTex, side: THREE.DoubleSide }));
  road.receiveShadow = true;
  scene.add(road);

  // dark verge so the road edge reads against grass
  const vergeMat = toonMat(isDirt ? 0x5f4526 : 0x3a3d42, { side: THREE.DoubleSide });
  scene.add(new THREE.Mesh(stripGeometry(-halfW - 1.8, -halfW, -0.01, null, false), vergeMat));
  scene.add(new THREE.Mesh(stripGeometry(halfW, halfW + 1.8, -0.01, null, false), vergeMat));

  // kerbs on curvy sections
  const red = new THREE.Color(0xd0342c), white = new THREE.Color(0xece8e0);
  const kerbTh = isDirt ? 999 : 0.004;
  const kerbCol = j => (Math.floor(j / 4) % 2 ? red : white);
  const kerbMat = toonMat(0xffffff, { vertexColors: true });
  let i = 0;
  while (i < N) {
    if (kappa[i] > kerbTh) {
      let j = i;
      while (j < N && kappa[j % N] > kerbTh * 0.6) j++;
      if (j - i > 8) {
        for (const side of [-1, 1]) {
          const pos = [], idx = [], col = [];
          for (let k = i; k <= j; k++) {
            const m = k % N;
            const p = samples[m], r = rights[m], b = bank[m];
            const o1 = side * halfW, o2 = side * (halfW + 1.3);
            pos.push(p.x + r.x * o1, p.y + 0.1 + o1 * b, p.z + r.z * o1,
                     p.x + r.x * o2, p.y + 0.07 + o2 * b, p.z + r.z * o2);
            const c = kerbCol(k);
            col.push(c.r, c.g, c.b, c.r, c.g, c.b);
            if (k < j) { const a = (k - i) * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
          }
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
          g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
          g.setIndex(idx);
          g.computeVertexNormals();
          scene.add(new THREE.Mesh(g, kerbMat));
        }
      }
      i = j + 1;
    } else i++;
  }

  // start / finish checkered
  const p0 = samples[0], r0 = rights[0], t0 = tangents[0];
  const cell = (halfW * 2) / 10;
  const bMat = new THREE.MeshBasicMaterial({ color: 0x14171c });
  const wMat = new THREE.MeshBasicMaterial({ color: 0xf2f2f2 });
  for (let row = 0; row < 2; row++)
    for (let c = 0; c < 10; c++) {
      const q = new THREE.Mesh(new THREE.PlaneGeometry(cell, cell), (row + c) % 2 ? bMat : wMat);
      q.rotation.x = -Math.PI / 2;
      const lat = -halfW + cell * (c + 0.5);
      q.position.set(p0.x + r0.x * lat + t0.x * cell * row, p0.y + 0.11,
                     p0.z + r0.z * lat + t0.z * cell * row);
      scene.add(q);
    }

  // gantry + start lights
  const gMat = toonMat(0x2b2e33);
  const gantry = new THREE.Group();
  for (const side of [-1, 1]) {
    const pil = new THREE.Mesh(new THREE.BoxGeometry(0.8, 8, 0.8), gMat);
    pil.position.set(r0.x * side * (halfW + 2), 4, r0.z * side * (halfW + 2));
    pil.castShadow = true;
    gantry.add(pil);
  }
  const beam = new THREE.Mesh(new THREE.BoxGeometry((halfW + 2) * 2 + 1, 1.2, 1), gMat);
  beam.position.y = 7.6;
  beam.rotation.y = Math.atan2(r0.x, r0.z) + Math.PI / 2;
  gantry.add(beam);
  track.startLights = [];
  for (let li = 0; li < 3; li++) {
    const lampMat = new THREE.MeshBasicMaterial({ color: 0x330000 });
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.45, 10, 8), lampMat);
    const lat = (li - 1) * 2.2;
    lamp.position.set(r0.x * lat, 6.6, r0.z * lat);
    gantry.add(lamp);
    track.startLights.push(lampMat);
  }
  gantry.position.set(p0.x, p0.y, p0.z);
  addOutlines(gantry, 1.03);
  scene.add(gantry);

  // walls
  if (def.walls || def.env === 'oval') {
    const wallMat = toonMat(0xd2d7df);
    const off = def.walls ? halfW + 1.3 : halfW + 2.6;
    const mk = (o) => {
      const pos = [], idx = [];
      for (let k = 0; k <= N; k++) {
        const m = k % N, p = samples[m], r = rights[m], yb = p.y + o * bank[m];
        pos.push(p.x + r.x * o, yb, p.z + r.z * o,
                 p.x + r.x * o, yb + 1.1, p.z + r.z * o);
        if (k < N) { const a = k * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2, a, a + 2, a + 1, a + 1, a + 2, a + 3); }
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      g.setIndex(idx);
      g.computeVertexNormals();
      const wm = new THREE.Mesh(g, wallMat);
      wm.receiveShadow = true;
      scene.add(wm);
    };
    mk(off);
    if (def.walls) mk(-off);
  }

  if (def.id === 'suzuka') {
    const pm = toonMat(0x8d939c);
    for (const [px, pz] of [[-27, 13], [27, -13]]) {
      const pil = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.4, 6.6, 8), pm);
      pil.position.set(px, 3.3, pz);
      pil.castShadow = true;
      scene.add(pil);
    }
  }
}

// Gradient sky dome (zenith -> horizon) + a soft sun disc that ignores fog.
function addSky(env) {
  const geo = new THREE.SphereGeometry(4200, 32, 16);
  const top = new THREE.Color(env.top), hor = new THREE.Color(env.horizon);
  const pos = geo.attributes.position, col = [];
  for (let i = 0; i < pos.count; i++) {
    const t = THREE.MathUtils.clamp((pos.getY(i) / 4200) * 1.4 + 0.15, 0, 1);
    const c = hor.clone().lerp(top, t * t);
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  const dome = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide, fog: false, depthWrite: false }));
  dome.renderOrder = -1;
  scene.add(dome);

  const sunDir = new THREE.Vector3(120, 200, 90).normalize();
  const sun = new THREE.Mesh(new THREE.SphereGeometry(130, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff7e0, fog: false, depthWrite: false }));
  sun.position.copy(sunDir).multiplyScalar(3600);
  scene.add(sun);
  const glow = new THREE.Mesh(new THREE.SphereGeometry(230, 20, 16),
    new THREE.MeshBasicMaterial({ color: 0xfff2c8, fog: false, transparent: true, opacity: 0.35, depthWrite: false }));
  glow.position.copy(sun.position);
  scene.add(glow);

  // a few soft clouds
  const cloudMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false });
  for (let i = 0; i < 14; i++) {
    const g = new THREE.Group();
    const puffs = 3 + Math.floor(rand01() * 3);
    for (let p = 0; p < puffs; p++) {
      const s = rand(40, 90);
      const m = new THREE.Mesh(new THREE.SphereGeometry(s, 10, 8), cloudMat);
      m.position.set((p - puffs / 2) * s * 1.1, rand(-8, 8), rand(-20, 20));
      m.scale.y = 0.55;
      g.add(m);
    }
    const a = rand01() * 6.28, r = rand(1400, 2600);
    g.position.set(Math.cos(a) * r, rand(520, 900), Math.sin(a) * r);
    scene.add(g);
  }
}

// Low-poly rolling terrain: a displaced grid, faceted, with grass-tone variation.
function buildTerrain(def, env, minX, maxX, minZ, maxZ) {
  const pad = 900;
  const x0 = minX - pad, x1 = maxX + pad, z0 = minZ - pad, z1 = maxZ + pad;
  const w = x1 - x0, h = z1 - z0;
  const seg = THREE.MathUtils.clamp(Math.round(Math.max(w, h) / 12), 150, 240);
  const geo = new THREE.PlaneGeometry(w, h, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const pos = geo.attributes.position;
  const lo = new THREE.Color(env.ground2), hi = new THREE.Color(env.ground);
  const col = [];
  let yMin = 1e9, yMax = -1e9;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i) + (x0 + x1) / 2, z = pos.getZ(i) + (z0 + z1) / 2;
    const y = terrainHeight(x, z);
    pos.setY(i, y - 0.28);      // sit just under the apron so it never pokes through
    yMin = Math.min(yMin, y); yMax = Math.max(yMax, y);
  }
  for (let i = 0; i < pos.count; i++) {
    const y = pos.getY(i);
    const t = THREE.MathUtils.clamp((y - yMin) / Math.max(yMax - yMin, 1), 0, 1);
    const n = 0.5 + 0.5 * Math.sin(pos.getX(i) * 0.05) * Math.cos(pos.getZ(i) * 0.05);
    const c = lo.clone().lerp(hi, t * 0.7 + n * 0.3);
    col.push(c.r, c.g, c.b);
  }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  const mat = toonMat(0xffffff, { vertexColors: true });
  const ground = new THREE.Mesh(geo, mat);
  ground.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
  ground.receiveShadow = true;
  scene.add(ground);
}

// Dense, clustered forest with a far treeline "wall" for a convincing façade.
function buildForest(env, scatterPos, outlineInstanced) {
  const dense = env.dense || 1;
  const positions = [];
  const nClusters = Math.round(70 * dense);
  for (let c = 0; c < nClusters; c++) {
    const cp = scatterPos(track.halfW + 8);
    if (!cp) continue;
    const n = 4 + Math.floor(rand01() * 9);
    for (let k = 0; k < n; k++) {
      const ang = rand01() * 6.28, rr = rand(2, 22);
      const x = cp[0] + Math.cos(ang) * rr, z = cp[1] + Math.sin(ang) * rr;
      if (track.distToTrack(x, z) < track.halfW + 6) continue;
      positions.push({ x, z, y: terrainHeight(x, z), s: rand(0.8, 1.9), type: rand01() < 0.68 ? 0 : 1 });
    }
  }
  // far perimeter treeline (the horizon "wall")
  let cx = 0, cz = 0;
  for (const p of track.samples) { cx += p.x; cz += p.z; }
  cx /= track.samples.length; cz /= track.samples.length;
  let rad = 0;
  for (const p of track.samples) rad = Math.max(rad, Math.hypot(p.x - cx, p.z - cz));
  const ringN = Math.round(170 * dense);
  for (let i = 0; i < ringN; i++) {
    const a = rand01() * 6.28, rr = rad + rand(120, 620);
    const x = cx + Math.cos(a) * rr, z = cz + Math.sin(a) * rr;
    positions.push({ x, z, y: terrainHeight(x, z), s: rand(1.3, 2.7), type: rand01() < 0.82 ? 0 : 1 });
  }

  const coneGeo = new THREE.ConeGeometry(3.2, 10, 8);
  const cone2Geo = new THREE.ConeGeometry(2.2, 6, 8);
  const blobGeo = new THREE.IcosahedronGeometry(3.4, 0);
  const trunkGeo = new THREE.CylinderGeometry(0.5, 0.7, 3.4, 6);
  const nCon = positions.filter(p => p.type === 0).length || 1;
  const nBlob = positions.length - nCon + 1;
  const cones = new THREE.InstancedMesh(coneGeo, toonMat(0x2f7a34), nCon);
  const cones2 = new THREE.InstancedMesh(cone2Geo, toonMat(0x3a8c40), nCon);
  const blobs = new THREE.InstancedMesh(blobGeo, toonMat(0x5aa845), nBlob);
  const trunks = new THREE.InstancedMesh(trunkGeo, toonMat(0x6b4a28), positions.length);
  const m4 = new THREE.Matrix4(), sv = new THREE.Vector3();
  let ci = 0, bi = 0, ti = 0;
  for (const p of positions) {
    const s = p.s, ry = rand01() * 6.28;
    m4.makeRotationY(ry).scale(sv.set(s, s, s)).setPosition(p.x, p.y + 1.7 * s, p.z);
    trunks.setMatrixAt(ti++, m4);
    if (p.type === 0) {
      m4.makeRotationY(ry).scale(sv.set(s, s, s)).setPosition(p.x, p.y + 8.4 * s, p.z);
      cones.setMatrixAt(ci, m4);
      m4.makeRotationY(ry).scale(sv.set(s, s, s)).setPosition(p.x, p.y + 12.4 * s, p.z);
      cones2.setMatrixAt(ci, m4);
      ci++;
    } else {
      m4.makeRotationY(ry).scale(sv.set(s, s * 1.15, s)).setPosition(p.x, p.y + 6.6 * s, p.z);
      blobs.setMatrixAt(bi++, m4);
    }
  }
  cones.count = cones2.count = ci; blobs.count = bi; trunks.count = ti;
  cones.castShadow = cones2.castShadow = blobs.castShadow = true;
  scene.add(cones, cones2, blobs, trunks);
  outlineInstanced(cones, 1.05);
  outlineInstanced(blobs, 1.05);
}

// ---- countryside scenery: patchwork fields, farm buildings, and a river ----
// A terrain-draped grid quad (samples terrainHeight per vertex so it hugs hills, not floats).
function drapedPatch(cx, cz, w, d, yaw, color, yLift) {
  const seg = 5, ca = Math.cos(yaw), sa = Math.sin(yaw);
  const pos = [], idx = [];
  for (let i = 0; i <= seg; i++) for (let k = 0; k <= seg; k++) {
    const lx = (i / seg - 0.5) * w, lz = (k / seg - 0.5) * d;
    const x = cx + lx * ca - lz * sa, z = cz + lx * sa + lz * ca;
    pos.push(x, terrainHeight(x, z) + yLift, z);
  }
  for (let i = 0; i < seg; i++) for (let k = 0; k < seg; k++) {
    const a = i * (seg + 1) + k, b = a + 1, c = a + seg + 1, e = c + 1;
    idx.push(a, c, b, b, c, e);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, toonMat(color, { side: THREE.DoubleSide }));
  m.receiveShadow = true;
  scene.add(m);
}
function buildFields(scatterPos) {
  const crops = [0xcdb45a, 0xd8c56a, 0x8a6a44, 0x9c7a4e, 0x7ea63e, 0x5f8a34, 0xa8b357]; // wheat, tilled, crops
  // scale field count to the track's footprint so a big map doesn't look bare
  let nx = 1e9, xx = -1e9, nz = 1e9, xz = -1e9;
  for (const s of track.samples) { nx = Math.min(nx, s.x); xx = Math.max(xx, s.x); nz = Math.min(nz, s.z); xz = Math.max(xz, s.z); }
  const n = Math.max(30, Math.min(90, Math.round((xx - nx) * (xz - nz) / 60000)));
  for (let i = 0; i < n; i++) {
    const p = scatterPos(track.halfW + 55);
    if (!p) continue;
    drapedPatch(p[0], p[1], rand(140, 340), rand(140, 340), rand(0, 6.28), crops[i % crops.length], 0.05 + Math.random() * 0.06);
  }
}
function buildFarms(scatterPos) {
  const bodyPal = [0x9c2b25, 0xb8352c, 0xe8e2d4, 0xd8cdb8, 0x7a6a54, 0xcabca4]; // barn red, farmhouse white, wood
  const roofPal = [0x3a3f47, 0x55402f, 0x6a7078, 0x4a4038];
  const box = new THREE.BoxGeometry(1, 1, 1);
  let nx = 1e9, xx = -1e9, nz = 1e9, xz = -1e9;
  for (const s of track.samples) { nx = Math.min(nx, s.x); xx = Math.max(xx, s.x); nz = Math.min(nz, s.z); xz = Math.max(xz, s.z); }
  const nFarms = Math.max(30, Math.min(70, Math.round((xx - nx) * (xz - nz) / 90000)));
  for (let i = 0; i < nFarms; i++) {
    const p = scatterPos(track.halfW + 20);
    if (!p) continue;
    const w = rand(11, 24), d = rand(11, 30), h = rand(6, 12);
    const gy = terrainHeight(p[0], p[1]), yaw = Math.floor(rand(0, 4)) * Math.PI / 2 + rand(-0.25, 0.25);
    const grp = new THREE.Group();
    const body = new THREE.Mesh(box, toonMat(bodyPal[i % bodyPal.length]));
    body.scale.set(w, h, d); body.position.y = h / 2; body.castShadow = true;
    grp.add(body);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(Math.max(w, d) * 0.72, h * 0.7, 4), toonMat(roofPal[i % roofPal.length]));
    roof.rotation.y = Math.PI / 4; roof.position.y = h + h * 0.35; roof.scale.set(w / Math.max(w, d), 1, d / Math.max(w, d)); roof.castShadow = true;
    grp.add(roof);
    if (i % 4 === 0) {   // a silo next to some barns
      const silo = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.2, h * 1.3, 10), toonMat(0xbfc4c9));
      silo.position.set(w * 0.5 + 4, h * 0.65, d * 0.2); silo.castShadow = true; grp.add(silo);
      const dome = new THREE.Mesh(new THREE.SphereGeometry(3.2, 10, 6, 0, 6.28, 0, 1.57), toonMat(0x9aa0a6));
      dome.position.set(w * 0.5 + 4, h * 1.3, d * 0.2); grp.add(dome);
    }
    grp.position.set(p[0], gy, p[1]); grp.rotation.y = yaw;
    scene.add(grp);
  }
}
// The river: a terrain-draped blue ribbon following a smoothed curve (not a closed loop).
function buildRiver(pts) {
  const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], 0, p[1])), false, 'centripetal');
  const M = pts.length * 12, HW = 17;
  const pos = [], idx = [], uv = [];
  for (let i = 0; i <= M; i++) {
    const t = i / M, c = curve.getPoint(t), tan = curve.getTangent(t);
    const nx = -tan.z, nz = tan.x, L = Math.hypot(nx, nz) || 1;
    const wob = HW * (0.85 + 0.15 * Math.sin(t * 40));        // gently varying width
    for (const s of [-1, 1]) {
      const x = c.x + (nx / L) * s * wob, z = c.z + (nz / L) * s * wob;
      pos.push(x, terrainHeight(x, z) + 0.04, z);             // sits just on the ground surface
      uv.push(s < 0 ? 0 : 1, t);
    }
  }
  for (let i = 0; i < M; i++) {
    const a = i * 2;
    idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setIndex(idx); g.computeVertexNormals();
  const m = new THREE.Mesh(g, toonMat(0x3f86c9, { side: THREE.DoubleSide }));
  m.receiveShadow = true;
  scene.add(m);
}

// A grass collar hugging the road on both sides — generated from the exact surface
// function at fine resolution, so the land always meets the track edge, everywhere.
function apronStrip(side, env) {
  const { samples, rights, N, halfW } = track;
  const bands = [halfW + 1.6, halfW + 9, halfW + 22, halfW + 40, halfW + 64].map(v => side * v);
  const rows = bands.length;
  const gA = new THREE.Color(env.ground), gB = new THREE.Color(env.ground2);
  const pos = [], idx = [], col = [];
  for (let i = 0; i <= N; i++) {
    const j = i % N, sp = samples[j], r = rights[j];
    for (let b = 0; b < rows; b++) {
      const L = bands[b], x = sp.x + r.x * L, z = sp.z + r.z * L;
      pos.push(x, terrainHeight(x, z) - 0.02, z);
      const c = gB.clone().lerp(gA, b / (rows - 1));
      const sh = 0.9 + 0.16 * Math.sin(i * 0.34 + b * 1.3);
      col.push(c.r * sh, c.g * sh, c.b * sh);
    }
  }
  for (let i = 0; i < N; i++)
    for (let b = 0; b < rows - 1; b++) {
      const a = i * rows + b, d = (i + 1) * rows + b;
      idx.push(a, a + 1, d, a + 1, d + 1, d);
    }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const m = new THREE.Mesh(g, toonMat(0xffffff, { vertexColors: true, side: THREE.DoubleSide }));
  m.receiveShadow = true;
  scene.add(m);
}

function buildEnvironment(def, env) {
  const distToTrack = track.distToTrack;

  let minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
  for (const p of track.samples) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
  }
  addSky(env);
  buildTerrain(def, env, minX, maxX, minZ, maxZ);
  apronStrip(1, env);
  apronStrip(-1, env);

  const margin = 340;
  const rand = (a, b) => a + Math.random() * (b - a);
  const scatterPos = (minDist) => {
    for (let tries = 0; tries < 30; tries++) {
      const x = rand(minX - margin, maxX + margin), z = rand(minZ - margin, maxZ + margin);
      if (distToTrack(x, z) > minDist) return [x, z];
    }
    return null;
  };
  const outlineInstanced = (src, thickness) => {
    const g2 = src.geometry.clone();
    const pos = g2.attributes.position;
    g2.computeBoundingBox();
    for (let i = 0; i < pos.count; i++) {   // push verts out along normal-ish (from center)
      pos.setXYZ(i, pos.getX(i) * thickness, pos.getY(i) * thickness, pos.getZ(i) * thickness);
    }
    pos.needsUpdate = true;
    const o = new THREE.InstancedMesh(g2, OUTLINE_MAT, src.count);
    o.instanceMatrix = src.instanceMatrix;
    o.count = src.count;
    o.frustumCulled = false;
    scene.add(o);
  };

  if (env.scatter === 'trees') {
    buildForest(env, scatterPos, outlineInstanced);
  } else if (env.scatter === 'countryside') {
    // composite rural scene: patchwork fields, forest, scattered farms, and the river
    buildFields(scatterPos);
    buildForest(env, scatterPos, outlineInstanced);
    buildFarms(scatterPos);
    if (def.river) buildRiver(def.river);
  } else if (env.scatter === 'rocks') {
    const geoRock = new THREE.DodecahedronGeometry(2.4, 0);
    const mRock = toonMat(0xb08a52);
    const geoShrub = new THREE.IcosahedronGeometry(1.3, 0);
    const mShrub = toonMat(0x6a7538);
    for (const [geo, mat, n, minD, ol] of [[geoRock, mRock, 80, track.halfW + 9, true], [geoShrub, mShrub, 130, track.halfW + 7, false]]) {
      const inst = new THREE.InstancedMesh(geo, mat, n);
      const m4 = new THREE.Matrix4();
      let placed = 0;
      for (let i = 0; i < n; i++) {
        const p = scatterPos(minD);
        if (!p) continue;
        const s = rand(0.5, 1.9);
        m4.makeRotationY(rand(0, 6.28)).scale(new THREE.Vector3(s, s * rand(0.6, 1), s)).setPosition(p[0], terrainHeight(p[0], p[1]) + s * 0.8, p[1]);
        inst.setMatrixAt(placed++, m4);
      }
      inst.count = placed;
      inst.castShadow = true;
      scene.add(inst);
      if (ol) outlineInstanced(inst, 1.05);
    }
  } else if (env.scatter === 'buildings') {
    const palette = [0x9aa2ad, 0xc0b199, 0x8b95a5, 0xb0a08c, 0x7e8894, 0xcabca4];
    const geo = new THREE.BoxGeometry(1, 1, 1);
    for (let i = 0; i < 120; i++) {
      const p = scatterPos(track.halfW + 15);
      if (!p) continue;
      const h = rand(9, 46), w = rand(10, 26), d = rand(10, 26);
      const m = new THREE.Mesh(geo, toonMat(palette[i % palette.length]));
      m.scale.set(w, h, d);
      m.position.set(p[0], terrainHeight(p[0], p[1]) + h / 2, p[1]);
      m.rotation.y = Math.floor(rand(0, 4)) * Math.PI / 2;
      m.castShadow = true;
      scene.add(m);
    }
  } else if (env.scatter === 'stands') {
    const mat = toonMat(0x7f8894);
    const roofM = toonMat(0xd6dae0);
    for (const side of [1, -1]) {
      const stand = new THREE.Group();
      for (let tier = 0; tier < 3; tier++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(600, 3, 8), mat);
        b.position.set(0, 1.5 + tier * 3, tier * 7);
        b.castShadow = true;
        stand.add(b);
      }
      const roof = new THREE.Mesh(new THREE.BoxGeometry(600, 0.6, 26), roofM);
      roof.position.set(0, 12, 7);
      stand.add(roof);
      stand.position.set(0, terrainHeight(0, side * 270), side * (240 + 30));
      if (side < 0) stand.rotation.y = Math.PI;
      scene.add(stand);
    }
  }

  if (env.scatter !== 'stands') {
    const p0 = track.samples[0], r0 = track.rights[0], t0 = track.tangents[0];
    const mat = toonMat(0x7f8894);
    const stand = new THREE.Group();
    for (let tier = 0; tier < 3; tier++) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(70, 2.4, 6), mat);
      b.position.set(0, 1.2 + tier * 2.4, tier * 5.4);
      b.castShadow = true;
      stand.add(b);
    }
    const off = track.halfW + (track.def.walls ? 6 : 16);
    stand.position.set(p0.x + r0.x * off, p0.y, p0.z + r0.z * off);
    stand.rotation.y = Math.atan2(t0.x, t0.z) + Math.PI;
    scene.add(stand);
  }
}

// ---------------------------------------------------------------- cars
const VEHICLES = ['f1', 'kart', 'rally', 'bike', 'monster'];
const VEHICLE_LABELS = { f1: '🏎️ F1 Car', kart: '🏁 Go-Kart', rally: '🚗 Rally Car', bike: '🏍️ Motorbike', monster: '🛻 Monster Truck' };

function buildCarMesh(color, helmet, vehicle = 'f1') {
  const g = new THREE.Group();
  const paint = toonMat(color);
  const dark = toonMat(0x1c1e22);
  const glass = toonMat(0x2b3540);
  const helmetMat = toonMat(helmet);
  const wheels = [];

  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) => {
    const m = new THREE.Mesh(geo, mat);
    m.position.set(x, y, z);
    m.rotation.set(rx, ry, rz);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  // a wheel = a group (steers via .rotation.y) whose child[0] is the rolling cylinder.
  const wheel = (x, z, front, r = 0.45, width = 0.44) => {
    const wg = new THREE.Group();
    const w = new THREE.Mesh(new THREE.CylinderGeometry(r, r, width, 12), dark);
    w.rotation.z = Math.PI / 2; w.castShadow = true;
    wg.add(w);
    wg.position.set(x, r, z);            // bottom of wheel sits at mesh-local y=0 (on the road)
    wg.userData.front = !!front;
    g.add(wg); wheels.push(wg);
    return wg;
  };
  const rider = (z, lean) => {                  // seated driver: torso + helmet (karts, bike)
    add(new THREE.BoxGeometry(0.5, 0.6, 0.42), dark, 0, 0.62, z, lean || 0);   // torso
    add(new THREE.SphereGeometry(0.28, 10, 8), helmetMat, 0, 1.0, z + (lean ? 0.18 : 0));
  };

  if (vehicle === 'kart') {
    add(new THREE.BoxGeometry(1.15, 0.16, 2.5), paint, 0, 0.2, 0);            // flat floor pan
    add(new THREE.BoxGeometry(1.25, 0.12, 0.5), dark, 0, 0.22, 1.35);        // front bumper
    add(new THREE.BoxGeometry(0.9, 0.5, 0.7), paint, 0, 0.45, -0.2);         // seat back
    add(new THREE.BoxGeometry(0.5, 0.4, 0.55), dark, 0.5, 0.42, -1.05);      // side engine
    add(new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6), dark, 0, 0.62, 0.75, Math.PI / 3); // steering column
    add(new THREE.TorusGeometry(0.22, 0.04, 6, 10), dark, 0, 0.78, 0.95, Math.PI / 2.4);    // small wheel
    rider(-0.1);
    wheel(-0.72, 0.95, 1, 0.34, 0.3); wheel(0.72, 0.95, 1, 0.34, 0.3);
    wheel(-0.78, -0.95, 0, 0.4, 0.42); wheel(0.78, -0.95, 0, 0.4, 0.42);
  } else if (vehicle === 'rally') {
    add(new THREE.BoxGeometry(1.9, 0.7, 4.0), paint, 0, 0.6, 0);             // main body
    add(new THREE.BoxGeometry(1.7, 0.6, 1.9), paint, 0, 1.15, -0.15);       // cabin
    add(new THREE.BoxGeometry(1.55, 0.42, 1.7), glass, 0, 1.2, -0.15);      // windows band
    add(new THREE.BoxGeometry(1.72, 0.5, 1.0), paint, 0, 1.35, -0.2);       // roof
    add(new THREE.BoxGeometry(0.5, 0.16, 0.4), dark, 0, 1.66, 0.1);         // roof scoop
    add(new THREE.BoxGeometry(2.0, 0.1, 0.5), dark, 0, 1.05, -2.05);        // rear spoiler
    add(new THREE.BoxGeometry(0.09, 0.35, 0.5), paint, -0.9, 0.9, -2.05);
    add(new THREE.BoxGeometry(0.09, 0.35, 0.5), paint, 0.9, 0.9, -2.05);
    add(new THREE.BoxGeometry(1.6, 0.2, 0.3), dark, 0, 0.55, 2.05);         // front bumper/lights
    for (const fz of [1.45, -1.45]) { add(new THREE.BoxGeometry(2.1, 0.5, 0.9), dark, 0, 0.4, fz); } // fender arches
    wheel(-1.0, 1.45, 1, 0.52, 0.5); wheel(1.0, 1.45, 1, 0.52, 0.5);
    wheel(-1.0, -1.45, 0, 0.52, 0.5); wheel(1.0, -1.45, 0, 0.52, 0.5);
  } else if (vehicle === 'bike') {
    add(new THREE.BoxGeometry(0.34, 0.42, 1.5), paint, 0, 0.72, -0.1);      // frame/tank
    add(new THREE.BoxGeometry(0.4, 0.16, 0.9), dark, 0, 0.92, -0.55);       // seat
    add(new THREE.BoxGeometry(0.5, 0.3, 0.7), paint, 0, 0.66, 0.75);        // front fairing
    add(new THREE.BoxGeometry(0.7, 0.05, 0.08), dark, 0, 1.0, 0.95);        // handlebars
    add(new THREE.CylinderGeometry(0.04, 0.04, 0.9, 6), dark, 0, 0.82, 0.9, Math.PI / 2.6); // forks
    // leaning rider
    add(new THREE.BoxGeometry(0.42, 0.7, 0.42), dark, 0, 1.05, -0.1, -0.5);     // torso leaning fwd
    add(new THREE.SphereGeometry(0.27, 10, 8), helmetMat, 0, 1.35, 0.35);       // helmet forward
    add(new THREE.BoxGeometry(0.16, 0.5, 0.16), dark, -0.3, 1.0, 0.5, 0, 0, 0.5); // arms to bars
    add(new THREE.BoxGeometry(0.16, 0.5, 0.16), dark, 0.3, 1.0, 0.5, 0, 0, -0.5);
    wheel(0, 1.25, 1, 0.5, 0.24);      // front (steers)
    wheel(0, -1.25, 0, 0.5, 0.28);     // rear
  } else if (vehicle === 'monster') {
    add(new THREE.BoxGeometry(2.0, 0.5, 3.4), dark, 0, 1.4, 0);             // tall chassis/frame
    add(new THREE.BoxGeometry(2.0, 0.9, 1.5), paint, 0, 2.0, -0.3);         // cab
    add(new THREE.BoxGeometry(1.8, 0.55, 1.2), glass, 0, 2.1, -0.25);       // windows
    add(new THREE.BoxGeometry(2.0, 0.7, 1.4), paint, 0, 1.85, 1.1);         // hood
    add(new THREE.BoxGeometry(2.2, 0.25, 0.3), dark, 0, 1.7, 1.9);          // front bumper
    add(new THREE.BoxGeometry(0.5, 0.2, 0.5), dark, 0, 2.55, 0.4);          // roof lights bar base
    for (const lx of [-0.5, 0, 0.5]) add(new THREE.SphereGeometry(0.14, 8, 6), toonMat(0xfff2b0), lx, 2.7, 0.4);
    wheel(-1.15, 1.35, 1, 0.95, 0.8); wheel(1.15, 1.35, 1, 0.95, 0.8);      // huge wheels
    wheel(-1.15, -1.35, 0, 0.95, 0.8); wheel(1.15, -1.35, 0, 0.95, 0.8);
  } else {   // 'f1' (default)
    add(new THREE.BoxGeometry(1.5, 0.42, 3.4), paint, 0, 0.42, -0.1);        // tub
    add(new THREE.BoxGeometry(0.62, 0.3, 1.7), paint, 0, 0.42, 2.0);         // nose
    add(new THREE.BoxGeometry(2.1, 0.09, 0.62), dark, 0, 0.3, 2.8);          // front wing
    add(new THREE.BoxGeometry(0.9, 0.5, 1.5), paint, 0, 0.76, -1.0);         // engine cover
    add(new THREE.BoxGeometry(0.7, 0.28, 0.7), dark, 0, 0.72, 0.55);         // cockpit rim
    add(new THREE.SphereGeometry(0.3, 10, 8), helmetMat, 0, 0.86, 0.35);     // helmet
    add(new THREE.BoxGeometry(1.8, 0.09, 0.55), dark, 0, 1.06, -2.1);        // rear wing plane
    add(new THREE.BoxGeometry(0.08, 0.5, 0.55), dark, -0.82, 0.82, -2.1);
    add(new THREE.BoxGeometry(0.08, 0.5, 0.55), dark, 0.82, 0.82, -2.1);
    add(new THREE.BoxGeometry(0.5, 0.4, 1.6), paint, -0.98, 0.45, -0.4);     // sidepods
    add(new THREE.BoxGeometry(0.5, 0.4, 1.6), paint, 0.98, 0.45, -0.4);
    wheel(-1.02, 1.55, 1); wheel(1.02, 1.55, 1);
    wheel(-1.06, -1.55, 0); wheel(1.06, -1.55, 0);
  }

  g.userData.wheels = wheels;
  addOutlines(g, 1.05);
  return g;
}

function makeCar(color, isPlayer, name, helmet, vehicle = 'f1') {
  return {
    mesh: buildCarMesh(color, helmet, vehicle),
    vehicle,
    color, name, isPlayer,
    x: 0, z: 0, y: 0, heading: 0, roll: 0, pitch: 0,
    velX: 0, velZ: 0, steer: 0,
    idx: 0, distAcc: 0, lap: 0, lapStart: 0,
    lastLap: null, bestLap: null,
    finished: false, finishTime: null,
    laneVar: 0, skill: 1, slip: 0, onRoad: true,
    lineBias: 0,                                // personal line offset (fraction of half-width)
    // per-bot line "wobble": slow weave + faster shimmy + steering imperfection, so bots
    // wander around their line and fight the car like real drivers instead of railing it.
    wAmp: 0, wW1: 0, wW2: 0, wP1: 0, wP2: 0, wJit: 0, wJW: 0, wJP: 0, steerSm: 0,
    engineMul: 1,                               // per-car engine scale (fast bots get a little more)
    // per-bot fluctuating top-speed limiter (shown-speed band); vCap is the live world-m/s cap
    vCap: 0, topLo: 0, topHi: 0, topBias: 0, topW: 0, topPhase: 0,
  };
}

function nearestSample(x, z, hint, windowSize) {
  const { samples, N } = track;
  let best = -1, bestD = 1e18;
  const scan = (i) => {
    const p = samples[(i + N) % N];
    const d = (p.x - x) ** 2 + (p.z - z) ** 2;
    if (d < bestD) { bestD = d; best = (i + N) % N; }
  };
  if (windowSize >= N / 2) for (let i = 0; i < N; i++) scan(i);
  else for (let i = hint - windowSize; i <= hint + windowSize; i++) scan(i);
  return best;
}

function placeCarAt(car, sampleIdx, lateral) {
  const { samples, tangents, rights, N } = track;
  const i = (sampleIdx + N) % N;
  const p = samples[i], t = tangents[i], r = rights[i];
  car.x = p.x + r.x * lateral;
  car.z = p.z + r.z * lateral;
  car.y = p.y;
  car.heading = Math.atan2(t.x, t.z);
  car.velX = car.velZ = 0;
  car.steer = 0;
  car.idx = i;
  car.distAcc = 0;
}

function resetCar(car) {
  const i = nearestSample(car.x, car.z, car.idx, 200);
  const before = car.distAcc;
  placeCarAt(car, i, 0);
  car.idx = i;
  car.distAcc = before;
}

// ---------------------------------------------------------------- physics
function surfaceAt(car) {
  const { samples, halfW, def } = track;
  const p = samples[car.idx];
  const d = Math.hypot(car.x - p.x, car.z - p.z);
  car.onRoad = d <= halfW + 0.7;
  if (car.onRoad) return SURFACES[def.surface];
  return def.surface === 'dirt' || def.env === 'desert' ? SURFACES.sand : SURFACES.grass;
}

function stepCar(car, input, dt) {
  const surf = surfaceAt(car);
  const speed = Math.hypot(car.velX, car.velZ);

  // grip rises a little with speed (downforce) -> planted, still slides when overdriven
  const gripBase = surf.grip * (1 + PHYS.downforce * Math.min(speed / 40, 1.4));
  const aLat = PHYS.aLatMax * gripBase * (input.handbrake ? PHYS.handbrakeGrip : 1);

  const fwdX0 = Math.sin(car.heading), fwdZ0 = Math.cos(car.heading);
  let vf = car.velX * fwdX0 + car.velZ * fwdZ0;

  // steering: speed-sensitive, grip-limited with slack for slides
  const maxSteer = Math.min(0.6, PHYS.aLatMax * PHYS.wheelbase / Math.max(vf * vf, 1)) * PHYS.steerOver;
  const targetSteer = THREE.MathUtils.clamp(input.steer, -1, 1) * maxSteer;
  const steerRate = 5.8 * Math.max(maxSteer, 0.16);
  car.steer += THREE.MathUtils.clamp(targetSteer - car.steer, -steerRate * dt, steerRate * dt);

  const yaw = vf / PHYS.wheelbase * Math.tan(car.steer);
  car.heading += yaw * dt;

  const fX = Math.sin(car.heading), fZ = Math.cos(car.heading);
  const rX = fZ, rZ = -fX;
  vf = car.velX * fX + car.velZ * fZ;
  let vl = car.velX * rX + car.velZ * rZ;

  // longitudinal
  let aLong = 0;
  if (input.throttle > 0) aLong += PHYS.engineAccel * (car.engineMul || 1) * paceMul * input.throttle * surf.accelMul;
  if (input.brake > 0) {
    if (vf > 1.5) aLong -= PHYS.brakeAccel * input.brake * Math.min(surf.grip * 1.4, 1);
    // reverse disabled for the player for now (a shifter will re-enable it later); AI may still back up
    else if (!car.isPlayer && vf > -PHYS.reverseMax) aLong -= PHYS.reverseAccel * input.brake;
    else if (car.isPlayer && vf > 0) aLong -= PHYS.brakeAccel * input.brake * 0.5;  // ease the last bit to a stop
  }
  if (input.handbrake && vf > 0) aLong -= 14;
  aLong -= PHYS.drag * surf.dragMul * vf * Math.abs(vf);
  aLong -= PHYS.rolling * Math.sign(vf) * Math.min(Math.abs(vf), 1);
  vf += aLong * dt;

  // lateral grip
  const latReduce = Math.min(Math.abs(vl), aLat * dt);
  vl -= Math.sign(vl) * latReduce;
  // stability assist: bleed off slide when you're not actively steering (catches spins)
  if (!input.handbrake) {
    const straighten = PHYS.stability * (1 - Math.min(Math.abs(input.steer), 1)) * dt;
    vl -= Math.sign(vl) * Math.min(Math.abs(vl), straighten);
  }
  car.slip = Math.abs(vl);

  car.velX = fX * vf + rX * vl;
  car.velZ = fZ * vf + rZ * vl;
  if (speed < 0.4 && input.throttle === 0 && input.brake === 0) { car.velX = 0; car.velZ = 0; }

  car.x += car.velX * dt;
  car.z += car.velZ * dt;

  const newIdx = nearestSample(car.x, car.z, car.idx, 26);
  let didx = newIdx - car.idx;
  const { N } = track;
  if (didx > N / 2) didx -= N;
  if (didx < -N / 2) didx += N;
  car.idx = newIdx;
  car.distAcc += didx;

  const sp = track.samples[car.idx];
  const surfY = terrainHeight(car.x, car.z);      // ride the real ground: road, grass, or hillside
  car.y += (surfY - car.y) * Math.min(1, dt * 12);

  const d = Math.hypot(car.x - sp.x, car.z - sp.z);
  if (d > track.outerLimit) {
    const nx = (car.x - sp.x) / d, nz = (car.z - sp.z) / d;
    car.x = sp.x + nx * track.outerLimit;
    car.z = sp.z + nz * track.outerLimit;
    const vOut = car.velX * nx + car.velZ * nz;
    if (vOut > 0) {
      car.velX -= vOut * nx * 1.35;
      car.velZ -= vOut * nz * 1.35;
      car.velX *= 0.9; car.velZ *= 0.9;
    }
  }
}

function aiInputs(car) {
  const { samples, rights, raceOffset, vmax, N } = track;
  const speed = Math.hypot(car.velX, car.velZ);

  // steering look-ahead point on the racing line
  const steerLook = Math.round(THREE.MathUtils.clamp(7 + speed * 0.4, 8, 42));
  const si = (car.idx + steerLook) % N;
  // personal cruising line: each bot sits a bit off the ideal line (staggered), then laneVar
  // adds dynamic overtaking movement on top. Clamp so the sum always stays on the road.
  const biasOff = car.lineBias * track.halfW * 0.42;
  // line wobble: slow weave + faster shimmy (in metres). Bots wander around their line
  // rather than railing it, so the field looks alive.
  const wob = (Math.sin(raceTime * car.wW1 + car.wP1) + 0.5 * Math.sin(raceTime * car.wW2 + car.wP2))
              * car.wAmp * track.halfW * 0.66;
  const off = THREE.MathUtils.clamp(raceOffset[si] + biasOff + car.laneVar + wob, -track.halfW * 0.85, track.halfW * 0.85);
  const tx = samples[si].x + rights[si].x * off;
  const tz = samples[si].z + rights[si].z * off;
  let err = Math.atan2(tx - car.x, tz - car.z) - car.heading;
  while (err > Math.PI) err -= 2 * Math.PI;
  while (err < -Math.PI) err += 2 * Math.PI;
  // steering imperfection: a small hand-jitter, plus a touch of reaction lag / slight
  // over-correction (steerSm chases the target and can overshoot) => a realistic wobble.
  const jitter = Math.sin(raceTime * car.wJW + car.wJP) * car.wJit;
  const rawSteer = THREE.MathUtils.clamp(err * 2.6 + jitter, -1, 1);
  car.steerSm += (rawSteer - car.steerSm) * 0.35;   // lag + overshoot -> natural weave
  const steer = THREE.MathUtils.clamp(car.steerSm, -1, 1);

  // speed: the vmax profile already bakes in braking zones (backward pass), so just follow
  // it a hair ahead — don't crawl to the corner speed 90m early.
  const look = Math.round(THREE.MathUtils.clamp(2 + speed * 0.08, 2, 8));
  let vTarget = vmax[(car.idx + 2) % N];
  for (let l = 3; l <= look; l++) vTarget = Math.min(vTarget, vmax[(car.idx + l) % N]);
  vTarget *= car.skill;
  // corner confidence: >1 => they don't brake enough for the corner and run wide (dumb bots hit
  // walls); ~1 => they respect the braking profile (aces brake properly). Only bites in corners,
  // because on straights the top-speed cap below clamps it anyway.
  vTarget *= (car.cornerConf || 1);
  if (car.vCap) vTarget = Math.min(vTarget, car.vCap);   // personal top-speed limiter (straights)

  let throttle = 0, brake = 0;
  if (speed < vTarget - 1) throttle = 1;
  else if (speed > vTarget + 1.5) brake = THREE.MathUtils.clamp((speed - vTarget) / 8, 0.2, 1);
  else throttle = 0.4;
  // ease off if pointing badly wrong
  if (Math.abs(err) > 0.5) throttle = Math.min(throttle, 0.5);

  // overtaking: catch a slower car, pull to the open side, and COMMIT to the pass once alongside.
  // Only lift when we're stuck directly behind with no room; if we've got a lane, keep racing.
  const fwdX = Math.sin(car.heading), fwdZ = Math.cos(car.heading);
  let lift = 0;
  for (const other of cars) {
    if (other === car || other.finished) continue;
    const dx = other.x - car.x, dz = other.z - car.z;
    const dist = Math.hypot(dx, dz);
    if (dist > 17 || dist < 0.01) continue;
    if (dx * fwdX + dz * fwdZ <= 0.15 * dist) continue;     // only cars ahead of us
    const otherV = other.velX * fwdX + other.velZ * fwdZ;
    const closing = speed - otherV;
    if (closing <= 0.5) continue;                           // not catching -> leave room (no gridlock)
    const side = dx * fwdZ - dz * fwdX;                     // where the other car sits, laterally
    const lateral = Math.abs(side);
    // steer out toward the side away from them; harder the closer we are
    const urgency = THREE.MathUtils.clamp((17 - dist) / 17, 0, 1);
    car.laneVar += (side > 0 ? -1 : 1) * (10 + 12 * urgency) * 0.016;
    car.laneVar = THREE.MathUtils.clamp(car.laneVar, -track.halfW * 0.82, track.halfW * 0.82);
    if (lateral < 3.2) {                                    // still lined up right behind them
      if (dist < 5.5 && closing > 1.5) lift = Math.max(lift, 0.8);   // about to rear-end -> brake
      else if (dist < 9) lift = Math.max(lift, 0.35);               // ease a touch while working around
    }
    // lateral >= 3.2 => we have a lane alongside: no lift, drive past
  }
  if (lift > 0) { throttle = Math.min(throttle, 1 - lift); brake = Math.max(brake, lift * 0.5); }
  car.laneVar *= 0.92;   // relax back toward the personal line when the coast is clear
  return { steer, throttle, brake, handbrake: 0 };
}

function collideCars(dt) {
  const R = 2.1;
  for (let i = 0; i < cars.length; i++)
    for (let j = i + 1; j < cars.length; j++) {
      const a = cars[i], b = cars[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.01 && d < R * 2) {
        const nx = dx / d, nz = dz / d;
        const push = (R * 2 - d) / 2;
        a.x -= nx * push; a.z -= nz * push;
        b.x += nx * push; b.z += nz * push;
        const rv = (b.velX - a.velX) * nx + (b.velZ - a.velZ) * nz;
        if (rv < 0) {
          const imp = rv * 0.55;
          a.velX += nx * imp; a.velZ += nz * imp;
          b.velX -= nx * imp; b.velZ -= nz * imp;
        }
      }
    }
}

// ---------------------------------------------------------------- game flow
function startGame(def, m) {
  mode = m;
  paceMul = hardMode ? 1.2 : 1;      // world rushes at you faster in hard mode
  fogMul = hardMode ? 0.62 : 1;      // ...and it emerges from the fog later
  $('menu').style.display = 'none';
  $('acctChip').style.display = 'none';
  $('results').style.display = 'none';
  buildTrack(def);

  cars = [];
  const nAI = mode === 'race' ? 11 : 0;              // 11 AI + you = 12 drivers
  // AI personalities. cap = top-speed band (shown km/h); corner = how much they OVER-drive corner
  // speed (>1 = don't brake enough -> run wide into walls); wob/jit = line/steer sloppiness.
  const PERSONAS = {
    ace:   { capLo: 190, capHi: 196, skill: 1.00, engine: 1.04, corner: 1.00, wob: 0.06, jit: 0.028 },
    mid:   { capLo: 175, capHi: 185, skill: 0.97, engine: 0.99, corner: 1.04, wob: 0.12, jit: 0.045 },
    slow:  { capLo: 156, capHi: 164, skill: 0.95, engine: 0.94, corner: 1.02, wob: 0.11, jit: 0.045 },
    dumb:  { capLo: 172, capHi: 190, skill: 0.92, engine: 0.99, corner: 1.45, wob: 0.26, jit: 0.10 },
    versta:{ capLo: 226, capHi: 234, skill: 1.08, engine: 1.48, corner: 0.98, wob: 0.04, jit: 0.02 },
  };
  // roster of 11: a couple aces, some mid, a couple slow, a handful of dumb
  let roster = ['ace', 'ace', 'mid', 'mid', 'mid', 'slow', 'slow', 'dumb', 'dumb', 'dumb', 'dumb'];
  for (let k = roster.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [roster[k], roster[j]] = [roster[j], roster[k]]; }
  const verstappen = Math.random() < 0.2;            // ~1 in 5 games: a cruising monster shows up
  if (verstappen) roster[0] = 'versta';
  let verstaCar = null;
  for (let i = 0; i < nAI; i++) {
    const key = roster[i], P = PERSONAS[key], isV = key === 'versta';
    const name = isV ? 'Verstappen' : AI_NAMES[i % AI_NAMES.length];
    const color = isV ? 0xff7a1a : CAR_COLORS[(i + 1) % CAR_COLORS.length];
    const helmet = isV ? 0x14274a : HELMET_COLORS[(i + 1) % HELMET_COLORS.length];
    const veh = isV ? 'f1' : VEHICLES[Math.floor(Math.random() * VEHICLES.length)];
    const c = makeCar(color, false, name, helmet, veh);
    c.persona = key;
    c.skill = P.skill * (hardMode ? 1.02 : 1);
    c.topLo = P.capLo; c.topHi = P.capHi; c.topBias = 0;
    c.engineMul = P.engine;
    c.cornerConf = P.corner + (key === 'dumb' ? Math.random() * 0.2 : 0);   // dumb varies: some wilder
    c.topW = 0.22 + Math.random() * 0.16;             // slow top-speed breathing, out of phase
    c.topPhase = Math.random() * Math.PI * 2;
    c.lineBias = THREE.MathUtils.clamp((nAI > 1 ? -0.7 + i * (1.4 / (nAI - 1)) : 0) + (Math.random() - 0.5) * 0.25, -0.8, 0.8);
    c.wAmp = P.wob + Math.random() * 0.03;            // line wander (dumb = wide, ace = tidy)
    c.wW1 = 0.5 + Math.random() * 0.6;   c.wP1 = Math.random() * Math.PI * 2;
    c.wW2 = 1.7 + Math.random() * 1.4;   c.wP2 = Math.random() * Math.PI * 2;
    c.wJit = P.jit + Math.random() * 0.02;            // steering imperfection
    c.wJW = 3.0 + Math.random() * 2.5;   c.wJP = Math.random() * Math.PI * 2;
    if (isV) verstaCar = c;
    cars.push(c);
  }
  if (verstappen) toast('⚠ Verstappen has entered the race');
  player = makeCar(CAR_COLORS[0], true, 'You', HELMET_COLORS[0], playerVehicle);
  cars.push(player);

  cars.sort((a, b) => (b.skill || 0) - (a.skill || 0));
  cars.forEach((c, i) => {
    const row = Math.floor(i / 2), col = i % 2;
    placeCarAt(c, track.N - 10 - row * 10, (col ? 1 : -1) * track.halfW * 0.5);
    scene.add(c.mesh);
  });

  raceTime = 0;
  cars.forEach(c => { c.lap = 0; c.lapStart = 0; c.finished = false; c.finishTime = null; c.lastLap = null; c.bestLap = null; });

  if (mode === 'race') { state = 'countdown'; countdownT = 3.6; }
  else { state = 'tt'; player.lapStart = 0; player.lap = -1; }

  $('hud').style.display = 'block';
  const best = localStorage.getItem('apex_best_' + def.id);
  $('bestLap').textContent = 'Best ' + fmtTime(best ? +best : null);
  $('trackLabel').textContent = def.name;
  updateHUD();
  if (typeof sendTrackToPhone === 'function') sendTrackToPhone();   // new track outline -> phone minimap
  initAudio(); startMusic(def);                                     // per-track music (speeds up on last lap)
  if (verstaCar) startVerstappenTheme(verstaCar);                   // his theme radiates from his car
  clock.getDelta();
}

function endRace() {
  state = 'results';
  stopMusic(); stopVerstappenTheme();
  const standings = [...cars].sort((a, b) => {
    if (a.finished !== b.finished) return a.finished ? -1 : 1;
    if (a.finished) return a.finishTime - b.finishTime;
    return (b.lap * track.N + b.distAcc) - (a.lap * track.N + a.distAcc);
  });
  let html = '<h2>Race Result</h2><table>';
  standings.forEach((c, i) => {
    const t = c.finished ? fmtTime(c.finishTime * 1000) : 'DNF (' + (c.lap + 1) + ' laps)';
    const best = c.bestLap ? fmtTime(c.bestLap) : '-';
    html += `<tr class="${c.isPlayer ? 'me' : ''}">
      <td>${i + 1}</td><td><span class="dot" style="background:#${c.color.toString(16).padStart(6, '0')}"></span>${c.name}</td>
      <td>${t}</td><td>${best}</td></tr>`;
  });
  html += '</table><button onclick="backToMenu()">Back to Menu</button>';
  $('results').innerHTML = html;
  $('results').style.display = 'flex';
}

function backToMenu() {
  state = 'menu';
  stopMusic(); stopVerstappenTheme();
  $('results').style.display = 'none';
  $('pause').style.display = 'none';
  $('hud').style.display = 'none';
  $('fpOverlay').classList.remove('on');
  buildMenu();
}
window.backToMenu = backToMenu;
window.restartRace = () => { $('pause').style.display = 'none'; startGame(track.def, mode); };

function updateInvertBtn() {
  const b = $('invertBtn');
  if (b) b.textContent = 'Steering: ' + (steerInvert ? 'Inverted' : 'Normal');
}
window.toggleInvert = () => {
  steerInvert = !steerInvert;
  localStorage.setItem('apex_steerInvert', steerInvert ? '1' : '0');
  updateInvertBtn();
  toast('Steering: ' + (steerInvert ? 'Inverted' : 'Normal'));
};

function onLapComplete(car) {
  const now = raceTime * 1000;
  if (car.lap >= 0) {
    const lapMs = now - car.lapStart;
    car.lastLap = lapMs;
    if (!car.bestLap || lapMs < car.bestLap) car.bestLap = lapMs;
    if (car.isPlayer) {
      const key = 'apex_best_' + track.def.id;
      const stored = localStorage.getItem(key);
      if (!stored || lapMs < +stored) {
        localStorage.setItem(key, Math.round(lapMs));
        $('bestLap').textContent = 'Best ' + fmtTime(lapMs) + ' ★';
        toast('New best lap!');
      }
      $('lastLap').textContent = 'Last ' + fmtTime(lapMs);
    }
  }
  car.lapStart = now;
  car.lap++;
  // player just started the final lap -> ramp the music up
  if (car.isPlayer && mode === 'race' && car.lap === track.def.laps - 1) setMusicFinalLap(true);
  if (mode === 'race' && car.lap >= track.def.laps && !car.finished) {
    car.finished = true;
    car.finishTime = raceTime;
    if (car.isPlayer) endRace();
  }
}

// ---------------------------------------------------------------- audio
const audio = {};
// tanh-ish saturation curve — adds the combustion grit/exhaust rasp that makes a
// synth engine read as a real one instead of a buzz. Built once.
function makeDriveCurve(amount) {
  const n = 1024, curve = new Float32Array(n), k = amount;
  for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; curve[i] = Math.tanh(k * x) / Math.tanh(k); }
  return curve;
}
function initAudio() {
  if (audio.ctx) return;
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const master = ctx.createGain();
    master.gain.value = muted ? 0 : 0.5;
    master.connect(ctx.destination);

    // ---- engine: a stack of harmonically-related oscillators feeding a drive/saturation
    // stage, a resonant lowpass whose cutoff opens with rpm+load, then a firing-rate
    // tremolo (the lumpy growl). Detune between the two saws gives an engine's rough beat.
    const engMix = ctx.createGain(); engMix.gain.value = 1;
    const sub   = ctx.createOscillator(); sub.type   = 'sawtooth';           // low block rumble (0.5x)
    const eng   = ctx.createOscillator(); eng.type   = 'sawtooth';           // fundamental firing
    const eng2  = ctx.createOscillator(); eng2.type  = 'sawtooth'; eng2.detune.value = 11; // beat/rough
    const harm  = ctx.createOscillator(); harm.type  = 'square';             // 2x metallic body
    const harm3 = ctx.createOscillator(); harm3.type = 'sawtooth';           // 3x exhaust wail
    const gSub = ctx.createGain();  gSub.gain.value  = 0.55;
    const gEng = ctx.createGain();  gEng.gain.value  = 0.6;
    const gEng2= ctx.createGain();  gEng2.gain.value = 0.5;
    const gHarm= ctx.createGain();  gHarm.gain.value = 0.16;
    const gH3  = ctx.createGain();  gH3.gain.value   = 0.05;                 // rises with throttle
    sub.connect(gSub);  eng.connect(gEng); eng2.connect(gEng2); harm.connect(gHarm); harm3.connect(gH3);
    gSub.connect(engMix); gEng.connect(engMix); gEng2.connect(engMix); gHarm.connect(engMix); gH3.connect(engMix);

    const shaper = ctx.createWaveShaper(); shaper.curve = makeDriveCurve(2.2); shaper.oversample = '2x';
    const filt = ctx.createBiquadFilter(); filt.type = 'lowpass'; filt.frequency.value = 700; filt.Q.value = 1.1;
    const trem = ctx.createGain(); trem.gain.value = 1;          // firing-pulse growl multiplies here
    const engGain = ctx.createGain(); engGain.gain.value = 0;
    engMix.connect(shaper); shaper.connect(filt); filt.connect(trem); trem.connect(engGain); engGain.connect(master);

    // firing-rate LFO -> tremolo depth. Real engines are "lumpy" at idle, smooth at high rpm.
    const lfo = ctx.createOscillator(); lfo.type = 'triangle'; lfo.frequency.value = 30;
    const lfoDepth = ctx.createGain(); lfoDepth.gain.value = 0.18;
    lfo.connect(lfoDepth); lfoDepth.connect(trem.gain);

    [sub, eng, eng2, harm, harm3, lfo].forEach(o => o.start());

    // ---- broadband noise: intake roar (rises with load) + reused for tyre skid
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource(); noise.buffer = buf; noise.loop = true;
    // intake
    const inFilt = ctx.createBiquadFilter(); inFilt.type = 'bandpass'; inFilt.frequency.value = 480; inFilt.Q.value = 0.7;
    const inGain = ctx.createGain(); inGain.gain.value = 0;
    noise.connect(inFilt); inFilt.connect(inGain); inGain.connect(master);
    // tyre skid
    const nFilt = ctx.createBiquadFilter(); nFilt.type = 'bandpass'; nFilt.frequency.value = 900; nFilt.Q.value = 0.9;
    const nGain = ctx.createGain(); nGain.gain.value = 0;
    noise.connect(nFilt); nFilt.connect(nGain); nGain.connect(master);
    noise.start();

    // separate bus for the procedural music so it mixes under the engine
    const musicGain = ctx.createGain(); musicGain.gain.value = 0.34;
    musicGain.connect(master);

    Object.assign(audio, { ctx, master, musicGain, sub, eng, eng2, harm, harm3, gH3, gHarm, filt, trem, lfo, lfoDepth, engGain, inGain, inFilt, nGain });
  } catch (e) { /* no audio */ }
}

// ---------------------------------------------------------------- procedural music
// Per-track chiptune loops built from oscillators; tempo ramps up on the final lap.
const MUSIC = { playing: false, step: 0, bpm: 120, baseBpm: 120, nextT: 0, song: null, timer: null };
const SCALES = {
  minor:  [0, 2, 3, 5, 7, 8, 10], dorian: [0, 2, 3, 5, 7, 9, 10],
  major:  [0, 2, 4, 5, 7, 9, 11], mixo:   [0, 2, 4, 5, 7, 9, 10],
  penta:  [0, 3, 5, 7, 10],       pentaM: [0, 2, 4, 7, 9],
};
// per-track: root MIDI, scale, bpm, lead/bass waveforms, 4-bar chord roots (semitone offsets), drum feel
const SONGS = {
  indy:       { root: 45, scale: 'major',  bpm: 140, lead: 'square',   bass: 'sawtooth', chords: [0, 0, 7, 5],  drive: 1 },
  monza:      { root: 43, scale: 'minor',  bpm: 150, lead: 'sawtooth', bass: 'square',   chords: [0, 5, 3, 7],  drive: 1 },
  monaco:     { root: 44, scale: 'dorian', bpm: 116, lead: 'triangle', bass: 'sawtooth', chords: [0, 3, 5, 7],  drive: 0 },
  silverstone:{ root: 47, scale: 'major',  bpm: 132, lead: 'square',   bass: 'triangle', chords: [0, 7, 9, 5],  drive: 1 },
  suzuka:     { root: 45, scale: 'pentaM', bpm: 128, lead: 'triangle', bass: 'sawtooth', chords: [0, 5, 7, 5],  drive: 0 },
  homestead:  { root: 46, scale: 'mixo',   bpm: 120, lead: 'triangle', bass: 'triangle', chords: [0, 5, 7, 5],  drive: 0 },
  coast:      { root: 48, scale: 'major',  bpm: 126, lead: 'square',   bass: 'sawtooth', chords: [0, 9, 5, 7],  drive: 1 },
  tech:       { root: 41, scale: 'minor',  bpm: 152, lead: 'sawtooth', bass: 'square',   chords: [0, 3, 7, 8],  drive: 1 },
  alpine:     { root: 43, scale: 'minor',  bpm: 124, lead: 'triangle', bass: 'sawtooth', chords: [0, 8, 5, 3],  drive: 0 },
  baja:       { root: 45, scale: 'penta',  bpm: 138, lead: 'square',   bass: 'sawtooth', chords: [0, 0, 5, 7],  drive: 1 },
};
function midiHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
function musicNote(freq, dur, type, gain, when) {
  const ctx = audio.ctx, o = ctx.createOscillator(), g = ctx.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, when);
  g.gain.linearRampToValueAtTime(gain, when + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0008, when + dur);
  o.connect(g); g.connect(audio.musicGain);
  o.start(when); o.stop(when + dur + 0.02);
}
function musicDrum(kind, when) {
  const ctx = audio.ctx;
  if (kind === 'kick') {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = 'sine'; o.frequency.setValueAtTime(150, when); o.frequency.exponentialRampToValueAtTime(48, when + 0.12);
    g.gain.setValueAtTime(0.9, when); g.gain.exponentialRampToValueAtTime(0.001, when + 0.16);
    o.connect(g); g.connect(audio.musicGain); o.start(when); o.stop(when + 0.18);
  } else { // hat/snare = filtered noise
    const dur = kind === 'snare' ? 0.14 : 0.03;
    const buf = ctx.createBuffer(1, ctx.sampleRate * dur, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const s = ctx.createBufferSource(); s.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = kind === 'snare' ? 1400 : 7000;
    const g = ctx.createGain(); g.gain.setValueAtTime(kind === 'snare' ? 0.5 : 0.28, when); g.gain.exponentialRampToValueAtTime(0.001, when + dur);
    s.connect(f); f.connect(g); g.connect(audio.musicGain); s.start(when); s.stop(when + dur);
  }
}
function musicTick() {
  if (!MUSIC.playing || !audio.ctx) return;
  const spb = 60 / MUSIC.bpm / 4;                 // seconds per 16th step
  const now = audio.ctx.currentTime;
  // schedule any steps due within the next lookahead
  while (MUSIC.nextT < now + 0.12) {
    const t = MUSIC.nextT, s = MUSIC.step, song = MUSIC.song;
    const scale = SCALES[song.scale], bar = Math.floor(s / 16) % 4, chordRoot = song.root + song.chords[bar];
    // drums
    if (s % 4 === 0) musicDrum('kick', t);
    if (s % 8 === 4) musicDrum('snare', t);
    if (s % 2 === 1) musicDrum('hat', t);
    // bass on the beat + a little walk
    if (s % 4 === 0 || s % 8 === 6) musicNote(midiHz(chordRoot - 12), spb * (s % 4 === 0 ? 3.6 : 1.6), song.bass, 0.5, t);
    // lead arpeggio (chord tones + passing notes), busier when 'drive'
    if (s % 2 === 0 || (song.drive && s % 4 === 3)) {
      const deg = [0, 2, 4, 6, 4, 2][(s / 1) % 6 | 0] % scale.length;
      const oct = 12 * (1 + ((s >> 3) & 1));
      musicNote(midiHz(chordRoot + scale[deg] + oct), spb * 1.4, song.lead, 0.22, t);
    }
    MUSIC.step = (s + 1) % 64;
    MUSIC.nextT += spb;
  }
}
function startMusic(def) {
  if (!audio.ctx) return;
  MUSIC.song = SONGS[def.id] || { root: 45, scale: 'minor', bpm: 124, lead: 'square', bass: 'sawtooth', chords: [0, 5, 3, 7], drive: 0 };
  MUSIC.baseBpm = MUSIC.bpm = MUSIC.song.bpm;
  MUSIC.step = 0; MUSIC.nextT = audio.ctx.currentTime + 0.1; MUSIC.playing = true;
  if (audio.musicGain) audio.musicGain.gain.value = muted ? 0 : 0.34;
  if (!MUSIC.timer) MUSIC.timer = setInterval(musicTick, 40);
}
function stopMusic() { MUSIC.playing = false; if (MUSIC.timer) { clearInterval(MUSIC.timer); MUSIC.timer = null; } }
function setMusicFinalLap(on) { MUSIC.bpm = on ? Math.round(MUSIC.baseBpm * 1.28) : MUSIC.baseBpm; }

// ---------------------------------------------------------------- Verstappen's entrance theme
// Bass-heavy boss motif that RADIATES from his car (3D panner), with exaggerated Doppler as he
// blasts past + big reverb. Comedy is the point.
const _v3 = new THREE.Vector3();                           // scratch for camera direction
const VTHEME = { on: false, car: null, step: 0, nextT: 0, bassNote: 33, leadNote: 57, nodes: null };
const VT_ROOT = 33;                                        // low, menacing
const VT_BASS = [0, 0, 7, 0, 5, 5, 3, 5, 0, 0, 7, 0, 8, 8, 7, 5];       // 16-step ostinato (semitones)
const VT_LEAD = [12, -1, 15, -1, 14, -1, 12, 10, 12, -1, 19, 17, 15, 14, 12, -1]; // -1 = rest
function _audPos(n, x, y, z) { if (n.positionX) { n.positionX.value = x; n.positionY.value = y; n.positionZ.value = z; } else if (n.setPosition) { n.setPosition(x, y, z); } }
function _audOri(n, fx, fy, fz, ux, uy, uz) { if (n.forwardX) { n.forwardX.value = fx; n.forwardY.value = fy; n.forwardZ.value = fz; n.upX.value = ux; n.upY.value = uy; n.upZ.value = uz; } else if (n.setOrientation) { n.setOrientation(fx, fy, fz, ux, uy, uz); } }
function _reverbIR(ctx, sec, decay) {
  const len = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
  return b;
}
function startVerstappenTheme(car) {
  if (!audio.ctx || !car) return; const ctx = audio.ctx;
  const panner = ctx.createPanner();
  panner.panningModel = 'HRTF'; panner.distanceModel = 'inverse'; panner.refDistance = 28; panner.maxDistance = 2600; panner.rolloffFactor = 1.0;
  const mix = ctx.createGain(); mix.gain.value = 1.0;
  const boost = ctx.createBiquadFilter(); boost.type = 'lowshelf'; boost.frequency.value = 200; boost.gain.value = 15; mix.connect(boost);
  const dry = ctx.createGain(); dry.gain.value = 1.0; boost.connect(dry); dry.connect(panner);
  const conv = ctx.createConvolver(); conv.buffer = _reverbIR(ctx, 2.8, 2.4);
  const rs = ctx.createGain(); rs.gain.value = 0.55; boost.connect(rs); rs.connect(conv);
  const rg = ctx.createGain(); rg.gain.value = 0.7; conv.connect(rg); rg.connect(panner);
  panner.connect(audio.master);
  const subEnv = ctx.createGain(); subEnv.gain.value = 0.0001;                 // omni sub you FEEL, beat-gated
  const subProx = ctx.createGain(); subProx.gain.value = 0; subEnv.connect(subProx); subProx.connect(audio.master);
  const lead = ctx.createOscillator(); lead.type = 'sawtooth';
  const lead2 = ctx.createOscillator(); lead2.type = 'square'; lead2.detune.value = 9;
  const bass = ctx.createOscillator(); bass.type = 'sawtooth';
  const sub = ctx.createOscillator(); sub.type = 'sine';
  const leadG = ctx.createGain(); leadG.gain.value = 0.0001; lead.connect(leadG); lead2.connect(leadG); leadG.connect(mix);
  const bassG = ctx.createGain(); bassG.gain.value = 0.0001; bass.connect(bassG); bassG.connect(mix);
  sub.connect(subEnv);
  [lead, lead2, bass, sub].forEach(o => o.start());
  VTHEME.on = true; VTHEME.car = car; VTHEME.step = 0; VTHEME.nextT = ctx.currentTime + 0.05;
  VTHEME.nodes = { panner, mix, dry, conv, rs, rg, lead, lead2, bass, sub, leadG, bassG, subEnv, subProx };
}
function stopVerstappenTheme() {
  if (!VTHEME.on) return; VTHEME.on = false;
  try { const n = VTHEME.nodes; [n.lead, n.lead2, n.bass, n.sub].forEach(o => { try { o.stop(); } catch (e) {} }); } catch (e) {}
  VTHEME.nodes = null; VTHEME.car = null;
}
function updateVerstappenTheme() {
  if (!VTHEME.on || !audio.ctx || !player || !VTHEME.car) return;
  const ctx = audio.ctx, n = VTHEME.nodes, car = VTHEME.car;
  _audPos(ctx.listener, camera.position.x, camera.position.y, camera.position.z);
  const fwd = camera.getWorldDirection(_v3);
  _audOri(ctx.listener, fwd.x, fwd.y, fwd.z, 0, 1, 0);
  _audPos(n.panner, car.x, car.y + 1.2, car.z);
  // exaggerated Doppler from radial relative velocity (source vs listener along the sightline)
  const dx = car.x - camera.position.x, dz = car.z - camera.position.z, dist = Math.hypot(dx, dz) || 1;
  const vrel = ((car.velX - player.velX) * dx + (car.velZ - player.velZ) * dz) / dist;   // + = receding
  const C = 200; let dopp = C / (C + vrel); dopp = Math.max(0.5, Math.min(1.85, dopp));
  const spb = 60 / 126 / 4;
  if (VTHEME.nextT < ctx.currentTime - 0.5) VTHEME.nextT = ctx.currentTime;      // after a pause, don't burst
  while (VTHEME.nextT < ctx.currentTime + 0.1) {
    const t = VTHEME.nextT, s = VTHEME.step % 16;
    VTHEME.bassNote = VT_ROOT + VT_BASS[s];
    const ld = VT_LEAD[s]; if (ld >= 0) VTHEME.leadNote = VT_ROOT + 24 + ld;
    n.bassG.gain.cancelScheduledValues(t); n.bassG.gain.setValueAtTime(0.35, t); n.bassG.gain.exponentialRampToValueAtTime(0.08, t + spb * 1.6);
    if (s % 2 === 0) { n.subEnv.gain.cancelScheduledValues(t); n.subEnv.gain.setValueAtTime(1.0, t); n.subEnv.gain.exponentialRampToValueAtTime(0.02, t + spb * 2.2); }
    if (ld >= 0) { n.leadG.gain.cancelScheduledValues(t); n.leadG.gain.setValueAtTime(0.2, t); n.leadG.gain.exponentialRampToValueAtTime(0.02, t + spb * 1.8); }
    VTHEME.step++; VTHEME.nextT += spb;
  }
  n.bass.frequency.value = midiHz(VTHEME.bassNote) * dopp;
  n.sub.frequency.value = midiHz(VTHEME.bassNote - 12) * dopp;
  n.lead.frequency.value = midiHz(VTHEME.leadNote) * dopp;
  n.lead2.frequency.value = midiHz(VTHEME.leadNote) * dopp;
  n.subProx.gain.setTargetAtTime(0.55 * Math.max(0, 1 - dist / 220), ctx.currentTime, 0.05);
}
function updateAudio(dt) {
  if (!audio.ctx || !player) return;
  const active = state === 'race' || state === 'tt' || state === 'countdown';
  const speed = Math.hypot(player.velX, player.velZ);
  const thr = Math.max(keys['w'] ? 1 : 0, throttlePedal || 0);   // 0..1 load
  // rpm-ish fundamental: idle ~46Hz, climbs with speed; throttle adds a little "pull"
  const f = 46 + speed * 3.1 + thr * 22;
  const g = (o, v) => { if (o) o.frequency.setTargetAtTime(v, audio.ctx.currentTime, 0.03); };
  g(audio.sub,   f * 0.5);
  g(audio.eng,   f);
  g(audio.eng2,  f);
  g(audio.harm,  f * 2);
  g(audio.harm3, f * 3);
  audio.eng2.detune.value = 9 + speed * 0.12;                    // beat widens with revs
  // firing pulses track rpm; the growl is deep at idle and fades out up top
  const firing = Math.max(24, f * 1.05);
  audio.lfo.frequency.setTargetAtTime(firing, audio.ctx.currentTime, 0.05);
  audio.lfoDepth.gain.value = Math.max(0.02, 0.22 - speed * 0.0016);
  // brightness opens with rpm AND throttle (load) — the on-throttle "snarl"
  audio.filt.frequency.setTargetAtTime(500 + speed * 22 + thr * 900, audio.ctx.currentTime, 0.04);
  audio.gH3.gain.setTargetAtTime(0.04 + thr * 0.14, audio.ctx.currentTime, 0.05);   // exhaust wail under power
  audio.engGain.gain.setTargetAtTime(active ? 0.16 + Math.min(speed / 260, 0.1) : 0, audio.ctx.currentTime, 0.05);
  // intake roar: louder with speed & throttle
  audio.inFilt.frequency.value = 380 + speed * 6;
  audio.inGain.gain.setTargetAtTime(active ? Math.min(speed / 900, 0.05) + thr * 0.03 : 0, audio.ctx.currentTime, 0.06);
  // tyre scrub
  audio.nGain.gain.setTargetAtTime(active && player.slip > 5 && player.onRoad ? Math.min((player.slip - 5) / 40, 0.16) : 0, audio.ctx.currentTime, 0.03);
  updateVerstappenTheme();                          // spatial + doppler theme radiating from his car
}

// ---------------------------------------------------------------- minimap
let miniBase = null, miniScale = null;
function buildMinimap(def) {
  const cv = $('minimap');
  miniBase = document.createElement('canvas');
  miniBase.width = cv.width; miniBase.height = cv.height;
  miniScale = drawTrackThumb(miniBase, def, 'rgba(255,255,255,0.85)');
}
function drawMinimap() {
  const cv = $('minimap'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  ctx.drawImage(miniBase, 0, 0);
  for (const c of cars) {
    ctx.fillStyle = c.isPlayer ? '#ffffff' : '#' + c.color.toString(16).padStart(6, '0');
    ctx.beginPath();
    ctx.arc(c.x * miniScale.s + miniScale.ox, c.z * miniScale.s + miniScale.oz, c.isPlayer ? 4 : 3, 0, 7);
    ctx.fill();
    if (c.isPlayer) { ctx.strokeStyle = '#222'; ctx.stroke(); }
  }
}

// ---------------------------------------------------------------- HUD
function updateHUD() {
  const speed = Math.round(Math.hypot(player.velX, player.velZ) * 3.6 * SPEED_DISPLAY_SCALE);
  $('speed').textContent = speed;
  if (mode === 'race') {
    const order = [...cars].sort((a, b) => (b.lap * track.N + b.distAcc) - (a.lap * track.N + a.distAcc));
    const pos = order.indexOf(player) + 1;
    $('position').textContent = 'P' + pos + ' / ' + cars.length;
    $('lapCount').textContent = 'Lap ' + Math.min(player.lap + 1, track.def.laps) + ' / ' + track.def.laps;
  } else {
    $('position').textContent = 'Time Trial';
    $('lapCount').textContent = player.lap >= 1 ? 'Lap ' + (player.lap + 1) : 'Out lap';
  }
  $('curLap').textContent = fmtTime(player.lap >= 0 || mode === 'race' ? raceTime * 1000 - player.lapStart : null);
}

// ---------------------------------------------------------------- main loop
function loop() {
  requestAnimationFrame(loop);
  let dt = Math.min(clock.getDelta(), 0.05);

  if (toastT > 0) { toastT -= dt; if (toastT <= 0) $('toast').style.opacity = '0'; }
  if (state === 'menu' || state === 'paused' || !track) return;

  if (state === 'countdown') {
    countdownT -= dt;
    const el = $('countdown');
    if (countdownT > 2.4) { el.textContent = '3'; setLights(1); }
    else if (countdownT > 1.2) { el.textContent = '2'; setLights(2); }
    else if (countdownT > 0) { el.textContent = '1'; setLights(3); }
    else {
      el.textContent = 'GO!'; setLights(0, true);
      state = 'race'; raceTime = 0;
      cars.forEach(c => { c.lapStart = 0; });
      setTimeout(() => { el.textContent = ''; }, 900);
    }
    el.style.display = 'block';
    updateCarVisuals(dt);
    render(dt); updateAudio(dt);
    return;
  }

  if (state === 'race' || state === 'tt') {
    raceTime += dt;
    // per-bot fluctuating top-speed limiter: slowly breathe each bot's cap within its shown-speed
    // band. Fast tier squares the wave so it hangs near the low end (195) and only rarely nears 200.
    const shownToWorld = 1 / (3.6 * SPEED_DISPLAY_SCALE);
    for (const c of cars) {
      if (c.isPlayer || !c.topHi) continue;
      let n = 0.5 + 0.5 * Math.sin(raceTime * c.topW + c.topPhase);   // 0..1
      if (c.topBias) n *= n;                                          // skew toward the low end
      c.vCap = (c.topLo + (c.topHi - c.topLo) * n) * shownToWorld;
    }
    // analog click pedals: ease travel toward the held state (press ~0.13s, release ~0.09s)
    throttlePedal += ((mouseThrottle ? 1 : 0) - throttlePedal) * (1 - Math.exp(-dt / (mouseThrottle ? 0.13 : 0.09)));
    brakePedal    += ((mouseBrake    ? 1 : 0) - brakePedal)    * (1 - Math.exp(-dt / (mouseBrake    ? 0.13 : 0.09)));
    if (throttlePedal < 0.02 && !mouseThrottle) throttlePedal = 0;
    if (brakePedal < 0.02 && !mouseBrake) brakePedal = 0;
    const kThr = (keys['w'] || keys['arrowup']) ? 1 : 0;
    const kBrk = (keys['s'] || keys['arrowdown']) ? 1 : 0;
    const sub = dt / SUBSTEPS;
    for (let s = 0; s < SUBSTEPS; s++) {
      for (const car of cars) {
        let input;
        if (car.isPlayer) {
          const now = performance.now();
          const hidGas = (now - hidGasLast) < HID_TIMEOUT;      // pedal seen "pushed" recently
          const hidBrk = (now - hidBrakeLast) < HID_TIMEOUT;
          const thr = Math.max(kThr, throttlePedal, hidGas ? 1 : 0);
          let brk = Math.max(kBrk, brakePedal, phoneBrake ? 1 : 0, hidBrk ? 1 : 0);
          // off the gas (and not braking) => gentle engine-braking so lifting off slows you a little
          if (thr < 0.06 && brk < 0.06) brk = COAST_BRAKE;
          input = { throttle: thr, brake: brk, steer: playerSteer(), handbrake: keys[' '] ? 1 : 0 };
        } else if (car.finished) {
          input = aiInputs(car); input.throttle = Math.min(input.throttle, 0.4);
        } else {
          input = aiInputs(car);
        }
        const before = car.distAcc;
        stepCar(car, input, sub);
        if (before < track.N && car.distAcc >= track.N) { car.distAcc -= track.N; onLapComplete(car); }
        else if (car.distAcc < -track.N * 0.5) { car.distAcc += track.N; car.lap--; }
      }
      collideCars(sub);
    }
    updateCarVisuals(dt);
    updateHUD();
    drawMinimap();
    // phone haptics: heavy shake when you're off the track; a light rumble on the Dust Devil dirt
    if (typeof sendRumble === 'function') {
      const pv = Math.hypot(player.velX, player.velZ);
      let rumble = 0;
      if (!player.onRoad) rumble = Math.min(1, 0.7 + pv / 25);                          // off track: lots of shake
      else if (track.def.surface === 'dirt') rumble = 0.22 * Math.min(1, 0.5 + pv / 45); // baja dirt: slight
      sendRumble(rumble);
    }
    if (typeof sendTelemetry === 'function') sendTelemetry();   // speed + car dots -> phone HUD
  }

  render(dt); updateAudio(dt);
}

function updateCarVisuals(dt) {
  for (const car of cars) {
    car.mesh.position.set(car.x, car.y, car.z);

    // Orient the chassis to the ground surface under it: sample the terrain around the
    // car, build the surface normal, and sit the car on that plane (real hill-following).
    const L = 2.6;
    const gx = (terrainHeight(car.x + L, car.z) - terrainHeight(car.x - L, car.z)) / (2 * L);
    const gz = (terrainHeight(car.x, car.z + L) - terrainHeight(car.x, car.z - L)) / (2 * L);
    _n.set(-gx, 1, -gz).normalize();
    if (!car._up) car._up = _n.clone();
    else car._up.lerp(_n, Math.min(1, dt * 7)).normalize();     // smooth out jitter
    _f.set(Math.sin(car.heading), 0, Math.cos(car.heading));
    _f.addScaledVector(car._up, -_f.dot(car._up));              // project heading onto the surface
    if (_f.lengthSq() < 1e-6) _f.set(Math.sin(car.heading), 0, Math.cos(car.heading));
    _f.normalize();
    _r.crossVectors(car._up, _f).normalize();                  // local +X (right)
    _m.makeBasis(_r, car._up, _f);                             // columns: right, up, forward
    car.mesh.quaternion.setFromRotationMatrix(_m);

    const speed = Math.hypot(car.velX, car.velZ);
    for (const w of car.mesh.userData.wheels) {
      if (w.userData.front) w.rotation.y = car.steer * 2.4;
      w.children[0].rotation.x += speed * dt / 0.45;
    }
  }
}

function setLights(n, green) {
  track.startLights.forEach((m, i) => {
    if (green) m.color.setHex(0x22dd44);
    else m.color.setHex(i < n ? 0xee2222 : 0x330000);
  });
}

function render(dt) {
  const speed = Math.hypot(player.velX, player.velZ);
  const fX = Math.sin(player.heading), fZ = Math.cos(player.heading);
  player.mesh.visible = camMode !== CAM_COCKPIT;

  const fp = $('fpOverlay');
  let targetFov = 70;
  if (camMode === CAM_COCKPIT) {
    camera.position.set(player.x - fX * 0.2, player.y + 1.15, player.z - fZ * 0.2);
    camera.lookAt(player.x + fX * 30, player.y + 0.95, player.z + fZ * 30);
    targetFov = 84 + Math.min(speed * 0.62, 46);   // fisheye speed tunnel — cranked in cockpit
    if (!fp.classList.contains('on')) fp.classList.add('on');
    $('fpWheel').style.transform = `translateX(-50%) rotate(${(-player.steer * 2.2).toFixed(3)}rad)`;
    $('fpReadout').textContent = Math.round(speed * 3.6 * SPEED_DISPLAY_SCALE);
  } else {
    if (fp.classList.contains('on')) fp.classList.remove('on');
    const near = camMode === CAM_CHASE;
    const dist = (near ? 6.4 : 12.5) + speed * (near ? 0.05 : 0.08);
    const h = (near ? 3.0 : 5.2) + speed * 0.016;
    tmpV.set(player.x - fX * dist, player.y + h, player.z - fZ * dist);
    const k = 1 - Math.exp(-(near ? 8 : 5) * dt);
    camera.position.lerp(tmpV, k);
    camera.position.y = Math.max(camera.position.y, player.y + (near ? 1.7 : 2.4));
    camera.lookAt(player.x + fX * 7, player.y + 1.3, player.z + fZ * 7);
    targetFov = 70 + Math.min(speed * 0.15, 15);
  }
  camera.fov += (targetFov - camera.fov) * Math.min(1, dt * 4);
  camera.updateProjectionMatrix();

  dirLight.position.set(player.x + 120, 200, player.z + 90);
  dirLight.target.position.set(player.x, 0, player.z);

  renderer.render(scene, camera);
}

boot();
