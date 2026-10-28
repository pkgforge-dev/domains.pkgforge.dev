// scripts/measure/kafka-protocol.mjs — the bytes of the four Kafka requests the
// measurement needs, the parse of their responses, and the decode of a record
// batch (magic 2). Pure: no socket, no clock. kafka-client.mjs carries the IO.
//
// The versions are the ones both designs used against the Zonestream broker:
// ApiVersions v0, Metadata v0, ListOffsets v1 and Fetch v4 (design A section 3.1,
// design B section 2.4). Fetch v4 returns the record batches as the broker
// stores them, so the bytes counted as wire_bytes are the bytes the raw lane
// keeps (docs/architecture.md section 3.4). Fetch v0, which design A's scripts
// used, makes the broker convert each batch to the old message format first.
//
// Every read is bounds-checked and every response must be consumed exactly: a
// short or long response is a ProtocolError, never a guess. A batch whose CRC-32C,
// compression or record count does not check is a KafkaDecodeError with a kind,
// so a caller counts it as a decode failure instead of losing it.
//
// Usage: import { ... } from './kafka-protocol.mjs'
// It is a module; it has no command line and no exit code.
import { gunzipSync, zstdDecompressSync } from 'node:zlib';
import { SnappyError, snappyKafka } from './snappy.mjs';

export const API = { FETCH: 1, LIST_OFFSETS: 2, METADATA: 3, API_VERSIONS: 18 };
// The version this module speaks for each API.
export const VERSION = { [API.FETCH]: 4, [API.LIST_OFFSETS]: 1, [API.METADATA]: 0, [API.API_VERSIONS]: 0 };
// ListOffsets sentinels: the earliest retained offset and the next offset to be written.
export const EARLIEST = -2;
export const LATEST = -1;

export const CODECS = ['none', 'gzip', 'snappy', 'lz4', 'zstd'];
export const codecName = (n) => CODECS[n] ?? `codec-${n}`;

// The broker error codes this measurement can meet, by number.
const ERROR_NAMES = {
  1: 'OFFSET_OUT_OF_RANGE',
  2: 'CORRUPT_MESSAGE',
  3: 'UNKNOWN_TOPIC_OR_PARTITION',
  5: 'LEADER_NOT_AVAILABLE',
  6: 'NOT_LEADER_OR_FOLLOWER',
  7: 'REQUEST_TIMED_OUT',
  29: 'TOPIC_AUTHORIZATION_FAILED',
  35: 'UNSUPPORTED_VERSION',
};
export const errorName = (code) => ERROR_NAMES[code] ?? `ERROR_${code}`;

export class ProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// A broker answered with a non-zero error code.
export class KafkaError extends Error {
  constructor(code, where) {
    super(`${where}: broker error ${code} ${errorName(code)}`);
    this.name = 'KafkaError';
    this.code = code;
  }
}

// A record batch that did not decode. kind is one of: truncated, magic, crc,
// gzip, snappy, zstd, codec (a codec this module cannot decode), records.
export class KafkaDecodeError extends Error {
  constructor(kind, message) {
    super(`${kind}: ${message}`);
    this.name = 'KafkaDecodeError';
    this.kind = kind;
  }
}

// ---- encoding --------------------------------------------------------------

export const int8 = (n) => Buffer.from([n & 0xff]);
export function int16(n) {
  const b = Buffer.alloc(2);
  b.writeInt16BE(n);
  return b;
}
export function int32(n) {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n);
  return b;
}
export function int64(n) {
  const b = Buffer.alloc(8);
  b.writeBigInt64BE(BigInt(n));
  return b;
}
// A nullable string: an int16 length (-1 for null) and UTF-8 bytes.
export function string(s) {
  if (s === null) return int16(-1);
  const b = Buffer.from(s, 'utf8');
  return Buffer.concat([int16(b.length), b]);
}
export const array = (items, encode) => Buffer.concat([int32(items.length), ...items.map(encode)]);

// One request, with its 4-byte size prefix and request header v1.
export function encodeRequest({ apiKey, apiVersion, correlationId, clientId, body }) {
  const payload = Buffer.concat([int16(apiKey), int16(apiVersion), int32(correlationId), string(clientId), body]);
  return Buffer.concat([int32(payload.length), payload]);
}

