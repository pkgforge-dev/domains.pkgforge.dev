// packages/adapter/src/kafka.ts (KafkaConnection) over three doors: liveConnect
// to the fake broker of DOM-004's tests on 127.0.0.1 (scripts/measure/fixtures/
// kafka/broker.mjs, real magic-2 batches), replayConnect over synthetic
// recordings whose requests are the bytes the script encodes
// (scripts/measure/kafka-protocol.mjs) and whose answers are the broker's
// frames recorded at 2026-10-28T10:40:45Z or built to plant one fault, and a
// local server that answers a cut frame and ends. Each rule of the client's
// header has a test: the version refusal, the correlation check, the frame
// caps, the close mid-frame, the partitions asked, one request in flight in one
// write, and the bounds that belong to the connect.
//
//   node scripts/test.mjs packages/adapter --name "adapter kafka:"
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { type AddressInfo, createServer, type Socket } from "node:net";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as viaExport from "@domains/adapter/kafka";
import * as protocolViaExport from "@domains/adapter/kafka-protocol";
import { APIS, FakeBroker, makePartition, zonestreamLike } from "../../../scripts/measure/fixtures/kafka/broker.mjs";
import { apiVersionsResponse, fetchResponse, frame, listOffsetsResponse, metadataResponse } from "../../../scripts/measure/fixtures/kafka/build.mjs";
import { FrameReader } from "../../../scripts/measure/kafka-client.mjs";
import * as mjs from "../../../scripts/measure/kafka-protocol.mjs";
import { LIVE_CONNECT_LIMITS, liveConnect, SocketError } from "../node/connect.ts";
import { encodeTcpRecording, parseTcpRecording, replayConnect, tapConnect } from "../src/connect.ts";
import { decodeBatch, EARLIEST, FETCH_MIN_BYTES, KAFKA_LIMITS, KafkaConnection, KafkaError, LATEST, ProtocolError, partitionKey, ZONESTREAM } from "../src/kafka.ts";
import type { Connect, SocketAddress } from "../src/types.ts";

const CLIENT = "domains.pkgforge.dev kafka test";
const FIXTURES = fileURLToPath(new URL("../../../scripts/measure/fixtures/kafka/", import.meta.url));
const T0 = Date.parse("2026-10-31T05:00:00Z");
const NRD = "newly_registered_domain";
const TOPICS = [NRD, "newly_registered_fqdn", "confirmed_newly_registered_domain"] as const;
const BASES: Readonly<Record<string, number>> = { [NRD]: 173_000_000, newly_registered_fqdn: 182_000_000, confirmed_newly_registered_domain: 81_000_000 };
const KEYS = TOPICS.map((t) => partitionKey(t, 0));
const ASKS = TOPICS.map((topic) => ({ topic, partition: 0 }));
// The address of the synthetic recordings.
const AT: SocketAddress = { hostname: "broker.test", port: 9092 };
const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const text = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array(0));

// A value of the NRD topics' shape, one a record.
const messageOf = (topic: string, i: number): string => JSON.stringify({ domain: `d${i}.${topic}.test.`, timestamp: T0 / 1000 + i * 10 });

// Three topics shaped like the NRD topics: one partition each, uncompressed,
// one record a batch, a message every 10 s from T0.
function nrdTopics(n = 30) {
  return Object.fromEntries(
    TOPICS.map((topic) => [
      topic,
      [makePartition({ baseOffset: BASES[topic], records: Array.from({ length: n }, (_, i) => ({ timestamp: T0 + i * 10_000, value: messageOf(topic, i) })), perBatch: 1, codec: "none" })],
    ]),
  );
}

async function withBroker<T>(topics: object, faults: object, fn: (at: SocketAddress, broker: FakeBroker) => Promise<T>): Promise<T> {
  const broker = new FakeBroker(topics, faults);
  const port = await broker.start();
  try {
    return await fn({ hostname: "127.0.0.1", port }, broker);
  } finally {
    await broker.stop();
  }
}

// A server on 127.0.0.1 that answers the nth request frame it reads with
// answers[n], and ends the connection after the last.
async function scripted(answers: readonly Uint8Array[]): Promise<{ at: SocketAddress; close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    sockets.add(s);
    s.on("close", () => sockets.delete(s));
    // The client ends a connection by destroying it; the reset is expected.
    s.on("error", () => {});
    let n = 0;
    const frames = new FrameReader(() => {
      const answer = answers[n++];
      if (answer === undefined) return;
      s.write(answer);
      if (n === answers.length) s.end();
    });
    s.on("data", (chunk: Buffer) => frames.push(chunk));
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  const { port } = server.address() as AddressInfo;
  return {
    at: { hostname: "127.0.0.1", port },
    close: () =>
      new Promise<void>((ok) => {
        for (const s of sockets) s.destroy();
        server.close(() => ok());
      }),
  };
}

