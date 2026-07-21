/* Open-world builder: baked PEMBROKE OSM (roads/buildings/water/forests/schools + real elevation
   heightmap) -> a drivable network in the shared global `track` (open:true). Reuses main.js
   globals: THREE, scene, camera, disposeScene, terrainHeight, toonMat, OUTLINE_MAT, buildTerrain,
   addSky, dirLight. */
'use strict';

const TOWN_ENV = { ground: 0x5f8a46, ground2: 0x4b7238, sky: 0x9fd0f4, top: 0x2f74cf, horizon: 0xd2e6f4, fog: 2600, scatter: 'none', dense: 0 };
const ROAD_COL = 0x3b3f47, WATER_COL = 0x3d82c4, BLDG_PAL = [0xb9a894, 0xc7b7a2, 0x9aa3ad, 0xa8907c, 0xcabfa8, 0x8f97a2, 0xc4a98e, 0x7f8894], SCHOOL_COL = 0x9c4a3a;

// building collision (oriented boxes in a coarse spatial hash)
let WORLD_BLDG = [], WORLD_BHASH = new Map();
const WORLD_BCELL = 40;
function worldCollide(car) {
  const cx = Math.floor(car.x / WORLD_BCELL), cz = Math.floor(car.z / WORLD_BCELL);
  for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
    const arr = WORLD_BHASH.get((cx + i) + ',' + (cz + j)); if (!arr) continue;
    for (const bi of arr) {
      const b = WORLD_BLDG[bi], dx = car.x - b.cx, dz = car.z - b.cz;
      const u = dx * b.ca + dz * b.sa, v = -dx * b.sa + dz * b.ca;
      if (u > -b.hw && u < b.hw && v > -b.hd && v < b.hd) {
        const pu = b.hw - Math.abs(u), pv = b.hd - Math.abs(v);
        let nu = 0, nv = 0; if (pu < pv) nu = u < 0 ? -1 : 1; else nv = v < 0 ? -1 : 1;
        const nx = nu * b.ca - nv * b.sa, nz = nu * b.sa + nv * b.ca, push = Math.min(pu, pv);
        car.x += nx * push; car.z += nz * push;
        const vo = car.velX * nx + car.velZ * nz;
        if (vo < 0) { car.velX -= vo * nx * 1.3; car.velZ -= vo * nz * 1.3; car.velX *= 0.85; car.velZ *= 0.85; }
      }
    }
  }
}

const HILL_EXAG = 3.5;                             // very exaggerated NH hills (166m -> ~580m relief)
// bilinear elevation from the baked heightmap
function makeHeightAt(H) {
  return (x, z) => {
    let cf = (x - H.x0) / H.dx, rf = (z - H.z0) / H.dz;
    cf = Math.max(0, Math.min(H.cols - 1.001, cf)); rf = Math.max(0, Math.min(H.rows - 1.001, rf));
    const c0 = cf | 0, r0 = rf | 0, fc = cf - c0, fr = rf - r0, d = H.data, cw = H.cols;
    const a = d[r0 * cw + c0], b = d[r0 * cw + c0 + 1], c = d[(r0 + 1) * cw + c0], e = d[(r0 + 1) * cw + c0 + 1];
    return ((a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + e * fc) * fr) * HILL_EXAG;
  };
}

function resamplePoly(pts, step) {
  if (pts.length < 2) return pts.map(p => new THREE.Vector3(p[0], 0, p[1]));
  let len = 0; for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const n = Math.max(1, Math.round(len / step));
  return new THREE.CatmullRomCurve3(pts.map(p => new THREE.Vector3(p[0], 0, p[1])), false, 'centripetal').getSpacedPoints(n);
}
function buildingOBB(poly) {
  let bestL = -1, ang = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length], dx = b[0] - a[0], dz = b[1] - a[1], L = dx * dx + dz * dz; if (L > bestL) { bestL = L; ang = Math.atan2(dz, dx); } }
  const ca = Math.cos(ang), sa = Math.sin(ang);
  let mnU = 1e9, mxU = -1e9, mnV = 1e9, mxV = -1e9;
  for (const p of poly) { const u = p[0] * ca + p[1] * sa, v = -p[0] * sa + p[1] * ca; if (u < mnU) mnU = u; if (u > mxU) mxU = u; if (v < mnV) mnV = v; if (v > mxV) mxV = v; }
  const cu = (mnU + mxU) / 2, cv = (mnV + mxV) / 2;
  return { cx: cu * ca - cv * sa, cz: cu * sa + cv * ca, w: mxU - mnU, d: mxV - mnV, ang };
}
function polyInPoly(x, z, poly) { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; }
function polyArea2(p) { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return Math.abs(a) / 2; }

