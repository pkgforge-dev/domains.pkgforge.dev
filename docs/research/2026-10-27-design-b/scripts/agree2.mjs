import fs from 'node:fs'; import zlib from 'node:zlib';
const load = (p) => new Set(fs.readFileSync(p, 'latin1').split('\n').filter(Boolean));
const R25 = load('norm/reg25.txt'), R26 = load('norm/reg26.txt');
let newReg = 0; for (const d of R26) if (!R25.has(d)) newReg++;
console.log('ICANN-regdoms 25:', R25.size, '26:', R26.size, '26 not in 25:', newReg, (newReg / R26.size * 100).toFixed(1) + '%');
const isc = (d) => new Set(JSON.parse(zlib.gunzipSync(fs.readFileSync(`dl_isc/${d}.json.gz`)).toString()).map(r => r.domainname));
const who = (d) => new Set(fs.readFileSync(`dl_whoisds/${d}.txt`, 'utf8').split('\n').filter(Boolean).map(s => s.toLowerCase()));
function rep(label, S) {
  let in26 = 0, in25 = 0, only26 = 0; for (const d of S) { const a = R26.has(d), b = R25.has(d); if (a) in26++; if (b) in25++; if (a && !b) only26++; }
  console.log(label, 'n=', S.size, 'in THC-26 regdoms', in26, (in26 / S.size * 100).toFixed(1) + '%', '| in THC-25', in25, (in25 / S.size * 100).toFixed(1) + '%', '| in 26 and not in 25', only26);
}
rep('ISC first-seen 10-26 ', isc('2026-10-26')); rep('ISC first-seen 10-25 ', isc('2026-10-25')); rep('WhoisDS file 10-26 (= ISC 10-25 day) ', who('2026-10-26'));
// of THC-26 regdoms not in THC-25: how many are in ISC 10-26 / 10-25 lists (precision proxy)
const I26 = isc('2026-10-26'), I25 = isc('2026-10-25'); let a = 0, b = 0; for (const d of R26) if (!R25.has(d)) { if (I26.has(d)) a++; if (I25.has(d)) b++; }
console.log('THC "regdoms in 26 not in 25":', newReg, '-> in ISC 10-26:', a, 'in ISC 10-25:', b);
