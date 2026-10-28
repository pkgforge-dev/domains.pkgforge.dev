// scripts/measure/kafkafetch.mjs — one Fetch v4 of one partition, printed
// batch by batch with the first records. Read-only.
//
// Copied from docs/research/2026-10-27-design-b/scripts/kafkafetch.mjs. What
// changed: it uses the shared client, so a snappy batch decodes (design B's copy
// printed "compression 2 unsupported" for it) and every batch's CRC-32C is
// checked; it takes --partition, --host and --port.
//
// Usage: node scripts/measure/kafkafetch.mjs TOPIC OFFSET|latest-N [MAXBYTES] [--partition 0] [--host H] [--port P]
//   OFFSET     an offset, or latest-N for N messages before the newest
//   MAXBYTES   the Fetch size limit (default 20000)
// Exit codes: 0 fetched and decoded, 1 the broker could not be reached, answered
// with an error or sent a batch that does not decode, 2 bad arguments.
import { LATEST } from './kafka-protocol.mjs';
import { fetchRecords, KafkaClient } from './kafka-client.mjs';
import { commonArgs, intArg, isMain, run, UsageError } from './kafka-cli.mjs';

const SHOWN = 6;

// The offset argument: {latestMinus: N} for latest-N, or {offset}.
export function parseOffsetArg(value) {
  const m = typeof value === 'string' ? value.match(/^latest-(\d+)$/) : null;
  if (m) return { latestMinus: Number(m[1]) };
  return { offset: intArg(value, 'OFFSET') };
}

async function main(argv) {
  const { args, host, port } = commonArgs(argv);
  const [topic, offsetArg, maxArg] = args._;
  if (!topic || offsetArg === undefined) throw new UsageError('usage: kafkafetch.mjs TOPIC OFFSET|latest-N [MAXBYTES] [--partition 0] [--host H] [--port P]');
  const want = parseOffsetArg(offsetArg);
  const maxBytes = maxArg === undefined ? 20000 : intArg(maxArg, 'MAXBYTES', 1);
  const partition = args.partition === undefined ? 0 : intArg(args.partition, '--partition');
  const client = await KafkaClient.connect({ host, port });
  try {
    const apis = await client.apiVersions();
    console.log('Fetch(1) versions', JSON.stringify(apis.get(1)), 'ListOffsets(2)', JSON.stringify(apis.get(2)), 'Metadata(3)', JSON.stringify(apis.get(3)));
    let offset = want.offset;
    if (want.latestMinus !== undefined) {
      const lo = await client.listOffsets([{ topic, partitions: [{ partition, timestamp: LATEST }] }]);
      offset = Math.max(0, lo[0].partitions[0].offset - want.latestMinus);
    }
    const f = await fetchRecords(client, topic, partition, offset, maxBytes);
    console.log('fetch error 0', 'hwm', f.highWatermark, 'recordset bytes', f.recordsBytes, 'partial batch bytes', f.partial);
    let shown = 0;
    let total = 0;
    let valueBytes = 0;
    f.decoded.forEach((d, i) => {
      for (const r of d.records) {
        total += 1;
        valueBytes += r.value?.length ?? 0;
        if (shown < SHOWN && r.offset >= offset) {
          console.log(' rec', r.offset, 'key', r.key === null ? null : r.key.toString('utf8'), 'val', (r.value?.toString('utf8') ?? '').slice(0, 220));
          shown += 1;
        }
      }
      console.log(' batch magic', f.batches[i].magic, 'compression', d.codec, 'records', d.recordCount, 'bytes', f.batches[i].size);
    });
    console.log('decoded records', total, 'avg value bytes', total > 0 ? (valueBytes / total).toFixed(1) : 0);
  } finally {
    client.close();
  }
  return 0;
}

if (isMain(import.meta.url)) await run('kafkafetch', main);
