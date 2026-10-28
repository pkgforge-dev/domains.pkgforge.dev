// scripts/measure/kafka-record.mjs — record real broker responses, byte for
// byte, as the fixtures the offline tests of the Kafka scripts decode
// (scripts/measure/fixtures/kafka/). Read-only against the broker.
//
// Each response is written whole as it came off the socket: the 4-byte size,
// the correlation id and the body. recorded.json names each file with the
// request that produced it, its size and its sha256, and the time and command
// of the recording.
//
// Usage: node scripts/measure/kafka-record.mjs [--data DIR] [--host H] [--port P]
// The files land in DIR (default .tmp/measure/DOM-004); to refresh the
// committed fixtures pass --data scripts/measure/fixtures/kafka.
// Exit codes: 0 recorded, 1 the broker could not be reached or answered with an
// error, 2 bad arguments.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { API, apiVersionsBody, EARLIEST, fetchBody, int32, KafkaError, LATEST, listOffsetsBody, metadataBody, parseFetch, Reader, splitBatches } from './kafka-protocol.mjs';
import { KafkaClient } from './kafka-client.mjs';
import { commonArgs, isMain, run, writeFileAtomic, writeJson } from './kafka-cli.mjs';

// What is recorded: a certstream_domains Fetch small enough to hold one or two
// batches and the start of the next, and the same for one NRD topic.
export const FETCHES = [
  { file: 'fetch-v4-certstream_domains.bin', topic: 'certstream_domains', back: 5000, maxBytes: 24 << 10 },
  { file: 'fetch-v4-newly_registered_domain.bin', topic: 'newly_registered_domain', back: 2000, maxBytes: 16 << 10 },
];

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

async function main(argv) {
  const { host, port, data } = commonArgs(argv);
  const client = await KafkaClient.connect({ host, port });
  const files = {};
  const keep = (file, request, raw) => {
    const bytes = Buffer.concat([int32(raw.length), raw]);
    writeFileAtomic(join(data, file), bytes);
    files[file] = { request, bytes: bytes.length, sha256: sha256(bytes) };
    console.log('recorded', file, bytes.length, 'bytes');
  };
  try {
    keep('api-versions-v0.bin', { api: 'ApiVersions', version: 0 }, (await client.request(API.API_VERSIONS, apiVersionsBody(), 'ApiVersions v0')).raw);
    const topics = FETCHES.map((f) => f.topic);
    keep('metadata-v0.bin', { api: 'Metadata', version: 0, topics }, (await client.request(API.METADATA, metadataBody(topics), 'Metadata v0')).raw);
    const lo = topics.map((topic) => ({ topic, partitions: [{ partition: 0, timestamp: LATEST }] }));
    const loRes = await client.request(API.LIST_OFFSETS, listOffsetsBody(lo), 'ListOffsets v1');
    keep('list-offsets-v1.bin', { api: 'ListOffsets', version: 1, topics: lo }, loRes.raw);
    const latest = await client.listOffsets(lo);
    const earliest = await client.listOffsets(lo.map((t) => ({ topic: t.topic, partitions: [{ partition: 0, timestamp: EARLIEST }] })));
    const offsetOf = (res, topic) => res.find((t) => t.topic === topic).partitions[0].offset;
    for (const f of FETCHES) {
      const offset = Math.max(offsetOf(earliest, f.topic), offsetOf(latest, f.topic) - f.back);
      const req = { topics: [{ topic: f.topic, partitions: [{ partition: 0, offset, maxBytes: f.maxBytes }] }], maxWaitMs: 100, minBytes: 1, maxBytes: f.maxBytes };
      const { raw } = await client.request(API.FETCH, fetchBody(req), 'Fetch v4');
      // A fixture is a real answer with data in it, or nothing is written.
      const p = parseFetch(new Reader(raw.subarray(4), f.file)).topics[0]?.partitions[0];
      if (!p || p.errorCode !== 0) throw new KafkaError(p?.errorCode ?? -1, `Fetch ${f.topic} at offset ${offset}`);
      if (splitBatches(p.records ?? Buffer.alloc(0)).batches.length === 0) throw new Error(`Fetch ${f.topic} at offset ${offset} returned no whole batch`);
      keep(f.file, { api: 'Fetch', version: 4, ...req }, raw);
    }
  } finally {
    client.close();
  }
  writeJson(join(data, 'recorded.json'), { recorded_at: new Date().toISOString(), host, port, command: ['node', 'scripts/measure/kafka-record.mjs', ...argv].join(' '), files });
  return 0;
}

if (isMain(import.meta.url)) await run('kafka-record', main);
