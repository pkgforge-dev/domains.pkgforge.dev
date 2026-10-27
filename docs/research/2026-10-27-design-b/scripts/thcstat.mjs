import fs from 'node:fs'; import zlib from 'node:zlib';
import { loadPSL } from './psl.mjs';
const [file, pslPath, outJson] = process.argv.slice(2);
const split = loadPSL(pslPath, { icannOnly: false });
const t0 = Date.now();
let n = 0, bytes = 0, wild = 0, bad = 0, unsorted = 0, noreg = 0, ipLike = 0, upper = 0, nonascii = 0, maxlen = 0;
let prev = '';
const regs = new Set(); const sufC = new Map(); const labC = {}; const tldC = new Map();
const wildRegs = new Set();
let buf = '';
const gz = fs.createReadStream(file).pipe(zlib.createGunzip());
gz.setEncoding('latin1');
function line(l) {
  if (!l) return;
  n++; bytes += l.length + 1;
  if (l < prev) unsorted++; prev = l;
  if (l.length > maxlen) maxlen = l.length;
  let h = l;
  if (h.startsWith('*.')) { wild++; h = h.slice(2); }
  if (/[A-Z]/.test(h)) upper++;
  if (/[^\x21-\x7e]/.test(h)) nonascii++;
  if (!/^[a-z0-9._*-]+$/.test(h)) { bad++; return; }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(h)) { ipLike++; return; }
  const { suffix, reg } = split(h);
  if (reg === null) { noreg++; return; }
  const k = reg; if (!regs.has(k)) regs.add(k);
  sufC.set(suffix, (sufC.get(suffix) || 0) + 1);
  const tld = suffix.slice(suffix.lastIndexOf('.') + 1); tldC.set(tld, (tldC.get(tld) || 0) + 1);
  const lc = h.split('.').length; labC[lc] = (labC[lc] || 0) + 1;
}
gz.on('data', (c) => { buf += c; let i; let s = 0; while ((i = buf.indexOf('\n', s)) >= 0) { line(buf.slice(s, i)); s = i + 1; } buf = buf.slice(s); });
gz.on('end', () => {
  line(buf);
  const out = { file, lines: n, bytes, wildcard: wild, bad, unsorted, noreg, ipLike, upper, nonascii, maxlen, distinctReg: regs.size, secs: (Date.now() - t0) / 1000, labels: labC,
    tldTop: [...tldC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25), sufTop: [...sufC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25), nTld: tldC.size, nSuf: sufC.size };
  fs.writeFileSync(outJson, JSON.stringify(out, null, 1));
  console.log(JSON.stringify(out));
});
