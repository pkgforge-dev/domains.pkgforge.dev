// DOM-026 instrument, copied from .tmp/dom026/review/hourly.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// Read-only: per-hour message counts of the three NRD topics across the retained span,
// by ListOffsets at each hour edge (the repository's own client). Writes hourly.json.
import { writeFileSync } from 'node:fs';
import { KafkaClient } from '../../../../scripts/measure/kafka-client.mjs';
import { EARLIEST, LATEST } from '../../../../scripts/measure/kafka-protocol.mjs';

const TOPICS = ['newly_registered_domain', 'newly_registered_fqdn', 'confirmed_newly_registered_domain'];
const t0 = Date.now();
const c = await KafkaClient.connect({ clientId: 'domains.pkgforge.dev review (read-only)' });
await c.apiVersions();
const at = async (ts) => {
  const r = await c.listOffsets(TOPICS.map((t) => ({ topic: t, partitions: [{ partition: 0, timestamp: ts }] })));
  const m = {};
  for (const t of r) m[t.topic] = t.partitions[0].offset;
  return m;
};
const earliest = await at(EARLIEST);
const latest = await at(LATEST);
console.log('earliest', JSON.stringify(earliest), 'latest', JSON.stringify(latest));
// the earliest message time: fetch not needed; use the design's 2026-10-22T13:00:50Z -> first hour edge after
const start = Date.parse('2026-10-22T14:00:00Z');
const end = Math.floor(Date.now() / 3600e3) * 3600e3;
const edges = [];
for (let t = start; t <= end; t += 3600e3) edges.push(t);
const offs = [];
for (const t of edges) offs.push([t, await at(t)]);
const rows = [];
// hour 0: from earliest to first edge
let prev = earliest;
let prevT = Date.parse('2026-10-22T13:00:50Z');
for (const [t, o] of offs) {
  const row = { start: new Date(prevT).toISOString(), end: new Date(t).toISOString() };
  for (const tp of TOPICS) row[tp] = (o[tp] === -1 ? latest[tp] : o[tp]) - prev[tp];
  rows.push(row);
  prev = Object.fromEntries(TOPICS.map((tp) => [tp, o[tp] === -1 ? latest[tp] : o[tp]]));
  prevT = t;
}
c.close();
writeFileSync(new URL('./07-hourly.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), earliest, latest, rows }, null, 1));
console.log('rows', rows.length, 'ms', Date.now() - t0);
