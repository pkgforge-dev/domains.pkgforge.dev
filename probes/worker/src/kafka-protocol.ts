// probes/worker/src/kafka-protocol.ts — the bytes of the three Kafka requests the
// probe's /kafka route sends, the parse of their responses, and the decode of a
// record batch (magic 2). Pure: no socket, no clock. src/kafka.ts carries the IO.
//
// A TypeScript port of the part of scripts/measure/kafka-protocol.mjs that the
// route needs (DOM-005), over Uint8Array and DataView instead of Node's Buffer,
// so it runs in workerd without nodejs_compat. The versions are the ones DOM-004
// ran against the Zonestream broker: ApiVersions v0, ListOffsets v1 and Fetch v4.
// Fetch v4 returns the record batches as the broker stores them. Metadata is not
// ported: the route reads one partition that the caller names.
//
// Codecs: none and snappy decode. DOM-004 found certstream_domains snappy in the
// xerial framing and the three NRD topics uncompressed, one record a batch
// (TODO/ingest.md, DOM-004's Corrections). gzip, lz4 and zstd are refused as a
// KafkaDecodeError of kind "codec", counted like any other failed batch: a
// Worker has no synchronous decoder for them.
//
// Every read is bounds-checked and every response must be consumed exactly: a
// short or long response is a ProtocolError, never a guess. A batch whose CRC-32C,
// compression or record count does not check is a KafkaDecodeError with a kind,
// so a caller counts it as a decode failure instead of losing it.
// src/kafka-protocol.test.ts holds the parse and the decode equal to the .mjs.
//
// Usage: import { ... } from "./kafka-protocol.ts"
// It is a module; it has no command line and no exit code.
import { SnappyError, snappyKafka } from "./snappy.ts";

export const API = Object.freeze({ FETCH: 1, LIST_OFFSETS: 2, API_VERSIONS: 18 });
// The version this module speaks for each API.
export const VERSION: Readonly<Record<number, number>> = Object.freeze({ [API.FETCH]: 4, [API.LIST_OFFSETS]: 1, [API.API_VERSIONS]: 0 });
// ListOffsets sentinels: the earliest retained offset and the next offset to be written.
export const EARLIEST = -2;
export const LATEST = -1;

export const CODECS: readonly string[] = Object.freeze(["none", "gzip", "snappy", "lz4", "zstd"]);
export const codecName = (n: number): string => CODECS[n] ?? `codec-${n}`;

// The broker error codes a read can meet, by number.
const ERROR_NAMES: Readonly<Record<number, string>> = Object.freeze({
  1: "OFFSET_OUT_OF_RANGE",
  2: "CORRUPT_MESSAGE",
  3: "UNKNOWN_TOPIC_OR_PARTITION",
  5: "LEADER_NOT_AVAILABLE",
  6: "NOT_LEADER_OR_FOLLOWER",
  7: "REQUEST_TIMED_OUT",
  29: "TOPIC_AUTHORIZATION_FAILED",
  35: "UNSUPPORTED_VERSION",
});
export const errorName = (code: number): string => ERROR_NAMES[code] ?? `ERROR_${code}`;

export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

// A broker answered with a non-zero error code.
export class KafkaError extends Error {
  readonly code: number;
  constructor(code: number, where: string) {
    super(`${where}: broker error ${code} ${errorName(code)}`);
    this.name = "KafkaError";
    this.code = code;
  }
}

// The kinds of a batch that did not decode: truncated, magic, crc, snappy, codec
// (a codec this module cannot decode), records.
export type DecodeKind = "truncated" | "magic" | "crc" | "snappy" | "codec" | "records";

export class KafkaDecodeError extends Error {
  readonly kind: DecodeKind;
  constructor(kind: DecodeKind, message: string) {
    super(`${kind}: ${message}`);
    this.name = "KafkaDecodeError";
    this.kind = kind;
  }
}

// ---- encoding --------------------------------------------------------------

const UTF8 = new TextEncoder();
const UTF8_DECODER = new TextDecoder();

function fixed(size: number, write: (view: DataView) => void): Uint8Array {
  const bytes = new Uint8Array(size);
  write(new DataView(bytes.buffer));
  return bytes;
}

export const int8 = (n: number): Uint8Array => fixed(1, (v) => v.setInt8(0, n));
export const int16 = (n: number): Uint8Array => fixed(2, (v) => v.setInt16(0, n));
export const int32 = (n: number): Uint8Array => fixed(4, (v) => v.setInt32(0, n));
export const int64 = (n: number): Uint8Array => fixed(8, (v) => v.setBigInt64(0, BigInt(n)));

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

