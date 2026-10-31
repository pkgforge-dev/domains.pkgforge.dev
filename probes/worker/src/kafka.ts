// probes/worker/src/kafka.ts — DOM-005's route of the probe Worker (TODO/ingest.md):
// can a Worker read OpenINTEL's Kafka broker over a TCP socket, and decode it?
//
//   GET /kafka?topic=<t>&offset=<n|earliest|latest|latest-N|ISO time>&max_bytes=<b>
//             [&partition=<p>][&max_wait_ms=<ms>][&sockets=<1..6>][&call=<label>]
//
// One call opens `sockets` TCP connections at once with connect() from
// cloudflare:sockets to kafka.zonestream.openintel.nl:9092, sends ApiVersions v0 on
// each, resolves a named offset with ListOffsets v1 on the first, sends one Fetch
// v4 of one partition there, splits and decodes the batches (CRC-32C, then snappy
// or codec none), and answers {messages, bytes, next_offset, decode_ms} with the
// counts and timings of the read. The route keeps no state: a caller resumes by
// passing next_offset back as offset. The other sockets exist only to show that
// they open (the entry asks whether a second concurrent socket does).
//
// Bounded by its own stated limits, never by refusing a caller (AGENTS.md absolute
// 8): max_bytes at most LIMITS.max_bytes, a Fetch response frame at most max_bytes
// + LIMITS.frame_slack, every other frame at most LIMITS.small_frame, each socket
// LIMITS.connect_ms to open, and the whole call LIMITS.wall_ms of wall time; past
// a cap the call answers 502 or 504 and closes its sockets. CPU and memory are
// Cloudflare's limits, and finding them is the point of the measurement.
//
// ⚠ decode_ms is read with the Worker's clock. READ 2026-10-28T16:04Z,
// https://developers.cloudflare.com/workers/runtime-apis/performance/: deployed,
// Date.now() and performance.now() advance only after I/O (a Spectre
// mitigation), so a decode with no I/O in it reads 0 there; in local development
// they advance regardless. MEASURED 2026-10-28T16:03Z (test/kafka-workerd.test.ts,
// workerd 1.20261006.1 under Miniflare): a decode of two snappy batches read 2 ms.
// The CPU of a deployed invocation is Cloudflare's own account of it (Workers
// Logs, `wrangler tail`), which scripts/measure/kafka-worker.mjs reads; no answer
// of this route claims a CPU time.
//
// cloudflare:sockets is imported at run time through a variable: wrangler marks
// cloudflare:* external, the harness's esbuild bundle does not, and Node cannot
// load it, so a static import would break the harness and the Node tests of
// src/index.ts. MEASURED 2026-10-28T15:33:56Z and again at 16:07Z with
// packages/testkit (workerd 1.20261006.1, date 2026-10-13): a literal
// import("cloudflare:sockets") fails the harness's bundle ("Build failed with 1
// error"), the variable form bundles, and workerd resolves it to a module whose
// connect is a function, which opens a socket to 127.0.0.1. MEASURED
// 2026-10-28T16:07Z: `wrangler deploy --dry-run` (4.150.0) of an entry that
// imports this module exits 0 and keeps the import as written.
//
// Usage: import { kafkaRoute } from "./kafka.ts". src/index.ts routes to it no
// more since DOM-005 closed; its tests call it directly.
// It is a module; it has no command line and no exit code.
import { ProbeError, WORKER } from "./gaps.ts";
import type { Route } from "./index.ts";
import {
  API,
  type ApiRange,
  apiVersionsBody,
  codecName,
  decodeBatch,
  EARLIEST,
  encodeRequest,
  fetchBody,
  KafkaDecodeError,
  KafkaError,
  LATEST,
  listOffsetsBody,
  ProtocolError,
  parseApiVersions,
  parseFetch,
  parseListOffsets,
  Reader,
  splitBatches,
  VERSION,
} from "./kafka-protocol.ts";
import type { Env } from "./types.ts";

export const ENTRY = "DOM-005";
export const PATH = "/kafka";
export const ANSWER_VERSION = 1;
// READ https://openintel.nl/data/zonestream/ and DOM-004: the broker answers plain
// TCP on 9092 with no credential (9091, the documented port, timed out from a runner).
export const ZONESTREAM = Object.freeze({ hostname: "kafka.zonestream.openintel.nl", port: 9092 });
// The client id the broker's operator sees in its request log (scripts/measure/kafka-client.mjs).
export const CLIENT_ID = "domains.pkgforge.dev";
const MIB = 1_048_576;

