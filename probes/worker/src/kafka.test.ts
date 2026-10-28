// probes/worker/src/kafka.test.ts — DOM-005's /kafka route under Node, its socket
// replaced by an in-memory one that speaks to the fake broker of DOM-004's tests
// (scripts/measure/fixtures/kafka/broker.mjs, synthetic batches) or replays the
// broker's answers recorded at 2026-10-28T10:40:45Z (scripts/measure/fixtures/kafka/).
// This is the mock tier: it plants the faults the real broker will not produce on
// demand. test/kafka-workerd.test.ts runs the route in workerd with the production
// connect over TCP, and the deployed probe is the acceptance test (the entry's Prove).
//
//   node scripts/test.mjs probes/worker --name "kafka"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { FakeBroker, makePartition, zonestreamLike } from "../../../scripts/measure/fixtures/kafka/broker.mjs";
import { buildBatch, fetchResponse, frame, listOffsetsResponse } from "../../../scripts/measure/fixtures/kafka/build.mjs";
import { FrameReader } from "../../../scripts/measure/kafka-client.mjs";
import * as mjs from "../../../scripts/measure/kafka-protocol.mjs";
import { ProbeError, WORKER } from "./gaps.ts";
import { type Connect, CODEC_NONE, CODEC_SNAPPY, type KafkaLimits, type KafkaSocket, kafkaRoute, LIMITS, makeKafkaRoute, parseQuery, type SocketAddress, ZONESTREAM } from "./kafka.ts";
import type { Env } from "./types.ts";

const FIXTURES = fileURLToPath(new URL("../../../scripts/measure/fixtures/kafka/", import.meta.url));
// The route reads no binding.
const ENV = {} as unknown as Env;
const MIN = 60_000;
const NOW = Date.parse("2026-10-28T12:00:00.000Z");
const CS_BASE = 42_000_000_000;
const NRD_BASE = 166_000_000;

type Handler = (request: Buffer) => Buffer | null;

interface FakeOptions {
  // Write each answer this many bytes at a time.
  chunk?: number;
  // opened rejects with this message.
  refuse?: string;
  // opened never settles.
  hang?: boolean;
  // connect() itself throws.
  throwOnConnect?: string;
  // Write only this many bytes of the Fetch answer, then end the stream.
  cutFetchAt?: number;
}

// A cloudflare:sockets Socket in memory: what the route writes is split into
// request frames for the handler, and its answers are queued on the readable side.
class FakeSocket implements KafkaSocket {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly opened: Promise<unknown>;
  closed = false;
  private controller: ReadableStreamDefaultController<Uint8Array> | null = null;

  constructor(handler: Handler, options: FakeOptions) {
    this.readable = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
      },
    });
    const frames = new FrameReader((frame: Buffer) => {
      const answer = handler(frame);
      if (answer === null) return;
      if (options.cutFetchAt !== undefined && frame.readInt16BE(0) === 1) {
        this.send(answer.subarray(0, options.cutFetchAt), options);
        void this.close();
      } else this.send(answer, options);
    });
    this.writable = new WritableStream<Uint8Array>({ write: (chunk) => frames.push(Buffer.from(chunk)) });
    this.opened = options.refuse !== undefined ? Promise.reject(new Error(options.refuse)) : options.hang ? new Promise(() => {}) : Promise.resolve({});
  }

  private send(bytes: Buffer, options: FakeOptions): void {
    if (this.closed || this.controller === null) return;
    const n = options.chunk ?? bytes.length;
    for (let p = 0; p < bytes.length; p += n) this.controller.enqueue(new Uint8Array(bytes.subarray(p, p + n)));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.controller?.close();
  }
}

function fakeConnect(handler: Handler, perSocket: (i: number) => FakeOptions = () => ({})) {
  const made: { address: SocketAddress; socket: FakeSocket }[] = [];
  const connect: Connect = (address, options) => {
    assert.deepEqual(options, { secureTransport: "off", allowHalfOpen: false });
    const o = perSocket(made.length);
    if (o.throwOnConnect !== undefined) throw new Error(o.throwOnConnect);
    const socket = new FakeSocket(handler, o);
    made.push({ address, socket });
    return socket;
  };
  return { connect, made };
}

const brokerHandler =
  (broker: FakeBroker): Handler =>
  (request) =>
    broker.handle(request);