// A request as the script encodes it: the bytes DOM-004 sent to the real broker.
const scriptRequest = (apiKey: number, correlationId: number, body: Buffer): Uint8Array =>
  new Uint8Array(mjs.encodeRequest({ apiKey, apiVersion: mjs.VERSION[apiKey], correlationId, clientId: CLIENT, body }));
const AV_REQUEST = scriptRequest(18, 1, mjs.apiVersionsBody());
const AV_ANSWER: Buffer = frame(1, apiVersionsResponse(APIS));

// A replay of one synthetic recording of AT.
function replayOf(exchanges: readonly (readonly [Uint8Array, Uint8Array])[], options: { chunkBytes?: number } = {}) {
  const json = encodeTcpRecording({ origin: "synthetic", address: AT, exchanges: exchanges.map(([request, response]) => ({ note: null, request, response })) });
  return replayConnect([parseTcpRecording(JSON.parse(json), "kafka.tcp.json")], options);
}

// Rejects with an error of this class whose message matches.
async function rejects<E extends Error>(p: Promise<unknown>, kind: abstract new (...args: never[]) => E, pattern: RegExp): Promise<E> {
  let caught: unknown = null;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof kind, `expected a ${kind.name}, got ${caught === null ? "no error" : String(caught)}`);
  assert.match(caught.message, pattern);
  return caught;
}

// Waits up to a second for a condition another socket's events settle.
async function settles(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((ok) => setTimeout(ok, 10));
  assert.ok(cond(), what);
}

test("adapter kafka: open sends ApiVersions v0 first, with the client id, and refuses a broker without Fetch v4 or Metadata v0, closing the socket", async () => {
  await withBroker(nrdTopics(), {}, async (at, broker) => {
    const conn = await KafkaConnection.open(liveConnect(), at, CLIENT);
    assert.deepEqual(broker.requests, [{ apiKey: 18, apiVersion: 0, clientId: CLIENT }]);
    assert.deepEqual(conn.address, at);
    await conn.close();
    await rejects(conn.metadata([NRD]), ProtocolError, /the connection is closed$/);
    assert.equal(broker.requests.length, 1, "a request after close sends nothing");
  });
  const without = (key: number, max?: number) => APIS.flatMap((a: { key: number; min: number; max: number }) => (a.key !== key ? [a] : max === undefined ? [] : [{ ...a, max }]));
  for (const [apis, pattern] of [
    [without(1, 3), /: the broker serves API 1 at 0\.\.3; this client sends v4$/],
    [without(3), /: the broker serves API 3 at no version; this client sends v0$/],
  ] as const) {
    await withBroker(nrdTopics(), { apis }, async (at, broker) => {
      await rejects(KafkaConnection.open(liveConnect(), at, CLIENT), ProtocolError, pattern);
      assert.equal(broker.requests.length, 1, "nothing is sent after the refusal");
      await settles(() => broker.sockets.size === 0, "the refused connection is closed by the client");
    });
  }
  // A broker's error code in ApiVersions is a KafkaError.
  const { connect } = replayOf([[AV_REQUEST, frame(1, apiVersionsResponse(APIS, 35))]]);
  const err = await rejects(KafkaConnection.open(connect, AT, CLIENT), KafkaError, /^broker\.test:9092 ApiVersions v0: broker error 35 UNSUPPORTED_VERSION$/);
  assert.equal(err.code, 35);
});

test("adapter kafka: a response with another correlation id is a ProtocolError, and the connection is spent after it", async () => {
  await withBroker(nrdTopics(), { wrongCorrelation: true }, async (at) => {
    await rejects(KafkaConnection.open(liveConnect(), at, CLIENT), ProtocolError, /ApiVersions v0: a response with correlation id 1001 to request 1$/);
  });
  const answer = frame(7, metadataResponse([], [{ name: NRD, partitions: [{ partition: 0 }] }]));
  const replay = replayOf([
    [AV_REQUEST, AV_ANSWER],
    [scriptRequest(3, 2, mjs.metadataBody([NRD])), answer],
  ]);
  const conn = await KafkaConnection.open(replay.connect, AT, CLIENT);
  const first = await rejects(conn.metadata([NRD]), ProtocolError, /^broker\.test:9092 Metadata v0: a response with correlation id 7 to request 2$/);
  const later = await rejects(conn.listOffsets([{ topic: NRD, partition: 0 }], LATEST), ProtocolError, /correlation id 7/);
  assert.equal(later, first, "a later request rejects with the first failure");
  assert.equal(replay.connections[0]!.requests.length, 2, "and writes nothing");
  assert.deepEqual(replay.misses, []);
  await conn.close();
});