export interface KafkaLimits {
  // The largest max_bytes a call may ask for, and the default.
  readonly max_bytes: number;
  readonly default_max_bytes: number;
  // A Fetch answer may exceed max_bytes: the broker returns the first batch
  // whole however large (Fetch v3 and later). A frame above max_bytes plus this
  // is refused, so memory stays bounded by what the caller asked.
  readonly frame_slack: number;
  // The cap of an ApiVersions or ListOffsets answer frame.
  readonly small_frame: number;
  readonly max_wait_ms: number;
  readonly default_max_wait_ms: number;
  // At most 6 connections at once: Cloudflare's limit of simultaneous open
  // connections of one invocation (design B section 2.3).
  readonly sockets: number;
  readonly connect_ms: number;
  readonly wall_ms: number;
}

export const LIMITS: KafkaLimits = Object.freeze({
  max_bytes: 64 * MIB,
  default_max_bytes: MIB,
  frame_slack: 2 * MIB,
  small_frame: MIB,
  max_wait_ms: 10_000,
  default_max_wait_ms: 500,
  sockets: 6,
  connect_ms: 10_000,
  wall_ms: 30_000,
});

// What each count of an answer means. scripts/measure/kafka-worker.mjs writes
// them into its result.
export const DEFINITIONS = Object.freeze({
  offset:
    "the offset the read starts at: the query's own number, or the one ListOffsets v1 gave for earliest, latest, latest-N (clamped at the earliest) or a time (the first message at or after it, the latest offset when there is none)",
  messages: "the records at or after offset in the whole batches of the answer that decoded; control records excluded",
  bytes: "the Fetch v4 response as it came off the socket, its 4-byte size included",
  wire_bytes: "the whole batches whose offsets reach offset or past it, exactly as the broker returned them, still compressed: the bytes a raw lane stores",
  raw_bytes: "the record values counted in messages, after decoding",
  decoded_bytes: "the counted batches that decoded, after decompression, 61-byte batch headers included",
  next_offset:
    "one past the last offset of the last counted batch, decoded or failed; offset when the answer held no whole batch at or past it. Passed back as offset, it resumes the read with no gap and no repeat",
  lag: "high_watermark - next_offset: the messages the partition held past this answer",
  partial_bytes: "the bytes of a batch the broker cut at the size limit, at the end of the answer; it is read again from next_offset",
  failed_batches:
    "counted batches that did not decode, by kind in failures: crc (CRC-32C mismatch), snappy, codec (a codec this route does not decode), records (records that do not match the header), magic, truncated",
  decode_ms:
    "the Worker's clock across the split and the decode. Deployed, the clock advances only after I/O, so a decode reads 0 (Cloudflare's documentation); locally it advances regardless. The CPU time is in Workers Logs and `wrangler tail`, not in this answer",
  ms: "the Worker's clock across each stage: connect (every socket opened or failed), api_versions, list_offsets (null when offset is a number), fetch (request written to response read), wall (the whole call)",
});

// ---- the socket seam ---------------------------------------------------------

export interface SocketAddress {
  hostname: string;
  port: number;
}

export interface SocketOptions {
  secureTransport: "off";
  allowHalfOpen: boolean;
}

// The members of a cloudflare:sockets Socket the route uses.
export interface KafkaSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly opened: Promise<unknown>;
  close(): Promise<void>;
}

export type Connect = (address: SocketAddress, options: SocketOptions) => KafkaSocket;

// A variable, so that no bundler resolves it (see the header).
const SOCKETS_MODULE: string = "cloudflare:sockets";

// The production connect: cloudflare:sockets, loaded on first use. In Node it
// rejects, since Node has no such module.
export async function loadConnect(): Promise<Connect> {
  const loaded = (await import(SOCKETS_MODULE)) as { connect?: unknown };
  if (typeof loaded.connect !== "function") throw new Error(`${SOCKETS_MODULE} has no connect function`);
  return loaded.connect as Connect;
}

// ---- errors and deadlines ----------------------------------------------------

export type Stage = "connect" | "api_versions" | "list_offsets" | "fetch" | "decode";

