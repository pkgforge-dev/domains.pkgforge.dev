// Read names tiles of one static CT log for a UTC window. usage: node ct-window.mjs <monitoring-url> <t0> <t1> <outname>
import fs from 'node:fs'; import zlib from 'node:zlib';
const [mon, t0iso, t1iso, outname] = process.argv.slice(2);
const T0 = Date.parse(t0iso), T1 = Date.parse(t1iso);
const base = mon.replace(/\/?$/, '/');
const enc = (n) => { let s = String(n).padStart(9, '0'); const g = [s.slice(0, 3), s.slice(3, 6), s.slice(6)]; while (g.length > 1 && g[0] === '000') g.shift(); return g.map((x, i) => (i < g.length - 1 ? 'x' + x : x)).join('/'); };
async function tile(i) {
  for (let a = 0; a < 4; a++) {
    const r = await fetch(base + 'tile/names/' + enc(i), { headers: { 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(30000) });
    if (r.status === 429) { await new Promise((x) => setTimeout(x, 2000 * (a + 1))); continue; }
    if (!r.ok) throw new Error('tile ' + i + ' ' + r.status);
    const txt = await r.text(); return { text: txt, bytes: Number(r.headers.get('content-length') || 0) };
  }
  throw new Error('429 persist');
}
const rows = (t) => t.trim().split('\n').map((l) => JSON.parse(l));
const cp = (await (await fetch(base + 'checkpoint')).text()).split('\n'); const size = Number(cp[1]); const last = Math.floor(size / 256) - 1;
let lo = 0, hi = last; // first tile whose last entry ts >= T0
let probes = 0;
while (lo < hi) { const m = (lo + hi) >> 1; const r = rows((await tile(m)).text); probes++; if (r.at(-1).Timestamp >= T0) hi = m; else lo = m + 1; }
const startTile = lo;
const names = new Set(); let entries = 0, tiles = 0, gz = 0, raw = 0, ei = 0, done = false; let tFirst = null, tLast = null;
const q = []; let next = startTile;
async function worker() { while (!done) { const i = next++; const t = await tile(i); const r = rows(t.text); tiles++; gz += t.bytes; raw += t.text.length; for (const e of r) { if (e.Timestamp < T0) continue; if (e.Timestamp >= T1) { done = true; continue; } entries++; tFirst ??= e.Timestamp; tLast = e.Timestamp; for (let d of e.DNS || []) { d = d.toLowerCase(); if (d.startsWith('*.')) d = d.slice(2); names.add(d); } } } }
await Promise.all(Array.from({ length: 6 }, worker));
const h53 = (s) => { let a = 0x811c9dc5, b = 0x01000193 ^ 0x9747b28c; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); a = Math.imul(a ^ c, 0x01000193); b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15; } return (a >>> 0) + (b & 0x1fffff) * 4294967296; };
fs.writeFileSync(`ct/${outname}.names.txt`, [...names].join(String.fromCharCode(10)));
const arr = new Float64Array(names.size); let k = 0; for (const d of names) arr[k++] = h53(d); arr.sort(); fs.writeFileSync(`ct/${outname}.names.f64`, Buffer.from(arr.buffer));
console.log(JSON.stringify({ mon, window: [t0iso, t1iso], log_size: size, start_tile: startTile, bsearch_probes: probes, tiles_read: tiles, entries, distinct_names: names.size, gz_bytes: gz, raw_bytes: raw, gz_per_entry: +(gz / Math.max(1, entries)).toFixed(1), first: tFirst && new Date(tFirst).toISOString(), last: tLast && new Date(tLast).toISOString() }));
