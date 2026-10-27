// usage: node regdoms.mjs <norm.txt> <psl> <out_reg.txt> <out_stats.json>
// one pass over a normalised (lowercase, sorted -u) name list: writes the distinct registrable domains (PSL ICANN+PRIVATE and ICANN-only counted separately)
import fs from 'node:fs'; import readline from 'node:readline';
import { loadPSL } from './psl.mjs';
const [inp, pslPath, outReg, outStats] = process.argv.slice(2);
const splitAll = loadPSL(pslPath, { icannOnly: false });
const splitIcann = loadPSL(pslPath, { icannOnly: true });
const regAll = new Set(), regIcann = new Set();
let n = 0, wild = 0, apexOnly = 0;
const rl = readline.createInterface({ input: fs.createReadStream(inp, { encoding: 'latin1' }), crlfDelay: Infinity });
for await (const l of rl) {
  n++; let h = l; if (h.startsWith('*.')) { wild++; h = h.slice(2); }
  if (!/^[a-z0-9._-]+$/.test(h)) continue;
  const a = splitAll(h); if (a.reg) regAll.add(a.reg);
  const b = splitIcann(h); if (b.reg) regIcann.add(b.reg);
}
fs.writeFileSync(outReg, [...regIcann].join('\n') + '\n');
fs.writeFileSync(outStats, JSON.stringify({ inp, lines: n, wildcard: wild, regAll: regAll.size, regIcann: regIcann.size }));
console.log(inp, n, 'regAll', regAll.size, 'regIcann', regIcann.size);
