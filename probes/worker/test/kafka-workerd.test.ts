// probes/worker/test/kafka-workerd.test.ts — the /kafka route of DOM-005 in
// workerd (Miniflare, through @domains/testkit), behind test/kafka-entry.ts, with
// the production connect from cloudflare:sockets over real TCP to the fake broker
// of DOM-004's tests (scripts/measure/fixtures/kafka/broker.mjs) on 127.0.0.1.
// The broker's log is synthetic: no byte here was recorded from the Zonestream
// broker (src/kafka.test.ts replays the recorded answers). The Worker reaches no
// host but 127.0.0.1. It proves what the Node test cannot: that the variable
// import of cloudflare:sockets resolves in workerd, that a Socket's streams carry
// the protocol, that six sockets open at once, and that the route bundles and runs
// under the probe's compatibility date and flags.
//
//   node scripts/test.mjs probes/worker --name "kafka workerd"
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { withWorker } from "@domains/testkit";
import { closedPort, FakeBroker, zonestreamLike } from "../../../scripts/measure/fixtures/kafka/broker.mjs";

const ENTRY = fileURLToPath(new URL("./kafka-entry.ts", import.meta.url));
const NOW = Date.now();
const MIN = 60_000;
const CS_BASE = 42_000_000_000;
const NRD_BASE = 166_000_000;
const CORRUPT = CS_BASE + 100;

interface Body {
  messages: number;
  bytes: number;
  next_offset: number;
  decode_ms: number;
  offset: number;
  lag: number;
  batches: number;
  failed_batches: number;
  failures: Record<string, number>;
  by_codec: Record<string, number>;
  sockets: { asked: number; opened: number; api_versions_ok: number; errors: string[] };
  stage?: string;
  error?: string;
}

// The fixture is JavaScript: TypeScript infers its default `corruptCertstream = []` as never[].
const zonestreamAt = zonestreamLike as (nowMs: number, options?: { corruptCertstream?: number[] }) => ReturnType<typeof zonestreamLike>;
const broker = new FakeBroker(zonestreamAt(NOW, { corruptCertstream: [CORRUPT] }));
let port = 0;
before(async () => {
  port = await broker.start();
});
after(() => broker.stop());

async function read(w: { fetch(path: string): Promise<{ status: number; json(): Promise<unknown> }> }, query: string): Promise<{ status: number; body: Body }> {
  const res = await w.fetch(`/kafka?${query}`);
  return { status: res.status, body: (await res.json()) as Body };
}

test("kafka workerd: the route reads the fake broker over cloudflare:sockets, snappy and codec none, resumes without a gap, and opens six sockets at once", async () => {
  await withWorker({ scriptPath: ENTRY, bindings: { KAFKA_HOST: "127.0.0.1", KAFKA_PORT: port } }, async (w) => {
    const loader = await w.fetch("/loader");
    assert.deepEqual(await loader.json(), { connect: "function" }, "the production loader resolves cloudflare:sockets in workerd");

    const cs = await read(w, `topic=certstream_domains&offset=${new Date(NOW - 15 * MIN).toISOString()}`);
    assert.equal(cs.status, 200, JSON.stringify(cs.body));
    assert.equal(cs.body.messages, 30);
    assert.deepEqual(cs.body.by_codec, { snappy: 2 });
    assert.equal(cs.body.failed_batches, 0);
    assert.equal(cs.body.lag, 0);
    assert.deepEqual(cs.body.sockets, { asked: 1, opened: 1, api_versions_ok: 1, errors: [] });
    // Locally the clock advances with no I/O (deployed it does not: src/kafka.ts),
    // so here decode_ms is the clock across the decode, never negative.
    assert.ok(Number.isInteger(cs.body.decode_ms) && cs.body.decode_ms >= 0, String(cs.body.decode_ms));

    let offset = "earliest";
    let total = 0;
    for (let calls = 0; ; calls += 1) {
      assert.ok(calls < 100, "the read reaches the head");
      const { status, body } = await read(w, `topic=newly_registered_domain&offset=${offset}&max_bytes=16384`);
      assert.equal(status, 200, JSON.stringify(body));
      assert.equal(body.offset, offset === "earliest" ? NRD_BASE : Number(offset));
      assert.deepEqual(body.by_codec, body.batches === 0 ? {} : { none: body.batches });
      total += body.messages;
      offset = String(body.next_offset);
      if (body.lag === 0) break;
    }
    assert.equal(total, 12 * 144, "every message once");

    const six = await read(w, "topic=newly_registered_fqdn&offset=latest-5&sockets=6");
    assert.equal(six.status, 200, JSON.stringify(six.body));
    assert.deepEqual(six.body.sockets, { asked: 6, opened: 6, api_versions_ok: 6, errors: [] });
    assert.equal(six.body.messages, 5);

    const bad = await read(w, `topic=certstream_domains&offset=${CORRUPT}&max_bytes=1`);
    assert.equal(bad.status, 200);
    assert.deepEqual(bad.body.failures, { crc: 1 });
    assert.equal(bad.body.next_offset, CORRUPT + 20, "the read goes on past the failed batch");

    const unknown = await read(w, "topic=no_such_topic&offset=earliest");
    assert.equal(unknown.status, 404);
    assert.equal(unknown.body.stage, "list_offsets");
    assert.equal(w.outbound.length, 0, "the Worker made no fetch");
  });
});

test("kafka workerd: a port nothing listens on answers 502 at connect, and a broker that never answers is cut at the wall cap (504)", async () => {
  const closed = await closedPort();
  await withWorker({ scriptPath: ENTRY, bindings: { KAFKA_HOST: "127.0.0.1", KAFKA_PORT: closed, CONNECT_MS: 5000 } }, async (w) => {
    const { status, body } = await read(w, "topic=certstream_domains&offset=0");
    assert.equal(status, 502, JSON.stringify(body));
    assert.equal(body.stage, "connect");
    assert.equal(body.sockets.opened, 0);
  });
  const silent = new FakeBroker(zonestreamLike(NOW), { silentApi: 1 });
  const silentPort = await silent.start();
  try {
    await withWorker({ scriptPath: ENTRY, bindings: { KAFKA_HOST: "127.0.0.1", KAFKA_PORT: silentPort, WALL_MS: 400 } }, async (w) => {
      const { status, body } = await read(w, `topic=certstream_domains&offset=${CS_BASE}`);
      assert.equal(status, 504, JSON.stringify(body));
      assert.equal(body.stage, "fetch");
      assert.match(body.error!, /past the cap of 400 ms/);
    });
  } finally {
    await silent.stop();
  }
});