export const apiVersionsBody = () => Buffer.alloc(0);

// Metadata v0: an empty topic list asks for every topic.
export const metadataBody = (topics = []) => array(topics, string);

// ListOffsets v1: [{topic, partitions: [{partition, timestamp}]}], as a consumer (replica -1).
export function listOffsetsBody(topics) {
  return Buffer.concat([int32(-1), array(topics, (t) => Buffer.concat([string(t.topic), array(t.partitions, (p) => Buffer.concat([int32(p.partition), int64(p.timestamp)]))]))]);
}

// Fetch v4: [{topic, partitions: [{partition, offset, maxBytes}]}], read uncommitted
// (isolation 0), as a consumer (replica -1).
export function fetchBody({ topics, maxWaitMs, minBytes, maxBytes }) {
  const partition = (p) => Buffer.concat([int32(p.partition), int64(p.offset), int32(p.maxBytes)]);
  return Buffer.concat([int32(-1), int32(maxWaitMs), int32(minBytes), int32(maxBytes), int8(0), array(topics, (t) => Buffer.concat([string(t.topic), array(t.partitions, partition)]))]);
}

// ---- decoding --------------------------------------------------------------

// A bounds-checked reader over one response or one decompressed batch. Every
// method throws ProtocolError (or the error class passed in) past the end.
export class Reader {
  constructor(buf, what, ErrorClass = ProtocolError) {
    this.buf = buf;
    this.pos = 0;
    this.what = what;
    this.ErrorClass = ErrorClass;
  }
  fail(message) {
    return this.ErrorClass === KafkaDecodeError ? new KafkaDecodeError('records', `${this.what}: ${message}`) : new this.ErrorClass(`${this.what}: ${message}`);
  }
  need(n) {
    if (n < 0 || this.pos + n > this.buf.length) throw this.fail(`needs ${n} byte(s) at ${this.pos}, has ${this.buf.length - this.pos}`);
  }
  remaining() {
    return this.buf.length - this.pos;
  }
  int8() {
    this.need(1);
    return this.buf.readInt8(this.pos++);
  }
  int16() {
    this.need(2);
    const v = this.buf.readInt16BE(this.pos);
    this.pos += 2;
    return v;
  }
  int32() {
    this.need(4);
    const v = this.buf.readInt32BE(this.pos);
    this.pos += 4;
    return v;
  }
  // An int64 as a Number; one past 2^53 is refused rather than rounded.
  int64() {
    this.need(8);
    const v = this.buf.readBigInt64BE(this.pos);
    this.pos += 8;
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw this.fail(`int64 ${v} is outside the safe integer range`);
    return n;
  }
  string() {
    const n = this.int16();
    if (n === -1) return null;
    this.need(n);
    const v = this.buf.toString('utf8', this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  bytes() {
    const n = this.int32();
    if (n === -1) return null;
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }
  // An array: an int32 count (-1 for null), each element read by fn. A count
  // larger than the bytes left cannot be honest, since every element has one.
  array(fn) {
    const n = this.int32();
    if (n === -1) return null;
    if (n < 0 || n > this.remaining()) throw this.fail(`array count ${n} with ${this.remaining()} byte(s) left`);
    const out = [];
    for (let i = 0; i < n; i++) out.push(fn(this));
    return out;
  }
  // A zigzag varint of at most maxBytes bytes (5 for a varint, 10 for a varlong),
  // as a Number; one past 2^53 is refused.
  varint(maxBytes = 5) {
    let v = 0;
    for (let i = 0, shift = 0; ; i++, shift += 7) {
      if (i >= maxBytes) throw this.fail(`varint longer than ${maxBytes} bytes`);
      this.need(1);
      const b = this.buf[this.pos++];
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
    }
    if (!Number.isSafeInteger(v)) throw this.fail(`varint ${v} is outside the safe integer range`);
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }
  varlong() {
    return this.varint(10);
  }
  // The response must end here.
  end() {
    if (this.pos !== this.buf.length) throw this.fail(`${this.buf.length - this.pos} trailing byte(s)`);
  }
}

// ApiVersions v0: Map apiKey -> {min, max}. Error 35 still carries the list.
export function parseApiVersions(r) {
  const errorCode = r.int16();
  const apis = new Map();
  for (const a of r.array((x) => ({ key: x.int16(), min: x.int16(), max: x.int16() })) ?? []) apis.set(a.key, { min: a.min, max: a.max });
  r.end();
  return { errorCode, apis };
}

// Metadata v0: {brokers: [{id, host, port}], topics: [{name, errorCode, partitions: [{partition, errorCode, leader}]}]}.
export function parseMetadata(r) {
  const brokers = r.array((x) => ({ id: x.int32(), host: x.string(), port: x.int32() })) ?? [];
  const topics =
    r.array((x) => {
      const errorCode = x.int16();
      const name = x.string();
      const partitions =
        x.array((y) => {
          const p = { errorCode: y.int16(), partition: y.int32(), leader: y.int32() };
          y.array((z) => z.int32());
          y.array((z) => z.int32());
          return p;
        }) ?? [];
      return { name, errorCode, partitions };
    }) ?? [];
  r.end();
  return { brokers, topics };
}

// ListOffsets v1: [{topic, partitions: [{partition, errorCode, timestamp, offset}]}].
// An offset of -1 for a timestamp query means no message at or after it.
export function parseListOffsets(r) {
  const topics =
    r.array((x) => ({
      topic: x.string(),
      partitions: x.array((y) => ({ partition: y.int32(), errorCode: y.int16(), timestamp: y.int64(), offset: y.int64() })) ?? [],
    })) ?? [];
  r.end();
  return topics;
}

// Fetch v4: {throttleMs, topics: [{topic, partitions: [{partition, errorCode,
// highWatermark, lastStableOffset, abortedTransactions, records}]}]}. records is
// the raw bytes of the batches, which may end in one partial batch.
export function parseFetch(r) {
  const throttleMs = r.int32();
  const topics =
    r.array((x) => ({
      topic: x.string(),
      partitions:
        x.array((y) => ({
          partition: y.int32(),
          errorCode: y.int16(),
          highWatermark: y.int64(),
          lastStableOffset: y.int64(),
          abortedTransactions: y.array((z) => ({ producerId: z.int64(), firstOffset: z.int64() })),
          records: y.bytes(),
        })) ?? [],
    })) ?? [];
  r.end();
  return { throttleMs, topics };
}

// ---- record batches ----------------------------------------------------------

// The offsets inside a magic-2 batch header.
const B = { length: 8, magic: 16, crc: 17, attributes: 21, lastOffsetDelta: 23, baseTimestamp: 27, maxTimestamp: 35, recordCount: 57, records: 61 };
export const BATCH_HEADER = B.records;

const CRC32C_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0x82f63b78 : c >>> 1;
    t[i] = c >>> 0;
  }
  return t;
})();