test("adapter kafka: a frame over its cap, or under 4 bytes, is refused before it is read", async () => {
  // Each answer is a 4-byte size and a correlation id, then the end of the
  // connection: a client that read the declared size would fail otherwise
  // (closed after 4 bytes), or ask for 2 GiB first.
  const head = (size: number): Buffer => Buffer.concat([mjs.int32(size), mjs.int32(1)]);
  for (const [size, pattern] of [
    [0x7fffffff, /ApiVersions v0: a response frame declares 2147483647 byte\(s\), above its cap of 1048576$/],
    [KAFKA_LIMITS.smallFrame + 1, /ApiVersions v0: a response frame declares 1048577 byte\(s\), above its cap of 1048576$/],
    [3, /ApiVersions v0: a response frame declares 3 byte\(s\), less than its correlation id$/],
    [-1, /ApiVersions v0: a response frame declares -1 byte\(s\), less than its correlation id$/],
  ] as const) {
    const server = await scripted([head(size)]);
    try {
      await rejects(KafkaConnection.open(liveConnect(), server.at, CLIENT), ProtocolError, pattern);
    } finally {
      await server.close();
    }
  }
  // A Fetch's cap is its maxBytes plus frameSlack. The broker answers the
  // first batch whole however large, so a maxBytes of 64 with a slack of 16
  // cannot hold one batch of these topics.
  await withBroker(nrdTopics(), {}, async (at) => {
    const conn = await KafkaConnection.open(liveConnect(), at, CLIENT, { ...KAFKA_LIMITS, frameSlack: 16 });
    await rejects(
      conn.fetch([{ topic: NRD, partition: 0, offset: BASES[NRD]!, maxBytes: 64 }], { maxWaitMs: 0, maxBytes: 64 }),
      ProtocolError,
      /Fetch v4: a response frame declares \d+ byte\(s\), above its cap of 80$/,
    );
    await conn.close();
  });
  // A frame of exactly its cap is read; one byte more is refused (the review of DOM-026).
  const exact = apiVersionsResponse(APIS).length + 4;
  await withBroker(nrdTopics(1), {}, async (at) => {
    const conn = await KafkaConnection.open(liveConnect(), at, CLIENT, { ...KAFKA_LIMITS, smallFrame: exact });
    await conn.close();
    await rejects(
      KafkaConnection.open(liveConnect(), at, CLIENT, { ...KAFKA_LIMITS, smallFrame: exact - 1 }),
      ProtocolError,
      new RegExp(`declares ${exact} byte\\(s\\), above its cap of ${exact - 1}$`),
    );
  });
});

test("adapter kafka: the correlation id of a connection goes to 2^31 - 1, and a request past it is a ProtocolError before a byte is sent", async () => {
  await withBroker(nrdTopics(1), {}, async (at, broker) => {
    const conn = await KafkaConnection.open(liveConnect(), at, CLIENT);
    // The ids are the connection's own: set by hand, as no test sends 2^31 requests.
    (conn as unknown as { nextId: number }).nextId = 0x7fffffff;
    assert.deepEqual([...(await conn.metadata([NRD])).entries()], [[NRD, [0]]]);
    const sent = broker.requests.length;
    await rejects(conn.metadata([NRD]), ProtocolError, /the correlation ids of this connection are used up$/);
    assert.equal(broker.requests.length, sent);
    await conn.close();
  });
});

