// DOM-029 instrument 28, copied from the session scratchpad (mutate-s3-record.mjs) as it ran on 2026-11-02T04:44Z.
// The question: whether each guard of adapters/thc-ct/record.mjs can fail a test (stage 3 mutation pass).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import { fileURLToPath } from 'node:url';
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/28-mutate-s3-record.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Scratch mutation pass of adapters/thc-ct/record.mjs's guards (stage 3 of
// DOM-029): killed only on a failing test of record.test.mjs; each file
// restored from the bytes read first, checked byte-equal.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FILE = join(ROOT, 'adapters/thc-ct/record.mjs');
const TEST = join(ROOT, 'adapters/thc-ct/record.test.mjs');
const M = [
  ['status unchecked', 'if (r.status !== want) throw', 'if (false) throw'],
  ['link unchecked', "if (listing.headers.get('link') !== null) throw", 'if (false) throw'],
  ['sizes unchecked', 'if (listed.get(args.day)?.bytes !== fileBytes || entry?.size !== fileBytes)', 'if (false)'],
  ['absent listed unchecked', 'if (listed.has(args.absent) || entries.has(args.absent)) throw', 'if (false) throw'],
  ['slice kinds unchecked', 'if (lacking.length > 0) throw', 'if (false) throw'],
  ['head unchecked', "if (res.status !== 206 || range !== `bytes 0-${args.headBytes - 1}/${fileBytes}` || gz.byteLength !== args.headBytes)", 'if (false)'],
  ['existing files overwritten', 'if (existsSync(join(args.out, n))) throw', 'if (false) throw'],
  ['set-cookie kept', "const KEPT = ['content-type',", "const KEPT = ['set-cookie', 'content-type',"],
  ['twin not derived', 'twin: has.upper.toLowerCase()', 'twin: has.upper'],
];
let killed = 0;
const survivors = [];
const original = readFileSync(FILE);
for (const [name, from, to] of M) {
  const text = original.toString('utf8');
  const at = text.indexOf(from);
  if (at === -1 || text.indexOf(from, at + 1) !== -1) {
    console.log(`SKIP ${name}`);
    survivors.push(`${name} (not applied)`);
    continue;
  }
  writeFileSync(FILE, text.slice(0, at) + to + text.slice(at + from.length));
  const r = spawnSync(process.execPath, ['--test', TEST], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  writeFileSync(FILE, original);
  if (!readFileSync(FILE).equals(original)) throw new Error('record.mjs not restored');
  const out = `${r.stdout}\n${r.stderr}`;
  const failed = r.status !== 0 && /^\u2716 /m.test(out) && /failing tests/.test(out);
  console.log(`${failed ? 'KILLED' : 'SURVIVED'} ${name} (exit ${r.status})`);
  if (failed) killed += 1;
  else survivors.push(name);
}
console.log(`killed ${killed}; survivors: ${survivors.length === 0 ? 'none' : survivors.join('; ')}`);
process.exitCode = survivors.length === 0 ? 0 : 1;
