// Analyse one THC daily dump: counts, distinct names, wildcard share, registrable domains, suffix histogram.
// usage: node thc-day.mjs <file.txt.gz> <outdir>
import fs from 'node:fs';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPsl, split } from './psl.mjs';

const [file, outdir] = process.argv.slice(2);
const day = path.basename(file).slice(0, 10);
const psl = loadPsl(fileURLToPath(new URL('../psl/psl.dat', import.meta.url)));

function h53(s) {
  let a = 0x811c9dc5, b = 0x01000193 ^ 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 15;
  }
  return (a >>> 0) + (b & 0x1fffff) * 4294967296;
}

let cap = 80_000_000;
let names = new Float64Array(cap), regs = new Float64Array(cap), sites = new Float64Array(cap);
let n = 0, lines = 0, bytes = 0, wild = 0, bad = 0, nosplit = 0, firstLines = [];
const suffixCount = new Map();
const lengths = { min: 1e9, max: 0, sum: 0 };

const t0 = Date.now();
let rest = '';
const gz = zlib.createGunzip();
const rs = fs.createReadStream(file, { highWaterMark: 1 << 20 }).pipe(gz);
function handle(line) {
  lines++;
  if (!line) return;
  let l = line.toLowerCase();
  if (l.charCodeAt(l.length - 1) === 13) l = l.slice(0, -1);
  if (l.startsWith('*.')) { wild++; l = l.slice(2); }
  if (!/^[a-z0-9_.*-]+$/.test(l) || l.indexOf('.') < 0) { bad++; return; }
  if (n >= cap) throw new Error('cap');
  const sp = split(psl.icann, l);
  if (!sp.reg) { nosplit++; }
  names[n] = h53(l);
  regs[n] = sp.reg ? h53(sp.reg) : h53(l);
  const sp2 = split(psl.all, l);
  sites[n] = sp2.reg ? h53(sp2.reg) : h53(l);
  n++;
  suffixCount.set(sp.suffix, (suffixCount.get(sp.suffix) || 0) + 1);
  lengths.sum += l.length; if (l.length > lengths.max) lengths.max = l.length; if (l.length < lengths.min) lengths.min = l.length;
}
for await (const chunk of rs) {
  bytes += chunk.length;
  const s = rest + chunk.toString('latin1');
  const parts = s.split('\n');
  rest = parts.pop();
  for (const p of parts) handle(p);
}
if (rest) handle(rest);

function uniq(a, n) {
  const v = a.subarray(0, n); v.sort();
  let u = 0; let last = -1;
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) { if (v[i] !== last) { out[u++] = v[i]; last = v[i]; } }
  return out.slice(0, u);
}
const un = uniq(names, n), ur = uniq(regs, n), us = uniq(sites, n);
fs.mkdirSync(outdir, { recursive: true });
fs.writeFileSync(path.join(outdir, day + '.names.f64'), Buffer.from(un.buffer, un.byteOffset, un.byteLength));
fs.writeFileSync(path.join(outdir, day + '.regs.f64'), Buffer.from(ur.buffer, ur.byteOffset, ur.byteLength));
const top = [...suffixCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40);
const stat = {
  day, gz_bytes: fs.statSync(file).size, text_bytes_uncompressed: bytes, lines, wildcard_lines: wild, rejected_lines: bad,
  names_after_wildcard_strip: n, distinct_names: un.length, distinct_registrable_icann: ur.length, distinct_sites_fullpsl: us.length,
  names_that_are_a_suffix_itself: nosplit, avg_name_len: +(lengths.sum / n).toFixed(2), max_name_len: lengths.max,
  top_suffixes: top, secs: (Date.now() - t0) / 1000,
  suffix_counts_selected: Object.fromEntries(['com', 'net', 'org', 'com.np', 'np', 'co.uk', 'ru', 'de', 'cn', 'xyz', 'top', 'shop', 'online', 'app', 'dev', 'se', 'ch', 'fr', 'nu', 'sk', 'ee', 'li'].map(k => [k, suffixCount.get(k) || 0])),
};
fs.writeFileSync(path.join(outdir, day + '.stat.json'), JSON.stringify(stat, null, 1));
console.log(JSON.stringify(stat));
