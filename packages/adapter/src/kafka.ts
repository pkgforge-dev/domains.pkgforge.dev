// packages/adapter/src/kafka.ts — the one Kafka client of adapters (DOM-026):
// KafkaConnection, one TCP connection to a broker over ctx.connect, which sends
// ApiVersions v0, Metadata v0, ListOffsets v1 and Fetch v4 as a consumer with
// no group, so it commits nothing on the broker.
//
//   const conn = await KafkaConnection.open(ctx.connect, ZONESTREAM, ctx.userAgent);
//   const parts = await conn.metadata(["newly_registered_domain"]);              // topic -> partition ids
//   const first = await conn.listOffsets([{ topic, partition: 0 }], EARLIEST);   // "topic/0" -> offset
//   const { partitions } = await conn.fetch([{ topic, partition: 0, offset, maxBytes: 4 << 20 }], { maxWaitMs: 500, maxBytes: 12 << 20 });
//   ...decodeBatch(batch.bytes) for each whole batch of partitions.get("topic/0")...
//   await conn.close();
//
// What the replay of the harness rests on (src/connect.ts): correlation ids
// count from 1 on each connection; one request is in flight at a time, in the
// order called, and its answer is read whole before the next is written; and
// each request is one write() call. So an adapter that is deterministic writes,
// from one cursor, the same bytes on every run, and finds the same exchanges.
//
// Memory is bounded per answer: a response frame that declares under 4 bytes,
// or more than its cap (KafkaLimits.smallFrame for ApiVersions, Metadata and
// ListOffsets; the Fetch's maxBytes plus frameSlack), is a ProtocolError before
// a byte of it is read, and each frame is read into one allocation of its size.
// It reads no clock and sets no timer: the timeouts are the bounds of the
// connect it is given (liveConnect's connect, idle, life and bytes,
// node/connect.ts), so what it returns depends only on the bytes it read.
//
// Errors: ProtocolError for a broker that breaks the protocol (a frame out of
// bounds, another correlation id, a partition not asked or not answered, the
// connection closed mid-frame, a version not served); KafkaError for a broker
// error code in ApiVersions, Metadata or ListOffsets; the socket's own error,
// unwrapped, for a read or a write that fails (a SocketError of liveConnect, a
// ContractError "unrecorded" of the replay), so its code reaches the adapter.
// A Fetch partition's error code is returned, not thrown, so one topic can stop
// while the others go on. After any failure of a request the connection is
// spent: every later request rejects with that failure. A TypeError is the
// caller's: an ask that is not one rejects with it before a byte is sent, and
// leaves the connection as it was.
//
// Limits: codecs none and snappy decode; gzip, lz4 and zstd are
// KafkaDecodeError "codec" (src/kafka-protocol.ts); magic 2 only.
//
// It imports nothing from `node:` (tsconfig.worker.json checks it as Worker code).
import {
  API,
  apiVersionsBody,
  EARLIEST,
  encodeRequest,
  fetchBody,
  KafkaError,
  LATEST,
  listOffsetsBody,
  metadataBody,
  ProtocolError,
  parseApiVersions,
  parseFetch,
  parseListOffsets,
  parseMetadata,
  Reader,
  type SplitBatch,
  splitBatches,
  VERSION,
} from "./kafka-protocol.ts";
import type { AdapterSocket, Connect, SocketAddress } from "./types.ts";

export {
  crc32c,
  type DecodedBatch,
  type DecodeKind,
  decodeBatch,
  EARLIEST,
  errorName,
  KafkaDecodeError,
  KafkaError,
  type KafkaRecord,
  LATEST,
  ProtocolError,
  type SplitBatch,
  splitBatches,
} from "./kafka-protocol.ts";

// READ https://openintel.nl/data/zonestream/ and DOM-004: the broker answers
// plain TCP on 9092 with no credential (9091, the documented port, timed out
// from a runner).
export const ZONESTREAM: SocketAddress = Object.freeze({ hostname: "kafka.zonestream.openintel.nl", port: 9092 });

