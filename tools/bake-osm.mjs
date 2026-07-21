// Dev-only: bake Overpass OSM dump + elevation grid -> js/pembroke.js.
// Usage: node tools/bake-osm.mjs <overpass.json> <elev.json> [out.js]
import fs from 'fs';

const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const elev = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
const outPath = process.argv[4] || new URL('../js/pembroke.js', import.meta.url).pathname;
const els = raw.elements;

// clip to the populated area (Pembroke + Suncook + west Allenstown) — drop eastern wilderness
const CLIP = { lat0: 43.098, lat1: 43.192, lon0: -71.502, lon1: -71.413 };
const WIDTH_MUL = 2.6;                                    // "so much wider" roads

const nodeById = new Map();
for (const e of els) if (e.type === 'node') nodeById.set(e.id, e);

// projection origin = clip-bbox centre (must match the heightmap)
const lat0 = (CLIP.lat0 + CLIP.lat1) / 2, lon0 = (CLIP.lon0 + CLIP.lon1) / 2;
const mLat = 111320, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
const projLL = (lat, lon) => [Math.round((lon - lon0) * mLon), Math.round(-(lat - lat0) * mLat)];
const proj = id => { const n = nodeById.get(id); return n ? projLL(n.lat, n.lon) : null; };
const inClip = n => n && n.lat >= CLIP.lat0 && n.lat <= CLIP.lat1 && n.lon >= CLIP.lon0 && n.lon <= CLIP.lon1;
const wayInClip = w => w.nodes && w.nodes.some(id => inClip(nodeById.get(id)));
const wayPts = w => w.nodes.map(proj).filter(Boolean);
const closePoly = p => { if (p.length > 1 && p[0][0] === p[p.length - 1][0] && p[0][1] === p[p.length - 1][1]) p.pop(); return p; };
const polyArea = p => { let a = 0; for (let i = 0; i < p.length; i++) { const q = p[i], r = p[(i + 1) % p.length]; a += q[0] * r[1] - r[0] * q[1]; } return Math.abs(a) / 2; };
const centroid = p => { let x = 0, z = 0; for (const q of p) { x += q[0]; z += q[1]; } return [x / p.length, z / p.length]; };
const dedup = p => p.filter((q, k) => k === 0 || q[0] !== p[k - 1][0] || q[1] !== p[k - 1][1]);

// ---------- roads ----------
const WIDTH = { motorway: 15, motorway_link: 9, trunk: 12, trunk_link: 8, primary: 11, primary_link: 7,
  secondary: 9, secondary_link: 6, tertiary: 8, tertiary_link: 6, residential: 7, unclassified: 7, service: 5, living_street: 6 };
const roads = els.filter(e => e.type === 'way' && e.tags && WIDTH[e.tags.highway] !== undefined && e.nodes && e.nodes.length >= 2 && wayInClip(e));
const use = new Map();
for (const w of roads) for (const id of w.nodes) use.set(id, (use.get(id) || 0) + 1);
const nIdx = new Map(), nodes = [];
const gid = osm => { if (nIdx.has(osm)) return nIdx.get(osm); const i = nodes.length; nodes.push(proj(osm)); nIdx.set(osm, i); return i; };
const edges = [];
for (const w of roads) {
  const cls = w.tags.highway, wdt = Math.round(WIDTH[cls] * WIDTH_MUL);
  const surf = (w.tags.surface && /unpaved|gravel|dirt|ground|compacted|fine_gravel/.test(w.tags.surface)) ? 'dirt' : 'asphalt';
  const name = w.tags.name || '';
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    if (use.get(w.nodes[i]) >= 2 || i === w.nodes.length - 1) {
      const seg = w.nodes.slice(start, i + 1), pts = dedup(seg.map(proj).filter(Boolean));
      if (pts.length >= 2) edges.push({ a: gid(seg[0]), b: gid(seg[seg.length - 1]), cls, w: wdt, surf, pts, name });
      start = i;
    }
  }
}

// ---------- schools (areas -> centroids; tag buildings inside) ----------
const schoolPolys = [];
const schools = [];
for (const e of els) {
  if (e.type === 'way' && e.tags && e.tags.amenity === 'school' && e.nodes && wayInClip(e)) {
    const p = closePoly(wayPts(e)); if (p.length >= 3) { schoolPolys.push(p); const c = centroid(p); schools.push({ x: c[0], z: c[1], name: e.tags.name || 'School' }); }
  } else if (e.type === 'node' && e.tags && e.tags.amenity === 'school' && inClip(e)) {
    const p = projLL(e.lat, e.lon); schools.push({ x: p[0], z: p[1], name: e.tags.name || 'School' });
  }
}
const pointInPoly = (x, z, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const xi = poly[i][0], zi = poly[i][1], xj = poly[j][0], zj = poly[j][1]; if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) c = !c; } return c; };

// ---------- buildings ----------
const buildings = [];
for (const w of els) {
  if (w.type !== 'way' || !w.tags || !w.tags.building || !w.nodes || w.nodes.length < 4 || !wayInClip(w)) continue;
  let poly = closePoly(wayPts(w)); if (poly.length < 3 || polyArea(poly) < 12) continue;
  const t = w.tags; let h = 6;
  if (t.height) h = parseFloat(t.height) || 6; else if (t['building:levels']) h = (parseFloat(t['building:levels']) || 2) * 3.2;
  h = Math.max(4, Math.min(45, Math.round(h)));
  const c = centroid(poly);
  const isSchool = t.amenity === 'school' || t.building === 'school' || schoolPolys.some(sp => pointInPoly(c[0], c[1], sp));
  buildings.push(isSchool ? { poly, h: Math.max(h, 9), school: 1 } : { poly, h });
}

