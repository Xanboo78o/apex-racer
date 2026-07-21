/* Open-world builder: turns the baked PEMBROKE OSM data into a drivable road network.
   Populates the SAME global `track` object the rest of the engine uses (samples/rights/bank/
   width/nearestInfo/def) with open:true, so terrainHeight/surfaceAt/physics all work network-wide.
   Reuses main.js globals: THREE, scene, camera, disposeScene, ambientHills, terrainHeight,
   toonMat, OUTLINE_MAT, buildTerrain, addSky, SURFACES, dirLight. */
'use strict';

const TOWN_ENV = {
  ground: 0x5f8a46, ground2: 0x4b7238, sky: 0x9fd0f4, top: 0x2f74cf, horizon: 0xd2e6f4,
  fog: 2500, scatter: 'none', dense: 0,
};
// building collision (oriented boxes in a coarse spatial hash)
let WORLD_BLDG = [], WORLD_BHASH = new Map();
const WORLD_BCELL = 40;
function worldCollide(car) {
  const cx = Math.floor(car.x / WORLD_BCELL), cz = Math.floor(car.z / WORLD_BCELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const arr = WORLD_BHASH.get((cx + i) + ',' + (cz + j)); if (!arr) continue;
    for (const bi of arr) {
      const b = WORLD_BLDG[bi];
      const dx = car.x - b.cx, dz = car.z - b.cz;
      const u = dx * b.ca + dz * b.sa, v = -dx * b.sa + dz * b.ca;   // car in box-local frame
      if (u > -b.hw && u < b.hw && v > -b.hd && v < b.hd) {
        const pu = b.hw - Math.abs(u), pv = b.hd - Math.abs(v);       // penetration each axis
        let nu = 0, nv = 0;
        if (pu < pv) nu = u < 0 ? -1 : 1; else nv = v < 0 ? -1 : 1;   // push out shortest axis
        const nx = nu * b.ca - nv * b.sa, nz = nu * b.sa + nv * b.ca; // normal back to world
        const push = Math.min(pu, pv);
        car.x += nx * push; car.z += nz * push;
        const vOut = car.velX * nx + car.velZ * nz;
        if (vOut < 0) { car.velX -= vOut * nx * 1.3; car.velZ -= vOut * nz * 1.3; car.velX *= 0.85; car.velZ *= 0.85; }
      }
    }
  }
}
const ROAD_COL = 0x3b3f47, PATCH_COL = 0x35393f;
const BLDG_PAL = [0xb9a894, 0xc7b7a2, 0x9aa3ad, 0xa8907c, 0xcabfa8, 0x8f97a2, 0xc4a98e, 0x7f8894];

// resample a polyline (edge.pts) to ~1 vertex per `step` metres, as centripetal Catmull-Rom
function resamplePoly(pts, step) {
  if (pts.length < 2) return pts.map(p => new THREE.Vector3(p[0], 0, p[1]));
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const n = Math.max(1, Math.round(len / step));
  const curve = new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], 0, p[1])), false, 'centripetal');
  return curve.getSpacedPoints(n);            // n+1 points
}

// oriented bounding box of a building footprint (aligned to its longest edge)
function buildingOBB(poly) {
  let bestL = -1, ang = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz;
    if (L > bestL) { bestL = L; ang = Math.atan2(dz, dx); }
  }
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let minU = 1e9, maxU = -1e9, minV = 1e9, maxV = -1e9;
  for (const p of poly) {
    const u = p[0] * ca + p[1] * sa, v = -p[0] * sa + p[1] * ca;
    if (u < minU) minU = u; if (u > maxU) maxU = u; if (v < minV) minV = v; if (v > maxV) maxV = v;
  }
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  return { cx: cu * ca - cv * sa, cz: cu * sa + cv * ca, w: maxU - minU, d: maxV - minV, ang };
}