test("adapter kafka: one ListOffsets answers three topics, and one Fetch three partitions with their whole batches and the partial byte count", async () => {
  const topics = nrdTopics(30);
  await withBroker(topics, {}, async (at, broker) => {
    const conn = await KafkaConnection.open(liveConnect(), at, CLIENT);
    const offsets = (f: (base: number) => number) => KEYS.map((k, i) => [k, f(BASES[TOPICS[i]]!)]);
    assert.deepEqual(
      [...(await conn.listOffsets(ASKS, EARLIEST))],
      offsets((b) => b),
    );
    assert.deepEqual(
      [...(await conn.listOffsets(ASKS, LATEST))],
      offsets((b) => b + 30),
    );
    // A time: the first record at or after it (the 10th, at T0 + 100 s); past the newest, -1.
    assert.deepEqual(
      [...(await conn.listOffsets(ASKS, T0 + 95_000))],
      offsets((b) => b + 10),
    );
    assert.deepEqual(
      [...(await conn.listOffsets(ASKS, T0 + 3_600_000))],
      offsets(() => -1),
    );
    assert.deepEqual(
      broker.requests.map((r: { apiKey: number }) => r.apiKey),
      [18, 2, 2, 2, 2],
      "one ListOffsets a call",
    );
    // From the 5th record, each partition's maxBytes cuts its third batch in half.
    const fetchAsks = TOPICS.map((topic) => {
      const b = topics[topic]![0].batches;
      return { topic, partition: 0, offset: BASES[topic]! + 5, maxBytes: b[5].bytes.length + b[6].bytes.length + Math.floor(b[7].bytes.length / 2) };
    });
    const res = await conn.fetch(fetchAsks, { maxWaitMs: 0, maxBytes: 1 << 20 });
    assert.deepEqual(
      broker.requests.map((r: { apiKey: number }) => r.apiKey),
      [18, 2, 2, 2, 2, 1],
      "one Fetch for the three partitions",
    );
    assert.deepEqual([...res.partitions.keys()], KEYS, "in the order asked");
    let asked = 0;
    for (const [i, topic] of TOPICS.entries()) {
      const p = res.partitions.get(KEYS[i]!)!;
      const b = topics[topic]![0].batches;
      const base = BASES[topic]!;
      assert.equal(p.errorCode, 0, topic);
      assert.equal(p.highWatermark, base + 30, topic);
      assert.deepEqual(
        p.batches.map((x) => [x.baseOffset, hex(x.bytes)]),
        [5, 6].map((k) => [base + k, hex(b[k].bytes)]),
        `${topic}: the whole batches as the broker stored them`,
      );
      assert.equal(p.partial, Math.floor(b[7].bytes.length / 2), `${topic}: the cut batch`);
      assert.deepEqual(
        p.batches.map((x) => text(decodeBatch(x.bytes).records[0]!.value)),
        [messageOf(topic, 5), messageOf(topic, 6)],
      );
      asked += fetchAsks[i]!.maxBytes;
    }
    assert.ok(res.frameBytes > asked, `the frame of ${res.frameBytes} bytes holds the ${asked} bytes of the three partitions`);
    await conn.close();
  });
});

// One session of every request against `connect`, as plain values.
async function session(connect: Connect, at: SocketAddress) {
  const conn = await KafkaConnection.open(connect, at, CLIENT);
  const md = await conn.metadata([...TOPICS]);
  const first = await conn.listOffsets(ASKS, EARLIEST);
  const fetched = await conn.fetch(
    ASKS.map((a) => ({ ...a, offset: first.get(partitionKey(a.topic, 0))!, maxBytes: 1 << 16 })),
    { maxWaitMs: 0, maxBytes: 1 << 20 },
  );
  await conn.close();
  const partitions = [...fetched.partitions].map(([k, p]) => [k, p.errorCode, p.highWatermark, p.partial, p.batches.map((b) => hex(b.bytes))]);
  return { md: [...md], first: [...first], frameBytes: fetched.frameBytes, partitions };
}

test("adapter kafka: a response written a few bytes at a time is read whole, live and replayed a byte a chunk", async () => {
  const topics = nrdTopics(20);
  let whole: Awaited<ReturnType<typeof session>> | null = null;
  let recording = "";
  await withBroker(topics, {}, async (at) => {
    const tap = tapConnect(liveConnect());
    whole = await session(tap.connect, at);
    recording = encodeTcpRecording({ origin: "synthetic", address: at, exchanges: tap.exchanges });
  });
  assert.ok(whole !== null);
  assert.equal((whole as Awaited<ReturnType<typeof session>>).partitions.length, 3);
  const chunked = await withBroker(topics, { chunkSize: 3 }, (at) => session(liveConnect(), at));
  assert.deepEqual(chunked, whole, "3 bytes a write from the broker");
  // The tapped session replays: each request one write of the same bytes, each
  // answer delivered a byte a chunk.
  const parsed = parseTcpRecording(JSON.parse(recording), "tapped.tcp.json");
  assert.equal(parsed.exchanges.length, 4, "ApiVersions, Metadata, ListOffsets and Fetch");
  const replay = replayConnect([parsed], { chunkBytes: 1 });
  const at = parsed.address;
  assert.deepEqual(await session(replay.connect, at), whole, "replayed a byte a chunk");
  assert.deepEqual(replay.misses, []);
});

