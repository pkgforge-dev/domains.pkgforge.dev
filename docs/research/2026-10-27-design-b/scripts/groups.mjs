import fs from 'node:fs'; import readline from 'node:readline';
import { loadPSL } from './psl.mjs';
const split = loadPSL('psl/public_suffix_list.dat', { icannOnly: true });
const rl = readline.createInterface({ input: fs.createReadStream('rev/r26.sorted', { encoding: 'latin1' }), crlfDelay: Infinity });
let prevRev = null, cnt = 0; const groups = []; let nameRows = 0; let noreg = 0;
const hist = [1, 2, 10, 100, 1000, 10000, 100000, 1e9]; const hc = new Array(hist.length).fill(0), hn = new Array(hist.length).fill(0);
const top = [];
function close() { if (prevRev === null) return; const i = hist.findIndex(h => cnt < h); hc[i]++; hn[i] += cnt; top.push([prevRev, cnt]); if (top.length > 4000) { top.sort((a, b) => b[1] - a[1]); top.length = 40; } }
for await (const l of rl) {
  const name = l.slice(0, l.indexOf('\t')); nameRows++;
  if (prevRev !== null && (name === prevRev || name.startsWith(prevRev + '.'))) { cnt++; continue; }
  close();
  const host = name.split('.').reverse().join('.'); const { reg } = split(host);
  if (!reg) { noreg++; prevRev = name; cnt = 1; continue; }
  prevRev = reg.split('.').reverse().join('.'); cnt = 1;
}
close(); top.sort((a, b) => b[1] - a[1]);
const labels = ['=1', '2-9', '10-99', '100-999', '1k-9.9k', '10k-99k', '>=100k'];
const tot = hc.reduce((a, b) => a + b, 0);
console.log('rows', nameRows, 'regdom groups', tot, 'noreg', noreg);
hc.slice(0, 7).forEach((c, i) => console.log(' names per regdom', labels[i], ': regdoms', c, '(' + (c / tot * 100).toFixed(1) + '%)', 'names', hn[i], '(' + (hn[i] / nameRows * 100).toFixed(1) + '%)'));
console.log('top', top.slice(0, 25).map(t => t[0].split('.').reverse().join('.') + ':' + t[1]).join(' '));