// A nullable string: an int16 length (-1 for null) and UTF-8 bytes.
export function string(s: string | null): Uint8Array {
  if (s === null) return int16(-1);
  const b = UTF8.encode(s);
  return concat([int16(b.length), b]);
}

export const array = <T>(items: readonly T[], encode: (item: T) => Uint8Array): Uint8Array => concat([int32(items.length), ...items.map(encode)]);

export interface RequestSpec {
  apiKey: number;
  apiVersion: number;
  correlationId: number;
  clientId: string;
  body: Uint8Array;
}

// One request, with its 4-byte size prefix and request header v1.
export function encodeRequest({ apiKey, apiVersion, correlationId, clientId, body }: RequestSpec): Uint8Array {
  const payload = concat([int16(apiKey), int16(apiVersion), int32(correlationId), string(clientId), body]);
  return concat([int32(payload.length), payload]);
}

export const apiVersionsBody = (): Uint8Array => new Uint8Array(0);

export interface OffsetQuery {
  topic: string;
  partitions: { partition: number; timestamp: number }[];
}

// ListOffsets v1: [{topic, partitions: [{partition, timestamp}]}], as a consumer (replica -1).
export function listOffsetsBody(topics: readonly OffsetQuery[]): Uint8Array {
  return concat([int32(-1), array(topics, (t) => concat([string(t.topic), array(t.partitions, (p) => concat([int32(p.partition), int64(p.timestamp)]))]))]);
}

export interface FetchSpec {
  topics: { topic: string; partitions: { partition: number; offset: number; maxBytes: number }[] }[];
  maxWaitMs: number;
  minBytes: number;
  maxBytes: number;
}

// Fetch v4, read uncommitted (isolation 0), as a consumer (replica -1).
export function fetchBody({ topics, maxWaitMs, minBytes, maxBytes }: FetchSpec): Uint8Array {
  const partition = (p: FetchSpec["topics"][number]["partitions"][number]) => concat([int32(p.partition), int64(p.offset), int32(p.maxBytes)]);
  return concat([int32(-1), int32(maxWaitMs), int32(minBytes), int32(maxBytes), int8(0), array(topics, (t) => concat([string(t.topic), array(t.partitions, partition)]))]);
}

// ---- decoding --------------------------------------------------------------

// A bounds-checked reader over one response or one decompressed batch. Every
// method throws ProtocolError past the end, or KafkaDecodeError("records") when
// it reads a batch's records.
export class Reader {
  readonly buf: Uint8Array;
  readonly view: DataView;
  readonly what: string;
  readonly inBatch: boolean;
  pos = 0;

  constructor(buf: Uint8Array, what: string, inBatch = false) {
    this.buf = buf;
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    this.what = what;
    this.inBatch = inBatch;
  }

  fail(message: string): Error {
    return this.inBatch ? new KafkaDecodeError("records", `${this.what}: ${message}`) : new ProtocolError(`${this.what}: ${message}`);
  }

  need(n: number): void {
    if (n < 0 || this.pos + n > this.buf.length) throw this.fail(`needs ${n} byte(s) at ${this.pos}, has ${this.buf.length - this.pos}`);
  }

  remaining(): number {
    return this.buf.length - this.pos;
  }

  int8(): number {
    this.need(1);
    return this.view.getInt8(this.pos++);
  }

  int16(): number {
    this.need(2);
    const v = this.view.getInt16(this.pos);
    this.pos += 2;
    return v;
  }

  int32(): number {
    this.need(4);
    const v = this.view.getInt32(this.pos);
    this.pos += 4;
    return v;
  }

  // An int64 as a number; one past 2^53 is refused rather than rounded.
  int64(): number {
    this.need(8);
    const v = this.view.getBigInt64(this.pos);
    this.pos += 8;
    const n = Number(v);
    if (!Number.isSafeInteger(n)) throw this.fail(`int64 ${v} is outside the safe integer range`);
    return n;
  }

  string(): string | null {
    const n = this.int16();
    if (n === -1) return null;
    this.need(n);
    const v = UTF8_DECODER.decode(this.buf.subarray(this.pos, this.pos + n));
    this.pos += n;
    return v;
  }

  bytes(): Uint8Array | null {
    const n = this.int32();
    if (n === -1) return null;
    this.need(n);
    const v = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return v;
  }