// CRC-32C (Castagnoli), the checksum of a magic-2 batch, over buf[start, end).
export function crc32c(buf, start = 0, end = buf.length) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC32C_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Splits a fetch's records bytes into whole batches, reading each header
// without decompressing it. A batch the response cut short (the broker stops
// at the size limit) is left in `partial`, as a byte count. Old-format message
// sets (magic 0 or 1) are returned with magic set, for the caller to refuse.
export function splitBatches(records) {
  const batches = [];
  let pos = 0;
  while (records.length - pos >= 17) {
    const batchLength = records.readInt32BE(pos + B.length);
    if (batchLength < 5) throw new ProtocolError(`records: a batch at byte ${pos} declares length ${batchLength}`);
    const size = 12 + batchLength;
    if (pos + size > records.length) break;
    const bytes = records.subarray(pos, pos + size);
    const baseOffset = Number(bytes.readBigInt64BE(0));
    const magic = bytes.readInt8(B.magic);
    const batch = { baseOffset, lastOffset: baseOffset, size, magic, bytes, codec: null, recordCount: null, firstTimestamp: null, isControl: false };
    if (magic === 2 && size >= BATCH_HEADER) {
      const attributes = bytes.readInt16BE(B.attributes);
      batch.lastOffset = baseOffset + bytes.readInt32BE(B.lastOffsetDelta);
      batch.codec = codecName(attributes & 7);
      batch.recordCount = bytes.readInt32BE(B.recordCount);
      batch.isControl = (attributes & 0x20) !== 0;
      batch.firstTimestamp = Number(bytes.readBigInt64BE(attributes & 8 ? B.maxTimestamp : B.baseTimestamp));
    }
    batches.push(batch);
    pos += size;
  }
  return { batches, partial: records.length - pos };
}

