import fs from 'node:fs'; import zlib from 'node:zlib';
const [f, nBytes] = process.argv.slice(2);
const buf = fs.readFileSync(f).subarray(0, +nBytes);
let out;
try { out = zlib.gunzipSync(buf, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch (e) { console.log('err', e.message); process.exit(1); }
const L = out.toString('latin1').split('\n');
console.log(L.slice(0, 20).join('\n')); console.log('...'); console.log(L.slice(5000, 5008).join('\n'));
let inv = 0; for (let i = 1; i < L.length - 1; i++) if (L[i] < L[i - 1]) { inv++; if (inv <= 6) console.log('inv', JSON.stringify(L[i - 1]), '->', JSON.stringify(L[i])); }
console.log('lines in prefix', L.length, 'inversions', inv);