test("adapter kafka: Metadata v0 gives each topic's partitions, and a topic the broker does not know is KafkaError 3", async () => {
  await withBroker(zonestreamLike(T0), {}, async (at) => {
    const conn = await KafkaConnection.open(liveConnect(), at, CLIENT);
    assert.deepEqual(
      [...(await conn.metadata(["newly_registered_fqdn_measurements", NRD]))],
      [
        ["newly_registered_fqdn_measurements", [0, 1, 2, 3]],
        [NRD, [0]],
      ],
    );
    const err = await rejects(conn.metadata([NRD, "no_such_topic"]), KafkaError, /Metadata v0 no_such_topic: broker error 3 UNKNOWN_TOPIC_OR_PARTITION$/);
    assert.equal(err.code, 3);
    await conn.close();
  });
  // An answer that names a topic not asked, answers one twice, leaves one out
  // or names a partition twice is a ProtocolError.
  const topic = (name: string, partitions = [0]) => ({ name, partitions: partitions.map((partition) => ({ partition })) });
  for (const [asked, answered, pattern] of [
    [[NRD], [topic("other")], /an answer for topic other, which was not asked$/],
    [[NRD], [topic(NRD), topic(NRD)], /topic newly_registered_domain is answered twice$/],
    [[NRD, "other"], [topic(NRD)], /topic other was asked and is not answered$/],
    [[NRD], [topic(NRD, [0, 0])], /topic newly_registered_domain names a partition twice$/],
  ] as const) {
    const replay = replayOf([
      [AV_REQUEST, AV_ANSWER],
      [scriptRequest(3, 2, mjs.metadataBody([...asked])), frame(2, metadataResponse([], answered))],
    ]);
    const conn = await KafkaConnection.open(replay.connect, AT, CLIENT);
    await rejects(conn.metadata([...asked]), ProtocolError, pattern);
    await conn.close();
  }
});

test("adapter kafka: the broker's recorded answers replay through ctx.connect, each request one write of the script's bytes with correlation ids from 1, and a Fetch frame past its maxBytes passes within the slack", async () => {
  // The frames DOM-004 recorded (scripts/measure/fixtures/kafka/recorded.json),
  // each with the correlation id this client gives its request.
  const recorded = (name: string, id: number): Buffer => {
    const b = Buffer.from(readFileSync(`${FIXTURES}${name}`));
    assert.equal(b.readInt32BE(0), b.length - 4, `${name} holds one whole frame`);
    b.writeInt32BE(id, 4);
    return b;
  };
  const CS = "certstream_domains";
  const csAsk = { topic: CS, partition: 0, offset: 42_689_203_481, maxBytes: 24_576 };
  const nrdAsk = { topic: NRD, partition: 0, offset: 172_679_348, maxBytes: 16_384 };
  const fetchRequest = (id: number, a: typeof csAsk) =>
    scriptRequest(1, id, mjs.fetchBody({ topics: [{ topic: a.topic, partitions: [{ partition: 0, offset: a.offset, maxBytes: a.maxBytes }] }], maxWaitMs: 100, minBytes: 1, maxBytes: a.maxBytes }));
  const replay = replayOf([
    [AV_REQUEST, recorded("api-versions-v0.bin", 1)],
    [scriptRequest(3, 2, mjs.metadataBody([CS, NRD])), recorded("metadata-v0.bin", 2)],
    [scriptRequest(2, 3, mjs.listOffsetsBody([CS, NRD].map((topic) => ({ topic, partitions: [{ partition: 0, timestamp: LATEST }] })))), recorded("list-offsets-v1.bin", 3)],
    [fetchRequest(4, csAsk), recorded("fetch-v4-certstream_domains.bin", 4)],
    [fetchRequest(5, nrdAsk), recorded("fetch-v4-newly_registered_domain.bin", 5)],
  ]);
  const conn = await KafkaConnection.open(replay.connect, AT, CLIENT);
  assert.deepEqual(
    [...(await conn.metadata([CS, NRD]))],
    [
      [CS, [0]],
      [NRD, [0]],
    ],
  );
  const latest = await conn.listOffsets(
    [CS, NRD].map((topic) => ({ topic, partition: 0 })),
    LATEST,
  );
  assert.ok(latest.get(partitionKey(CS, 0))! > csAsk.offset && latest.get(partitionKey(NRD, 0))! > nrdAsk.offset);
  const cs = await conn.fetch([csAsk], { maxWaitMs: 100, maxBytes: csAsk.maxBytes });
  assert.equal(cs.frameBytes, 26_881, "the broker's answer, past its maxBytes of 24,576 and within the slack");
  assert.ok(cs.frameBytes <= csAsk.maxBytes + KAFKA_LIMITS.frameSlack);
  const nrd = await conn.fetch([nrdAsk], { maxWaitMs: 100, maxBytes: nrdAsk.maxBytes });
  for (const [name, res, ask] of [
    ["fetch-v4-certstream_domains.bin", cs, csAsk],
    ["fetch-v4-newly_registered_domain.bin", nrd, nrdAsk],
  ] as const) {
    const p = res.partitions.get(partitionKey(ask.topic, 0))!;
    const script = mjs.parseFetch(new mjs.Reader(recorded(name, 0).subarray(8), name)).topics[0].partitions[0];
    const split = mjs.splitBatches(script.records);
    assert.deepEqual(
      p.batches.map((b) => hex(b.bytes)),
      split.batches.map((b: { bytes: Buffer }) => hex(b.bytes)),
      `${name}: the script's batches`,
    );
    assert.equal(p.partial, split.partial, `${name}: the script's partial tail`);
    assert.equal(p.highWatermark, script.highWatermark);
    for (const b of p.batches) assert.ok(decodeBatch(b.bytes).records.length >= 1, `${name}: batch ${b.baseOffset} decodes`);
  }
  // The NRD topic's names carry their trailing dot as recorded.
  const value = JSON.parse(text(decodeBatch(nrd.partitions.get(partitionKey(NRD, 0))!.batches[0]!.bytes).records[0]!.value));
  assert.match(value.domain, /\.$/);
  await conn.close();
  assert.deepEqual(replay.misses, []);
  assert.deepEqual(
    replay.connections.map((c) => c.requests.map((r) => r.exchange)),
    [[0, 1, 2, 3, 4].map((i) => `kafka.tcp.json#${i}`)],
    "one connection, one write a request, each the script's bytes",
  );
});

