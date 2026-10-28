// scripts/measure/kafka-offsets.mjs — the offsets of every topic and two
// messages at each end of every partition, written to DIR/offsets.json.
// Read-only.
//
// Copied from docs/research/2026-10-27-design-a/scripts/kafka-offsets.mjs. What
// changed: it uses the shared client (Fetch v4, every partition, snappy
// decoded, where design A's Fetch v0 marked a snappy message `<codec 2>`); the
// counts are the shared offset summary's; the topics are every topic the broker
// lists; and the file goes under --data DIR instead of ../kafka/. The committed
// docs/research/2026-10-27-design-a/kafka/offsets.json is design A's reading of
// 2026-10-27T05:30:36Z and is never read or written here.
//
// Usage: node scripts/measure/kafka-offsets.mjs [--data DIR] [--host H] [--port P]
// Exit codes: 0 written, 1 the broker could not be reached or answered with an
// error, 2 bad arguments.
import { join } from 'node:path';
import { fetchRecords, KafkaClient, offsetSummary, userTopics } from './kafka-client.mjs';
import { commonArgs, isMain, run, writeJson } from './kafka-cli.mjs';

const SAMPLE_CHARS = 400;

export const sampleOf = (records) => records.map((m) => ({ off: m.offset, ts: new Date(m.timestamp).toISOString(), v: (m.value?.toString('utf8') ?? '').slice(0, SAMPLE_CHARS) }));

async function main(argv) {
  const { host, port, data } = commonArgs(argv);
  const client = await KafkaClient.connect({ host, port });
  const now = Date.now();
  const res = {};
  try {
    const md = await client.metadata();
    const summary = await offsetSummary(client, userTopics(md), now);
    for (const [topic, s] of Object.entries(summary)) {
      const partitions = [];
      for (const p of s.by_partition) {
        const empty = p.latest === p.earliest;
        const first = empty ? [] : (await fetchRecords(client, topic, p.partition, p.earliest, 4096)).records.slice(0, 2);
        const last = empty ? [] : (await fetchRecords(client, topic, p.partition, Math.max(p.earliest, p.latest - 5), 8192)).records.slice(-2);
        partitions.push({
          ...p,
          earliest_msg_ts: first[0] ? new Date(first[0].timestamp).toISOString() : null,
          latest_msg_ts: last.length > 0 ? new Date(last.at(-1).timestamp).toISOString() : null,
          sample: sampleOf([...first, ...last]),
        });
      }
      res[topic] = { ...s, by_partition: partitions };
      console.log(topic, JSON.stringify({ ...s, by_partition: undefined }));
    }
  } finally {
    client.close();
  }
  const file = join(data, 'offsets.json');
  writeJson(file, { at: new Date(now).toISOString(), host, port, res });
  console.log('wrote', file);
  return 0;
}

if (isMain(import.meta.url)) await run('kafka-offsets', main);