// ---------- water (lakes/ponds polygons + rivers/streams lines) ----------
const water = [], waterways = [];
for (const w of els) {
  if (w.type !== 'way' || !w.tags || !w.nodes || !wayInClip(w)) continue;
  if (w.tags.natural === 'water' || w.tags.waterway === 'riverbank') {
    const p = closePoly(wayPts(w)); if (p.length >= 3 && polyArea(p) > 60) water.push({ poly: p });
  } else if (/^(river|stream|canal)$/.test(w.tags.waterway)) {
    const p = dedup(wayPts(w)); if (p.length >= 2) waterways.push({ pts: p, w: w.tags.waterway === 'river' ? 14 : 6 });
  }
}

// ---------- forests / woods (for tree scatter) ----------
const forests = [];
for (const w of els) {
  if (w.type !== 'way' || !w.tags || !w.nodes || !wayInClip(w)) continue;
  if (w.tags.natural === 'wood' || w.tags.landuse === 'forest' || w.tags.landuse === 'meadow') {
    const p = closePoly(wayPts(w)); if (p.length >= 3 && polyArea(p) > 400) forests.push({ poly: p, dense: w.tags.landuse === 'meadow' ? 0.25 : 1 });
  }
}

// ---------- heightmap (elevation grid -> local metres) ----------
const eb = elev;
const x0 = (eb.LON0 - lon0) * mLon, x1 = (eb.LON1 - lon0) * mLon;           // west..east
const zS = -(eb.LAT0 - lat0) * mLat, zN = -(eb.LAT1 - lat0) * mLat;         // row0=south(+z) .. rowLast=north(-z)
const base = Math.min(...eb.data);
const height = {
  x0, z0: zS, dx: (x1 - x0) / (eb.COLS - 1), dz: (zN - zS) / (eb.ROWS - 1),
  cols: eb.COLS, rows: eb.ROWS, base,
  data: eb.data.map(v => Math.round(v - base)),
};

// ---------- race candidates (chain by street name; longest few) ----------
const elen = e => { let L = 0; for (let i = 1; i < e.pts.length; i++) L += Math.hypot(e.pts[i][0] - e.pts[i - 1][0], e.pts[i][1] - e.pts[i - 1][1]); return L; };
const byName = new Map();
edges.forEach((e, i) => { if (!e.name || e.cls === 'service') return; (byName.get(e.name) || byName.set(e.name, []).get(e.name)).push(i); });
function buildLine(idxs) {
  const adj = new Map(); for (const i of idxs) for (const nn of [edges[i].a, edges[i].b]) (adj.get(nn) || adj.set(nn, []).get(nn)).push(i);
  let start = null; for (const [nn, arr] of adj) if (arr.length === 1) { start = nn; break; }
  if (start === null) start = edges[idxs[0]].a;
  const used = new Set(); let cur = start; const line = [];
  while (used.size < idxs.length) {
    const cand = (adj.get(cur) || []).filter(i => !used.has(i)); if (!cand.length) break;
    const ei = cand[0]; used.add(ei); let pts = edges[ei].pts; if (edges[ei].a !== cur) pts = pts.slice().reverse();
    for (let k = line.length ? 1 : 0; k < pts.length; k++) line.push(pts[k]);
    cur = edges[ei].a === cur ? edges[ei].b : edges[ei].a;
  }
  return line;
}
const cands = [];
for (const [name, idxs] of byName) {
  const line = buildLine(idxs); if (line.length < 4) continue;
  let L = 0; for (let i = 1; i < line.length; i++) L += Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]);
  if (L < 500) continue; cands.push({ name, L: Math.round(L), line });
}
cands.sort((a, b) => b.L - a.L);
const races = cands.slice(0, 8).map((r, i) => ({
  id: 'r' + i, name: r.name.replace(/\b\w/g, c => c.toUpperCase()), line: r.line,
  reward: Math.round(500 + r.L * 0.7), tier: 1 + Math.floor(i / 3), start: r.line[0],
}));

const xs = nodes.map(p => p[0]), zs = nodes.map(p => p[1]);
const bbox = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
const out = { origin: { lat0: +lat0.toFixed(6), lon0: +lon0.toFixed(6) }, bbox, height, nodes, edges, buildings, water, waterways, forests, schools, races };
fs.writeFileSync(outPath, 'window.PEMBROKE = ' + JSON.stringify(out) + ';\n');
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`baked ${kb}KB | edges ${edges.length} bldg ${buildings.length} water ${water.length} rivers ${waterways.length} forests ${forests.length} schools ${schools.length} races ${races.length}`);
console.log(`span ${bbox[2] - bbox[0]}m x ${bbox[3] - bbox[1]}m | elev 0..${Math.max(...height.data)}m | schools: ${schools.map(s => s.name).join(', ')}`);
console.log('races:', races.map(r => r.name).join(', '));
