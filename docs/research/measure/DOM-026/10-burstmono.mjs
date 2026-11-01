// DOM-026 instrument, copied from .tmp/dom026/review/burstmono.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// Read-only: read one whole burst minute (140,503 messages) and test the design's D8 premise (record timestamp monotone with offset),
// and the share of zone rows and the distribution of record seconds.
import { KafkaClient, fetchRecords } from '../../../../scripts/measure/kafka-client.mjs';
const topic = 'newly_registered_domain';
const start = 173007942, n = 140503;
const c = await KafkaClient.connect({ clientId: 'domains.pkgforge.dev review (read-only)' });
await c.apiVersions();
let off = start, got = 0, stepBack = 0, maxBack = 0, prev = null, zone = 0, bytes = 0;
const secs = new Map();
const t0 = Date.now();
while (off < start + n) {
  const f = await fetchRecords(c, topic, 0, off, 8 << 20);
  bytes += f.recordsBytes;
  if (f.records.length === 0) break;
  for (const r of f.records) {
    if (r.offset >= start + n) break;
    const sec = Math.floor(r.timestamp / 1000);
    secs.set(sec, (secs.get(sec) ?? 0) + 1);
    if (prev !== null && r.timestamp < prev) { stepBack++; maxBack = Math.max(maxBack, prev - r.timestamp); }
    prev = prev === null ? r.timestamp : Math.max(prev, r.timestamp);
    if (r.value.includes('zone_data')) zone++;
    got++;
  }
  off = f.records.at(-1).offset + 1;
}
c.close();
const top = [...secs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
console.log(JSON.stringify({ got, ms: Date.now() - t0, wireMB: (bytes / 1e6).toFixed(1), stepBack, maxBackMs: maxBack, zone, distinctSeconds: secs.size, maxInOneSecond: top[0][1], top }));