export interface KafkaLimits {
  // The cap of an ApiVersions, Metadata or ListOffsets answer frame.
  readonly smallFrame: number;
  // A Fetch answer may pass its maxBytes by one batch: the broker returns the
  // first batch whole however large (Fetch v3 and later). A frame above the
  // Fetch's maxBytes plus this is refused, so memory stays bounded by the ask.
  readonly frameSlack: number;
}

export const KAFKA_LIMITS: KafkaLimits = Object.freeze({ smallFrame: 1 << 20, frameSlack: 2 << 20 });

// The Fetch's min_bytes: the broker answers once it holds one byte at the
// offset, or after maxWaitMs with none, so a quiet topic costs one wait and no more.
export const FETCH_MIN_BYTES = 1;

// The key of a partition in the maps this client returns.
export const partitionKey = (topic: string, partition: number): string => `${topic}/${partition}`;

export interface PartitionAsk {
  readonly topic: string;
  readonly partition: number;
}

export interface FetchAsk extends PartitionAsk {
  readonly offset: number;
  readonly maxBytes: number;
}

export interface FetchOptions {
  // How long the broker may hold the answer for FETCH_MIN_BYTES to arrive.
  readonly maxWaitMs: number;
  // The bytes of the whole answer, which may pass it by one batch (frameSlack).
  readonly maxBytes: number;
}

export interface FetchedPartition {
  readonly errorCode: number;
  readonly highWatermark: number;
  // The whole batches of the answer, in the broker's order, not decoded.
  readonly batches: readonly SplitBatch[];
  // The bytes of a batch the broker cut at the size limit, at the end of the answer.
  readonly partial: number;
}

export interface FetchResult {
  // The response as it came off the socket, its 4-byte size included.
  readonly frameBytes: number;
  // By partitionKey, in the order asked.
  readonly partitions: ReadonlyMap<string, FetchedPartition>;
}

const INT32_MAX = 0x7fffffff;
// An int16 string: the client id's length prefix.
const INT16_MAX = 0x7fff;
// Kafka's own rule for a topic name.
const TOPIC = /^[A-Za-z0-9._-]{1,249}$/;
const EMPTY = new Uint8Array(0);

const isWhole = (n: unknown, min: number, max: number): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= min && n <= max;

function checkLimits(limits: KafkaLimits): void {
  for (const k of ["smallFrame", "frameSlack"] as const) {
    const v = limits?.[k];
    if (!isWhole(v, 1, INT32_MAX)) throw new TypeError(`KafkaConnection: ${k} ${v} is not a whole number from 1 to ${INT32_MAX}`);
  }
}

function checkTopic(topic: unknown, what: string): asserts topic is string {
  if (typeof topic !== "string" || !TOPIC.test(topic)) throw new TypeError(`${what}: topic ${JSON.stringify(topic)} is not a Kafka topic name`);
}

// The asks grouped by topic, topics in the order first asked and partitions in
// the order asked, so a request's bytes depend on its asks alone.
function byTopic<T extends PartitionAsk>(asks: readonly T[], what: string, check: (ask: T) => void): { topic: string; partitions: T[] }[] {
  if (!Array.isArray(asks) || asks.length === 0) throw new TypeError(`${what}: asks no partition`);
  const groups = new Map<string, T[]>();
  for (const ask of asks) {
    checkTopic(ask?.topic, what);
    if (!isWhole(ask.partition, 0, INT32_MAX)) throw new TypeError(`${what}: partition ${ask.partition} of ${ask.topic} is not a whole number from 0`);
    check(ask);
    let group = groups.get(ask.topic);
    if (group === undefined) {
      group = [];
      groups.set(ask.topic, group);
    }
    if (group.some((g) => g.partition === ask.partition)) throw new TypeError(`${what}: asks ${partitionKey(ask.topic, ask.partition)} twice`);
    group.push(ask);
  }
  return [...groups].map(([topic, partitions]) => ({ topic, partitions }));
}

