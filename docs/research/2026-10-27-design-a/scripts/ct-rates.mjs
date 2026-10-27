// Poll every tiled CT log's checkpoint twice and probe for names tiles; also poll RFC 6962 logs' get-sth.
import fs from 'node:fs';
const rows = JSON.parse(fs.readFileSync(new URL('../ct/logs.json', import.meta.url), 'utf8'));
const gapMs = Number(process.argv[2] || 90000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function size(r) {
  try {
    if (r.kind === 'tiled') {
      const res = await fetch(r.mon.replace(/\/?$/, '/') + 'checkpoint', { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return { err: res.status };
      const t = (await res.text()).split('\n');
      return { size: Number(t[1]) };
    }
    const res = await fetch(r.url.replace(/\/?$/, '/') + 'ct/v1/get-sth', { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return { err: res.status };
    const j = await res.json();
    return { size: j.tree_size };
  } catch (e) { return { err: String(e.message || e) }; }
}
async function hasNames(r) {
  if (r.kind !== 'tiled') return null;
  try {
    const res = await fetch(r.mon.replace(/\/?$/, '/') + 'tile/names/000', { signal: AbortSignal.timeout(20000) });
    return res.status;
  } catch (e) { return String(e.message || e); }
}
const live = rows.filter((r) => r.state !== 'rejected' && r.state !== 'retired');
const run = async () => {
  const out = [];
  const q = [...live];
  await Promise.all(Array.from({ length: 12 }, async () => { while (q.length) { const r = q.shift(); out.push({ r, s: await size(r) }); } }));
  return out;
};
const t0 = Date.now(); const a = await run();
const nm = {};
{ const q = live.filter((r) => r.kind === 'tiled'); await Promise.all(Array.from({ length: 6 }, async () => { while (q.length) { const r = q.shift(); nm[r.mon] = await hasNames(r); } })); }
await sleep(gapMs - (Date.now() - t0));
const t1 = Date.now(); const b = await run();
const dt = (t1 - t0) / 1000;
const bm = new Map(b.map((x) => [x.r.mon || x.r.url, x.s]));
const res = a.map((x) => {
  const k = x.r.mon || x.r.url; const y = bm.get(k);
  const rate = x.s.size != null && y?.size != null ? (y.size - x.s.size) / dt : null;
  return { op: x.r.op, desc: x.r.desc, kind: x.r.kind, state: x.r.state, size: y?.size ?? x.s.size, rate_per_s: rate, per_day_M: rate == null ? null : +(rate * 86400 / 1e6).toFixed(2), names_tile: x.r.kind === 'tiled' ? nm[x.r.mon] : null, err: x.s.err || y?.err };
});
fs.writeFileSync(new URL('../ct/rates.json', import.meta.url), JSON.stringify({ t0: new Date(t0).toISOString(), dt_s: dt, res }, null, 1));
let tot = 0, totNames = 0;
for (const x of res) { if (x.per_day_M) { tot += x.per_day_M; if (x.names_tile === 200) totNames += x.per_day_M; } }
console.log(JSON.stringify({ dt_s: dt, logs: res.length, total_M_per_day: +tot.toFixed(1), names_tile_logs_M_per_day: +totNames.toFixed(1) }));
for (const x of res.filter((x) => x.per_day_M > 0.5).sort((p, q) => q.per_day_M - p.per_day_M)) console.log(x.op.padEnd(14), x.desc.padEnd(34), x.kind.padEnd(8), x.state.padEnd(10), String(x.per_day_M).padStart(6), 'M/day', 'names:' + x.names_tile);