interface Answer {
  status: number;
  body: Record<string, unknown> & {
    messages: number;
    bytes: number;
    next_offset: number;
    decode_ms: number;
    offset: number;
    lag: number;
    high_watermark: number;
    wire_bytes: number;
    raw_bytes: number;
    batches: number;
    failed_batches: number;
    failures: Record<string, number>;
    by_codec: Record<string, number>;
    partial_bytes: number;
    sockets: { asked: number; opened: number; api_versions_ok: number; errors: string[] };
    stage?: string;
    error?: string;
    id?: string;
  };
}

async function ask(route: ReturnType<typeof makeKafkaRoute>, query: string, headers: Record<string, string> = {}): Promise<Answer> {
  const url = new URL(`https://probe.test/kafka?${query}`);
  const res = await route.handle(new Request(url, { headers }), ENV, url, Date.now);
  assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(res.headers.get("cache-control"), "no-store");
  return { status: res.status, body: (await res.json()) as Answer["body"] };
}

function routeOn(handler: Handler, extra: { limits?: Partial<KafkaLimits>; perSocket?: (i: number) => FakeOptions } = {}) {
  const lines: string[] = [];
  const { connect, made } = fakeConnect(handler, extra.perSocket);
  const route = makeKafkaRoute({ connect, limits: extra.limits, log: (line) => lines.push(line) });
  return { route, made, lines };
}

// The fixture is JavaScript: TypeScript infers its default `corruptCertstream = []` as never[].
const zonestreamAt = zonestreamLike as (nowMs: number, options?: { corruptCertstream?: number[] }) => ReturnType<typeof zonestreamLike>;
const zonestream = () => new FakeBroker(zonestreamAt(NOW));
const iso = (ms: number) => new Date(ms).toISOString();

test("kafka route: the production route is GET /kafka of DOM-005 against kafka.zonestream.openintel.nl:9092, and in Node, which has no cloudflare:sockets, it answers 502 at connect", async () => {
  assert.equal(kafkaRoute.method, "GET");
  assert.equal(kafkaRoute.path, "/kafka");
  assert.equal(kafkaRoute.entry, "DOM-005");
  assert.deepEqual({ ...ZONESTREAM }, { hostname: "kafka.zonestream.openintel.nl", port: 9092 });
  assert.match(kafkaRoute.summary, /kafka\.zonestream\.openintel\.nl:9092/);
  const url = new URL("https://probe.test/kafka?topic=certstream_domains&offset=latest");
  // The production logger is console.error, which Workers Logs keeps: read what it writes.
  const logged: unknown[][] = [];
  const consoleError = console.error;
  console.error = (...args: unknown[]) => logged.push(args);
  let res: Response;
  try {
    res = await kafkaRoute.handle(new Request(url, { headers: { "cf-ray": "8f01-TEST" } }), ENV, url, Date.now);
  } finally {
    console.error = consoleError;
  }
  assert.equal(res.status, 502);
  const body = (await res.json()) as Answer["body"];
  assert.equal(body.stage, "connect");
  assert.match(body.error!, /^connect kafka\.zonestream\.openintel\.nl:9092: .*cloudflare:/);
  assert.equal(body.sockets.opened, 0);
  assert.equal(logged.length, 1);
  assert.deepEqual(JSON.parse(String(logged[0]![0])), { level: "error", worker: WORKER, op: "/kafka", id: "8f01-TEST", stage: "connect", status: 502, error: body.error });
});