function buildWorld() {
  const P = window.PEMBROKE;
  const heightAt = makeHeightAt(P.height);
  disposeScene();
  scene = new THREE.Scene();
  scene.background = new THREE.Color(TOWN_ENV.sky);
  scene.fog = new THREE.Fog(TOWN_ENV.horizon, TOWN_ENV.fog * 0.4, TOWN_ENV.fog);
  scene.add(new THREE.HemisphereLight(0xeaf4ff, 0x49563a, 0.72));
  dirLight = new THREE.DirectionalLight(0xfff4e2, 1.35);
  dirLight.position.set(200, 340, 150); dirLight.castShadow = true;
  dirLight.shadow.mapSize.set(2048, 2048); dirLight.shadow.bias = -0.0004;
  const sc = dirLight.shadow.camera; sc.left = -200; sc.right = 200; sc.top = 200; sc.bottom = -200; sc.near = 20; sc.far = 800;
  scene.add(dirLight, dirLight.target);
  if (camera) { camera.far = 9000; camera.updateProjectionMatrix(); }

  const townDef = { env: 'town', hills: 0, surface: 'asphalt', laps: 0 };

  // Pass A: sample all road centerlines -> merged arrays + nearestInfo (y = real elevation)
  const samples = [], rights = [], width = [], bank = [], edgeSamp = [];
  for (const e of P.edges) {
    const verts = resamplePoly(e.pts, 9), rs = [];
    for (let i = 0; i < verts.length; i++) {
      const a = verts[Math.max(0, i - 1)], b = verts[Math.min(verts.length - 1, i + 1)];
      let tx = b.x - a.x, tz = b.z - a.z; const L = Math.hypot(tx, tz) || 1;
      rs.push({ x: tz / L, z: -tx / L });
    }
    const hw = e.w / 2; edgeSamp.push({ verts, right: rs, halfW: hw });
    for (let i = 0; i < verts.length; i++) { const v = verts[i]; v.y = heightAt(v.x, v.z); samples.push(v); rights.push(new THREE.Vector3(rs[i].x, 0, rs[i].z)); width.push(hw); bank.push(0); }
  }
  const N = samples.length, cellSize = 40, hash = new Map();
  for (let i = 0; i < N; i++) { const p = samples[i], k = Math.floor(p.x / cellSize) + ',' + Math.floor(p.z / cellSize); (hash.get(k) || hash.set(k, []).get(k)).push(i); }
  const nearestInfo = (x, z) => {                 // NO O(N) fallback (rural real-scale would hang)
    let bd = 1e9, bi = 0; const cx = Math.floor(x / cellSize), cz = Math.floor(z / cellSize);
    for (let i = -2; i <= 2; i++) for (let j = -2; j <= 2; j++) { const arr = hash.get((cx + i) + ',' + (cz + j)); if (arr) for (const s of arr) { const p = samples[s], d = Math.hypot(p.x - x, p.z - z); if (d < bd) { bd = d; bi = s; } } }
    return { d: bd, y: samples[bi].y, i: bi };
  };
  track = { def: townDef, open: true, heightAt, samples, rights, bank, width, N, halfW: 9, ds: 9, nearestInfo, distToTrack: (x, z) => nearestInfo(x, z).d, bbox: P.bbox, nodes: P.nodes, edges: P.edges, races: P.races, schools: P.schools };

  const [minX, minZ, maxX, maxZ] = P.bbox;
  buildTerrain(townDef, TOWN_ENV, minX, maxX, minZ, maxZ);   // follows terrainHeight -> real elevation
  addSky(TOWN_ENV);

  // ---- water (draped, under the road slightly) ----
  { const wp = [], wi = []; let wb = 0;
    for (const wobj of (P.water || [])) {                    // lake/pond -> fan triangulation
      const poly = wobj.poly; if (poly.length < 3) continue;
      let cx = 0, cz = 0; for (const q of poly) { cx += q[0]; cz += q[1]; } cx /= poly.length; cz /= poly.length;
      const y = heightAt(cx, cz) - 0.25; const c0 = wb; wp.push(cx, y, cz);
      for (const q of poly) wp.push(q[0], y, q[1]);
      for (let i = 0; i < poly.length; i++) wi.push(c0, c0 + 1 + i, c0 + 1 + (i + 1) % poly.length);
      wb += poly.length + 1;
    }
    for (const rv of (P.waterways || [])) {                  // river/stream -> ribbon
      const v = resamplePoly(rv.pts, 12), hw = rv.w / 2; const c0 = wb;
      for (let i = 0; i < v.length; i++) {
        const a = v[Math.max(0, i - 1)], b = v[Math.min(v.length - 1, i + 1)]; let tx = b.x - a.x, tz = b.z - a.z; const L = Math.hypot(tx, tz) || 1;
        const rx = tz / L, rz = -tx / L, y = heightAt(v[i].x, v[i].z) - 0.2;
        wp.push(v[i].x + rx * hw, y, v[i].z + rz * hw, v[i].x - rx * hw, y, v[i].z - rz * hw);
      }
      for (let i = 0; i < v.length - 1; i++) { const a = c0 + i * 2; wi.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      wb += v.length * 2;
    }
    if (wp.length) { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3)); g.setIndex(wi); g.computeVertexNormals(); const m = new THREE.Mesh(g, toonMat(WATER_COL, { side: THREE.DoubleSide })); m.frustumCulled = false; scene.add(m); }
  }

  // ---- road ribbon mesh + intersection patches ----
  { const pos = [], idx = []; let base = 0;
    for (const es of edgeSamp) {
      const v = es.verts, r = es.right, hw = es.halfW, start = base;
      for (let i = 0; i < v.length; i++) { const p = v[i], y = heightAt(p.x, p.z) + 0.06; pos.push(p.x + r[i].x * hw, y, p.z + r[i].z * hw, p.x - r[i].x * hw, y, p.z - r[i].z * hw); }
      for (let i = 0; i < v.length - 1; i++) { const a = start + i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
      base += v.length * 2;
    }
    for (const nd of P.nodes) { const [x, z] = nd, y = heightAt(x, z) + 0.05, r = 9, a = base; pos.push(x - r, y, z - r, x + r, y, z - r, x - r, y, z + r, x + r, y, z + r); idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); base += 4; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx); g.computeVertexNormals();
    const m = new THREE.Mesh(g, toonMat(ROAD_COL, { side: THREE.DoubleSide })); m.receiveShadow = true; m.frustumCulled = false; scene.add(m);
  }

  // ---- buildings (oriented boxes, school-tinted) + collision ----
  const box = new THREE.BoxGeometry(1, 1, 1), bMat = toonMat(0xffffff);
  const bInst = new THREE.InstancedMesh(box, bMat, P.buildings.length); bInst.castShadow = true; bInst.frustumCulled = false;
  const m4 = new THREE.Matrix4(), col = new THREE.Color(); let bi = 0;
  WORLD_BLDG = []; WORLD_BHASH = new Map();
  for (const b of P.buildings) {
    const o = buildingOBB(b.poly); if (o.w < 2 || o.d < 2 || o.w > 220 || o.d > 220) continue;
    const gy = heightAt(o.cx, o.cz);
    m4.makeRotationY(-o.ang); m4.scale(new THREE.Vector3(o.w, b.h, o.d)); m4.setPosition(o.cx, gy + b.h / 2, o.cz);
    bInst.setMatrixAt(bi, m4); bInst.setColorAt(bi, col.setHex(b.school ? SCHOOL_COL : BLDG_PAL[bi % BLDG_PAL.length])); bi++;
    const obb = { cx: o.cx, cz: o.cz, hw: o.w / 2 + 1.6, hd: o.d / 2 + 1.6, ca: Math.cos(o.ang), sa: Math.sin(o.ang) }, idx2 = WORLD_BLDG.length; WORLD_BLDG.push(obb);
    const c0 = Math.floor((o.cx - o.w / 2) / WORLD_BCELL), c1 = Math.floor((o.cx + o.w / 2) / WORLD_BCELL), d0 = Math.floor((o.cz - o.d / 2) / WORLD_BCELL), d1 = Math.floor((o.cz + o.d / 2) / WORLD_BCELL);
    for (let cx = c0; cx <= c1; cx++) for (let cz = d0; cz <= d1; cz++) { const k = cx + ',' + cz; (WORLD_BHASH.get(k) || WORLD_BHASH.set(k, []).get(k)).push(idx2); }
  }
  bInst.count = bi; scene.add(bInst);
  { const og = box.clone(), op = og.attributes.position; for (let i = 0; i < op.count; i++) op.setXYZ(i, op.getX(i) * 1.04, op.getY(i) * 1.02, op.getZ(i) * 1.04); op.needsUpdate = true; const oI = new THREE.InstancedMesh(og, OUTLINE_MAT, bi); oI.instanceMatrix = bInst.instanceMatrix; oI.count = bi; oI.frustumCulled = false; scene.add(oI); }

  // ---- trees: dense inside OSM forest polys + a rural fill across the countryside (NH is woods) ----
  { const tpos = [];
    const areas = (P.forests || []).map(f => polyArea2(f.poly)); const tot = areas.reduce((a, b) => a + b, 0) || 1;
    (P.forests || []).forEach((f, fi) => {                     // dense in mapped forests
      const poly = f.poly; let mnx = 1e9, mxx = -1e9, mnz = 1e9, mxz = -1e9; for (const q of poly) { if (q[0] < mnx) mnx = q[0]; if (q[0] > mxx) mxx = q[0]; if (q[1] < mnz) mnz = q[1]; if (q[1] > mxz) mxz = q[1]; }
      const want = Math.floor(9000 * (areas[fi] / tot) * (f.dense || 1)); let placed = 0, tries = 0;
      while (placed < want && tries < want * 8) { tries++; const x = mnx + Math.random() * (mxx - mnx), z = mnz + Math.random() * (mxz - mnz); if (polyInPoly(x, z, poly)) { tpos.push(x, z); placed++; } }
    });
    // rural fill: scatter across the whole map wherever it's off-road and not in the built-up village
    { const FILL = 14000, mnx = minX - 200, mxx = maxX + 200, mnz = minZ - 200, mxz = maxZ + 200; let tries = 0, placed = 0;
      while (placed < FILL && tries < FILL * 5) { tries++;
        const x = mnx + Math.random() * (mxx - mnx), z = mnz + Math.random() * (mxz - mnz);
        const info = nearestInfo(x, z);
        if (info.d < 24) continue;                             // keep clear of roads
        const bc = Math.floor(x / WORLD_BCELL) + ',' + Math.floor(z / WORLD_BCELL);
        if (WORLD_BHASH.has(bc) && Math.random() < 0.85) continue;   // thin out over built areas
        tpos.push(x, z); placed++;
      }
    }
    const nT = tpos.length / 2;
    if (nT) {
      const cone = new THREE.ConeGeometry(3.4, 9, 6), coneM = toonMat(0x3f7d34);
      const trunk = new THREE.CylinderGeometry(0.5, 0.7, 3, 5), trunkM = toonMat(0x5a4326);
      const ci = new THREE.InstancedMesh(cone, coneM, nT), ti = new THREE.InstancedMesh(trunk, trunkM, nT); ci.castShadow = true; ci.frustumCulled = ti.frustumCulled = false;
      const mm = new THREE.Matrix4(), sv = new THREE.Vector3();
      for (let k = 0; k < nT; k++) { const x = tpos[k * 2], z = tpos[k * 2 + 1], gy = heightAt(x, z), s = 0.7 + Math.random() * 0.9; mm.makeScale(s, s, s).setPosition(x, gy + 6 * s, z); ci.setMatrixAt(k, mm); mm.makeScale(s, s, s).setPosition(x, gy + 1.5 * s, z); ti.setMatrixAt(k, mm); }
      scene.add(ci, ti);
      const og = cone.clone(), op = og.attributes.position; for (let i = 0; i < op.count; i++) op.setXYZ(i, op.getX(i) * 1.06, op.getY(i) * 1.04, op.getZ(i) * 1.06); op.needsUpdate = true; const oI = new THREE.InstancedMesh(og, OUTLINE_MAT, nT); oI.instanceMatrix = ci.instanceMatrix; oI.count = nT; oI.frustumCulled = false; scene.add(oI);
    }
  }

  const spawn = (P.races[0] && P.races[0].start) || [(minX + maxX) / 2, (minZ + maxZ) / 2];
  track.spawn = { x: spawn[0], z: spawn[1] };
  return track;
}
