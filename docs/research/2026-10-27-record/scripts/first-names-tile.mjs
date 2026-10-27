// Find the lowest names tile a log serves, by binary search between tile 0 (404) and the tail (200). Assumes monotone. Read-only.
const [mon0, tailStr] = process.argv.slice(2);
const mon = mon0.replace(/\/?$/, '/');
const enc = (n) => { const s = String(n).padStart(9, '0'); const g = [s.slice(0, 3), s.slice(3, 6), s.slice(6)]; while (g.length > 1 && g[0] === '000') g.shift(); return g.map((x, i) => (i < g.length - 1 ? 'x' + x : x)).join('/'); };
const ua = 'probe (contact: nobody@example.invalid)';
const ok = async (i) => { const r = await fetch(mon + 'tile/names/' + enc(i), { headers: { 'user-agent': ua, 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(20000) }); await r.arrayBuffer(); return r.status === 200 ? true : r.status === 404 ? false : (() => { throw new Error('status ' + r.status); })(); };
let lo = 0, hi = Number(tailStr), n = 0;
if (await ok(lo)) { console.log('tile 0 exists'); process.exit(0); }
if (!(await ok(hi))) { console.log('tail missing'); process.exit(0); }
while (hi - lo > 1) { const mid = (lo + hi) >> 1; n++; if (await ok(mid)) hi = mid; else lo = mid; }
console.log(JSON.stringify({ firstServedTile: hi, tail: Number(tailStr), servedTiles: Number(tailStr) - hi + 1, entriesServed: (Number(tailStr) - hi + 1) * 256, probes: n }));
