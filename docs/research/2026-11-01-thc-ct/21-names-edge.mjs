// DOM-029 instrument 21, copied from .tmp/dom029/challenge/door/names-edge.mjs as it ran on 2026-11-01T10:22Z.
// The question: what normalise and split do with address literals, public suffixes, IDN rules and bad punycode (design M29).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/21-names-edge.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Challenge lens "the door and the failures": what packages/names does with
// the edge lines THC may send. Read-only; prints one line per case.
import { readFileSync } from 'node:fs';
import { loadPsl, normalise, split, key } from '../../../packages/names/src/index.ts';

const psl = await loadPsl(readFileSync(new URL('../../../packages/names/test/fixtures/psl-2026-10-27.dat', import.meta.url)));
const lines = [
  'a.example.com', '*.a.example.com', 'A.Example.COM', '192.0.2.1', '*.10.0.0.1', '1.2.3.4.example.com', '10.0.0.1.',
  'foo.xn--55qx5d.cn', 'foo.xn--p1ai', 'xn--80ak6aa92e.xn--p1ai', 'foo.com.np', 'co.uk', '*.co.uk', 'github.io', 'foo.github.io',
  'xn--bcher-kva.example', 'xn--.example.com', 'xn--a.example.com', 'a b.example.com', 'a\r', '_dmarc.example.com', '*.*.example.com',
  'a..example.com', '-a.example.com', 'a-.example.com', 'foo.ck', 'www.ck', 'foo.bar.ck', '[::1]', '::1', 'localhost', 'example.com:443',
  'EXAMPLE.COM.', 'foo.bd', 'x.kawasaki.jp', 'city.kawasaki.jp', 'a.b.city.kawasaki.jp',
];
for (const l of lines) {
  const n = normalise(l, psl);
  if ('refused' in n) { console.log(JSON.stringify(l).padEnd(30), 'REFUSED', n.refused); continue; }
  const s = split(n.name, psl);
  console.log(JSON.stringify(l).padEnd(30), n.name.padEnd(28), 'wild', n.wild, 'reg', JSON.stringify(s.reg), 'site', JSON.stringify(s.site ?? null), 'key', key(n.name));
}
// IDN rules in the PSL: does the loaded list hold their ASCII form?
const text = readFileSync(new URL('../../../packages/names/test/fixtures/psl-2026-10-27.dat', import.meta.url), 'utf8');
const idn = text.split('\n').filter((x) => /[^\x00-\x7f]/.test(x) && !x.startsWith('//')).slice(0, 5);
console.log('IDN rules in file (first 5):', idn.join(' | '));
for (const r of idn) {
  const probe = `foo.${r.replace(/^[*!]\./, '')}`;
  const n = normalise(probe, psl);
  console.log(JSON.stringify(probe), 'refused' in n ? `REFUSED ${n.refused}` : JSON.stringify(split(n.name, psl).reg));
}