function decompress(codec, payload) {
  try {
    if (codec === 0) return payload;
    if (codec === 1) return gunzipSync(payload);
    if (codec === 2) {
      const out = snappyKafka(payload);
      return Buffer.from(out.buffer, out.byteOffset, out.length);
    }
    if (codec === 4) return zstdDecompressSync(payload);
  } catch (e) {
    const kind = codecName(codec);
    throw new KafkaDecodeError(kind, e instanceof SnappyError ? e.message : `${kind} decompression failed: ${e.message}`);
  }
  throw new KafkaDecodeError('codec', `compression ${codecName(codec)} is not decoded by this reader`);
}

function readRecord(r, base) {
  const length = r.varint();
  const start = r.pos;
  r.need(length);
  r.int8();
  const timestampDelta = r.varlong();
  const offsetDelta = r.varint();
  const keyLength = r.varint();
  const key = keyLength < 0 ? null : r.buf.subarray(r.pos, r.pos + keyLength);
  if (keyLength > 0) {
    r.need(keyLength);
    r.pos += keyLength;
  }
  const valueLength = r.varint();
  if (valueLength > 0) r.need(valueLength);
  const value = valueLength < 0 ? null : r.buf.subarray(r.pos, r.pos + valueLength);
  if (valueLength > 0) r.pos += valueLength;
  const headerCount = r.varint();
  for (let i = 0; i < headerCount; i++) {
    const hk = r.varint();
    r.need(Math.max(0, hk));
    r.pos += Math.max(0, hk);
    const hv = r.varint();
    r.need(Math.max(0, hv));
    r.pos += Math.max(0, hv);
  }
  if (r.pos - start !== length) throw r.fail(`a record declares ${length} byte(s) and holds ${r.pos - start}`);
  return {
    offset: base.baseOffset + offsetDelta,
    timestamp: base.logAppendTime ? base.maxTimestamp : base.baseTimestamp + timestampDelta,
    key,
    value,
  };
}

// Decodes one magic-2 batch: checks its CRC-32C, decompresses it, and parses
// exactly the records its header declares. Throws KafkaDecodeError on any failure.
export function decodeBatch(bytes) {
  if (bytes.length < BATCH_HEADER) throw new KafkaDecodeError('truncated', `a batch of ${bytes.length} byte(s) is shorter than the ${BATCH_HEADER}-byte header`);
  const magic = bytes.readInt8(B.magic);
  if (magic !== 2) throw new KafkaDecodeError('magic', `magic ${magic}; this reader decodes magic 2 only`);
  const declared = bytes.readUInt32BE(B.crc);
  const actual = crc32c(bytes, B.attributes);
  if (declared !== actual) throw new KafkaDecodeError('crc', `CRC-32C ${actual.toString(16)} where the batch declares ${declared.toString(16)}`);
  const attributes = bytes.readInt16BE(B.attributes);
  const codec = attributes & 7;
  const base = {
    baseOffset: Number(bytes.readBigInt64BE(0)),
    baseTimestamp: Number(bytes.readBigInt64BE(B.baseTimestamp)),
    maxTimestamp: Number(bytes.readBigInt64BE(B.maxTimestamp)),
    logAppendTime: (attributes & 8) !== 0,
  };
  const recordCount = bytes.readInt32BE(B.recordCount);
  const decoded = decompress(codec, bytes.subarray(B.records));
  const r = new Reader(decoded, `batch at offset ${base.baseOffset}`, KafkaDecodeError);
  const records = [];
  for (let i = 0; i < recordCount; i++) records.push(readRecord(r, base));
  if (r.remaining() !== 0) throw new KafkaDecodeError('records', `batch at offset ${base.baseOffset}: ${r.remaining()} byte(s) after the ${recordCount} declared record(s)`);
  return {
    baseOffset: base.baseOffset,
    lastOffset: base.baseOffset + bytes.readInt32BE(B.lastOffsetDelta),
    codec: codecName(codec),
    isControl: (attributes & 0x20) !== 0,
    recordCount,
    records,
    decodedBytes: BATCH_HEADER + decoded.length,
  };
}
