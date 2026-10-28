// scripts/measure/fixtures/kafka/build.mjs — builders for the offline tests of
// the Kafka scripts: a snappy compressor, the xerial framing, magic-2 record
// batches with a real CRC-32C, and response frames.
//
// The compressor is the test's own and is independent of snappy.mjs: it is a
// greedy matcher that emits every literal length form and every copy type, so
// decode(compress(x)) === x checks the decoder against a second implementation.
// The recorded responses beside this file check it against the real producer.
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { array, crc32c, int8, int16, int32, int64, string } from '../../kafka-protocol.mjs';

// A Kafka varint: zigzag, then 7 bits a byte, least significant first.
export function varint(n) {
  let v = n >= 0 ? n * 2 : -n * 2 - 1;
  const out = [];
  while (v >= 0x80) {
    out.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  out.push(v);
  return Buffer.from(out);
}

function uvarint(n) {
  const out = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b |= 0x80;
    out.push(b);
  } while (v > 0);
  return Buffer.from(out);
}

// A raw snappy block. maxLiteral splits literals; copy4 writes every copy with
// a 4-byte offset. Matches are of 4 bytes or more.
export function snappyCompress(input, { maxLiteral = Number.POSITIVE_INFINITY, copy4 = false } = {}) {
  const src = Buffer.from(input);
  const out = [uvarint(src.length)];
  const literal = (from, to) => {
    for (let p = from; p < to; ) {
      const bytes = src.subarray(p, Math.min(to, p + maxLiteral));
      const l = bytes.length - 1;
      if (l < 60) out.push(Buffer.from([l << 2]));
      else if (l < 0x100) out.push(Buffer.from([60 << 2, l]));
      else if (l < 0x10000) out.push(Buffer.from([61 << 2, l & 0xff, l >> 8]));
      else if (l < 0x1000000) out.push(Buffer.from([62 << 2, l & 0xff, (l >> 8) & 0xff, l >> 16]));
      else out.push(Buffer.from([63 << 2, l & 0xff, (l >> 8) & 0xff, (l >> 16) & 0xff, (l >>> 24) & 0xff]));
      out.push(bytes);
      p += bytes.length;
    }
  };
  const copy = (offset, length) => {
    for (let left = length; left > 0; ) {
      const l = Math.min(left, 64);
      if (!copy4 && l >= 4 && l <= 11 && offset < 2048) out.push(Buffer.from([1 | ((l - 4) << 2) | ((offset >> 8) << 5), offset & 0xff]));
      else if (!copy4 && offset < 0x10000) out.push(Buffer.from([2 | ((l - 1) << 2), offset & 0xff, offset >> 8]));
      else out.push(Buffer.from([3 | ((l - 1) << 2), offset & 0xff, (offset >> 8) & 0xff, (offset >> 16) & 0xff, (offset >>> 24) & 0xff]));
      left -= l;
    }
  };
  const seen = new Map();
  let lit = 0;
  let i = 0;
  while (i + 4 <= src.length) {
    const key = src.readUInt32LE(i);
    const cand = seen.get(key);
    seen.set(key, i);
    if (cand === undefined || (!copy4 && i - cand >= 0x10000)) {
      i += 1;
      continue;
    }
    let len = 4;
    while (i + len < src.length && src[cand + len] === src[i + len]) len += 1;
    literal(lit, i);
    copy(i - cand, len);
    i += len;
    lit = i;
  }
  literal(lit, src.length);
  return Buffer.concat(out);
}

// The xerial stream of raw blocks: the 16-byte header, then each block with its int32 length.
export function xerial(blocks) {
  const header = Buffer.from([0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00, 0, 0, 0, 1, 0, 0, 0, 1]);
  return Buffer.concat([header, ...blocks.flatMap((b) => [int32(b.length), b])]);
}

const CODEC = { none: 0, gzip: 1, snappy: 2, lz4: 3, zstd: 4 };

