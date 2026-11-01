// packages/adapter/src/connect.ts — the TCP door of the adapter contract
// (ctx.connect): the recording of a conversation, its replay, and the tap that
// records one (docs/architecture.md section 5.6).
//
// A recording is one JSON file, `NAME.tcp.json`, beside the `NAME.http.json`
// recordings of harness.ts:
//   { "format": "domains.tcp-recording.v1",
//     "origin": "recorded", "recorded_at": "2026-11-01T00:10:08Z",   (or "origin": "synthetic")
//     "address": { "hostname": "kafka.zonestream.openintel.nl", "port": 9092 },
//     "exchanges": [ { "note": "ApiVersions v0", "request_base64": "...", "response_base64": "..." } ] }
// An exchange is the exact bytes of one client write and every byte the server
// answered to it. `note` is free text, and optional.
//
//   const { connect, connections, misses } = replayConnect(recordings);
//
// The replay knows no protocol. A connect to an address no recording names, or
// one that asks for TLS, is a miss: its `opened` rejects with ContractError
// `unrecorded`, and so do its streams. Each write on an open socket is one
// request: its bytes are looked up among the address's exchanges by byte
// equality, and the response is queued on the readable. A write that matches
// none is a miss: the write, and every read and write after it, reject with
// ContractError `unrecorded`. So is a read that waits idleMs past every byte
// recorded with no write since, which a recording cut short gives (an exchange
// of no answer byte is refused when the file is read). The contract rests on one rule: a client writes
// each request in one write() call (harness.ts states it too). Nothing is
// rewritten: a request's correlation id is in its bytes, so a deterministic
// client that numbers its requests from 1 on each connection writes, from the
// same cursor, the same bytes, and finds the same exchanges.
//
//   const tap = tapConnect(liveConnect(), prior);       // records a conversation
//   ...the adapter runs with tap.connect...
//   encodeTcpRecording({ origin: "recorded", recordedAt, address, exchanges: tap.exchanges });
//
// It imports nothing from `node:`, so it runs in Node and in workerd alike.
import { base64Of, bytesOfBase64, sha256Hex } from "./json.ts";
import type { AdapterSocket, Connect, SocketAddress } from "./types.ts";
import { ContractError, isIsoUtc } from "./validate.ts";

export const TCP_RECORDING_FORMAT = "domains.tcp-recording.v1";
export const TCP_RECORDING_SUFFIX = ".tcp.json";
const MAX_PORT = 65_535;

export interface TcpExchange {
  readonly note: string | null;
  readonly request: Uint8Array;
  readonly response: Uint8Array;
}

export interface TcpRecording {
  readonly name: string;
  readonly origin: "recorded" | "synthetic";
  readonly recordedAt: string | null;
  readonly address: SocketAddress;
  readonly exchanges: readonly TcpExchange[];
}

// One request written on a replayed connection: its size, its SHA-256, and the
// exchange that answered it (`NAME#I`, I from 0), or null for a miss.
export interface TcpRequestLog {
  readonly bytes: number;
  readonly sha256: string;
  readonly exchange: string | null;
}

export interface ConnectionLog {
  // HOST:PORT
  readonly address: string;
  // false for a miss: no recording names the address, or the connect asked for TLS.
  readonly opened: boolean;
  readonly requests: readonly TcpRequestLog[];
}

export interface ConnectMiss {
  readonly address: string;
  readonly detail: string;
}

export interface ConnectReplay {
  readonly connect: Connect;
  readonly connections: readonly ConnectionLog[];
  readonly misses: readonly ConnectMiss[];
}

// An exchange a tap took, with the address it was taken on.
export interface TappedExchange extends TcpExchange {
  readonly address: SocketAddress;
}

export interface Tap {
  readonly connect: Connect;
  // The exchanges sent to the live socket, in the order written; each response
  // is every byte read until the next write or the end of the connection.
  readonly exchanges: readonly TappedExchange[];
}

type Obj = Readonly<Record<string, unknown>>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function bad(name: string, detail: string): ContractError {
  return new ContractError("recording", `${name}: ${detail}`);
}

const where = (a: SocketAddress): string => `${a.hostname}:${a.port}`;

// A hostname of the recording grammar: printable, with no space or slash.
const HOSTNAME = /^[!-.0-~]+$/;

