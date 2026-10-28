// scripts/measure/fixtures/kafka/broker.mjs — a fake Kafka broker on
// 127.0.0.1 for the offline tests of the Kafka scripts. It answers ApiVersions
// v0, Metadata v0, ListOffsets v1 and Fetch v4 from an in-memory log of real
// magic-2 batches (build.mjs), and injects the faults the real broker will not
// produce on demand: a corrupt batch, a wrong correlation id, a request left
// unanswered, a broker error code, a response written a few bytes at a time.
//
// Like the real broker, a Fetch returns whole batches from the first one that
// holds the offset, cut at the size limit (so it can end in a partial batch),
// and always at least one whole batch however large.
import { execFile } from 'node:child_process';
import net from 'node:net';
import { setImmediate as tick } from 'node:timers/promises';
import { ROOT } from '../../../files.mjs';
import { FrameReader } from '../../kafka-client.mjs';
import { Reader } from '../../kafka-protocol.mjs';
import { apiVersionsResponse, buildBatch, fetchResponse, frame, listOffsetsResponse, metadataResponse } from './build.mjs';

export const APIS = [
  { key: 1, min: 0, max: 16 },
  { key: 2, min: 0, max: 8 },
  { key: 3, min: 0, max: 12 },
  { key: 18, min: 0, max: 4 },
];

// One partition's log: records [{timestamp, value}] at offsets baseOffset and
// up, perBatch to a batch. corrupt lists base offsets whose batch gets its last
// byte flipped after the CRC-32C is computed.
export function makePartition({ baseOffset = 0, records, perBatch = 10, codec = 'snappy', xerialChunk = 0, corrupt = [] }) {
  const batches = [];
  for (let i = 0; i < records.length; i += perBatch) {
    const recs = records.slice(i, i + perBatch);
    const bytes = buildBatch({ baseOffset: baseOffset + i, records: recs, codec, xerialChunk });
    if (corrupt.includes(baseOffset + i)) bytes[bytes.length - 1] ^= 0xff;
    batches.push({ baseOffset: baseOffset + i, lastOffset: baseOffset + i + recs.length - 1, timestamps: recs.map((r) => r.timestamp), bytes });
  }
  return { batches, earliest: baseOffset, hwm: baseOffset + records.length };
}

// The offset ListOffsets v1 answers for a timestamp, as the real broker does:
// -2 the earliest, -1 the high watermark, else the first record at or after it,
// or -1 when there is none.
export function offsetFor(part, ts) {
  if (ts === -2) return { timestamp: -1, offset: part.earliest };
  if (ts === -1) return { timestamp: -1, offset: part.hwm };
  for (const b of part.batches) for (let k = 0; k < b.timestamps.length; k++) if (b.timestamps[k] >= ts) return { timestamp: b.timestamps[k], offset: b.baseOffset + k };
  return { timestamp: -1, offset: -1 };
}

function fetchPart(part, offset, maxBytes) {
  if (offset < part.earliest || offset > part.hwm) return { errorCode: 1, highWatermark: part.hwm, records: Buffer.alloc(0) };
  const idx = part.batches.findIndex((b) => b.lastOffset >= offset);
  if (idx === -1) return { highWatermark: part.hwm, records: Buffer.alloc(0) };
  const take = [];
  let total = 0;
  for (let i = idx; i < part.batches.length && total <= maxBytes; i++) {
    take.push(part.batches[i].bytes);
    total += part.batches[i].bytes.length;
  }
  const blob = Buffer.concat(take);
  return { highWatermark: part.hwm, records: blob.subarray(0, Math.max(take[0].length, Math.min(maxBytes, blob.length))) };
}

export class FakeBroker {
  // topics: {name: [partition, ...]} from makePartition. Faults: chunkSize
  // (write responses this many bytes at a time), wrongCorrelation, silentApi
  // (an API key never answered), fetchError {topic, partition, code},
  // emptyFetch (every Fetch answers no record below a high watermark it reports).
  constructor(topics, faults = {}) {
    this.topics = topics;
    this.faults = faults;
    this.requests = [];
    this.sockets = new Set();
    this.server = null;
    this.port = null;
  }

  async start() {
    this.server = net.createServer((sock) => this.serve(sock));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = this.server.address().port;
    return this.port;
  }

  serve(sock) {
    this.sockets.add(sock);
    let queue = Promise.resolve();
    const frames = new FrameReader((req) => {
      const out = this.handle(req);
      if (out) queue = queue.then(() => this.write(sock, out));
    });
    sock.on('data', (chunk) => frames.push(chunk));
    // A client that goes away mid-response is the tests' own doing.
    sock.on('error', () => {});
    sock.on('close', () => this.sockets.delete(sock));
  }

  async write(sock, bytes) {
    const n = this.faults.chunkSize ?? 0;
    if (n <= 0) {
      sock.write(bytes);
      return;
    }
    for (let p = 0; p < bytes.length && !sock.destroyed; p += n) {
      sock.write(bytes.subarray(p, p + n));
      await tick();
    }
  }