function compress(codec, bytes, xerialChunk) {
  if (codec === 'none' || codec === 'lz4') return bytes;
  if (codec === 'gzip') return gzipSync(bytes);
  if (codec === 'zstd') return zstdCompressSync(bytes);
  if (codec === 'snappy') {
    if (!xerialChunk) return snappyCompress(bytes);
    const blocks = [];
    for (let p = 0; p < bytes.length; p += xerialChunk) blocks.push(snappyCompress(bytes.subarray(p, p + xerialChunk)));
    return xerial(blocks);
  }
  throw new Error(`build: no codec ${codec}`);
}

const asBytes = (v) => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v : Buffer.from(v));
const sized = (b) => (b === null ? varint(-1) : Buffer.concat([varint(b.length), b]));

// One record of a magic-2 batch.
export function buildRecord({ offsetDelta, timestampDelta, key = null, value, headers = [] }) {
  const body = Buffer.concat([
    int8(0),
    varint(timestampDelta),
    varint(offsetDelta),
    sized(asBytes(key)),
    sized(asBytes(value)),
    varint(headers.length),
    ...headers.map(([k, v]) => Buffer.concat([sized(asBytes(k)), sized(asBytes(v))])),
  ]);
  return Buffer.concat([varint(body.length), body]);
}

// A magic-2 batch of records [{timestamp, value, key?, headers?}], offsets
// baseOffset and up, with its CRC-32C. control marks a control batch;
// xerialChunk writes snappy as a xerial stream of blocks of that size.
export function buildBatch({ baseOffset, records, codec = 'snappy', control = false, logAppendTime = false, xerialChunk = 0 }) {
  const baseTimestamp = records[0].timestamp;
  const maxTimestamp = Math.max(...records.map((r) => r.timestamp));
  const recBytes = Buffer.concat(records.map((r, i) => buildRecord({ offsetDelta: i, timestampDelta: r.timestamp - baseTimestamp, key: r.key ?? null, value: r.value, headers: r.headers ?? [] })));
  const attributes = CODEC[codec] | (logAppendTime ? 8 : 0) | (control ? 0x20 : 0);
  const afterCrc = Buffer.concat([
    int16(attributes),
    int32(records.length - 1),
    int64(baseTimestamp),
    int64(maxTimestamp),
    int64(-1),
    int16(-1),
    int32(-1),
    int32(records.length),
    compress(codec, recBytes, xerialChunk),
  ]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32c(afterCrc));
  const afterLength = Buffer.concat([int32(0), int8(2), crc, afterCrc]);
  return Buffer.concat([int64(baseOffset), int32(afterLength.length), afterLength]);
}

// A response frame as it comes off the socket.
export const frame = (correlationId, body) => Buffer.concat([int32(body.length + 4), int32(correlationId), body]);

export const apiVersionsResponse = (apis, errorCode = 0) => Buffer.concat([int16(errorCode), array(apis, (a) => Buffer.concat([int16(a.key), int16(a.min), int16(a.max)]))]);

export function metadataResponse(brokers, topics) {
  const partition = (p) => Buffer.concat([int16(p.errorCode ?? 0), int32(p.partition), int32(p.leader ?? 1), array([p.leader ?? 1], int32), array([p.leader ?? 1], int32)]);
  return Buffer.concat([
    array(brokers, (b) => Buffer.concat([int32(b.id), string(b.host), int32(b.port)])),
    array(topics, (t) => Buffer.concat([int16(t.errorCode ?? 0), string(t.name), array(t.partitions, partition)])),
  ]);
}

export const listOffsetsResponse = (topics) =>
  array(topics, (t) => Buffer.concat([string(t.topic), array(t.partitions, (p) => Buffer.concat([int32(p.partition), int16(p.errorCode ?? 0), int64(p.timestamp), int64(p.offset)]))]));

export function fetchResponse(topics, throttleMs = 0) {
  const partition = (p) => {
    const records = p.records ?? null;
    return Buffer.concat([
      int32(p.partition),
      int16(p.errorCode ?? 0),
      int64(p.highWatermark),
      int64(p.highWatermark),
      int32(-1),
      records === null ? int32(-1) : Buffer.concat([int32(records.length), records]),
    ]);
  };
  return Buffer.concat([int32(throttleMs), array(topics, (t) => Buffer.concat([string(t.topic), array(t.partitions, partition)]))]);
}