// An answer's partitions held to the asks: each one asked, each answered once,
// none left out. The map is in the order asked.
function matchAsks<T>(where: string, asks: readonly PartitionAsk[], answers: Iterable<{ topic: string | null; partition: number; value: T }>): Map<string, T> {
  const got = new Map<string, T>();
  const asked = asks.map((a) => partitionKey(a.topic, a.partition));
  for (const a of answers) {
    const key = partitionKey(String(a.topic), a.partition);
    if (a.topic === null || !asked.includes(key)) throw new ProtocolError(`${where}: an answer for ${key}, which was not asked`);
    if (got.has(key)) throw new ProtocolError(`${where}: ${key} is answered twice`);
    got.set(key, a.value);
  }
  for (const key of asked) if (!got.has(key)) throw new ProtocolError(`${where}: ${key} was asked and is not answered`);
  return new Map(asked.map((key) => [key, got.get(key)!]));
}

// One connection, one request at a time (the header).
export class KafkaConnection {
  readonly address: SocketAddress;
  readonly clientId: string;
  readonly limits: KafkaLimits;
  private readonly where: string;
  private readonly socket: AdapterSocket;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private rest: Uint8Array = EMPTY;
  private nextId = 1;
  // Settles when the request before it has: requests run in the order called.
  private queue: Promise<void> = Promise.resolve();
  // The first failure of a request, or the close: every later request rejects with it.
  private spent: { readonly error: unknown } | null = null;

