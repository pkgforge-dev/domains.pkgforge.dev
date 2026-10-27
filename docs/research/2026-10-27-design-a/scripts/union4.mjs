import fs from 'node:fs';
const kind = process.argv[2]; const days = ['2026-10-23','2026-10-24','2026-10-25','2026-10-26'];
const arrs = days.map(d => { const b = fs.readFileSync(`out-thc/${d}.${kind}.f64`); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); });
const seen = new Set(); // too big for names; use sorted merge instead
const all = new Float64Array(arrs.reduce((a, x) => a + x.length, 0)); let o = 0; for (const a of arrs) { all.set(a, o); o += a.length; }
all.sort(); let u = 0, last = -1; for (let i = 0; i < all.length; i++) if (all[i] !== last) { u++; last = all[i]; }
// new on day 4 vs union of days 1-3
const prev = new Float64Array(arrs[0].length + arrs[1].length + arrs[2].length); let p = 0; for (let i = 0; i < 3; i++) { prev.set(arrs[i], p); p += arrs[i].length; } prev.sort();
const has = (x) => { let lo = 0, hi = prev.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (prev[m] === x) return true; if (prev[m] < x) lo = m + 1; else hi = m - 1; } return false; };
let fresh = 0; for (const x of arrs[3]) if (!has(x)) fresh++;
console.log(JSON.stringify({ kind, per_day: arrs.map(a => a.length), union4: u, sum: all.length, day4: arrs[3].length, day4_not_in_days1to3: fresh, pct_new: +(100 * fresh / arrs[3].length).toFixed(1) }));
