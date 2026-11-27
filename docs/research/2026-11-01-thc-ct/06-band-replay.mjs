// DOM-029 instrument 06, copied from .tmp/dom029/band-replay.mjs as it ran on 2026-11-01T08:01Z.
// The question: which days of 2026-09-01 to 2026-10-31 the band quarantines or holds, at a ceiling of 2.5 and of 4 (design M12).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/06-band-replay.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// .tmp/dom029/band-replay.mjs — DOM-029 design measurement (not tracked).
// Replays checkBand of @domains/adapter over the Hugging Face listing in date
// order, as the backfill's plan would: each day checked against the verdicts
// of the days before it, the metric the raw file's bytes.
// Usage: node docs/research/2026-11-01-thc-ct/06-band-replay.mjs LISTING.json [MAX]
import { readFileSync } from 'node:fs';
import { checkBand } from '@domains/adapter';

const [listing, maxArg] = process.argv.slice(2);
const band = { metric: 'bytes', min: 0.4, max: Number(maxArg ?? 2.5), relative: true };
const files = JSON.parse(readFileSync(listing, 'utf8'))
  .filter((e) => e.type === 'file' && /\.txt\.gz$/.test(e.path))
  .map((e) => ({ day: e.path.match(/\d{4}-\d{2}-\d{2}/)[0], bytes: e.size, path: e.path }))
  .sort((a, b) => (a.day < b.day ? -1 : 1));
const history = [];
const out = [];
for (const f of files) {
  const r = checkBand(f.bytes, history, band, { precision: 'day' });
  out.push(`${f.day} ${(f.bytes / 1e6).toFixed(1)} MB ${r.verdict} ${r.reason} median ${r.median === null ? '-' : (r.median / 1e6).toFixed(1)} floor ${r.floor === null ? '-' : (r.floor / 1e6).toFixed(1)}${r.reset === null ? '' : ` reset ${(r.reset / 1e6).toFixed(1)}`}`);
  if (r.verdict !== 'hold') history.push({ day: f.day, count: f.bytes, quarantined: r.verdict === 'quarantine' });
}
console.log(`band ${JSON.stringify(band)}, ${files.length} files`);
for (const l of out) if (!/ ok within /.test(l)) console.log(l);
console.log(`quarantined: ${history.filter((h) => h.quarantined).map((h) => h.day).join(' ')}`);
console.log(`held: ${out.filter((l) => / hold /.test(l)).map((l) => l.slice(0, 10)).join(' ') || 'none'}`);
// A return to September's volume after the October level: the ratio of the largest file to the last median.
const last = checkBand(986e6, history, band, { precision: 'day' });
console.log(`a 986 MB day after 10-31: ${last.verdict} ${last.reason}, median ${(last.median / 1e6).toFixed(1)} MB, ceiling ${(last.ceiling / 1e6).toFixed(1)} MB`);