// A failure of the read, answered with its status and stage.
export class KafkaRouteError extends Error {
  readonly status: number;
  readonly stage: Stage;
  constructor(status: number, stage: Stage, message: string) {
    super(message);
    this.name = "KafkaRouteError";
    this.status = status;
    this.stage = stage;
  }
}

class DeadlineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeadlineError";
  }
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// A cap of wall time. race() settles with the promise or rejects when the cap
// passes, whichever comes first; onExpire runs once, to close the sockets so
// that a read waiting on one ends.
class Deadline {
  private readonly timer: ReturnType<typeof setTimeout>;
  private readonly expired: Promise<never>;

  constructor(ms: number, what: string, onExpire: () => void) {
    let fire: (err: Error) => void = () => {};
    this.expired = new Promise<never>((_, reject) => {
      fire = reject;
    });
    // Nobody may be racing when the cap passes; the rejection is read by the next race.
    this.expired.catch(() => {});
    this.timer = setTimeout(() => {
      fire(new DeadlineError(`${what}: past the cap of ${ms} ms`));
      onExpire();
    }, ms);
  }

  race<T>(promise: Promise<T>): Promise<T> {
    return Promise.race([promise, this.expired]);
  }

  clear(): void {
    clearTimeout(this.timer);
  }
}

// The socket failed to open, or failed under a read or a write.
class SocketError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SocketError";
  }
}

// The status and stage of a failure. Anything else is a defect of the route and
// is rethrown for src/index.ts to answer 500 and log.
function routeError(stage: Stage, err: unknown): KafkaRouteError {
  if (err instanceof KafkaRouteError) return err;
  if (err instanceof DeadlineError) return new KafkaRouteError(504, stage, err.message);
  if (err instanceof KafkaError) {
    const status = err.code === 1 ? 416 : err.code === 3 ? 404 : 502;
    return new KafkaRouteError(status, stage, err.message);
  }
  if (err instanceof ProtocolError || err instanceof SocketError) return new KafkaRouteError(502, stage, err.message);
  throw err;
}

// ---- one connection ----------------------------------------------------------

const EMPTY = new Uint8Array(0);

// One connection, one request at a time: each request's answer is read whole
// before the next is written, and its correlation id must be the request's.
class Connection {
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly where: string;
  private readonly wall: Deadline;
  private rest: Uint8Array = EMPTY;
  private nextId = 1;

  constructor(socket: KafkaSocket, where: string, wall: Deadline) {
    this.where = where;
    this.wall = wall;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
  }

  async request(apiKey: number, body: Uint8Array, what: string, frameCap: number): Promise<{ reader: Reader; frameBytes: number }> {
    const correlationId = this.nextId++;
    const bytes = encodeRequest({ apiKey, apiVersion: VERSION[apiKey]!, correlationId, clientId: CLIENT_ID, body });
    try {
      await this.wall.race(this.writer.write(bytes));
    } catch (err) {
      if (err instanceof DeadlineError) throw err;
      throw new SocketError(`${this.where}: ${what}: the write failed: ${message(err)}`);
    }
    const head = await this.read(4, what);
    const size = new DataView(head.buffer, head.byteOffset, 4).getInt32(0);
    if (size < 4) throw new ProtocolError(`${what}: a response frame declares ${size} byte(s), less than its correlation id`);
    if (size > frameCap) throw new ProtocolError(`${what}: a response frame declares ${size} byte(s), above this call's cap of ${frameCap}`);
    const frame = await this.read(size, what);
    const id = new DataView(frame.buffer, frame.byteOffset, 4).getInt32(0);
    if (id !== correlationId) throw new ProtocolError(`${what}: a response with correlation id ${id} to request ${correlationId}`);
    return { reader: new Reader(frame.subarray(4), what), frameBytes: 4 + size };
  }

  // Exactly n bytes: one allocation of n, filled from the stream, so a large
  // answer is held once and never concatenated chunk by chunk.
  private async read(n: number, what: string): Promise<Uint8Array> {
    const out = new Uint8Array(n);
    let filled = Math.min(n, this.rest.length);
    out.set(this.rest.subarray(0, filled));
    this.rest = this.rest.subarray(filled);
    while (filled < n) {
      const value = await this.next(`${what}: after ${filled} of ${n} byte(s)`);
      if (value === null) throw new SocketError(`${this.where}: ${what}: the connection closed after ${filled} of ${n} byte(s)`);
      const take = Math.min(value.length, n - filled);
      out.set(value.subarray(0, take), filled);
      filled += take;
      if (take < value.length) this.rest = value.subarray(take);
    }
    return out;
  }