  // An array: an int32 count (-1 for null), each element read by fn. A count
  // larger than the bytes left cannot be honest, since every element has one.
  array<T>(fn: (r: Reader) => T): T[] | null {
    const n = this.int32();
    if (n === -1) return null;
    if (n < 0 || n > this.remaining()) throw this.fail(`array count ${n} with ${this.remaining()} byte(s) left`);
    const out: T[] = [];
    for (let i = 0; i < n; i++) out.push(fn(this));
    return out;
  }

  // A zigzag varint of at most maxBytes bytes (5 for a varint, 10 for a varlong),
  // as a number; one past 2^53 is refused.
  varint(maxBytes = 5): number {
    let v = 0;
    for (let i = 0, shift = 0; ; i++, shift += 7) {
      if (i >= maxBytes) throw this.fail(`varint longer than ${maxBytes} bytes`);
      this.need(1);
      const b = this.buf[this.pos++]!;
      v += (b & 0x7f) * 2 ** shift;
      if ((b & 0x80) === 0) break;
    }
    if (!Number.isSafeInteger(v)) throw this.fail(`varint ${v} is outside the safe integer range`);
    return v % 2 === 0 ? v / 2 : -(v + 1) / 2;
  }

  varlong(): number {
    return this.varint(10);
  }

  // The response must end here.
  end(): void {
    if (this.pos !== this.buf.length) throw this.fail(`${this.buf.length - this.pos} trailing byte(s)`);
  }
}

export interface ApiRange {
  min: number;
  max: number;
}

// ApiVersions v0: Map apiKey -> {min, max}. Error 35 still carries the list.
export function parseApiVersions(r: Reader): { errorCode: number; apis: Map<number, ApiRange> } {
  const errorCode = r.int16();
  const apis = new Map<number, ApiRange>();
  for (const a of r.array((x) => ({ key: x.int16(), min: x.int16(), max: x.int16() })) ?? []) apis.set(a.key, { min: a.min, max: a.max });
  r.end();
  return { errorCode, apis };
}

export interface OffsetAnswer {
  topic: string | null;
  partitions: { partition: number; errorCode: number; timestamp: number; offset: number }[];
}

// ListOffsets v1. An offset of -1 for a timestamp query means no message at or after it.
export function parseListOffsets(r: Reader): OffsetAnswer[] {
  const topics =
    r.array((x) => ({
      topic: x.string(),
      partitions: x.array((y) => ({ partition: y.int32(), errorCode: y.int16(), timestamp: y.int64(), offset: y.int64() })) ?? [],
    })) ?? [];
  r.end();
  return topics;
}

export interface FetchPartition {
  partition: number;
  errorCode: number;
  highWatermark: number;
  lastStableOffset: number;
  abortedTransactions: { producerId: number; firstOffset: number }[] | null;
  // The raw bytes of the batches, which may end in one partial batch.
  records: Uint8Array | null;
}

export interface FetchAnswer {
  throttleMs: number;
  topics: { topic: string | null; partitions: FetchPartition[] }[];
}

