// DOM-026 instrument, copied from .tmp/dom026/cpu.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// Read-only: 20,000 newest messages of each NRD topic over the repository's client, then time
// JSON.parse, normalise and split (the fixture PSL) per message in this process.
import { readFileSync } from 'node:fs';
import { consumeRange, KafkaClient } from '../../../../scripts/measure/kafka-client.mjs';
import { LATEST } from '../../../../scripts/measure/kafka-protocol.mjs';
import { key, loadPsl, normalise, split } from '../../../../packages/names/src/index.ts';
const psl = await loadPsl(readFileSync('packages/names/test/fixtures/psl-2026-10-27.dat'));
const client = await KafkaClient.connect({});
const values = [];
try {
  await client.apiVersions();
  for (const topic of ['newly_registered_domain', 'newly_registered_fqdn', 'confirmed_newly_registered_domain']) {
    const lo = await client.listOffsets([{ topic, partitions: [{ partition: 0, timestamp: LATEST }] }]);
    const latest = lo[0].partitions[0].offset;
    await consumeRange(client, { topic, ranges: [{ partition: 0, start: latest - 20000, stop: latest }], fetchBytes: 8 << 20, onRecord: (r) => values.push(r.value) });
  }
} finally { client.close(); }
const t0 = performance.now();
let refused = 0, differs = 0;
const keys = new Set();
for (let round = 0; round < 5; round++) for (const v of values) {
  const m = JSON.parse(v.toString('utf8'));
  const n = normalise(m.domain ?? m.fqdn, psl);
  if ('refused' in n) { refused++; continue; }
  const s = split(n.name, psl);
  if (s.reg !== n.name) differs++;
  keys.add(key(m.domain ? s.reg : n.name));
}
const ms = performance.now() - t0;
console.log('messages', values.length * 5, 'ms', ms.toFixed(0), 'us/message', ((ms * 1000) / (values.length * 5)).toFixed(2), 'refused', refused / 5, 'reg differs', differs / 5, 'distinct keys', keys.size);