  // The next chunk off the socket, or null at its end.
  private async next(what: string): Promise<Uint8Array | null> {
    try {
      const chunk = await this.wall.race(this.reader.read());
      if (chunk.done) return null;
      return chunk.value;
    } catch (err) {
      if (err instanceof DeadlineError) throw err;
      throw new SocketError(`${this.where}: ${what}: the read failed: ${message(err)}`);
    }
  }
}

// ---- the query ---------------------------------------------------------------

export type OffsetSpec = { kind: "offset"; offset: number } | { kind: "earliest" } | { kind: "latest"; back: number } | { kind: "time"; ms: number };

export interface KafkaQuery {
  topic: string;
  partition: number;
  offset: OffsetSpec;
  offsetText: string;
  maxBytes: number;
  maxWaitMs: number;
  sockets: number;
  call: string | null;
}

const PARAMS: readonly string[] = Object.freeze(["topic", "offset", "max_bytes", "partition", "max_wait_ms", "sockets", "call"]);
// Kafka's own rule for a topic name.
const TOPIC = /^[A-Za-z0-9._-]{1,249}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const bad = (text: string): ProbeError => new ProbeError(400, text);

function wholeNumber(name: string, text: string, min: number, max: number): number {
  const n = /^\d{1,16}$/.test(text) ? Number(text) : Number.NaN;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw bad(`${name} must be a whole number from ${min} to ${max}`);
  return n;
}

export function parseOffset(text: string): OffsetSpec {
  if (text === "earliest") return { kind: "earliest" };
  if (text === "latest") return { kind: "latest", back: 0 };
  const back = /^latest-(\d{1,16})$/.exec(text);
  if (back !== null) return { kind: "latest", back: wholeNumber("the N of offset=latest-N", back[1]!, 0, Number.MAX_SAFE_INTEGER) };
  if (ISO_TIME.test(text)) {
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) throw bad(`offset ${text} is not a valid time`);
    return { kind: "time", ms };
  }
  if (/^\d+$/.test(text)) return { kind: "offset", offset: wholeNumber("offset", text, 0, Number.MAX_SAFE_INTEGER) };
  throw bad("offset must be a whole number, earliest, latest, latest-N or a UTC time such as 2026-10-28T12:00:00Z");
}

// The query, checked. Throws ProbeError 400, which src/index.ts answers.
export function parseQuery(url: URL, limits: KafkaLimits = LIMITS): KafkaQuery {
  for (const name of url.searchParams.keys()) if (!PARAMS.includes(name)) throw bad(`${PATH} takes ${PARAMS.join(", ")}, not ${name}`);
  for (const name of PARAMS) if (url.searchParams.getAll(name).length > 1) throw bad(`${name} is given more than once`);
  const get = (name: string): string | null => url.searchParams.get(name);
  const topic = get("topic");
  if (topic === null || !TOPIC.test(topic)) throw bad("topic is required: 1 to 249 of A-Z, a-z, 0-9, dot, underscore and hyphen");
  const offsetText = get("offset");
  if (offsetText === null) throw bad("offset is required: a whole number, earliest, latest, latest-N or a UTC time");
  const maxBytesText = get("max_bytes");
  const maxWaitText = get("max_wait_ms");
  const partitionText = get("partition");
  const socketsText = get("sockets");
  const call = get("call");
  if (call !== null && !/^[A-Za-z0-9_-]{1,64}$/.test(call)) throw bad("call is a label of 1 to 64 of A-Z, a-z, 0-9, underscore and hyphen");
  return {
    topic,
    partition: partitionText === null ? 0 : wholeNumber("partition", partitionText, 0, 0x7fffffff),
    offset: parseOffset(offsetText),
    offsetText,
    maxBytes: maxBytesText === null ? limits.default_max_bytes : wholeNumber("max_bytes", maxBytesText, 1, limits.max_bytes),
    maxWaitMs: maxWaitText === null ? limits.default_max_wait_ms : wholeNumber("max_wait_ms", maxWaitText, 0, limits.max_wait_ms),
    sockets: socketsText === null ? 1 : wholeNumber("sockets", socketsText, 1, limits.sockets),
    call,
  };
}

// ---- the read ----------------------------------------------------------------

interface Timings {
  connect: number | null;
  api_versions: number | null;
  list_offsets: number | null;
  fetch: number | null;
  wall: number | null;
}