function buildWorld() {
  const P = window.PEMBROKE;
  disposeScene();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(TOWN_ENV.sky);
  scene.fog = new THREE.Fog(TOWN_ENV.horizon, TOWN_ENV.fog * 0.4, TOWN_ENV.fog);

  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x4a5236, 0.74));
  dirLight = new THREE.DirectionalLight(0xfff4e2, 1.35);
  dirLight.position.set(200, 320, 150);
  dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048);
  dirLight.shadow.bias = -0.0004;
  const sc = dirLight.shadow.camera;
  sc.left = -180; sc.right = 180; sc.top = 180; sc.bottom = -180; sc.near = 20; sc.far = 700;
  scene.add(dirLight, dirLight.target);
  if (camera) { camera.far = 9000; camera.updateProjectionMatrix(); }

  const townDef = { env: 'town', hills: 0.06, surface: 'asphalt', laps: 0 };

  // ---- Pass A: resample every edge centerline into merged sample arrays + build nearestInfo
  const samples = [], rights = [], width = [], bank = [];
  const edgeSamp = [];                              // per-edge: {verts:[Vector3], right:[{x,z}], halfW}
  for (const e of P.edges) {
    const verts = resamplePoly(e.pts, 8);
    const rs = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[Math.max(0, i - 1)], b = verts[Math.min(verts.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z; const L = Math.hypot(tx, tz) || 1; tx /= L; tz /= L;
      rs.push({ x: tz, z: -tx });                   // right = perpendicular (matches buildTrack)
    }
    const hw = e.w / 2;
    edgeSamp.push({ verts, right: rs, halfW: hw });
    for (let i = 0; i < verts.length; i++) {
      const v = verts[i]; v.y = ambientHills(v.x, v.z, townDef.hills);
      samples.push(v); rights.push(new THREE.Vector3(rs[i].x, 0, rs[i].z)); width.push(hw); bank.push(0);
    }
  }
  const N = samples.length;

  // spatial hash (same shape as buildTrack's nearestInfo)
  const cellSize = 40, hash = new Map();
  for (let i = 0; i < N; i++) {
    const p = samples[i], k = Math.floor(p.x / cellSize) + ',' + Math.floor(p.z / cellSize);
    (hash.get(k) || hash.set(k, []).get(k)).push(i);
  }
  // NOTE: no O(N) fallback — a real-scale rural town has most points far from any road; the
  // fallback would make world/terrain build O(N^2) and hang. Far points just return d=huge
  // (widened to a 2-cell radius so streets are never missed within ~80m), and terrainHeight
  // then blends to open rolling hills there.
  const nearestInfo = (x, z) => {
    let bestD = 1e9, bestI = 0;
    const cx = Math.floor(x / cellSize), cz = Math.floor(z / cellSize);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) {
      const arr = hash.get((cx + i) + ',' + (cz + j));
      if (arr) for (const s of arr) { const p = samples[s], d = Math.hypot(p.x - x, p.z - z); if (d < bestD) { bestD = d; bestI = s; } }
    }
    return { d: bestD, y: samples[bestI].y, i: bestI };
  };

  track = {
    def: townDef, open: true, samples, rights, bank, width, N,
    halfW: 7, ds: 8, nearestInfo, distToTrack: (x, z) => nearestInfo(x, z).d,
    bbox: P.bbox, nodes: P.nodes, edges: P.edges, races: P.races,
  };

  // terrain + sky (reuse main.js builders; they read the global `track`/terrainHeight)
  const [minX, minZ, maxX, maxZ] = P.bbox;
  buildTerrain(townDef, TOWN_ENV, minX, maxX, minZ, maxZ);
  addSky(TOWN_ENV);

  // ---- Pass B: road ribbon mesh (one merged geometry, draped on terrain)
  const pos = [], idx = [];
  let base = 0;
  const roadMat = toonMat(ROAD_COL, { side: THREE.DoubleSide });
  for (const es of edgeSamp) {
    const v = es.verts, r = es.right, hw = es.halfW;
    const start = base;
    for (let i = 0; i < v.length; i++) {
      const p = v[i], y = terrainHeight(p.x, p.z) + 0.05;
      pos.push(p.x + r[i].x * hw, y, p.z + r[i].z * hw);
      pos.push(p.x - r[i].x * hw, y, p.z - r[i].z * hw);
    }
    for (let i = 0; i < v.length - 1; i++) {
      const a = start + i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    base += v.length * 2;
  }
  // intersection patches (a small square at each graph node so junctions read as solid)
  for (const nd of P.nodes) {
    const [x, z] = nd, y = terrainHeight(x, z) + 0.04, r = 6;
    const a = base;
    pos.push(x - r, y, z - r, x + r, y, z - r, x - r, y, z + r, x + r, y, z + r);
    idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    base += 4;
  }
  const roadGeo = new THREE.BufferGeometry();
  roadGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  roadGeo.setIndex(idx); roadGeo.computeVertexNormals();
  const roadMesh = new THREE.Mesh(roadGeo, roadMat);
  roadMesh.receiveShadow = true; roadMesh.frustumCulled = false;
  scene.add(roadMesh);

  // ---- buildings: one InstancedMesh of oriented boxes (+ toon outline)
  const nb = P.buildings.length;
  const box = new THREE.BoxGeometry(1, 1, 1);
  const bMat = toonMat(0xffffff);                    // white base; per-instance colour via setColorAt
  const bInst = new THREE.InstancedMesh(box, bMat, nb);
  bInst.castShadow = true; bInst.frustumCulled = false;
  const m4 = new THREE.Matrix4(), col = new THREE.Color();
  let bi = 0;
  WORLD_BLDG = []; WORLD_BHASH = new Map();
  for (const b of P.buildings) {
    const o = buildingOBB(b.poly);
    if (o.w < 2 || o.d < 2 || o.w > 200 || o.d > 200) continue;
    const gy = terrainHeight(o.cx, o.cz);
    m4.makeRotationY(-o.ang);
    m4.scale(new THREE.Vector3(o.w, b.h, o.d));
    m4.setPosition(o.cx, gy + b.h / 2, o.cz);
    bInst.setMatrixAt(bi, m4);
    bInst.setColorAt(bi, col.setHex(BLDG_PAL[bi % BLDG_PAL.length]));
    bi++;
    // collision OBB (footprint + 0.4 car-radius margin)
    const obb = { cx: o.cx, cz: o.cz, hw: o.w / 2 + 1.6, hd: o.d / 2 + 1.6, ca: Math.cos(o.ang), sa: Math.sin(o.ang) };
    const bidx = WORLD_BLDG.length; WORLD_BLDG.push(obb);
    const c0 = Math.floor((o.cx - o.w / 2) / WORLD_BCELL), c1 = Math.floor((o.cx + o.w / 2) / WORLD_BCELL);
    const d0 = Math.floor((o.cz - o.d / 2) / WORLD_BCELL), d1 = Math.floor((o.cz + o.d / 2) / WORLD_BCELL);
    for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) {
      const k = cx + ',' + cz; (WORLD_BHASH.get(k) || WORLD_BHASH.set(k, []).get(k)).push(bidx);
    }
  }
  bInst.count = bi;
  scene.add(bInst);
  // instanced outline (inverted hull) — replicate outlineInstanced
  const og = box.clone();
  const op = og.attributes.position;
  for (let i = 0; i < op.count; i++) op.setXYZ(i, op.getX(i) * 1.04, op.getY(i) * 1.02, op.getZ(i) * 1.04);
  op.needsUpdate = true;
  const oInst = new THREE.InstancedMesh(og, OUTLINE_MAT, bi);
  oInst.instanceMatrix = bInst.instanceMatrix; oInst.count = bi; oInst.frustumCulled = false;
  scene.add(oInst);

  // spawn: near the first race start (a main street), or town centroid
  const spawn = (P.races[0] && P.races[0].start) || [(minX + maxX) / 2, (minZ + maxZ) / 2];
  track.spawn = { x: spawn[0], z: spawn[1] };
  return track;
}
