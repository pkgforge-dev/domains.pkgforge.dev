// DOM-029 instrument 08, copied from .tmp/dom029/challenge/ratio.mjs as it ran on 2026-11-01T10:00Z.
// The question: what the runner costs a line across DOM-009 legs, against the desktop (design M16).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/08-ratio.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
import { readFileSync } from 'node:fs';
const r = JSON.parse(readFileSync(new URL('../measure/DOM-009/result.json', import.meta.url), 'utf8'));
const loc = JSON.parse(readFileSync(new URL('../measure/DOM-009/local-2026-10-26.stat.json', import.meta.url), 'utf8'));
console.log('local keys', Object.keys(loc).join(','));
const ls = loc.stages ?? loc.stage_seconds ?? loc;
console.log('local stages', JSON.stringify(ls).slice(0, 400), 'wall', loc.wall_seconds);
const nonDl = (s) => s.normalise + s.sort + s.split + s.encode + s.verify;
const rows = r.per_day.map((d) => ({ day: d.day, names: d.distinct_names, lines: d.lines, sum: nonDl(d.stages), per: nonDl(d.stages) / d.distinct_names * 1e6, wall: d.wall_seconds, dl: d.stages.download }));
rows.sort((a, b) => a.per - b.per);
console.log('runner us/name (non-download stages), min..max:');
for (const x of [rows[0], rows[1], rows[Math.floor(rows.length / 2)], rows[rows.length - 2], rows[rows.length - 1]]) console.log(x.day, x.per.toFixed(2), 'sum', x.sum.toFixed(1), 'names', x.names);
const locSum = loc.stages ? nonDl(loc.stages) : null;
const locPer = locSum / loc.counts?.distinct_names * 1e6;
console.log('local sum', locSum, 'local us/name', locPer?.toFixed?.(2));
const oct26 = r.per_day.find((d) => d.day === '2026-10-26');
console.log('matrix leg 10-26 non-dl', nonDl(oct26.stages).toFixed(1), 'one-day run non-dl', (19.547 + 15.11 + 36.506 + 27.096 + 16.126).toFixed(1));
console.log('ratio matrix', (nonDl(oct26.stages) / locSum).toFixed(3), 'ratio one-day', ((19.547 + 15.11 + 36.506 + 27.096 + 16.126) / locSum).toFixed(3));
// slowest leg wall, and the sept 09-12 non-dl vs sept median
const sept = rows.filter((x) => x.day < '2026-10-01');
console.log('sept legs', sept.length, 'non-dl s min/median/max', Math.min(...sept.map((x) => x.sum)).toFixed(0), sept.map((x) => x.sum).sort((a, b) => a - b)[16].toFixed(0), Math.max(...sept.map((x) => x.sum)).toFixed(0));