test("adapter kafka: a connection closed mid-frame is a ProtocolError, and a bound of the connect reaches the caller as its own SocketError", async () => {
  const server = await scripted([AV_ANSWER.subarray(0, 10)]);
  try {
    await rejects(KafkaConnection.open(liveConnect(), server.at, CLIENT), ProtocolError, new RegExp(`ApiVersions v0: the connection closed after 6 of ${AV_ANSWER.length - 4} byte\\(s\\)$`));
  } finally {
    await server.close();
  }
  // The client sets no timer: a Fetch never answered ends at the connect's idle bound.
  await withBroker(nrdTopics(), { silentApi: 1 }, async (at) => {
    const conn = await KafkaConnection.open(liveConnect({ ...LIVE_CONNECT_LIMITS, idleMs: 200 }), at, CLIENT);
    const err = await rejects(conn.fetch([{ topic: NRD, partition: 0, offset: BASES[NRD]!, maxBytes: 1024 }], { maxWaitMs: 0, maxBytes: 1024 }), SocketError, /^idle: /);
    assert.equal(err.code, "idle");
    assert.equal(await conn.metadata([NRD]).catch((e: unknown) => e), err, "the connection is spent with it");
    await conn.close();
  });
});

test("adapter kafka: an answer that names a partition not asked, answers one twice or leaves one out is a ProtocolError; a partition's error code throws in ListOffsets and is returned by Fetch", async () => {
  const loRequest = scriptRequest(2, 2, mjs.listOffsetsBody([{ topic: NRD, partitions: [{ partition: 0, timestamp: LATEST }] }]));
  const lo = (topic: string, partitions: object[]) => frame(2, listOffsetsResponse([{ topic, partitions }]));
  const at0 = { partition: 0, timestamp: -1, offset: 5 };
  for (const [answer, err, pattern] of [
    [lo(NRD, [{ ...at0, partition: 1 }]), ProtocolError, /an answer for newly_registered_domain\/1, which was not asked$/],
    [lo("other", [at0]), ProtocolError, /an answer for other\/0, which was not asked$/],
    [lo(NRD, [at0, at0]), ProtocolError, /newly_registered_domain\/0 is answered twice$/],
    [lo(NRD, []), ProtocolError, /newly_registered_domain\/0 was asked and is not answered$/],
    [lo(NRD, [{ ...at0, errorCode: 1 }]), KafkaError, /ListOffsets v1 newly_registered_domain\/0: broker error 1 OFFSET_OUT_OF_RANGE$/],
  ] as const) {
    const replay = replayOf([
      [AV_REQUEST, AV_ANSWER],
      [loRequest, answer],
    ]);
    const conn = await KafkaConnection.open(replay.connect, AT, CLIENT);
    await rejects(conn.listOffsets([{ topic: NRD, partition: 0 }], LATEST), err, pattern);
    await conn.close();
  }
  const fetchRequest = scriptRequest(1, 2, mjs.fetchBody({ topics: [{ topic: NRD, partitions: [{ partition: 0, offset: 7, maxBytes: 100 }] }], maxWaitMs: 0, minBytes: 1, maxBytes: 100 }));
  const extra = frame(
    2,
    fetchResponse([
      {
        topic: NRD,
        partitions: [
          { partition: 0, highWatermark: 9, records: Buffer.alloc(0) },
          { partition: 2, highWatermark: 9, records: Buffer.alloc(0) },
        ],
      },
    ]),
  );
  const fetchReplay = replayOf([
    [AV_REQUEST, AV_ANSWER],
    [fetchRequest, extra],
  ]);
  const fc = await KafkaConnection.open(fetchReplay.connect, AT, CLIENT);
  await rejects(fc.fetch([{ topic: NRD, partition: 0, offset: 7, maxBytes: 100 }], { maxWaitMs: 0, maxBytes: 100 }), ProtocolError, /an answer for newly_registered_domain\/2, which was not asked$/);
  await fc.close();
  // A Fetch partition's error code is returned, and the other partitions are read.
  await withBroker(nrdTopics(), { fetchError: { topic: NRD, partition: 0, code: 6 } }, async (at) => {
    const conn = await KafkaConnection.open(liveConnect(), at, CLIENT);
    const res = await conn.fetch(
      ASKS.map((a) => ({ ...a, offset: BASES[a.topic]!, maxBytes: 1 << 16 })),
      { maxWaitMs: 0, maxBytes: 1 << 20 },
    );
    assert.deepEqual(
      [...res.partitions].map(([k, p]) => [k, p.errorCode, p.batches.length > 0]),
      [
        [KEYS[0], 6, false],
        [KEYS[1], 0, true],
        [KEYS[2], 0, true],
      ],
    );
    await conn.close();
  });
});

