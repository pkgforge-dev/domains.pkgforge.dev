// DOM-029 instrument 14, copied from .tmp/dom029/challenge/band-sizes.mjs as it ran on 2026-11-01T08:24Z.
// The question: which days the band at 0.4 and 4 quarantines over the listing of 59 days (design M20).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/14-band-sizes.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Challenge probe: the real listing sizes against the band at each day, the margin to the floor and the ceiling,
// and what a second step (a recovery to the September level, a second drop) does. Uses checkBand of the repo.
// Usage: node band-sizes.mjs HF-LISTING.json
import { readFileSync } from 'node:fs';
import { checkBand } from '../../../packages/adapter/src/band.ts';

const listing = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const days = listing
  .map((e) => ({ day: /(\d{4}-\d{2}-\d{2})\.txt\.gz$/.exec(e.path)[1], bytes: e.size }))
  .sort((a, b) => (a.day < b.day ? -1 : 1));

function replay(series, band) {
  const hist = [];
  const out = [];
  for (const s of series) {
    const r = checkBand(s.bytes, hist.filter((h) => h.day < s.day), band, { precision: 'day' });
    out.push({ ...s, ...r });
    if (r.verdict === 'ok' || r.verdict === 'quarantine') hist.push({ day: s.day, count: s.bytes, quarantined: r.verdict === 'quarantine' });
    else {
      out.at(-1).stopped = true;
      break; // a hold stops the source: nothing is written, the cursor stays
    }
  }
  return out;
}

const band = { metric: 'bytes', min: 0.4, max: 4, relative: true };
const base = replay(days, band);
console.log('day        MB     verdict     reason       median   floor    ceiling  ratio-to-median');
for (const r of base) {
  const mb = (r.bytes / 1e6).toFixed(1).padStart(7);
  const med = r.median === null ? '-' : (r.median / 1e6).toFixed(0);
  console.log(`${r.day} ${mb} ${r.verdict.padEnd(11)} ${r.reason.padEnd(12)} ${med.padStart(6)} ${r.floor === null ? '-'.padStart(7) : (r.floor / 1e6).toFixed(0).padStart(7)} ${r.ceiling === null ? '-'.padStart(8) : (r.ceiling / 1e6).toFixed(0).padStart(8)}  ${r.median === null ? '-' : (r.bytes / r.median).toFixed(2)}`);
}
const quarantined = base.filter((r) => r.verdict === 'quarantine').map((r) => r.day);
console.log('quarantined:', quarantined.join(' '), `(${quarantined.length})`);

// Scenario 1: the live regime goes on; a lower day of 40% of the median is the boundary.
const tail = base.at(-1);
const next = { day: '2026-11-01', bytes: 0 };
function after(extra, label) {
  const series = [...days, ...extra];
  const r = replay(series, band);
  const last = r.slice(days.length);
  console.log(label.padEnd(58), last.map((x) => `${x.day} ${(x.bytes / 1e6).toFixed(0)}MB ${x.verdict}/${x.reason}${x.stopped ? ' STOP' : ''}`).join(' | '));
}
const med = tail.median;
console.log('\nbaseline median at 10-31 =', (med / 1e6).toFixed(1), 'MB');
after([{ day: '2026-11-01', bytes: 986_000_000 }], 'one day at the September size (986 MB)');
after([{ day: '2026-11-01', bytes: 1_400_000_000 }], 'one day at 1.4 GB');
after([{ day: '2026-11-01', bytes: 986_000_000 }, { day: '2026-11-02', bytes: 330_000_000 }, { day: '2026-11-03', bytes: 330_000_000 }], 'September-size day, then normal days (does the source resume?)');
after([{ day: '2026-11-01', bytes: 120_000_000 }, { day: '2026-11-02', bytes: 110_000_000 }, { day: '2026-11-03', bytes: 130_000_000 }], 'three days near 120 MB (a second step down)');
after([{ day: '2026-11-01', bytes: 0 }], 'an empty file (0 B)');
after([{ day: '2026-11-01', bytes: 20 }], 'a 20-byte file (an empty gzip)');