function addressOf(v: unknown, name: string): SocketAddress {
  if (!isObject(v)) throw bad(name, "address is not an object");
  for (const k of Object.keys(v)) if (k !== "hostname" && k !== "port") throw bad(name, `unknown field address.${k}`);
  if (typeof v.hostname !== "string" || !HOSTNAME.test(v.hostname)) throw bad(name, "address.hostname is not a hostname");
  if (typeof v.port !== "number" || !Number.isInteger(v.port) || v.port < 1 || v.port > MAX_PORT) throw bad(name, `address.port is not an integer from 1 to ${MAX_PORT}`);
  return { hostname: v.hostname, port: v.port };
}

// One recording file's JSON, checked field by field.
export function parseTcpRecording(json: unknown, name: string): TcpRecording {
  if (!isObject(json)) throw bad(name, "not an object");
  for (const k of Object.keys(json)) if (!["format", "origin", "recorded_at", "address", "exchanges"].includes(k)) throw bad(name, `unknown field ${k}`);
  if (json.format !== TCP_RECORDING_FORMAT) throw bad(name, `format is not ${TCP_RECORDING_FORMAT}`);
  const origin = json.origin;
  if (origin !== "recorded" && origin !== "synthetic") throw bad(name, 'origin is not "recorded" or "synthetic"');
  // A recorded conversation names the time it was read; a synthetic one says so.
  if (origin === "recorded" && !isIsoUtc(json.recorded_at)) throw bad(name, "a recorded conversation needs recorded_at, an ISO 8601 UTC time");
  if (origin === "synthetic" && json.recorded_at !== undefined) throw bad(name, "a synthetic conversation has no recorded_at");
  const address = addressOf(json.address, name);
  if (!Array.isArray(json.exchanges) || json.exchanges.length === 0) throw bad(name, "exchanges is not a list of at least one exchange");
  const exchanges = json.exchanges.map((x: unknown, i: number): TcpExchange => {
    const at = `exchanges[${i}]`;
    if (!isObject(x)) throw bad(name, `${at} is not an object`);
    for (const k of Object.keys(x)) if (!["note", "request_base64", "response_base64"].includes(k)) throw bad(name, `unknown field ${at}.${k}`);
    if (x.note !== undefined && typeof x.note !== "string") throw bad(name, `${at}.note is not a string`);
    const request = bytesOfBase64(x.request_base64);
    if (request === null) throw bad(name, `${at}.request_base64 is not base64`);
    // A write of no byte is no request: nothing could look it up.
    if (request.byteLength === 0) throw bad(name, `${at}.request_base64 holds no byte`);
    const response = bytesOfBase64(x.response_base64);
    if (response === null) throw bad(name, `${at}.response_base64 is not base64`);
    // An answer of no byte cannot be told from a recording cut short, and
    // every request of the protocols adapters speak draws an answer.
    if (response.byteLength === 0) throw bad(name, `${at}.response_base64 holds no byte`);
    return { note: x.note ?? null, request, response };
  });
  return { name, origin, recordedAt: origin === "recorded" ? (json.recorded_at as string) : null, address, exchanges };
}

// The bytes as a string of one code unit a byte: a Map key that is equal for
// equal bytes and only for them.
function binary(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return out;
}

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);

// A socket that never opened: `opened` and both streams fail with err.
function refusedSocket(err: Error): AdapterSocket {
  const opened = Promise.reject(err);
  // The error reaches the adapter through its streams as well, and the harness
  // fails the run on the miss logged; an adapter need not await opened.
  opened.catch(() => {});
  return {
    readable: new ReadableStream<Uint8Array>({
      start(c) {
        c.error(err);
      },
    }),
    writable: new WritableStream<Uint8Array>({
      start(c) {
        c.error(err);
      },
    }),
    opened,
    close: async () => {},
  };
}

interface Answer {
  readonly response: Uint8Array;
  readonly id: string;
}

// The exchanges of each address, by request bytes. Two exchanges of one address
// with equal requests and other responses are refused; equal pairs are kept once.
function answersOf(recordings: readonly TcpRecording[]): Map<string, Map<string, Answer>> {
  const byAddress = new Map<string, Map<string, Answer>>();
  for (const r of recordings) {
    const at = where(r.address);
    let answers = byAddress.get(at);
    if (answers === undefined) {
      answers = new Map();
      byAddress.set(at, answers);
    }
    r.exchanges.forEach((x, i) => {
      const id = `${r.name}#${i}`;
      const key = binary(x.request);
      const was = answers.get(key);
      if (was === undefined) answers.set(key, { response: x.response, id });
      else if (!bytesEqual(was.response, x.response)) throw new ContractError("recording", `${id}: another recording answers the same request otherwise (${was.id})`);
    });
  }
  return byAddress;
}