interface SocketReport {
  asked: number;
  opened: number;
  api_versions_ok: number;
  errors: string[];
}

const bump = (counts: Record<string, number>, key: string): void => {
  counts[key] = (counts[key] ?? 0) + 1;
};

const isoOrNull = (ms: number | null): string | null => (ms === null || !Number.isFinite(ms) ? null : new Date(ms).toISOString());

// The counts of one Fetch answer's batches from `start` (DEFINITIONS).
export function countBatches(records: Uint8Array, start: number, now: () => number) {
  const t0 = now();
  const { batches, partial } = splitBatches(records);
  const c = {
    messages: 0,
    wire_bytes: 0,
    raw_bytes: 0,
    decoded_bytes: 0,
    batches: 0,
    control_batches: 0,
    by_codec: {} as Record<string, number>,
    failed_batches: 0,
    failures: {} as Record<string, number>,
    failed_by_codec: {} as Record<string, number>,
    first_failure: null as string | null,
    partial_bytes: partial,
    next_offset: start,
    first_ts: null as number | null,
    last_ts: null as number | null,
  };
  for (const b of batches) {
    if (b.lastOffset < start) continue;
    c.batches += 1;
    c.wire_bytes += b.size;
    c.next_offset = b.lastOffset + 1;
    try {
      const d = decodeBatch(b.bytes);
      bump(c.by_codec, d.codec);
      c.decoded_bytes += d.decodedBytes;
      if (d.isControl) {
        c.control_batches += 1;
        continue;
      }
      for (const record of d.records) {
        if (record.offset < start) continue;
        c.messages += 1;
        c.raw_bytes += record.value === null ? 0 : record.value.length;
        c.first_ts ??= record.timestamp;
        c.last_ts = record.timestamp;
      }
    } catch (err) {
      if (!(err instanceof KafkaDecodeError)) throw err;
      c.failed_batches += 1;
      bump(c.failures, err.kind);
      bump(c.failed_by_codec, b.codec ?? `magic-${b.magic}`);
      c.first_failure ??= `offset ${b.baseOffset}: ${err.message}`;
    }
  }
  return { ...c, decode_ms: now() - t0 };
}

async function apiVersions(conn: Connection, limits: KafkaLimits): Promise<ApiRange> {
  const { reader } = await conn.request(API.API_VERSIONS, apiVersionsBody(), "ApiVersions v0", limits.small_frame);
  const { errorCode, apis } = parseApiVersions(reader);
  if (errorCode !== 0) throw new KafkaError(errorCode, "ApiVersions v0");
  for (const [key, version] of Object.entries(VERSION)) {
    const range = apis.get(Number(key));
    if (range === undefined || version < range.min || version > range.max) {
      throw new ProtocolError(`the broker serves API ${key} at ${range === undefined ? "no version" : `${range.min}..${range.max}`}; this route sends v${version}`);
    }
  }
  return apis.get(API.FETCH)!;
}

async function offsetAt(conn: Connection, q: KafkaQuery, timestamp: number, limits: KafkaLimits): Promise<number> {
  const { reader } = await conn.request(API.LIST_OFFSETS, listOffsetsBody([{ topic: q.topic, partitions: [{ partition: q.partition, timestamp }] }]), "ListOffsets v1", limits.small_frame);
  const answer = parseListOffsets(reader);
  const p = answer.find((t) => t.topic === q.topic)?.partitions.find((x) => x.partition === q.partition);
  if (p === undefined) throw new ProtocolError(`ListOffsets did not answer ${q.topic}/${q.partition}`);
  if (p.errorCode !== 0) throw new KafkaError(p.errorCode, `ListOffsets ${q.topic}/${q.partition}`);
  return p.offset;
}

// The offset the read starts at, and how it was found.
async function resolveOffset(conn: Connection, q: KafkaQuery, limits: KafkaLimits): Promise<number> {
  const spec = q.offset;
  if (spec.kind === "offset") return spec.offset;
  if (spec.kind === "earliest") return offsetAt(conn, q, EARLIEST, limits);
  if (spec.kind === "latest") {
    const latest = await offsetAt(conn, q, LATEST, limits);
    if (spec.back === 0) return latest;
    return Math.max(await offsetAt(conn, q, EARLIEST, limits), latest - spec.back);
  }
  const at = await offsetAt(conn, q, spec.ms, limits);
  return at === -1 ? offsetAt(conn, q, LATEST, limits) : at;
}