  private constructor(socket: AdapterSocket, address: SocketAddress, clientId: string, limits: KafkaLimits) {
    this.socket = socket;
    this.address = Object.freeze({ hostname: address.hostname, port: address.port });
    this.where = `${address.hostname}:${address.port}`;
    this.clientId = clientId;
    this.limits = limits;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  // Opens the socket, waits for it to open, sends ApiVersions v0, and refuses a
  // broker that does not serve every version this client sends (VERSION of
  // src/kafka-protocol.ts: Fetch v4, ListOffsets v1, Metadata v0, ApiVersions v0).
  // On any failure the socket is closed before the rejection.
  static async open(connect: Connect, address: SocketAddress, clientId: string, limits: KafkaLimits = KAFKA_LIMITS): Promise<KafkaConnection> {
    checkLimits(limits);
    if (typeof clientId !== "string" || new TextEncoder().encode(clientId).length > INT16_MAX) throw new TypeError(`KafkaConnection: the client id is not a string of at most ${INT16_MAX} bytes`);
    const socket = connect(address, { secureTransport: "off", allowHalfOpen: false });
    try {
      await socket.opened;
    } catch (err) {
      await closeAfterFailure(socket);
      throw err;
    }
    const conn = new KafkaConnection(socket, address, clientId, limits);
    try {
      await conn.apiVersions();
    } catch (err) {
      await closeAfterFailure(socket);
      throw err;
    }
    return conn;
  }

  private apiVersions(): Promise<void> {
    const what = "ApiVersions v0";
    return this.call(API.API_VERSIONS, apiVersionsBody(), what, this.limits.smallFrame, (r) => {
      const { errorCode, apis } = parseApiVersions(r);
      if (errorCode !== 0) throw new KafkaError(errorCode, `${this.where} ${what}`);
      for (const [key, version] of Object.entries(VERSION)) {
        const range = apis.get(Number(key));
        if (range === undefined || version < range.min || version > range.max) {
          throw new ProtocolError(`${this.where}: the broker serves API ${key} at ${range === undefined ? "no version" : `${range.min}..${range.max}`}; this client sends v${version}`);
        }
      }
    });
  }

  // Metadata v0: each topic's partition ids, ascending, in the order asked. A
  // topic's error code is a KafkaError. A partition's own error code is not
  // read here: a partition that cannot serve fails its ListOffsets or Fetch.
  async metadata(topics: readonly string[]): Promise<Map<string, number[]>> {
    const what = "Metadata v0";
    // An empty list asks Metadata v0 for every topic, which no adapter reads.
    if (!Array.isArray(topics) || topics.length === 0) throw new TypeError(`${what}: asks no topic`);
    for (const t of topics) checkTopic(t, what);
    if (new Set(topics).size !== topics.length) throw new TypeError(`${what}: asks a topic twice`);
    return this.call(API.METADATA, metadataBody(topics), what, this.limits.smallFrame, (r) => {
      const label = `${this.where} ${what}`;
      const got = new Map<string, number[]>();
      for (const t of parseMetadata(r).topics) {
        if (t.name === null || !topics.includes(t.name)) throw new ProtocolError(`${label}: an answer for topic ${t.name}, which was not asked`);
        if (got.has(t.name)) throw new ProtocolError(`${label}: topic ${t.name} is answered twice`);
        if (t.errorCode !== 0) throw new KafkaError(t.errorCode, `${label} ${t.name}`);
        const ids = t.partitions.map((p) => p.partition).sort((a, b) => a - b);
        if (new Set(ids).size !== ids.length) throw new ProtocolError(`${label}: topic ${t.name} names a partition twice`);
        got.set(t.name, ids);
      }
      for (const t of topics) if (!got.has(t)) throw new ProtocolError(`${label}: topic ${t} was asked and is not answered`);
      return new Map(topics.map((t) => [t, got.get(t)!]));
    });
  }

  // ListOffsets v1 of every asked partition at one timestamp, in one request:
  // EARLIEST, LATEST, or a time in ms since the epoch, for which the answer is
  // the first offset whose record time is at or after it, or -1 past the newest
  // message. By partitionKey, in the order asked. A partition's error code is
  // a KafkaError.
  async listOffsets(asks: readonly PartitionAsk[], timestamp: number): Promise<Map<string, number>> {
    const what = "ListOffsets v1";
    if (timestamp !== EARLIEST && timestamp !== LATEST && !isWhole(timestamp, 0, Number.MAX_SAFE_INTEGER))
      throw new TypeError(`${what}: timestamp ${timestamp} is not EARLIEST, LATEST or a whole number of ms from 0`);
    const topics = byTopic(asks, what, () => {});
    const body = listOffsetsBody(topics.map((t) => ({ topic: t.topic, partitions: t.partitions.map((p) => ({ partition: p.partition, timestamp })) })));
    return this.call(API.LIST_OFFSETS, body, what, this.limits.smallFrame, (r) => {
      const label = `${this.where} ${what}`;
      const answers = parseListOffsets(r).flatMap((t) => t.partitions.map((p) => ({ topic: t.topic, partition: p.partition, value: p })));
      const got = matchAsks(label, asks, answers);
      const out = new Map<string, number>();
      for (const [key, p] of got) {
        if (p.errorCode !== 0) throw new KafkaError(p.errorCode, `${label} ${key}`);
        out.set(key, p.offset);
      }
      return out;
    });
  }

  // Fetch v4 of every asked partition in one request, read uncommitted
  // (isolation 0), as a consumer (replica -1), with FETCH_MIN_BYTES. Each
  // partition's records are split into whole batches (splitBatches); nothing is
  // decoded here, so the batches are the bytes a raw lane keeps.
  async fetch(asks: readonly FetchAsk[], options: FetchOptions): Promise<FetchResult> {
    const what = "Fetch v4";
    if (!isWhole(options?.maxWaitMs, 0, INT32_MAX)) throw new TypeError(`${what}: maxWaitMs ${options?.maxWaitMs} is not a whole number from 0 to ${INT32_MAX}`);
    if (!isWhole(options.maxBytes, 1, INT32_MAX)) throw new TypeError(`${what}: maxBytes ${options.maxBytes} is not a whole number from 1 to ${INT32_MAX}`);
    const topics = byTopic(asks, what, (a) => {
      if (!isWhole(a.offset, 0, Number.MAX_SAFE_INTEGER)) throw new TypeError(`${what}: offset ${a.offset} of ${partitionKey(a.topic, a.partition)} is not a whole number from 0`);
      if (!isWhole(a.maxBytes, 1, INT32_MAX)) throw new TypeError(`${what}: maxBytes ${a.maxBytes} of ${partitionKey(a.topic, a.partition)} is not a whole number from 1 to ${INT32_MAX}`);
    });
    const body = fetchBody({
      topics: topics.map((t) => ({ topic: t.topic, partitions: t.partitions.map((p) => ({ partition: p.partition, offset: p.offset, maxBytes: p.maxBytes })) })),
      maxWaitMs: options.maxWaitMs,
      minBytes: FETCH_MIN_BYTES,
      maxBytes: options.maxBytes,
    });
    return this.call(API.FETCH, body, what, options.maxBytes + this.limits.frameSlack, (r, frameBytes) => {
      const label = `${this.where} ${what}`;
      const answers = parseFetch(r).topics.flatMap((t) => t.partitions.map((p) => ({ topic: t.topic, partition: p.partition, value: p })));
      const partitions = new Map<string, FetchedPartition>();
      for (const [key, p] of matchAsks(label, asks, answers)) {
        const { batches, partial } = splitBatches(p.records ?? EMPTY);
        partitions.set(key, { errorCode: p.errorCode, highWatermark: p.highWatermark, batches, partial });
      }
      return { frameBytes, partitions };
    });
  }

  // Ends the connection: the socket's close is awaited, and a request after it
  // rejects. A request in flight is not waited for; with one request in flight
  // and every request awaited, there is none.
  async close(): Promise<void> {
    this.spent ??= { error: new ProtocolError(`${this.where}: the connection is closed`) };
    await this.socket.close();
  }

  // One request, run when the one before it has settled. `parse` reads the
  // answer; any failure, of the socket, the frame or the parse, spends the
  // connection.
  private call<T>(apiKey: number, body: Uint8Array, what: string, frameCap: number, parse: (r: Reader, frameBytes: number) => T): Promise<T> {
    const run = async (): Promise<T> => {
      if (this.spent !== null) throw this.spent.error;
      try {
        const { reader, frameBytes } = await this.exchange(apiKey, body, what, frameCap);
        return parse(reader, frameBytes);
      } catch (err) {
        this.spent ??= { error: err };
        throw err;
      }
    };
    const answer = this.queue.then(run);
    // The queue only orders the requests: each failure reaches its own caller
    // through `answer`, and the next request reads `spent`.
    this.queue = answer.then(
      () => {},
      () => {},
    );
    return answer;
  }

  private async exchange(apiKey: number, body: Uint8Array, what: string, frameCap: number): Promise<{ reader: Reader; frameBytes: number }> {
    const label = `${this.where} ${what}`;
    if (this.nextId > INT32_MAX) throw new ProtocolError(`${label}: the correlation ids of this connection are used up`);
    const correlationId = this.nextId++;
    // One write() a request, whole: the replay matches whole writes (src/connect.ts).
    await this.writer.write(encodeRequest({ apiKey, apiVersion: VERSION[apiKey]!, correlationId, clientId: this.clientId, body }));
    const head = await this.read(4, label);
    const size = new DataView(head.buffer, head.byteOffset, 4).getInt32(0);
    if (size < 4) throw new ProtocolError(`${label}: a response frame declares ${size} byte(s), less than its correlation id`);
    if (size > frameCap) throw new ProtocolError(`${label}: a response frame declares ${size} byte(s), above its cap of ${frameCap}`);
    const frame = await this.read(size, label);
    const id = new DataView(frame.buffer, frame.byteOffset, 4).getInt32(0);
    if (id !== correlationId) throw new ProtocolError(`${label}: a response with correlation id ${id} to request ${correlationId}`);
    return { reader: new Reader(frame.subarray(4), label), frameBytes: 4 + size };
  }

  // Exactly n bytes: one allocation of n, filled from the stream, so a large
  // answer is held once and never concatenated chunk by chunk. A read that
  // rejects rejects with the socket's own error.
  private async read(n: number, label: string): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let filled = Math.min(n, this.rest.length);
    out.set(this.rest.subarray(0, filled));
    this.rest = this.rest.subarray(filled);
    while (filled < n) {
      const chunk = await this.reader.read();
      if (chunk.done) throw new ProtocolError(`${label}: the connection closed after ${filled} of ${n} byte(s)`);
      const value = chunk.value;
      const take = Math.min(value.length, n - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
      if (take < value.length) this.rest = value.subarray(take);
    }
    return out;
  }
}

// Closes a socket whose open or first request failed. That failure is the one
// the caller is given; a close that fails after it leaves nothing to undo.
async function closeAfterFailure(socket: AdapterSocket): Promise<void> {
  try {
    await socket.close();
  } catch {
    // Deliberately empty: see above.
  }
}