test("adapter kafka: requests go one at a time in the order called, each in one write, with correlation ids from 1", async () => {
  await withBroker(nrdTopics(), {}, async (at) => {
    const log: string[] = [];
    const writes: Uint8Array[] = [];
    // A short idle bound: a client with two requests in flight on one reader
    // waits for bytes that never come, and ends here in 2 s, not in 60.
    const live = liveConnect({ ...LIVE_CONNECT_LIMITS, idleMs: 2_000 });
    // liveConnect, with each write and each chunk the client reads logged.
    const logged: Connect = (address, options) => {
      const s = live(address, options);
      const reader = s.readable.getReader();
      const writer = s.writable.getWriter();
      const readable = new ReadableStream<Uint8Array>(
        {
          async pull(c) {
            const r = await reader.read();
            if (r.done) c.close();
            else {
              log.push("read");
              c.enqueue(r.value);
            }
          },
          cancel: (reason) => reader.cancel(reason),
        },
        { highWaterMark: 0 },
      );
      const writable = new WritableStream<Uint8Array>({
        async write(chunk) {
          log.push("write");
          writes.push(chunk.slice());
          await writer.write(chunk);
        },
      });
      return { readable, writable, opened: s.opened, close: () => s.close() };
    };
    const conn = await KafkaConnection.open(logged, at, CLIENT);
    // Called together: the client writes each once the answer before it is read.
    const [md, first, last, fetched] = await Promise.all([
      conn.metadata([...TOPICS]),
      conn.listOffsets(ASKS, EARLIEST),
      conn.listOffsets(ASKS, LATEST),
      conn.fetch(
        ASKS.map((a) => ({ ...a, offset: BASES[a.topic]!, maxBytes: 1 << 16 })),
        { maxWaitMs: 0, maxBytes: 1 << 20 },
      ),
    ]);
    await conn.close();
    assert.deepEqual([...md.values()], [[0], [0], [0]]);
    assert.deepEqual(
      [...first.values()],
      TOPICS.map((t) => BASES[t]),
    );
    assert.deepEqual(
      [...last.values()],
      TOPICS.map((t) => BASES[t]! + 30),
    );
    assert.equal(fetched.partitions.size, 3);
    const view = (w: Uint8Array) => new DataView(w.buffer, w.byteOffset, w.byteLength);
    assert.deepEqual(
      writes.map((w) => view(w).getInt32(0) === w.byteLength - 4),
      [true, true, true, true, true],
      "each write is one whole request",
    );
    assert.deepEqual(
      writes.map((w) => [view(w).getInt16(4), view(w).getInt32(8)]),
      [
        [18, 1],
        [3, 2],
        [2, 3],
        [2, 4],
        [1, 5],
      ],
      "in the order called, correlation ids from 1",
    );
    // The Fetch asks for FETCH_MIN_BYTES, 1: the body is replica -1, max wait,
    // then min bytes, after the header's client id.
    const fetch = writes[4]!;
    const headerEnd = 4 + 2 + 2 + 4 + 2 + view(fetch).getInt16(12);
    assert.equal(view(fetch).getInt32(headerEnd + 8), 1);
    assert.equal(FETCH_MIN_BYTES, 1);
    const order = log
      .join(" ")
      .replace(/(read ?)+/g, "read ")
      .trim();
    assert.equal(order, "write read write read write read write read write read", "no write while an answer is being read");
  });
});

