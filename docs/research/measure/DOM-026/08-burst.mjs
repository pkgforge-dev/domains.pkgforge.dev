// DOM-026 instrument, copied from .tmp/dom026/review/burst.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// Read-only: minute-by-minute counts of the worst burst hours (ListOffsets by timestamp).
import { KafkaClient } from '../../../../scripts/measure/kafka-client.mjs';
const T = ['newly_registered_domain', 'confirmed_newly_registered_domain'];
const c = await KafkaClient.connect({ clientId: 'domains.pkgforge.dev review (read-only)' });
await c.apiVersions();
const at = async (ts) => {
  const r = await c.listOffsets(T.map((t) => ({ topic: t, partitions: [{ partition: 0, timestamp: ts }] })));
  const m = {};
  for (const t of r) m[t.topic] = t.partitions[0].offset;
  return m;
};
for (const hour of ['2026-10-24T01:00:00Z', '2026-10-29T07:00:00Z', '2026-10-27T07:00:00Z', '2026-10-30T07:00:00Z']) {
  const h0 = Date.parse(hour);
  const pts = [];
  for (let m = 0; m <= 60; m++) pts.push(await at(h0 + m * 60e3));
  const per = {};
  for (const t of T) per[t] = pts.slice(1).map((p, i) => p[t] - pts[i][t]);
  const w10 = (t) => { const a = []; for (let i = 0; i < 6; i++) a.push(per[t].slice(i * 10, i * 10 + 10).reduce((x, y) => x + y, 0)); return a; };
  console.log(hour, 'domain 10-min windows', JSON.stringify(w10(T[0])), 'max minute', Math.max(...per[T[0]]), '| confirmed 10-min', JSON.stringify(w10(T[1])), 'max minute', Math.max(...per[T[1]]));
}
c.close();
