// DOM-026 instrument, copied from .tmp/dom026/review2/claim-audit/run3/mono-scan.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// claim audit: is the Kafka record timestamp monotone with the offset over a whole retained span? (read-only)
import { writeFileSync } from 'node:fs';
import { KafkaClient, fetchRecords } from '../../../../scripts/measure/kafka-client.mjs';
import { EARLIEST, LATEST } from '../../../../scripts/measure/kafka-protocol.mjs';
const [topic, outFile] = process.argv.slice(2);
const c = await KafkaClient.connect({ clientId: 'domains.pkgforge.dev review (read-only)' });
await c.apiVersions();
const at = async (ts) => (await c.listOffsets([{ topic, partitions: [{ partition: 0, timestamp: ts }] }]))[0].partitions[0].offset;
const first = await at(EARLIEST), last = await at(LATEST);
let off = first, got = 0, prev = null, back = 0, maxBack = 0, jprev = null, jback = 0, jmaxBack = 0, ex = null;
const t0 = Date.now();
while (off < last) {
  const f = await fetchRecords(c, topic, 0, off, 8 << 20);
  if (f.records.length === 0) break;
  for (const r of f.records) {
    if (r.offset >= last) break;
    got++;
    if (prev !== null && r.timestamp < prev) { back++; maxBack = Math.max(maxBack, prev - r.timestamp); ex ??= { offset: r.offset, ms: r.timestamp, prev }; }
    prev = prev === null ? r.timestamp : Math.max(prev, r.timestamp);
    try { const v = JSON.parse(r.value.toString('utf8')); if (typeof v.timestamp === 'number') { if (jprev !== null && v.timestamp < jprev) { jback++; jmaxBack = Math.max(jmaxBack, jprev - v.timestamp); } jprev = jprev === null ? v.timestamp : Math.max(jprev, v.timestamp); } } catch {}
  }
  off = f.records.at(-1).offset + 1;
}
c.close();
const out = { topic, first, last, got, recordTsStepBacks: back, recordMaxStepBackMs: maxBack, firstExample: ex, jsonStepBacks: jback, jsonMaxStepBackS: jmaxBack, secs: (Date.now() - t0) / 1000, at: new Date().toISOString() };
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