test("kafka route: a certstream_domains-like topic read from a time decodes its snappy xerial batches and counts the records at or after it", async () => {
  const broker = zonestream();
  const { route, made } = routeOn(brokerHandler(broker));
  const from = NOW - 15 * MIN;
  const { status, body } = await ask(route, `topic=certstream_domains&offset=${iso(from)}&call=t-1`);
  assert.equal(status, 200, JSON.stringify(body));
  // One message every 30 s from NOW - 26 h: the first at or after NOW - 15 min is the 3,090th.
  assert.equal(body.offset, CS_BASE + 3090);
  assert.equal(body.offset_from, iso(from));
  assert.equal(body.messages, 30);
  assert.equal(body.high_watermark, CS_BASE + 3120);
  assert.equal(body.next_offset, CS_BASE + 3120);
  assert.equal(body.lag, 0);
  assert.equal(body.batches, 2, "the batch holding offset 3,090 and the one after it");
  assert.deepEqual(body.by_codec, { [CODEC_SNAPPY]: 2 });
  assert.equal(body.failed_batches, 0);
  const part = broker.topics.certstream_domains[0];
  assert.equal(
    body.wire_bytes,
    part.batches.slice(-2).reduce((a: number, b: { bytes: Buffer }) => a + b.bytes.length, 0),
  );
  assert.ok(body.bytes > body.wire_bytes, "the response frame holds the batches and its own framing");
  assert.ok(body.raw_bytes > 0);
  assert.equal(body.first_ts, iso(NOW - 26 * 60 * MIN + 3090 * 30_000));
  assert.equal(body.call, "t-1");
  assert.equal(typeof body.decode_ms, "number");
  assert.deepEqual(body.sockets, { asked: 1, opened: 1, api_versions_ok: 1, errors: [] });
  assert.deepEqual(body.limits, { ...LIMITS });
  assert.equal(made.length, 1);
  assert.deepEqual(made[0]!.address, { ...ZONESTREAM });
  assert.ok(made[0]!.socket.closed, "the socket is closed when the call ends");
  // ApiVersions, ListOffsets for the time, then one Fetch, all as a client of id domains.pkgforge.dev.
  assert.deepEqual(
    broker.requests.map((r: { apiKey: number; apiVersion: number }) => [r.apiKey, r.apiVersion]),
    [
      [18, 0],
      [2, 1],
      [1, 4],
    ],
  );
  assert.ok(broker.requests.every((r: { clientId: string }) => r.clientId === "domains.pkgforge.dev"));
});

test("kafka route: an NRD-like topic read from its earliest offset decodes codec none, one record a batch", async () => {
  const { route } = routeOn(brokerHandler(zonestream()));
  const { status, body } = await ask(route, "topic=newly_registered_domain&offset=earliest&max_bytes=8192");
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.offset, NRD_BASE);
  assert.equal(body.offset_from, "earliest");
  assert.ok(body.messages > 10);
  assert.equal(body.messages, body.batches);
  assert.deepEqual(body.by_codec, { [CODEC_NONE]: body.batches });
  assert.equal(body.next_offset, NRD_BASE + body.messages);
  assert.ok(body.partial_bytes > 0, "the broker cut the answer at max_bytes, inside a batch");
  assert.ok(body.bytes <= 8192 + 200, "the answer holds max_bytes of batches and its own framing");
});

test("kafka route: reading on from each next_offset covers the log once, with no gap and no repeat", async () => {
  const { route } = routeOn(brokerHandler(zonestream()));
  let offset = "earliest";
  let total = 0;
  let calls = 0;
  let previousNext: number | null = null;
  for (;;) {
    const { status, body } = await ask(route, `topic=newly_registered_fqdn&offset=${offset}&max_bytes=4096`);
    assert.equal(status, 200, JSON.stringify(body));
    if (previousNext !== null) assert.equal(body.offset, previousNext);
    assert.equal(body.next_offset - body.offset, body.messages, "one record a batch, none skipped");
    total += body.messages;
    calls += 1;
    previousNext = body.next_offset;
    offset = String(body.next_offset);
    if (body.lag === 0) break;
    assert.ok(calls < 200, "the read reaches the head");
  }
  assert.equal(total, 12 * 144, "every message of the topic, once");
  assert.ok(calls > 10, "in many calls of 4 KiB");
});

test("kafka route: latest-N reads the last N messages, clamped at the earliest; latest and a time past the head read from the head", async () => {
  const { route } = routeOn(brokerHandler(zonestream()));
  const last = await ask(route, "topic=newly_registered_domain&offset=latest-100");
  assert.equal(last.body.offset, NRD_BASE + 1728 - 100);
  assert.equal(last.body.messages, 100);
  const clamped = await ask(route, "topic=newly_registered_domain&offset=latest-100000&max_bytes=1");
  assert.equal(clamped.body.offset, NRD_BASE, "clamped at the earliest offset");
  assert.equal(clamped.body.messages, 1, "the broker returns the first batch whole however small max_bytes is");
  for (const offset of ["latest", iso(NOW + 60 * MIN)]) {
    const head = await ask(route, `topic=newly_registered_domain&offset=${offset}`);
    assert.equal(head.status, 200);
    assert.equal(head.body.offset, NRD_BASE + 1728, offset);
    assert.equal(head.body.messages, 0);
    assert.equal(head.body.next_offset, head.body.offset, "no batch, no progress");
    assert.equal(head.body.lag, 0);
  }
});