  handle(req) {
    const r = new Reader(req, 'request');
    const apiKey = r.int16();
    const apiVersion = r.int16();
    const corr = r.int32();
    const clientId = r.string();
    this.requests.push({ apiKey, apiVersion, clientId });
    if (apiKey === this.faults.silentApi) return null;
    const id = this.faults.wrongCorrelation ? corr + 1000 : corr;
    if (apiKey === 18) return frame(id, apiVersionsResponse(this.faults.apis ?? APIS));
    if (apiKey === 3) {
      const asked = r.array((x) => x.string());
      const names = asked.length === 0 ? Object.keys(this.topics) : asked;
      const topics = names.map((name) => (this.topics[name] ? { name, partitions: this.topics[name].map((_, i) => ({ partition: i })) } : { name, errorCode: 3, partitions: [] }));
      return frame(id, metadataResponse([{ id: 1, host: '127.0.0.1', port: this.port }], topics));
    }
    if (apiKey === 2) {
      r.int32();
      const topics = r.array((x) => ({ topic: x.string(), partitions: x.array((y) => ({ partition: y.int32(), timestamp: y.int64() })) }));
      return frame(
        id,
        listOffsetsResponse(
          topics.map((t) => ({
            topic: t.topic,
            partitions: t.partitions.map((p) => {
              const part = this.topics[t.topic]?.[p.partition];
              return part ? { partition: p.partition, ...offsetFor(part, p.timestamp) } : { partition: p.partition, errorCode: 3, timestamp: -1, offset: -1 };
            }),
          })),
        ),
      );
    }
    if (apiKey === 1) {
      r.int32();
      r.int32();
      r.int32();
      r.int32();
      r.int8();
      const topics = r.array((x) => ({ topic: x.string(), partitions: x.array((y) => ({ partition: y.int32(), offset: y.int64(), maxBytes: y.int32() })) }));
      const fe = this.faults.fetchError;
      return frame(
        id,
        fetchResponse(
          topics.map((t) => ({
            topic: t.topic,
            partitions: t.partitions.map((p) => {
              const part = this.topics[t.topic]?.[p.partition];
              if (fe && fe.topic === t.topic && fe.partition === p.partition) return { partition: p.partition, errorCode: fe.code, highWatermark: part?.hwm ?? -1, records: Buffer.alloc(0) };
              if (!part) return { partition: p.partition, errorCode: 3, highWatermark: -1, records: Buffer.alloc(0) };
              if (this.faults.emptyFetch) return { partition: p.partition, highWatermark: part.hwm, records: Buffer.alloc(0) };
              return { partition: p.partition, ...fetchPart(part, p.offset, p.maxBytes) };
            }),
          })),
        ),
      );
    }
    throw new Error(`fake broker: no API ${apiKey}`);
  }

  stop() {
    for (const s of this.sockets) s.destroy();
    return new Promise((resolve) => this.server.close(resolve));
  }
}

// A port nothing listens on: bound, then released.
export async function closedPort() {
  const s = net.createServer();
  await new Promise((resolve) => s.listen(0, '127.0.0.1', resolve));
  const { port } = s.address();
  await new Promise((resolve) => s.close(resolve));
  return port;
}

const MINUTE = 60e3;
const HOUR = 60 * MINUTE;

// A certstream_domains message shaped like the real one.
export const certValue = (i, ts) =>
  JSON.stringify({
    certIndex: i,
    domain_list: [`h${i}.example.com`, `*.w${i % 50}.example.org`],
    fingerprint: `F${i % 1000}`,
    seen: Math.floor(ts / 1000),
    sld_list: ['example.com', 'example.org'],
    source: i % 3 === 0 ? 'Log A' : 'Log B',
    updateType: 'PrecertLogEntry',
  });

// A log shaped like the Zonestream broker's, relative to nowMs:
// certstream_domains (snappy in xerial blocks, a message every 30 s for 26 h,
// at the real topic's offset magnitude), the three NRD topics (uncompressed,
// one message a batch, every 10 min for 12 days), a 4-partition topic and two
// small certificate topics.
export function zonestreamLike(nowMs, { corruptCertstream = [] } = {}) {
  const series = (from, step, n, value) => Array.from({ length: n }, (_, i) => ({ timestamp: from + i * step, value: value(i, from + i * step) }));
  const cs = series(nowMs - 26 * HOUR, 30e3, 26 * 120, certValue);
  const nrd = (name) => series(nowMs - 12 * 24 * HOUR, 10 * MINUTE, 12 * 144, (i) => JSON.stringify({ domain: `n${i}.${name}.test.`, ct_name: 'Log A', timestamp: i }));
  const small = (n) => series(nowMs - 2 * HOUR, MINUTE, n, (i) => JSON.stringify({ i }));
  return {
    certstream_domains: [makePartition({ baseOffset: 42_000_000_000, records: cs, perBatch: 20, xerialChunk: 2048, corrupt: corruptCertstream })],
    newly_registered_domain: [makePartition({ baseOffset: 166_000_000, records: nrd('nrd'), perBatch: 1, codec: 'none' })],
    newly_registered_fqdn: [makePartition({ baseOffset: 177_000_000, records: nrd('fqdn'), perBatch: 1, codec: 'none' })],
    confirmed_newly_registered_domain: [makePartition({ baseOffset: 77_000_000, records: nrd('confirmed'), perBatch: 1, codec: 'none' })],
    newly_registered_fqdn_measurements: [0, 1, 2, 3].map((p) => makePartition({ baseOffset: p * 1000, records: small(30), perBatch: 5, codec: 'zstd' })),
    newly_issued_certificates_measurements: [makePartition({ records: small(60), perBatch: 10, codec: 'gzip' })],
    certstream: [makePartition({ records: small(20), perBatch: 5 })],
  };
}

// Runs a script under node from the repository root. Resolves with the exit
// code and both streams, whatever the code.
export function runCli(script, args, env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [script, ...args], { cwd: ROOT, env: { ...process.env, ...env }, maxBuffer: 64 << 20 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout, stderr });
    });
  });
}
