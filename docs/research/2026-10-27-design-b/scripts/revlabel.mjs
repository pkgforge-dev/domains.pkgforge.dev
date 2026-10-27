// reversed-label transform: in: normalised names (one per line, may start with "*."); out: "<reversed labels>\t<0|1>" (1 = wildcard)
import fs from 'node:fs'; import readline from 'node:readline';
const [inp, out] = process.argv.slice(2);
const w = fs.createWriteStream(out, { encoding: 'latin1' });
const rl = readline.createInterface({ input: fs.createReadStream(inp, { encoding: 'latin1' }), crlfDelay: Infinity });
let n = 0, bad = 0, buf = [];
for await (const l of rl) {
  let h = l, f = 0; if (h.startsWith('*.')) { f = 1; h = h.slice(2); }
  if (!/^[a-z0-9._-]+$/.test(h) || h.startsWith('.') || h.endsWith('.') || h.includes('..')) { bad++; continue; }
  buf.push(h.split('.').reverse().join('.') + '\t' + f); n++;
  if (buf.length >= 50000) { w.write(buf.join('\n') + '\n'); buf = []; }
}
w.write(buf.join('\n') + '\n'); w.end();
console.log('rows', n, 'bad', bad);
