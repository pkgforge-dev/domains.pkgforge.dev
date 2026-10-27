// usage: node f64cmp.mjs A.f64 B.f64 : counts of |A|, |B|, |A∩B| (sorted unique Float64 arrays)
import fs from 'node:fs';
const ld = (p) => { const b = fs.readFileSync(p); return new Float64Array(b.buffer, b.byteOffset, b.byteLength / 8); };
const A = ld(process.argv[2]), B = ld(process.argv[3]);
let i = 0, j = 0, c = 0;
while (i < A.length && j < B.length) { if (A[i] === B[j]) { c++; i++; j++; } else if (A[i] < B[j]) i++; else j++; }
console.log(JSON.stringify({ a: process.argv[2].split(/[\/]/).pop(), A: A.length, b: process.argv[3].split(/[\/]/).pop(), B: B.length, both: c, pctOfA: +(100 * c / A.length).toFixed(2), pctOfB: +(100 * c / B.length).toFixed(2) }));