test("adapter kafka: asks and options are checked before a byte is sent, and the constants are the stated ones, exported by package name", async () => {
  assert.deepEqual(ZONESTREAM, { hostname: "kafka.zonestream.openintel.nl", port: 9092 });
  assert.deepEqual(KAFKA_LIMITS, { smallFrame: 1 << 20, frameSlack: 2 << 20 });
  assert.ok(Object.isFrozen(ZONESTREAM) && Object.isFrozen(KAFKA_LIMITS));
  assert.equal(FETCH_MIN_BYTES, 1);
  assert.equal(viaExport.KafkaConnection, KafkaConnection);
  assert.equal(viaExport.KafkaError, protocolViaExport.KafkaError);
  assert.equal(viaExport.decodeBatch, protocolViaExport.decodeBatch);
  const replay = replayOf([[AV_REQUEST, AV_ANSWER]]);
  await rejects(KafkaConnection.open(replay.connect, AT, CLIENT, { smallFrame: 0, frameSlack: 1 }), TypeError, /smallFrame 0 is not a whole number/);
  await rejects(KafkaConnection.open(replay.connect, AT, "x".repeat(0x8000)), TypeError, /client id is not a string of at most 32767 bytes/);
  assert.equal(replay.connections.length, 0, "no socket is opened for a refused option");
  const conn = await KafkaConnection.open(replay.connect, AT, CLIENT);
  const fetchOk = { topic: NRD, partition: 0, offset: 0, maxBytes: 1 };
  for (const [call, pattern] of [
    [() => conn.metadata([]), /^Metadata v0: asks no topic$/],
    [() => conn.metadata([NRD, NRD]), /^Metadata v0: asks a topic twice$/],
    [() => conn.metadata(["no spaces"]), /^Metadata v0: topic "no spaces" is not a Kafka topic name$/],
    [() => conn.listOffsets([], LATEST), /^ListOffsets v1: asks no partition$/],
    [() => conn.listOffsets([ASKS[0], ASKS[0]], LATEST), /^ListOffsets v1: asks newly_registered_domain\/0 twice$/],
    [() => conn.listOffsets([{ topic: NRD, partition: -1 }], LATEST), /^ListOffsets v1: partition -1 of newly_registered_domain is not a whole number from 0$/],
    [() => conn.listOffsets(ASKS, -3), /^ListOffsets v1: timestamp -3 is not EARLIEST, LATEST or a whole number of ms from 0$/],
    [() => conn.fetch([{ ...fetchOk, offset: -1 }], { maxWaitMs: 0, maxBytes: 1 }), /^Fetch v4: offset -1 of newly_registered_domain\/0 is not a whole number from 0$/],
    [() => conn.fetch([{ ...fetchOk, maxBytes: 0 }], { maxWaitMs: 0, maxBytes: 1 }), /^Fetch v4: maxBytes 0 of newly_registered_domain\/0 is not/],
    [() => conn.fetch([fetchOk], { maxWaitMs: -1, maxBytes: 1 }), /^Fetch v4: maxWaitMs -1 is not/],
    [() => conn.fetch([fetchOk], { maxWaitMs: 0, maxBytes: 2 ** 31 }), /^Fetch v4: maxBytes 2147483648 is not/],
  ] as const) {
    await rejects(call(), TypeError, pattern);
  }
  assert.equal(replay.connections[0]!.requests.length, 1, "only ApiVersions was written");
  await conn.close();
});
