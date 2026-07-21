// Dev-only: convert an Overpass JSON dump of Pembroke NH (roads + buildings) into js/pembroke.js.
// Usage: node tools/bake-osm.mjs <raw_overpass.json> [out.js]
import fs from 'fs';

const raw = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const outPath = process.argv[3] || new URL('../js/pembroke.js', import.meta.url).pathname;
const els = raw.elements;

const nodeById = new Map();
for (const e of els) if (e.type === 'node') nodeById.set(e.id, e);

// projection origin = mean of all nodes; x=east, z=south(-north) to match the Homestead KML convention
let sLat = 0, sLon = 0, n = 0;
for (const nd of nodeById.values()) { sLat += nd.lat; sLon += nd.lon; n++; }
const lat0 = sLat / n, lon0 = sLon / n;
const mLat = 111320, mLon = 111320 * Math.cos(lat0 * Math.PI / 180);
const proj = id => { const nd = nodeById.get(id); return nd ? [Math.round((nd.lon - lon0) * mLon), Math.round(-(nd.lat - lat0) * mLat)] : null; };

const WIDTH = { motorway: 15, motorway_link: 9, trunk: 12, trunk_link: 8, primary: 11, primary_link: 7,
  secondary: 9, secondary_link: 6, tertiary: 8, tertiary_link: 6, residential: 7, unclassified: 7, service: 5, living_street: 6 };

const roads = els.filter(e => e.type === 'way' && e.tags && e.tags.highway && WIDTH[e.tags.highway] !== undefined && e.nodes && e.nodes.length >= 2);
const bldgWays = els.filter(e => e.type === 'way' && e.tags && e.tags.building && e.nodes && e.nodes.length >= 4);

// node usage across roads -> intersections are nodes used by >=2 roads
const use = new Map();
for (const w of roads) for (const id of w.nodes) use.set(id, (use.get(id) || 0) + 1);

// graph nodes (shared coords), split ways into edges
const nIdx = new Map(); const nodes = [];
const gid = osm => { if (nIdx.has(osm)) return nIdx.get(osm); const i = nodes.length; nodes.push(proj(osm)); nIdx.set(osm, i); return i; };
const edges = [];
for (const w of roads) {
  const cls = w.tags.highway, wdt = WIDTH[cls];
  const surf = (w.tags.surface && /unpaved|gravel|dirt|ground|compacted|fine_gravel/.test(w.tags.surface)) ? 'dirt' : 'asphalt';
  const name = w.tags.name || '';
  let start = 0;
  for (let i = 1; i < w.nodes.length; i++) {
    const shared = use.get(w.nodes[i]) >= 2, last = i === w.nodes.length - 1;
    if (shared || last) {
      const seg = w.nodes.slice(start, i + 1);
      let pts = seg.map(proj).filter(Boolean);
      pts = pts.filter((p, k) => k === 0 || p[0] !== pts[k - 1][0] || p[1] !== pts[k - 1][1]);
      if (pts.length >= 2) edges.push({ a: gid(seg[0]), b: gid(seg[seg.length - 1]), cls, w: wdt, surf, pts, name });
      start = i;
    }
  }
}

// buildings -> footprint polygon + height
const buildings = [];
for (const w of bldgWays) {
  let poly = w.nodes.map(proj).filter(Boolean);
  if (poly.length > 1 && poly[0][0] === poly[poly.length - 1][0] && poly[0][1] === poly[poly.length - 1][1]) poly.pop();
  if (poly.length < 3) continue;
  let area = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; area += p[0] * q[1] - q[0] * p[1]; }
  if (Math.abs(area) / 2 < 12) continue;               // skip tiny sheds
  const t = w.tags; let h = 6;
  if (t.height) h = parseFloat(t.height) || 6;
  else if (t['building:levels']) h = (parseFloat(t['building:levels']) || 2) * 3.2;
  buildings.push({ poly, h: Math.max(4, Math.min(40, Math.round(h))) });
}

// race candidates: chain edges by street name into ordered polylines; keep the longest
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
  const total = idxs.reduce((s, i) => s + elen(edges[i]), 0);
  if (total < 500) continue;
  const line = buildLine(idxs); if (line.length < 4) continue;
  cands.push({ name, total: Math.round(total), line, cls: edges[idxs[0]].cls });
}
cands.sort((a, b) => b.total - a.total);
const races = cands.slice(0, 7).map((r, i) => ({
  id: 'r' + i, name: r.name.replace(/\b\w/g, c => c.toUpperCase()) + ' Sprint',
  line: r.line, circuit: false, laps: 1,
  reward: Math.round(500 + r.total * 0.7), tier: 1 + Math.floor(i / 3), start: r.line[0],
}));

const xs = nodes.map(p => p[0]), zs = nodes.map(p => p[1]);
const bbox = [Math.min(...xs), Math.min(...zs), Math.max(...xs), Math.max(...zs)];
const out = { origin: { lat0: +lat0.toFixed(6), lon0: +lon0.toFixed(6) }, bbox, nodes, edges, buildings, races };
fs.writeFileSync(outPath, 'window.PEMBROKE = ' + JSON.stringify(out) + ';\n');
const kb = (fs.statSync(outPath).size / 1024).toFixed(0);
console.log(`baked ${outPath}: ${kb}KB | nodes ${nodes.length} edges ${edges.length} buildings ${buildings.length} races ${races.length}`);
console.log(`world span ${bbox[2] - bbox[0]}m x ${bbox[3] - bbox[1]}m`);
console.log('races:', races.map(r => `${r.name} (${Math.round(r.line.reduce((s,p,i)=>i?s+Math.hypot(p[0]-r.line[i-1][0],p[1]-r.line[i-1][1]):0,0))}m $${r.reward})`).join(', '));
