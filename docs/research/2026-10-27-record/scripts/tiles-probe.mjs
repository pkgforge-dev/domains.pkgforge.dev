// Probe the names tile at tile 0 and at the tail of each tiled log in a short list. Read-only, 3 requests a log.
import fs from 'node:fs';
const list = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const want = /Let.s Encrypt|Geomys|IPng|GoDaddy/i;
const enc = (n) => { const s = String(n).padStart(9, '0'); const g = [s.slice(0, 3), s.slice(3, 6), s.slice(6)]; while (g.length > 1 && g[0] === '000') g.shift(); return g.map((x, i) => (i < g.length - 1 ? 'x' + x : x)).join('/'); };
const get = async (u) => { const t = Date.now(); try { const r = await fetch(u, { headers: { 'accept-encoding': 'gzip' }, signal: AbortSignal.timeout(20000) }); const b = await r.arrayBuffer(); return { s: r.status, n: b.byteLength, ms: Date.now() - t, t: new TextDecoder().decode(b.slice(0, 300)) }; } catch (e) { return { s: 'ERR ' + e.message, ms: Date.now() - t }; } };
for (const op of list.operators) {
  if (!want.test(op.name)) continue;
  for (const l of op.tiled_logs || []) {
    const st = Object.keys(l.state || {})[0];
    if (st !== 'usable' && !/GoDaddy Aquamarine2027h1/.test(l.description)) continue;
    const mon = l.monitoring_url.replace(/\/?$/, '/');
    const cp = await get(mon + 'checkpoint');
    const size = cp.s === 200 ? Number(cp.t.split('\n')[1]) : NaN;
    const tail = Number.isFinite(size) ? Math.floor(size / 256) - 1 : -1;
    const t0 = await get(mon + 'tile/names/' + enc(0));
    const tt = tail >= 0 ? await get(mon + 'tile/names/' + enc(tail)) : { s: '-' };
    console.log([l.description, 'size=' + size, 'cp=' + cp.s + '/' + cp.ms + 'ms', 'tile0=' + t0.s + '/' + (t0.n ?? '-') + 'B', 'tail=' + tail + ':' + tt.s + '/' + (tt.n ?? '-') + 'B/' + (tt.ms ?? '-') + 'ms'].join(' | '));
  }
}