test("kafka route: an answer written a few bytes at a time decodes to the same counts", async () => {
  const query = `topic=certstream_domains&offset=${CS_BASE + 3000}`;
  const whole = await ask(routeOn(brokerHandler(zonestream())).route, query);
  const bytewise = await ask(routeOn(brokerHandler(zonestream()), { perSocket: () => ({ chunk: 7 }) }).route, query);
  const counts = ({ ms, decode_ms, ...rest }: Answer["body"]) => rest;
  assert.equal(whole.status, 200);
  assert.deepEqual(counts(bytewise.body), counts(whole.body));
});

test("kafka route: the broker's recorded answers decode as scripts/measure/kafka-protocol.mjs decodes them", async () => {
  const recorded = JSON.parse(readFileSync(`${FIXTURES}recorded.json`, "utf8"));
  const frame = (name: string) => readFileSync(`${FIXTURES}${name}`);
  for (const [file, codec] of [
    ["fetch-v4-certstream_domains.bin", CODEC_SNAPPY],
    ["fetch-v4-newly_registered_domain.bin", CODEC_NONE],
  ] as const) {
    const ask0 = recorded.files[file].request.topics[0];
    const start: number = ask0.partitions[0].offset;
    // The recorded frame, its correlation id set to the request's.
    const handler: Handler = (request) => {
      const source = request.readInt16BE(0) === 18 ? frame("api-versions-v0.bin") : request.readInt16BE(0) === 1 ? frame(file) : null;
      assert.ok(source !== null, `the route sent API ${request.readInt16BE(0)}`);
      const out = Buffer.from(source);
      out.writeInt32BE(request.readInt32BE(4), 4);
      return out;
    };
    const { status, body } = await ask(routeOn(handler).route, `topic=${ask0.topic}&offset=${start}&max_bytes=${ask0.partitions[0].maxBytes}`);
    assert.equal(status, 200, JSON.stringify(body));
    // The same answer through the script's parser and decoder.
    const p = mjs.parseFetch(new mjs.Reader(frame(file).subarray(8), file)).topics[0].partitions[0];
    const { batches, partial } = mjs.splitBatches(p.records);
    const counted = batches.filter((b: { lastOffset: number }) => b.lastOffset >= start);
    const records = counted.flatMap((b: { bytes: Buffer }) => mjs.decodeBatch(b.bytes).records).filter((r: { offset: number }) => r.offset >= start);
    assert.equal(body.messages, records.length, file);
    assert.equal(
      body.raw_bytes,
      records.reduce((a: number, r: { value: Buffer }) => a + r.value.length, 0),
      file,
    );
    assert.equal(
      body.wire_bytes,
      counted.reduce((a: number, b: { size: number }) => a + b.size, 0),
      file,
    );
    assert.equal(body.next_offset, counted[counted.length - 1]!.lastOffset + 1, file);
    assert.equal(body.partial_bytes, partial, file);
    assert.equal(body.high_watermark, p.highWatermark, file);
    assert.equal(body.bytes, frame(file).length, file);
    assert.deepEqual(body.by_codec, { [codec]: counted.length }, file);
    assert.equal(body.failed_batches, 0, file);
  }
});

// A partition whose batch at `at` is replaced by `replace(bytes)`, its CRC-32C recomputed.
function plantedTopic(codec: string, replace: (bytes: Buffer) => Buffer) {
  const records = Array.from({ length: 60 }, (_, i) => ({ timestamp: NOW - 60 * MIN + i * MIN, value: JSON.stringify({ domain: `p${i}.example` }) }));
  const part = makePartition({ baseOffset: 500, records, perBatch: 10, codec });
  const victim = part.batches[2];
  const bytes = replace(Buffer.from(victim.bytes));
  bytes.writeUInt32BE(mjs.crc32c(bytes, 21), 17);
  victim.bytes = Buffer.from(bytes);
  return new FakeBroker({ planted: [part] });
}

