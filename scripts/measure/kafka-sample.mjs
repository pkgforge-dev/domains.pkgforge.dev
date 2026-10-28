// scripts/measure/kafka-sample.mjs — read the newest few hundred messages of
// the certificate topics and write their size and four samples to
// DIR/samples.json. Read-only.
//
// Copied from docs/research/2026-10-27-design-a/scripts/kafka-sample.mjs. What
// changed: it uses the shared client (Fetch v4, every partition); bytes_per_msg
// is the mean UTF-8 byte length of a value, where design A measured string
// length; and the file goes under --data DIR instead of ../kafka/.
//
// Usage: node scripts/measure/kafka-sample.mjs [--data DIR] [--host H] [--port P]
//        [--topics certstream_domains,certstream,newly_issued_certificates_measurements]
// Exit codes: 0 written, 1 the broker could not be reached or answered with an
// error, 2 bad arguments.
import { join } from 'node:path';
import { LATEST } from './kafka-protocol.mjs';
import { fetchRecords, KafkaClient } from './kafka-client.mjs';
import { commonArgs, isMain, run, UsageError, writeJson } from './kafka-cli.mjs';

export const DEFAULT_TOPICS = ['certstream_domains', 'certstream', 'newly_issued_certificates_measurements'];
const BACK = 300;
const MAX_BYTES = 256 << 10;

// The mean value size in bytes and the first four values, cut to 500 characters.
export function describe(records) {
  const bytes = records.reduce((a, m) => a + (m.value?.length ?? 0), 0);
  return {
    n: records.length,
    bytes_per_msg: records.length > 0 ? Math.round(bytes / records.length) : null,
    sample: records.slice(0, 4).map((m) => ({ off: m.offset, v: (m.value?.toString('utf8') ?? '').slice(0, 500) })),
  };
}

async function main(argv) {
  const { args, host, port, data } = commonArgs(argv);
  if (args.topics !== undefined && typeof args.topics !== 'string') throw new UsageError('--topics needs a comma-separated list');
  const topics = args.topics === undefined ? DEFAULT_TOPICS : args.topics.split(',').map((t) => t.trim());
  const client = await KafkaClient.connect({ host, port });
  const out = {};
  try {
    const md = await client.metadata(topics);
    for (const name of topics) {
      const t = md.topics.find((x) => x.name === name);
      if (!t || t.errorCode !== 0) throw new Error(`the broker does not serve ${name}`);
      const latest = await client.listOffsets([{ topic: name, partitions: t.partitions.map((p) => ({ partition: p.partition, timestamp: LATEST })) }]);
      out[name] = [];
      for (const lp of latest[0].partitions) {
        const f = await fetchRecords(client, name, lp.partition, Math.max(0, lp.offset - BACK), MAX_BYTES);
        out[name].push({ partition: lp.partition, latest: lp.offset, ...describe(f.records) });
      }
      console.log(name, JSON.stringify(out[name], null, 1).slice(0, 2600));
    }
  } finally {
    client.close();
  }
  const file = join(data, 'samples.json');
  writeJson(file, out);
  console.log('wrote', file);
  return 0;
}

if (isMain(import.meta.url)) await run('kafka-sample', main);
