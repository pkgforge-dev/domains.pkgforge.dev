// scripts/measure/kafkaprobe.mjs — ApiVersions v0, Metadata v0, and ListOffsets
// v1 for every partition: earliest, latest, and the offsets at now - 1 h, 24 h
// and 7 d, with the counts between them. Read-only.
//
// Copied from docs/research/2026-10-27-design-b/scripts/kafkaprobe.mjs. What
// changed: it uses the shared client and the shared offset summary
// (kafka-client.mjs, the same counts kafka-runner.mjs records in step 2), and
// it takes --host and --port.
//
// Usage: node scripts/measure/kafkaprobe.mjs [--host H] [--port 9092]
// Exit codes: 0 every answer read, 1 the broker could not be reached or
// answered with an error, 2 bad arguments.
import { KafkaClient, offsetSummary, userTopics } from './kafka-client.mjs';
import { commonArgs, isMain, run } from './kafka-cli.mjs';

async function main(argv) {
  const { host, port } = commonArgs(argv);
  const client = await KafkaClient.connect({ host, port });
  try {
    console.log('tcp connected', host, port);
    const apis = await client.apiVersions();
    console.log('ApiVersions error_code 0 apis', apis.size);
    const md = await client.metadata();
    console.log('brokers', md.brokers.map((b) => `${b.id}@${b.host}:${b.port}`).join(' '));
    console.log('topics', md.topics.map((t) => `${t.name}(ec=${t.errorCode},parts=${t.partitions.length})`).join(' '));
    const summary = await offsetSummary(client, userTopics(md), Date.now());
    for (const [name, s] of Object.entries(summary)) {
      for (const p of s.by_partition) {
        console.log(
          name,
          `p${p.partition}`,
          'earliest',
          p.earliest,
          'latest',
          p.latest,
          'retained',
          p.latest - p.earliest,
          '| last 1h',
          p.last_1h,
          '| last 24h',
          p.last_24h,
          '| last 7d',
          p.last_7d,
          '| earliest message',
          p.earliest_ts === null ? null : new Date(p.earliest_ts).toISOString(),
        );
      }
    }
  } finally {
    client.close();
  }
  return 0;
}

if (isMain(import.meta.url)) await run('kafkaprobe', main);