test("kafka route: a batch that fails its CRC-32C, its snappy payload or its record count is counted by kind, and the read goes on past it", async () => {
  const cases: [string, FakeBroker, string, string][] = [
    ["a flipped byte", new FakeBroker(zonestreamAt(NOW, { corruptCertstream: [CS_BASE + 3080] })), "certstream_domains", "crc"],
    [
      "a snappy payload that does not decode",
      plantedTopic("snappy", (b) => {
        // A block that declares 32 bytes and holds a literal of 1.
        const bad = Buffer.concat([b.subarray(0, 61), Buffer.from([0x20, 0x00, 0x61])]);
        bad.writeInt32BE(bad.length - 12, 8);
        return bad;
      }),
      "planted",
      "snappy",
    ],
    [
      "one record more declared than held",
      plantedTopic("none", (b) => {
        b.writeInt32BE(b.readInt32BE(57) + 1, 57);
        return b;
      }),
      "planted",
      "records",
    ],
    ["a gzip batch", new FakeBroker({ planted: [makePartition({ baseOffset: 500, records: [{ timestamp: NOW, value: "{}" }], codec: "gzip" })] }), "planted", "codec"],
  ];
  for (const [name, broker, topic, kind] of cases) {
    const start = topic === "certstream_domains" ? CS_BASE + 3080 : 500;
    const { status, body } = await ask(routeOn(brokerHandler(broker)).route, `topic=${topic}&offset=${start}`);
    assert.equal(status, 200, name);
    assert.equal(body.failed_batches, 1, name);
    assert.deepEqual(body.failures, { [kind]: 1 }, name);
    assert.match(String(body.first_failure), new RegExp(`^offset \\d+: ${kind}: `), name);
    assert.equal(body.next_offset, body.high_watermark, `${name}: the read goes on past the failed batch`);
  }
  // Without the plant, the same reads decode whole.
  const clean = await ask(routeOn(brokerHandler(zonestream())).route, `topic=certstream_domains&offset=${CS_BASE + 3080}`);
  assert.equal(clean.body.failed_batches, 0);
  assert.equal(clean.body.messages, 40);
});

test("kafka route: a control batch counts as a batch and none of its records as messages", async () => {
  const control = buildBatch({ baseOffset: 510, records: [{ timestamp: NOW, value: "x" }], codec: "none", control: true });
  const data = makePartition({ baseOffset: 500, records: Array.from({ length: 10 }, (_, i) => ({ timestamp: NOW + i, value: `v${i}` })), codec: "none", perBatch: 10 });
  data.batches.push({ baseOffset: 510, lastOffset: 510, timestamps: [NOW], bytes: control });
  data.hwm = 511;
  const { body } = await ask(routeOn(brokerHandler(new FakeBroker({ t: [data] }))).route, "topic=t&offset=500");
  assert.equal(body.batches, 2);
  assert.equal(body.control_batches, 1);
  assert.equal(body.messages, 10);
  assert.equal(body.next_offset, 511);
});

test("kafka route: a broker error is answered with its status: offset out of range 416, unknown topic 404, any other 502, and only a 5xx is logged", async () => {
  const cases: [string, FakeBroker, string, number, string][] = [
    ["an offset past the head", zonestream(), `topic=certstream_domains&offset=${CS_BASE + 99_999}`, 416, "fetch"],
    ["an unknown topic at a number", zonestream(), "topic=nope&offset=0", 404, "fetch"],
    ["an unknown topic at earliest", zonestream(), "topic=nope&offset=earliest", 404, "list_offsets"],
    ["NOT_LEADER_OR_FOLLOWER", new FakeBroker(zonestreamLike(NOW), { fetchError: { topic: "certstream_domains", partition: 0, code: 6 } }), `topic=certstream_domains&offset=${CS_BASE}`, 502, "fetch"],
  ];
  for (const [name, broker, query, statusWanted, stage] of cases) {
    const { route, lines } = routeOn(brokerHandler(broker));
    const { status, body } = await ask(route, query, { "cf-ray": "8f00-TEST" });
    assert.equal(status, statusWanted, name);
    assert.equal(body.stage, stage, name);
    assert.match(body.error!, /broker error \d+ [A-Z_]+/, name);
    assert.equal(body.id, "8f00-TEST", name);
    if (statusWanted >= 500) {
      assert.equal(lines.length, 1, name);
      assert.deepEqual(JSON.parse(lines[0]!), { level: "error", worker: WORKER, op: "/kafka", id: "8f00-TEST", stage, status: statusWanted, error: body.error }, name);
    } else assert.deepEqual(lines, [], `${name}: a 4xx is the caller's query, not logged`);
  }
});