// Opens one socket within the connect cap.
async function openSocket(connect: Connect, address: SocketAddress, limits: KafkaLimits, wall: Deadline, opened: KafkaSocket[]): Promise<KafkaSocket> {
  const where = `${address.hostname}:${address.port}`;
  let socket: KafkaSocket;
  try {
    socket = connect(address, { secureTransport: "off", allowHalfOpen: false });
  } catch (err) {
    throw new SocketError(`connect ${where}: ${message(err)}`);
  }
  // Every socket is closed when the call ends, opened or not.
  opened.push(socket);
  const cap = new Deadline(limits.connect_ms, `connect ${where}`, () => {
    void socket.close().catch(() => {});
  });
  try {
    await wall.race(cap.race(socket.opened));
  } catch (err) {
    if (err instanceof DeadlineError) throw err;
    throw new SocketError(`connect ${where}: ${message(err)}`);
  } finally {
    cap.clear();
  }
  return socket;
}

function json(status: number, body: unknown): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}

// The probe's log line (src/index.ts logError), with the stage: one JSON line per
// failure of the read that answers 5xx. A 4xx is the caller's query or offset.
export function failureLine(id: string, err: KafkaRouteError): string {
  return JSON.stringify({ level: "error", worker: WORKER, op: PATH, id, stage: err.stage, status: err.status, error: err.message });
}

export interface KafkaRouteOptions {
  hostname?: string;
  port?: number;
  // The socket opener; cloudflare:sockets when not given.
  connect?: Connect;
  limits?: Partial<KafkaLimits>;
  // Where a failure line goes; console.error, which Workers Logs keeps, when not given.
  log?: (line: string) => void;
}