// A read that waits this long on a replayed socket, with every recorded byte
// read and no write since, waits for bytes no recording holds: a recording
// cut short. liveConnect's idleMs bounds the live socket the same way.
export const REPLAY_IDLE_MS = 10_000;

// ctx.connect of the harness: the recordings replayed. `chunkBytes` splits each
// response into chunks of at most that many bytes, as a socket may deliver it.
// `idleMs` (REPLAY_IDLE_MS by default) ends a read that waits past every
// recorded byte: a miss, so the run fails as unrecorded and does not hang.
export function replayConnect(recordings: readonly TcpRecording[], options: { chunkBytes?: number; idleMs?: number } = {}): ConnectReplay {
  if (!Array.isArray(recordings)) throw new ContractError("options", "tcp recordings is not a list");
  const chunkBytes = options.chunkBytes;
  if (chunkBytes !== undefined && (!Number.isInteger(chunkBytes) || chunkBytes < 1)) throw new ContractError("options", `chunkBytes ${chunkBytes} is not a positive integer`);
  const idleMs = options.idleMs ?? REPLAY_IDLE_MS;
  if (!Number.isInteger(idleMs) || idleMs < 1) throw new ContractError("options", `idleMs ${idleMs} is not a positive integer`);
  const byAddress = answersOf(recordings);
  const connections: ConnectionLog[] = [];
  const misses: ConnectMiss[] = [];
  const connect: Connect = (address, options) => {
    const at = typeof address?.hostname === "string" && typeof address?.port === "number" ? where(address) : JSON.stringify(address);
    const requests: TcpRequestLog[] = [];
    const answers = byAddress.get(at);
    const tls = options?.secureTransport;
    if (answers === undefined || (tls !== undefined && tls !== "off")) {
      const detail = answers === undefined ? `connect ${at}: no recording` : `connect ${at} with secureTransport ${JSON.stringify(tls)}: TLS is not recorded`;
      connections.push({ address: at, opened: false, requests });
      misses.push({ address: at, detail });
      return refusedSocket(new ContractError("unrecorded", detail));
    }
    connections.push({ address: at, opened: true, requests });
    let rc!: ReadableStreamDefaultController<Uint8Array>;
    // The readable is closed, errored or cancelled: nothing more is queued on it.
    let ended = false;
    let closed = false;
    let failed: ContractError | null = null;
    // The timer of a read that waits with nothing queued (pull runs only then,
    // the high-water mark being 0); a write, a close or a cancel stops it.
    let idle: ReturnType<typeof setTimeout> | null = null;
    const quiet = (): void => {
      if (idle !== null) clearTimeout(idle);
      idle = null;
    };
    const readable = new ReadableStream<Uint8Array>(
      {
        start(c) {
          rc = c;
        },
        pull() {
          quiet();
          if (ended) return;
          idle = setTimeout(() => {
            idle = null;
            if (ended) return;
            const detail = `${at}: a read waited ${idleMs} ms past every byte recorded, with no write: the recording of the last request is cut short`;
            misses.push({ address: at, detail });
            failed = new ContractError("unrecorded", detail);
            rc.error(failed);
            ended = true;
          }, idleMs);
        },
        cancel() {
          quiet();
          ended = true;
        },
      },
      { highWaterMark: 0 },
    );
    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        quiet();
        if (failed !== null) throw failed;
        if (closed) throw new TypeError(`${at}: a write after close()`);
        if (!(chunk instanceof Uint8Array)) throw new TypeError(`${at}: a write of ${Object.prototype.toString.call(chunk)}, not a Uint8Array`);
        const request = chunk.slice();
        const sha256 = await sha256Hex(request);
        const hit = answers.get(binary(request));
        requests.push({ bytes: request.byteLength, sha256, exchange: hit?.id ?? null });
        if (hit === undefined) {
          const detail = `${at}: no recording for a request of ${request.byteLength} bytes, sha256 ${sha256}`;
          misses.push({ address: at, detail });
          failed = new ContractError("unrecorded", detail);
          if (!ended) rc.error(failed);
          ended = true;
          throw failed;
        }
        if (ended) return;
        const step = chunkBytes ?? Math.max(1, hit.response.byteLength);
        for (let i = 0; i < hit.response.byteLength; i += step) rc.enqueue(hit.response.slice(i, i + step));
      },
    });
    const opened = Promise.resolve({ remoteAddress: at });
    return {
      readable,
      writable,
      opened,
      async close() {
        quiet();
        if (closed) return;
        closed = true;
        // The readable gives what it holds, then is done.
        if (!ended) rc.close();
        ended = true;
      },
    };
  };
  return { connect, connections, misses };
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

