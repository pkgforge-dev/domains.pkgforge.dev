// DOM-026 instrument, copied from .tmp/dom026/review/burstcontent2.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// Read-only: what a burst minute holds (TLD, ct_name, cert_index, timestamps), from the repository's client.
import { KafkaClient, fetchRecords } from '../../../../scripts/measure/kafka-client.mjs';
const topic = 'newly_registered_domain';
const c = await KafkaClient.connect({ clientId: 'domains.pkgforge.dev review (read-only)' });
await c.apiVersions();
const off = async (ts) => {
  const r = await c.listOffsets([{ topic, partitions: [{ partition: 0, timestamp: ts }] }]);
  return r[0].partitions[0].offset;
};
// the burst minute of 2026-10-29T07:10..07:20 window: find the minute with the most messages
const h0 = Date.parse('2026-10-24T01:00:00Z');
let best = null;
let prev = await off(h0 + 0 * 60e3);
for (let m = 1; m <= 10; m++) {
  const o = await off(h0 + m * 60e3);
  if (best === null || o - prev > best.n) best = { m: m - 1, start: prev, n: o - prev };
  prev = o;
}
console.log('burst minute', JSON.stringify(best));
const sample = [];
for (const at of [best.start, best.start + Math.floor(best.n / 2), best.start + best.n - 2000]) {
  const r = await fetchRecords(c, topic, 0, at, 1 << 20);
  for (const rec of r.records.slice(0, 1500)) sample.push({ off: rec.offset, ts: rec.timestamp, v: JSON.parse(rec.value.toString('utf8')) });
}
const tld = {}, ct = {}, idx = {}, secs = new Set(), tsDelta = [];
for (const s of sample) {
  const d = s.v.domain.replace(/\.$/, '');
  const t = d.split('.').slice(-1)[0];
  tld[t] = (tld[t] ?? 0) + 1;
  ct[s.v.ct_name] = (ct[s.v.ct_name] ?? 0) + 1;
  idx[s.v.cert_index === -1 ? '-1' : 'other'] = (idx[s.v.cert_index === -1 ? '-1' : 'other'] ?? 0) + 1;
  secs.add(Math.floor(s.ts / 1000));
  tsDelta.push(s.ts / 1000 - s.v.timestamp);
}
tsDelta.sort((a, b) => a - b);
console.log('n', sample.length, 'tld', JSON.stringify(Object.entries(tld).sort((a, b) => b[1] - a[1]).slice(0, 6)), 'ct_name', JSON.stringify(Object.entries(ct).sort((a, b) => b[1] - a[1]).slice(0, 4)), 'cert_index', JSON.stringify(idx));
console.log('distinct record seconds', secs.size, 'rec minus json timestamp p50', tsDelta[Math.floor(tsDelta.length / 2)], 'max', tsDelta.at(-1), 'min', tsDelta[0]);
console.log('example', JSON.stringify(sample[0].v), JSON.stringify(sample.at(-1).v));
c.close();
