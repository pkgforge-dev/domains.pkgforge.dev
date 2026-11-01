// DOM-026 instrument: the size of facts.json for the table of 400,000 keys that the S1 test of
// scripts/compact/day.test.mjs builds, encoded by encodeFacts. Copied from the claim audit's
// facts-size.mjs with its import path moved to docs/research/measure/DOM-026/.
import { encodeFacts } from '../../../../packages/adapter/src/facts.ts';
const key = (k) => `com.s${String(k).padStart(6, '0')}-synthetic`;
const ageA = (k) => (k % 2 === 0 ? 2_592_000 : 120);
const ageB = (k) => (k % 3 === 0 ? 864_000 : 60);
const m = new Map();
for (let k = 0; k < 400_000; k++) {
  const ages = [];
  if (k < 205_000) ages.push(ageA(k));
  if (k >= 195_000) ages.push(ageB(k));
  m.set(key(k), new Map([[1, { cert_age: Math.min(...ages) }]]));
}
const b = encodeFacts(m);
console.log('bytes', b.length, 'per key', (b.length / 400000).toFixed(2), '64MiB', 64 << 20, 'ratio 14.2MB cap', ((64<<20)/14.2e6).toFixed(2));