// Fetch v4.
export function parseFetch(r: Reader): FetchAnswer {
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
const B = Object.freeze({ length: 8, magic: 16, crc: 17, attributes: 21, lastOffsetDelta: 23, baseTimestamp: 27, maxTimestamp: 35, recordCount: 57, records: 61 });
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
export function crc32c(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC32C_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const viewOf = (b: Uint8Array): DataView => new DataView(b.buffer, b.byteOffset, b.byteLength);

export interface SplitBatch {
  baseOffset: number;
  lastOffset: number;
  size: number;
  magic: number;
  bytes: Uint8Array;
  codec: string | null;
  recordCount: number | null;
  firstTimestamp: number | null;
  isControl: boolean;
}

// Splits a fetch's records bytes into whole batches, reading each header
// without decompressing it. A batch the response cut short (the broker stops
// at the size limit) is left in `partial`, as a byte count. Old-format message
// sets (magic 0 or 1) are returned with magic set, for the caller to refuse.
export function splitBatches(records: Uint8Array): { batches: SplitBatch[]; partial: number } {
  const batches: SplitBatch[] = [];
  const view = viewOf(records);
  let pos = 0;
  while (records.length - pos >= 17) {
    const batchLength = view.getInt32(pos + B.length);
    if (batchLength < 5) throw new ProtocolError(`records: a batch at byte ${pos} declares length ${batchLength}`);
    const size = 12 + batchLength;
    if (pos + size > records.length) break;
    const bytes = records.subarray(pos, pos + size);
    const at = viewOf(bytes);
    const baseOffset = Number(at.getBigInt64(0));
    const magic = at.getInt8(B.magic);
    const batch: SplitBatch = { baseOffset, lastOffset: baseOffset, size, magic, bytes, codec: null, recordCount: null, firstTimestamp: null, isControl: false };
    if (magic === 2 && size >= BATCH_HEADER) {
      const attributes = at.getInt16(B.attributes);
      batch.lastOffset = baseOffset + at.getInt32(B.lastOffsetDelta);
      batch.codec = codecName(attributes & 7);
      batch.recordCount = at.getInt32(B.recordCount);
      batch.isControl = (attributes & 0x20) !== 0;
      batch.firstTimestamp = Number(at.getBigInt64(attributes & 8 ? B.maxTimestamp : B.baseTimestamp));
    }
    batches.push(batch);
    pos += size;
  }
  return { batches, partial: records.length - pos };
}

function decompress(codec: number, payload: Uint8Array): Uint8Array {
  if (codec === 0) return payload;
  if (codec === 2) {
    try {
      return snappyKafka(payload);
    } catch (e) {
      throw new KafkaDecodeError("snappy", e instanceof SnappyError ? e.message : `snappy decompression failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new KafkaDecodeError("codec", `compression ${codecName(codec)} is not decoded by this reader`);
}

export interface KafkaRecord {
  offset: number;
  timestamp: number;
  key: Uint8Array | null;
  value: Uint8Array | null;
}

interface BatchBase {
  baseOffset: number;
  baseTimestamp: number;
  maxTimestamp: number;
  logAppendTime: boolean;
}

function readRecord(r: Reader, base: BatchBase): KafkaRecord {
  const length = r.varint();
  const start = r.pos;
  r.need(length);
  r.int8();
  const timestampDelta = r.varlong();
  const offsetDelta = r.varint();
  const keyLength = r.varint();
  if (keyLength > 0) r.need(keyLength);
  const key = keyLength < 0 ? null : r.buf.subarray(r.pos, r.pos + keyLength);
  if (keyLength > 0) r.pos += keyLength;
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

export interface DecodedBatch {
  baseOffset: number;
  lastOffset: number;
  codec: string;
  isControl: boolean;
  recordCount: number;
  records: KafkaRecord[];
  decodedBytes: number;
}

// Decodes one magic-2 batch: checks its CRC-32C, decompresses it, and parses
// exactly the records its header declares. Throws KafkaDecodeError on any failure.
export function decodeBatch(bytes: Uint8Array): DecodedBatch {
  if (bytes.length < BATCH_HEADER) throw new KafkaDecodeError("truncated", `a batch of ${bytes.length} byte(s) is shorter than the ${BATCH_HEADER}-byte header`);
  const view = viewOf(bytes);
  const magic = view.getInt8(B.magic);
  if (magic !== 2) throw new KafkaDecodeError("magic", `magic ${magic}; this reader decodes magic 2 only`);
  const declared = view.getUint32(B.crc);
  const actual = crc32c(bytes, B.attributes);
  if (declared !== actual) throw new KafkaDecodeError("crc", `CRC-32C ${actual.toString(16)} where the batch declares ${declared.toString(16)}`);
  const attributes = view.getInt16(B.attributes);
  const codec = attributes & 7;
  const base: BatchBase = {
    baseOffset: Number(view.getBigInt64(0)),
    baseTimestamp: Number(view.getBigInt64(B.baseTimestamp)),
    maxTimestamp: Number(view.getBigInt64(B.maxTimestamp)),
    logAppendTime: (attributes & 8) !== 0,
  };
  const recordCount = view.getInt32(B.recordCount);
  const decoded = decompress(codec, bytes.subarray(B.records));
  const r = new Reader(decoded, `batch at offset ${base.baseOffset}`, true);
  const records: KafkaRecord[] = [];
  for (let i = 0; i < recordCount; i++) records.push(readRecord(r, base));
  if (r.remaining() !== 0) throw new KafkaDecodeError("records", `batch at offset ${base.baseOffset}: ${r.remaining()} byte(s) after the ${recordCount} declared record(s)`);
  return {
    baseOffset: base.baseOffset,
    lastOffset: base.baseOffset + view.getInt32(B.lastOffsetDelta),
    codec: codecName(codec),
    isControl: (attributes & 0x20) !== 0,
    recordCount,
    records,
    decodedBytes: BATCH_HEADER + decoded.length,
  };
}