test("kafka route: a broker that cannot serve Fetch v4 or ListOffsets v1 is refused at api_versions (502)", async () => {
  const apis = [
    { key: 1, min: 0, max: 3 },
    { key: 2, min: 0, max: 8 },
    { key: 18, min: 0, max: 4 },
  ];
  const { status, body } = await ask(routeOn(brokerHandler(new FakeBroker(zonestreamLike(NOW), { apis }))).route, "topic=certstream_domains&offset=0");
  assert.equal(status, 502);
  assert.equal(body.stage, "api_versions");
  assert.match(body.error!, /serves API 1 at 0\.\.3; this route sends v4/);
});

test("kafka route: an answer whose correlation id is not its request's is refused (502)", async () => {
  const { status, body } = await ask(routeOn(brokerHandler(new FakeBroker(zonestreamLike(NOW), { wrongCorrelation: true }))).route, "topic=certstream_domains&offset=0");
  assert.equal(status, 502);
  assert.equal(body.stage, "api_versions");
  assert.match(body.error!, /correlation id 1001 to request 1/);
});

test("kafka route: an answer frame larger than max_bytes plus the slack is refused before it is read (502)", async () => {
  const broker = zonestream();
  // A Fetch answer that declares one byte past the cap and sends nothing more:
  // without the cap the route would wait for the rest until its wall time.
  const handler: Handler = (request) => {
    if (request.readInt16BE(0) !== 1) return broker.handle(request);
    const head = Buffer.alloc(8);
    head.writeInt32BE(1024 + LIMITS.frame_slack + 1, 0);
    head.writeInt32BE(request.readInt32BE(4), 4);
    return head;
  };
  const { status, body } = await ask(routeOn(handler).route, "topic=certstream_domains&offset=0&max_bytes=1024");
  assert.equal(status, 502);
  assert.equal(body.stage, "fetch");
  assert.match(body.error!, new RegExp(`declares ${1024 + LIMITS.frame_slack + 1} byte\\(s\\), above this call's cap of ${1024 + LIMITS.frame_slack}`));
});

test("kafka route: the shipped limits are these numbers", () => {
  assert.deepEqual(
    { ...LIMITS },
    {
      max_bytes: 67_108_864,
      default_max_bytes: 1_048_576,
      frame_slack: 2_097_152,
      small_frame: 1_048_576,
      max_wait_ms: 10_000,
      default_max_wait_ms: 500,
      sockets: 6,
      connect_ms: 10_000,
      wall_ms: 30_000,
    },
  );
});

// A handler that answers API `key` with a bare frame head declaring `size` bytes, and passes the rest to the broker.
const headOnly =
  (broker: FakeBroker, key: number, size: number): Handler =>
  (request) => {
    if (request.readInt16BE(0) !== key) return broker.handle(request);
    const head = Buffer.alloc(8);
    head.writeInt32BE(size, 0);
    head.writeInt32BE(request.readInt32BE(4), 4);
    return head;
  };

