// DOM-029 instrument 20, copied from .tmp/dom029/challenge/door/band-trap.mjs as it ran on 2026-11-01T10:20Z.
// The question: whether a held day of the first draft band is ever released (design M20, the door lens).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/20-band-trap.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Challenge lens "the door and the failures": can the band (0.4 / 4) stop the
// source for good? Replays checkBand of @domains/adapter as run.mjs and
// advance.ts would: a `hold` writes no proposal and no history, so the day is
// checked again next hour against the same history.
import { checkBand } from '../../../packages/adapter/src/index.ts';

const band = { metric: 'bytes', min: 0.4, max: 4, relative: true };
const day = (i) => new Date(Date.UTC(2026, 10, 1 + i)).toISOString().slice(0, 10);
const MB = 1e6;

function scenario(name, sizesMb) {
  const history = [];
  console.log(`--- ${name}`);
  let held = null;
  sizesMb.forEach((mb, i) => {
    const d = day(i);
    const r = checkBand(mb * MB, history, band, { precision: 'day' });
    console.log(`${d} ${String(mb).padStart(5)} MB  ${r.verdict.padEnd(10)} ${r.reason.padEnd(11)} median ${r.median === null ? '-' : (r.median / MB).toFixed(1)} ceiling ${r.ceiling === null ? '-' : (r.ceiling / MB).toFixed(1)}${r.reset === null ? '' : ` reset ${(r.reset / MB).toFixed(1)}`}`);
    if (r.verdict === 'hold') {
      held = held ?? d;
      return; // no history written, so the cursor stays and the day is read again
    }
    history.push({ day: d, count: mb * MB, quarantined: r.verdict === 'quarantine' });
  });
  // The held day is checked again with the same history: same answer.
  if (held !== null) {
    const again = checkBand(sizesMb[sizesMb.indexOf(sizesMb.find((_, i) => day(i) === held))] * MB, history, band, { precision: 'day' });
    console.log(`re-check of the held day ${held} an hour later: ${again.verdict} ${again.reason} (history unchanged: ${history.length} days)`);
  }
}

// A: seven normal October-regime days, then a three-day THC outage that leaves small
// (but valid gzip) files like 10-15's 77 MB, then the normal level returns.
scenario('three 77 MB days (the size of the real 10-15) then 340 MB', [300, 310, 290, 330, 320, 305, 315, 77, 77, 77, 340, 330, 320]);
// B: a deeper outage: three truncated or near-empty files.
scenario('three 5 MB days then 300 MB', [300, 310, 290, 330, 320, 305, 315, 5, 5, 5, 300, 310]);
// C: the upper edge from the other side: 4x a 330 MB median is 1,320 MB; the largest ever seen is 986 MB.
scenario('a 1.4 GB day over a 330 MB median', [300, 310, 290, 330, 320, 305, 315, 1400]);
