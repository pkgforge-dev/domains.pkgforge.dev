// scripts/measure/kafka-probe.mjs — ApiVersions, Metadata, and the earliest
// and latest offset of every partition. Read-only.
//
// Copied from docs/research/2026-10-27-design-a/scripts/kafka-probe.mjs. What
// changed: it uses the shared client (kafka-client.mjs); the port is a flag
// whose default is 9092, where design A defaulted to 9091 through KPORT (9091
// times out from every network measured so far); `--tls` replaces the `tls`
// argument.
//
// Usage: node scripts/measure/kafka-probe.mjs [--host H] [--port 9092] [--tls]
// Exit codes: 0 every answer read, 1 the broker could not be reached or
// answered with an error, 2 bad arguments.
import { EARLIEST, LATEST } from './kafka-protocol.mjs';
import { KafkaClient, userTopics } from './kafka-client.mjs';
import { commonArgs, isMain, run } from './kafka-cli.mjs';

async function main(argv) {
  const { args, host, port } = commonArgs(argv);
  const client = await KafkaClient.connect({ host, port, useTls: args.tls === true });
  try {
    const apis = await client.apiVersions();
    const range = (k) => (apis.has(k) ? [apis.get(k).min, apis.get(k).max] : null);
    console.log('ApiVersions err 0', 'Metadata', JSON.stringify(range(3)), 'ListOffsets', JSON.stringify(range(2)), 'Fetch', JSON.stringify(range(1)));
    const md = await client.metadata();
    console.log('brokers', JSON.stringify(md.brokers));
    console.log('topics', JSON.stringify(md.topics.map((t) => ({ name: t.name, e: t.errorCode, parts: t.partitions.map((p) => ({ pid: p.partition, leader: p.leader, pe: p.errorCode })) }))));
    for (const t of userTopics(md)) {
      for (const ts of [EARLIEST, LATEST]) {
        const res = await client.listOffsets([{ topic: t.name, partitions: t.partitions.map((p) => ({ partition: p.partition, timestamp: ts })) }]);
        const out = res.flatMap((r) => r.partitions.map((p) => ({ pid: p.partition, pe: p.errorCode, ts: String(p.timestamp), off: String(p.offset) })));
        console.log(t.name, ts === EARLIEST ? 'earliest' : 'latest', JSON.stringify(out));
      }
    }
  } finally {
    client.close();
  }
  return 0;
}

if (isMain(import.meta.url)) await run('kafka-probe', main);