export function makeKafkaRoute(options: KafkaRouteOptions = {}): Route {
  const address: SocketAddress = { hostname: options.hostname ?? ZONESTREAM.hostname, port: options.port ?? ZONESTREAM.port };
  const limits: KafkaLimits = Object.freeze({ ...LIMITS, ...options.limits });
  const where = `${address.hostname}:${address.port}`;
  const log = options.log ?? ((line: string) => console.error(line));
  const readFrom = `Kafka Fetch v${VERSION[API.FETCH]} of one partition over a cloudflare:sockets TCP connection to ${where}`;

  async function handle(request: Request, _env: Env, url: URL, now: () => number): Promise<Response> {
    const q = parseQuery(url, limits);
    const started = now();
    const ms: Timings = { connect: null, api_versions: null, list_offsets: null, fetch: null, wall: null };
    const sockets: SocketReport = { asked: q.sockets, opened: 0, api_versions_ok: 0, errors: [] };
    const all: KafkaSocket[] = [];
    const closeAll = (): void => {
      // A close that fails leaves nothing to undo: the call is already past its cap.
      for (const socket of all) void socket.close().catch(() => {});
    };
    const wall = new Deadline(limits.wall_ms, `${PATH} wall time`, closeAll);
    let stage: Stage = "connect";
    try {
      let connect: Connect;
      try {
        connect = options.connect ?? (await loadConnect());
      } catch (err) {
        throw new SocketError(`connect ${where}: ${message(err)}`);
      }
      const opening = await Promise.allSettled(Array.from({ length: q.sockets }, () => openSocket(connect, address, limits, wall, all)));
      ms.connect = now() - started;
      const live: KafkaSocket[] = [];
      let firstFailure: unknown = null;
      for (const result of opening) {
        if (result.status === "fulfilled") live.push(result.value);
        else {
          firstFailure ??= result.reason;
          sockets.errors.push(`connect: ${message(result.reason)}`);
        }
      }
      sockets.opened = live.length;
      if (live.length === 0) throw routeError("connect", firstFailure);

      stage = "api_versions";
      const t1 = now();
      const conns = live.map((socket) => new Connection(socket, where, wall));
      const versions = await Promise.allSettled(conns.map((conn) => apiVersions(conn, limits)));
      ms.api_versions = now() - t1;
      let conn: Connection | null = null;
      let fetchVersions: ApiRange | null = null;
      firstFailure = null;
      for (let i = 0; i < versions.length; i += 1) {
        const result = versions[i]!;
        if (result.status === "rejected") {
          firstFailure ??= result.reason;
          sockets.errors.push(`api_versions: ${message(result.reason)}`);
          continue;
        }
        sockets.api_versions_ok += 1;
        if (conn === null) {
          conn = conns[i]!;
          fetchVersions = result.value;
        }
      }
      if (conn === null || fetchVersions === null) throw routeError("api_versions", firstFailure);

      stage = "list_offsets";
      const t2 = now();
      const offset = await resolveOffset(conn, q, limits);
      if (q.offset.kind !== "offset") ms.list_offsets = now() - t2;

      stage = "fetch";
      const t3 = now();
      const spec = { topics: [{ topic: q.topic, partitions: [{ partition: q.partition, offset, maxBytes: q.maxBytes }] }], maxWaitMs: q.maxWaitMs, minBytes: 1, maxBytes: q.maxBytes };
      const { reader, frameBytes } = await conn.request(API.FETCH, fetchBody(spec), `Fetch v${VERSION[API.FETCH]}`, q.maxBytes + limits.frame_slack);
      const answer = parseFetch(reader);
      ms.fetch = now() - t3;
      const part = answer.topics.find((t) => t.topic === q.topic)?.partitions.find((p) => p.partition === q.partition);
      if (part === undefined) throw new ProtocolError(`Fetch did not answer ${q.topic}/${q.partition}`);
      if (part.errorCode !== 0) throw new KafkaError(part.errorCode, `Fetch ${q.topic}/${q.partition} at offset ${offset}`);

      stage = "decode";
      const counted = countBatches(part.records ?? EMPTY, offset, now);
      ms.wall = now() - started;
      return json(200, {
        v: ANSWER_VERSION,
        entry: ENTRY,
        read_from: readFrom,
        topic: q.topic,
        partition: q.partition,
        offset,
        offset_from: q.offset.kind === "offset" ? "offset" : q.offsetText,
        max_bytes: q.maxBytes,
        max_wait_ms: q.maxWaitMs,
        messages: counted.messages,
        bytes: frameBytes,
        next_offset: counted.next_offset,
        decode_ms: counted.decode_ms,
        wire_bytes: counted.wire_bytes,
        raw_bytes: counted.raw_bytes,
        decoded_bytes: counted.decoded_bytes,
        batches: counted.batches,
        control_batches: counted.control_batches,
        by_codec: counted.by_codec,
        failed_batches: counted.failed_batches,
        failures: counted.failures,
        failed_by_codec: counted.failed_by_codec,
        first_failure: counted.first_failure,
        partial_bytes: counted.partial_bytes,
        high_watermark: part.highWatermark,
        lag: part.highWatermark - counted.next_offset,
        throttle_ms: answer.throttleMs,
        first_ts: isoOrNull(counted.first_ts),
        last_ts: isoOrNull(counted.last_ts),
        sockets,
        fetch_versions: fetchVersions,
        ms,
        call: q.call,
        limits,
      });
    } catch (err) {
      const failure = routeError(stage, err);
      ms.wall = now() - started;
      const id = request.headers.get("cf-ray") ?? crypto.randomUUID();
      if (failure.status >= 500) log(failureLine(id, failure));
      return json(failure.status, {
        v: ANSWER_VERSION,
        entry: ENTRY,
        error: failure.message,
        stage: failure.stage,
        id,
        topic: q.topic,
        partition: q.partition,
        offset_from: q.offsetText,
        sockets,
        ms,
        call: q.call,
        limits,
      });
    } finally {
      wall.clear();
      // Closing a socket the broker or a cap already closed may reject; the answer is decided by then.
      await Promise.allSettled(all.map(async (socket) => socket.close()));
    }
  }

  return {
    method: "GET",
    path: PATH,
    entry: ENTRY,
    summary: `one Fetch v${VERSION[API.FETCH]} of topic=<t> (partition=<p>, default 0) at offset=<n|earliest|latest|latest-N|UTC time> over a TCP socket to ${where}, at most max_bytes (default ${limits.default_max_bytes}, cap ${limits.max_bytes}); sockets=<1..${limits.sockets}> opens that many at once; ${limits.wall_ms} ms of wall time; answers messages, bytes, next_offset and decode_ms`,
    handle,
  };
}

// The row src/index.ts adds to ROUTES.
export const kafkaRoute: Route = makeKafkaRoute();

// Codec names as the answer's by_codec writes them, for a reader of the answer.
export const CODEC_NONE = codecName(0);
export const CODEC_SNAPPY = codecName(2);
