// DOM-026 instrument, copied from .tmp/dom026/reg.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// Read-only: for the two domain topics, how often OpenINTEL's domain is not our ICANN reg (fixture PSL).
import { readFileSync } from 'node:fs';
import { consumeRange, KafkaClient } from '../../../../scripts/measure/kafka-client.mjs';
import { LATEST } from '../../../../scripts/measure/kafka-protocol.mjs';
import { loadPsl, normalise, split } from '../../../../packages/names/src/index.ts';
const psl = await loadPsl(readFileSync('packages/names/test/fixtures/psl-2026-10-27.dat'));
const client = await KafkaClient.connect({});
try {
  await client.apiVersions();
  for (const topic of ['newly_registered_domain', 'confirmed_newly_registered_domain']) {
    const lo = await client.listOffsets([{ topic, partitions: [{ partition: 0, timestamp: LATEST }] }]);
    const latest = lo[0].partitions[0].offset;
    const values = [];
    await consumeRange(client, { topic, ranges: [{ partition: 0, start: latest - 20000, stop: latest }], fetchBytes: 8 << 20, onRecord: (r) => values.push(r.value) });
    let refused = {}, differs = 0, siteDiffers = 0; const ex = [];
    for (const v of values) {
      const m = JSON.parse(v.toString('utf8'));
      const n = normalise(m.domain, psl);
      if ('refused' in n) { refused[n.refused] = (refused[n.refused] ?? 0) + 1; continue; }
      const s = split(n.name, psl);
      if (s.reg !== n.name) { differs++; if (ex.length < 5) ex.push(`${n.name} -> ${s.reg}`); }
      if (s.site !== n.name) siteDiffers++;
    }
    console.log(topic, 'messages', values.length, 'refused', JSON.stringify(refused), 'domain != ICANN reg', differs, 'domain != site', siteDiffers, 'e.g.', ex.join('; '));
  }
} finally { client.close(); }