test("kafka route: an ApiVersions or ListOffsets frame above small_frame, or a frame under 4 bytes, is refused (502)", async () => {
  const api = await ask(routeOn(headOnly(zonestream(), 18, LIMITS.small_frame + 1)).route, "topic=certstream_domains&offset=0");
  assert.equal(api.status, 502);
  assert.equal(api.body.stage, "api_versions");
  assert.match(api.body.error!, new RegExp(`declares ${LIMITS.small_frame + 1} byte\\(s\\), above this call's cap of ${LIMITS.small_frame}$`));
  const offsets = await ask(routeOn(headOnly(zonestream(), 2, LIMITS.small_frame + 1)).route, "topic=certstream_domains&offset=latest");
  assert.equal(offsets.status, 502);
  assert.match(offsets.body.error!, /ListOffsets v1: a response frame declares 1048577 byte\(s\), above this call's cap of 1048576$/);
  for (const size of [0, 2, -5]) {
    const tiny = await ask(routeOn(headOnly(zonestream(), 18, size)).route, "topic=certstream_domains&offset=0");
    assert.equal(tiny.status, 502, String(size));
    assert.match(tiny.body.error!, new RegExp(`declares ${size} byte\\(s\\), less than its correlation id$`));
  }
});

test("kafka route: a ListOffsets or Fetch answer that leaves out the asked partition is refused (502)", async () => {
  const broker = zonestream();
  const without =
    (key: number): Handler =>
    (request) => {
      if (request.readInt16BE(0) !== key) return broker.handle(request);
      const id = request.readInt32BE(4);
      return key === 2 ? frame(id, listOffsetsResponse([{ topic: "certstream_domains", partitions: [] }])) : frame(id, fetchResponse([{ topic: "certstream_domains", partitions: [] }]));
    };
  const offsets = await ask(routeOn(without(2)).route, "topic=certstream_domains&offset=latest");
  assert.equal(offsets.status, 502);
  assert.match(offsets.body.error!, /ListOffsets did not answer certstream_domains\/0/);
  const fetched = await ask(routeOn(without(1)).route, `topic=certstream_domains&offset=${CS_BASE}`);
  assert.equal(fetched.status, 502);
  assert.match(fetched.body.error!, /Fetch did not answer certstream_domains\/0/);
});

test("kafka route: the Fetch the broker receives carries the call's max_wait_ms and max_bytes, and the project's client id", async () => {
  const broker = zonestream();
  const seen: { clientId: string; maxWaitMs: number; minBytes: number; maxBytes: number }[] = [];
  const handler: Handler = (request) => {
    if (request.readInt16BE(0) === 1) {
      const idLength = request.readInt16BE(8);
      const at = 10 + idLength;
      seen.push({ clientId: request.subarray(10, at).toString("utf8"), maxWaitMs: request.readInt32BE(at + 4), minBytes: request.readInt32BE(at + 8), maxBytes: request.readInt32BE(at + 12) });
    }
    return broker.handle(request);
  };
  assert.equal((await ask(routeOn(handler).route, `topic=certstream_domains&offset=${CS_BASE}&max_wait_ms=250&max_bytes=2048`)).status, 200);
  assert.equal((await ask(routeOn(handler).route, `topic=certstream_domains&offset=${CS_BASE}`)).status, 200);
  assert.deepEqual(seen, [
    { clientId: "domains.pkgforge.dev", maxWaitMs: 250, minBytes: 1, maxBytes: 2048 },
    { clientId: "domains.pkgforge.dev", maxWaitMs: 500, minBytes: 1, maxBytes: 1_048_576 },
  ]);
});

test("kafka route: a connection the broker closes inside an answer is refused (502)", async () => {
  const { route } = routeOn(brokerHandler(zonestream()), { perSocket: () => ({ cutFetchAt: 100 }) });
  const { status, body } = await ask(route, `topic=certstream_domains&offset=${CS_BASE}`);
  assert.equal(status, 502);
  assert.equal(body.stage, "fetch");
  assert.match(body.error!, /the connection closed after 96 of \d+ byte\(s\)/);
});

test("kafka route: a broker that never answers is cut at the wall cap (504), and the socket is closed", async () => {
  const { route, made } = routeOn(brokerHandler(new FakeBroker(zonestreamLike(NOW), { silentApi: 1 })), { limits: { wall_ms: 150 } });
  const { status, body } = await ask(route, "topic=certstream_domains&offset=0");
  assert.equal(status, 504);
  assert.equal(body.stage, "fetch");
  assert.match(body.error!, /\/kafka wall time: past the cap of 150 ms/);
  assert.ok(made[0]!.socket.closed);
});

test("kafka route: a socket that does not open answers 502, one that never opens is cut at the connect cap (504)", async () => {
  const refused = await ask(routeOn(brokerHandler(zonestream()), { perSocket: () => ({ refuse: "connection refused" }) }).route, "topic=certstream_domains&offset=0");
  assert.equal(refused.status, 502);
  assert.equal(refused.body.stage, "connect");
  assert.match(refused.body.error!, /^connect kafka\.zonestream\.openintel\.nl:9092: connection refused$/);
  const thrown = await ask(routeOn(brokerHandler(zonestream()), { perSocket: () => ({ throwOnConnect: "port blocked" }) }).route, "topic=certstream_domains&offset=0");
  assert.equal(thrown.status, 502);
  assert.match(thrown.body.error!, /port blocked/);
  const hung = routeOn(brokerHandler(zonestream()), { perSocket: () => ({ hang: true }), limits: { connect_ms: 50 } });
  const slow = await ask(hung.route, "topic=certstream_domains&offset=0");
  assert.equal(slow.status, 504);
  assert.equal(slow.body.stage, "connect");
  assert.match(slow.body.error!, /past the cap of 50 ms/);
  assert.ok(hung.made[0]!.socket.closed, "the socket that never opened is closed");
});

test("kafka route: sockets=N opens N connections at once, reports how many opened, and reads over the first that answered", async () => {
  const broker = zonestream();
  const six = await ask(routeOn(brokerHandler(broker)).route, "topic=certstream_domains&offset=latest-10&sockets=6");
  assert.equal(six.status, 200);
  assert.deepEqual(six.body.sockets, { asked: 6, opened: 6, api_versions_ok: 6, errors: [] });
  assert.equal(six.body.messages, 10);
  const { route, made } = routeOn(brokerHandler(zonestream()), { perSocket: (i) => (i === 0 ? { refuse: "first one refused" } : {}) });
  const mixed = await ask(route, "topic=certstream_domains&offset=latest-10&sockets=3");
  assert.equal(mixed.status, 200, "one socket that opened is enough to read");
  assert.equal(mixed.body.sockets.opened, 2);
  assert.equal(mixed.body.sockets.api_versions_ok, 2);
  assert.deepEqual(mixed.body.sockets.errors, ["connect: connect kafka.zonestream.openintel.nl:9092: first one refused"]);
  assert.equal(mixed.body.messages, 10);
  assert.ok(
    made.every((m) => m.socket.closed),
    "every socket is closed when the call ends",
  );
});

test("kafka route: the query is checked, and a bad one is refused with 400 before any socket opens", async () => {
  const { route, made } = routeOn(brokerHandler(zonestream()));
  const refused = async (query: string, pattern: RegExp) => {
    const url = new URL(`https://probe.test/kafka?${query}`);
    await assert.rejects(route.handle(new Request(url), ENV, url, Date.now), (err: unknown) => err instanceof ProbeError && err.status === 400 && pattern.test(err.message), query);
  };
  await refused("offset=0", /topic is required/);
  await refused("topic=a/b&offset=0", /topic is required/);
  await refused(`topic=${"t".repeat(250)}&offset=0`, /topic is required/);
  await refused("topic=t", /offset is required/);
  await refused("topic=t&offset=-1", /offset must be/);
  await refused("topic=t&offset=1.5", /offset must be/);
  await refused("topic=t&offset=99999999999999999", /offset must be a whole number from 0 to/);
  await refused("topic=t&offset=2026-13-45T00:00:00Z", /is not a valid time/);
  await refused("topic=t&offset=yesterday", /offset must be/);
  await refused("topic=t&offset=0&max_bytes=0", /max_bytes must be a whole number from 1 to 67108864$/);
  await refused(`topic=t&offset=0&max_bytes=${LIMITS.max_bytes + 1}`, /max_bytes must be a whole number from 1 to 67108864$/);
  await refused("topic=t&offset=0&max_wait_ms=10001", /max_wait_ms must be a whole number from 0 to 10000$/);
  await refused("topic=t&offset=0&sockets=7", /sockets must be a whole number from 1 to 6/);
  await refused("topic=t&offset=0&sockets=0", /sockets must be a whole number from 1 to 6/);
  await refused("topic=t&offset=0&partition=x", /partition must be/);
  await refused("topic=t&offset=0&call=a%20b", /call is a label/);
  await refused("topic=t&offset=0&offset=1", /offset is given more than once/);
  await refused("topic=t&offset=0&format=csv", /\/kafka takes topic, offset, max_bytes, partition, max_wait_ms, sockets, call, not format/);
  assert.equal(made.length, 0, "no socket was opened for a refused query");
  const q = parseQuery(new URL(`https://probe.test/kafka?topic=certstream_domains&offset=latest-5&max_bytes=${LIMITS.max_bytes}&partition=3&max_wait_ms=0&sockets=6&call=run-1`));
  assert.deepEqual(q, { topic: "certstream_domains", partition: 3, offset: { kind: "latest", back: 5 }, offsetText: "latest-5", maxBytes: LIMITS.max_bytes, maxWaitMs: 0, sockets: 6, call: "run-1" });
  const defaults = parseQuery(new URL("https://probe.test/kafka?topic=t&offset=2026-10-28T12:00:00.5Z"));
  assert.deepEqual(defaults.offset, { kind: "time", ms: Date.parse("2026-10-28T12:00:00.5Z") });
  assert.equal(defaults.maxBytes, LIMITS.default_max_bytes);
  assert.equal(defaults.maxWaitMs, LIMITS.default_max_wait_ms);
  assert.equal(defaults.sockets, 1);
  assert.equal(defaults.partition, 0);
});
