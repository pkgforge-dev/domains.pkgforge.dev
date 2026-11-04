// DOM-029 instrument 07, copied from .tmp/dom029/challenge/legs.mjs as it ran on 2026-11-01T08:33Z.
// The question: how long a leg and the backfill take on a runner from the desktop unit costs and DOM-009 day sizes (design M25).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/07-legs.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Runner lens: recompute the design's section 2.3 per-leg time and the backfill wall time.
// Desktop per-unit costs are the design's own (M7 to M10, .tmp/dom029/*.out), the re-measured
// merge cost with 65 runs (challenge/measure-head-92000.out: 14.00 s / 5.98M keys = 2.34 us),
// scaled by a runner/desktop ratio r. The per-day sizes are DOM-009's runner result.
// Usage: node legs.mjs
import { readFileSync } from 'node:fs';
const r9 = JSON.parse(readFileSync(new URL('../measure/DOM-009/result.json', import.meta.url), 'utf8'));
const days = r9.per_day.map((d) => ({ day: d.day, lines: d.lines, names: d.distinct_names, regs: d.distinct_registrable, gz: d.gz_bytes, dl: d.stages.download }));
const RUN_KEYS = 2_000_000;
// desktop seconds for one day
function desktopSeconds(d) {
  const norm = 7.5e-6 * d.lines; // gunzip, split, normalise, key (M8: 2.27 + 3.86 + 3.01 us less the double split)
  const reg = 3.1e-6 * d.names; // reg once per name
  const runs = 3.04e-6 * d.lines; // sort and encode runs (M7)
  const nRuns = Math.ceil(d.lines / RUN_KEYS);
  const mergeUs = nRuns >= 50 ? 2.34 : nRuns >= 20 ? 1.6 : 1.1; // M7 1.1 us at 6 runs; 2.34 at 65 runs (re-measured)
  const merge = mergeUs * 1e-6 * d.lines;
  const regRuns = 0.92e-6 * d.names;
  const namesPack = 10.13e-6 * d.names;
  const domainsPack = 7.85e-6 * d.regs;
  const verifyN = 11.8e-6 * d.names;
  const verifyD = 11.8e-6 * d.regs; // M10 measured names only; domains assumed the same per record (design guessed 8)
  return { norm, reg, runs, merge, regRuns, namesPack, domainsPack, verifyN, verifyD, total: norm + reg + runs + merge + regRuns + namesPack + domainsPack + verifyN + verifyD };
}
const live = [...days.filter((d) => d.day !== '2026-10-31')];
const SETUP_S = 120; // checkout, setup-node, npm ci, oras
function legMinutes(d, ratio, dlSlow) {
  const c = desktopSeconds(d).total * ratio;
  const dl = dlSlow ? d.gz / 3.5e6 : d.gz / 10.3e6; // HF slow mode 3.5 MB/s (DOM-009 min); cs2 10.3 MB/s (one-day run, 31.186 s for 319.9 MB)
  const push = (d.gz + d.names * 0.65 + d.regs * 0.2) / 63.5e6 + 30; // DOM-006 63.5 MB/s, real pack bytes, +30 s of oras overhead
  return (c + dl + push + SETUP_S) / 60;
}
const big = days.find((d) => d.day === '2026-09-12');
const b = desktopSeconds(big);
console.log('2026-09-12 desktop seconds by part:', Object.fromEntries(Object.entries(b).map(([k, v]) => [k, Math.round(v)])), 'total min', (b.total / 60).toFixed(1));
for (const ratio of [0.344, 0.531, 0.55, 0.69]) {
  const compute = (b.total * ratio) / 60;
  const best = legMinutes(big, ratio, false);
  const worst = legMinutes(big, ratio, true);
  console.log(`ratio ${ratio}: 09-12 compute ${compute.toFixed(1)} min; leg wall ${best.toFixed(1)} (cs2) to ${worst.toFixed(1)} (HF slow) min`);
}
// backfill wall: 6 legs at once, legs started in date order, on the first free slot
for (const ratio of [0.344, 0.531, 0.55, 0.69]) {
  const mins = live.map((d) => legMinutes(d, ratio, true));
  const slots = new Array(6).fill(0);
  for (const m of mins) {
    const i = slots.indexOf(Math.min(...slots));
    slots[i] += m;
  }
  const sum = mins.reduce((a, x) => a + x, 0);
  console.log(`ratio ${ratio}: ${mins.length} legs, ${sum.toFixed(0)} leg-min, wall at 6 wide ${Math.max(...slots).toFixed(0)} min (${(Math.max(...slots) / 60).toFixed(1)} h), longest leg ${Math.max(...mins).toFixed(0)} min`);
}