// A connect that records the conversations of `connect`. A write whose bytes
// equal a request of `prior` on the same address is answered from `prior` and
// never sent; any other is sent, and every byte the live socket delivers until
// the next write, or the end of the connection, is its response. That is exact
// for a client with one request in flight, which reads each answer whole
// before it writes again.
export function tapConnect(connect: Connect, prior: readonly TappedExchange[] = []): Tap {
  const answers = new Map<string, Uint8Array>();
  prior.forEach((x, i) => {
    const key = `${where(x.address)}\n${binary(x.request)}`;
    const was = answers.get(key);
    if (was !== undefined && !bytesEqual(was, x.response)) throw new ContractError("recording", `prior[${i}]: another prior exchange answers the same request otherwise`);
    answers.set(key, x.response);
  });
  const taken: { address: SocketAddress; request: Uint8Array; parts: Uint8Array[] }[] = [];
  const tapped: Connect = (address, options) => {
    const live = connect(address, options);
    const at = where(address);
    const copy = { hostname: address.hostname, port: address.port };
    let current: { address: SocketAddress; request: Uint8Array; parts: Uint8Array[] } | null = null;
    let rc!: ReadableStreamDefaultController<Uint8Array>;
    const reader = live.readable.getReader();
    const writer = live.writable.getWriter();
    const readable = new ReadableStream<Uint8Array>({
      start(c) {
        rc = c;
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    // Every byte of the live socket, kept against the request it answers and
    // passed on. It ends with the socket, and it never rejects: a failure
    // errors the readable the adapter reads.
    const pump = async (): Promise<void> => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (current === null) throw new ContractError("recording", `${at}: the server sent ${value.byteLength} bytes that answer no request sent`);
          current.parts.push(value.slice());
          rc.enqueue(value);
        }
        rc.close();
      } catch (err) {
        rc.error(err);
      }
    };
    void pump();
    const writable = new WritableStream<Uint8Array>({
      async write(chunk) {
        const request = chunk.slice();
        const answer = answers.get(`${at}\n${binary(request)}`);
        if (answer !== undefined) {
          current = null;
          rc.enqueue(answer.slice());
          return;
        }
        current = { address: copy, request, parts: [] };
        taken.push(current);
        await writer.write(request);
      },
      async close() {
        await writer.close();
      },
      async abort(reason) {
        await writer.abort(reason);
      },
    });
    return { readable, writable, opened: live.opened, close: () => live.close() };
  };
  return {
    connect: tapped,
    get exchanges(): readonly TappedExchange[] {
      return taken.map((t) => ({ address: t.address, note: null, request: t.request, response: concat(t.parts) }));
    },
  };
}

export interface TcpRecordingInput {
  readonly origin: "recorded" | "synthetic";
  // For a recorded conversation: when it was read, ISO 8601 UTC.
  readonly recordedAt?: string;
  readonly address: SocketAddress;
  // The exchanges of `address`, in order; equal pairs are written once. A
  // TappedExchange of another address is refused.
  readonly exchanges: readonly (TcpExchange | TappedExchange)[];
}

// The text of a `NAME.tcp.json` file: JSON of two-space indent and a final
// newline, held to parseTcpRecording before it is returned, so a file this
// writes always reads back.
export function encodeTcpRecording(input: TcpRecordingInput): string {
  const at = where(input.address);
  const seen = new Map<string, Uint8Array>();
  const exchanges: Record<string, string>[] = [];
  input.exchanges.forEach((x, i) => {
    if ("address" in x && where(x.address) !== at) throw new ContractError("recording", `exchanges[${i}] was taken on ${where(x.address)}, not ${at}`);
    const key = binary(x.request);
    const was = seen.get(key);
    if (was !== undefined) {
      if (!bytesEqual(was, x.response)) throw new ContractError("recording", `exchanges[${i}]: an exchange before it answers the same request otherwise`);
      return;
    }
    seen.set(key, x.response);
    exchanges.push({ ...(x.note === null ? {} : { note: x.note }), request_base64: base64Of(x.request), response_base64: base64Of(x.response) });
  });
  const json = {
    format: TCP_RECORDING_FORMAT,
    origin: input.origin,
    ...(input.recordedAt === undefined ? {} : { recorded_at: input.recordedAt }),
    address: { hostname: input.address.hostname, port: input.address.port },
    exchanges,
  };
  const text = `${JSON.stringify(json, null, 2)}\n`;
  parseTcpRecording(JSON.parse(text), "the encoded recording");
  return text;
}
