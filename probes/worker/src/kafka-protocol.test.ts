// probes/worker/src/kafka-protocol.test.ts — the Worker's port of the Kafka
// protocol (src/kafka-protocol.ts) and of snappy (src/snappy.ts) against the
// scripts' modules that DOM-004 ran on a runner (scripts/measure/kafka-protocol.mjs,
// scripts/measure/snappy.mjs): the same requests encode to the same bytes, the
// broker's recorded answers parse to the same values, every batch decodes to the
// same records, and every malformed input is refused with the same kind and
// message. The port is a second copy of the decoder; this file is the check that
// the two agree (docs/conventions/forbidden-patterns.md, a value in two places).
//
//   node scripts/test.mjs probes/worker --name "kafka"
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildBatch, snappyCompress, varint, xerial } from "../../../scripts/measure/fixtures/kafka/build.mjs";
import * as mjs from "../../../scripts/measure/kafka-protocol.mjs";
import * as mjsSnappy from "../../../scripts/measure/snappy.mjs";
import * as ts from "./kafka-protocol.ts";
import * as tsSnappy from "./snappy.ts";

const FIXTURES = fileURLToPath(new URL("../../../scripts/measure/fixtures/kafka/", import.meta.url));
const recordedFrame = (name: string): Buffer => {
  const b = readFileSync(`${FIXTURES}${name}`);
  assert.equal(b.readInt32BE(0), b.length - 4, `${name} holds one whole frame`);
  return b;
};
const hex = (b: Uint8Array | null | undefined): string | null => (b === null || b === undefined ? null : Buffer.from(b).toString("hex"));
const t0 = 1_793_000_000_000;
const records = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: t0 + i * 1000, value: JSON.stringify({ i, domain: `d${i}.example` }) }));

interface AnyBatch {
  baseOffset: number;
  lastOffset: number;
  codec: string;
  isControl: boolean;
  recordCount: number;
  decodedBytes: number;
  records: { offset: number; timestamp: number; key: Uint8Array | null; value: Uint8Array | null }[];
}

const plain = (d: AnyBatch) => ({ ...d, records: d.records.map((r) => ({ offset: r.offset, timestamp: r.timestamp, key: hex(r.key), value: hex(r.value) })) });

// The outcome of a decode: the batch, or the error's kind and message.
function outcome(decode: () => AnyBatch): unknown {
  try {
    return plain(decode());
  } catch (err) {
    const e = err as Error & { kind?: string };
    return { error: e.name, kind: e.kind ?? null, message: e.message };
  }
}

const both = (bytes: Uint8Array): { port: unknown; script: unknown } => ({
  port: outcome(() => ts.decodeBatch(new Uint8Array(bytes))),
  script: outcome(() => mjs.decodeBatch(Buffer.from(bytes)) as AnyBatch),
});

// The CRC-32C recomputed over a batch whose bytes a test changed after the
// build, so that the planted fault is the only one.
const reCrc = (b: Buffer): Buffer => {
  b.writeUInt32BE(mjs.crc32c(b, 21), 17);
  return b;
};

test("kafka protocol port: CRC-32C matches the Castagnoli check value and the script's", () => {
  assert.equal(ts.crc32c(new TextEncoder().encode("123456789")), 0xe3069283);
  assert.equal(ts.crc32c(new Uint8Array(0)), 0);
  const data = randomBytes(4096);
  assert.equal(ts.crc32c(data, 21, 4000), mjs.crc32c(data, 21, 4000));
});

test("kafka protocol port: ApiVersions, ListOffsets and Fetch requests encode to the script's bytes", () => {
  const body = ts.fetchBody({ topics: [{ topic: "certstream_domains", partitions: [{ partition: 3, offset: 42_689_203_481, maxBytes: 1 << 20 }] }], maxWaitMs: 500, minBytes: 1, maxBytes: 1 << 20 });
  const same = (a: Uint8Array, b: Buffer, what: string) => assert.equal(hex(a), b.toString("hex"), what);
  same(
    body,
    mjs.fetchBody({ topics: [{ topic: "certstream_domains", partitions: [{ partition: 3, offset: 42_689_203_481, maxBytes: 1 << 20 }] }], maxWaitMs: 500, minBytes: 1, maxBytes: 1 << 20 }),
    "Fetch v4",
  );
  const lo = [{ topic: "newly_registered_domain", partitions: [{ partition: 0, timestamp: ts.EARLIEST }] }];
  same(ts.listOffsetsBody(lo), mjs.listOffsetsBody(lo), "ListOffsets v1");
  for (const apiKey of [ts.API.API_VERSIONS, ts.API.LIST_OFFSETS, ts.API.FETCH]) {
    const spec = { apiKey, apiVersion: ts.VERSION[apiKey]!, correlationId: 7, clientId: "domains.pkgforge.dev", body };
    same(ts.encodeRequest(spec), mjs.encodeRequest({ ...spec, body: Buffer.from(body) }), `request ${apiKey}`);
  }
  assert.deepEqual({ ...ts.VERSION }, { 1: mjs.VERSION[1], 2: mjs.VERSION[2], 18: mjs.VERSION[18] }, "the port speaks the script's versions");
});

test("kafka protocol port: the broker's recorded answers parse to the script's values", () => {
  const av = recordedFrame("api-versions-v0.bin").subarray(8);
  assert.deepEqual([...ts.parseApiVersions(new ts.Reader(av, "av")).apis], [...mjs.parseApiVersions(new mjs.Reader(av, "av")).apis]);
  const lo = recordedFrame("list-offsets-v1.bin").subarray(8);
  assert.deepEqual(ts.parseListOffsets(new ts.Reader(lo, "lo")), mjs.parseListOffsets(new mjs.Reader(lo, "lo")));
  for (const name of ["fetch-v4-certstream_domains.bin", "fetch-v4-newly_registered_domain.bin"]) {
    const frame = recordedFrame(name).subarray(8);
    const port = ts.parseFetch(new ts.Reader(frame, name));
    const script = mjs.parseFetch(new mjs.Reader(frame, name));
    const p = port.topics[0]!.partitions[0]!;
    const s = script.topics[0].partitions[0];
    assert.deepEqual({ ...p, records: hex(p.records) }, { ...s, records: hex(s.records) }, name);
    const split = ts.splitBatches(p.records!);
    const scriptSplit = mjs.splitBatches(s.records);
    assert.equal(split.partial, scriptSplit.partial, `${name}: the partial tail`);
    assert.deepEqual(
      split.batches.map((b) => ({ ...b, bytes: hex(b.bytes) })),
      scriptSplit.batches.map((b: { bytes: Buffer }) => ({ ...b, bytes: hex(b.bytes) })),
      `${name}: the batches`,
    );
    for (const b of split.batches) {
      const { port: decoded, script: expected } = both(b.bytes);
      assert.deepEqual(decoded, expected, `${name}: batch at ${b.baseOffset}`);
      assert.equal((decoded as AnyBatch).recordCount, b.recordCount);
    }
  }
});

test("kafka protocol port: batches of codec none and snappy, raw and xerial, decode to the script's records", () => {
  const cases = [
    buildBatch({ baseOffset: 42_000_000_000, records: records(25), codec: "none" }),
    buildBatch({ baseOffset: 42_000_000_000, records: records(25), codec: "snappy" }),
    buildBatch({ baseOffset: 7, records: records(300), codec: "snappy", xerialChunk: 256 }),
    buildBatch({ baseOffset: 0, records: records(3), codec: "none", logAppendTime: true }),
    buildBatch({ baseOffset: 0, records: records(1), codec: "none", control: true }),
    buildBatch({
      baseOffset: 9,
      records: [
        { timestamp: t0, key: "k", value: null, headers: [["h", "v"]] },
        { timestamp: t0 - 5, value: "" },
      ],
      codec: "snappy",
    }),
  ];
  for (const bytes of cases) {
    const { port, script } = both(bytes);
    assert.ok(!("error" in (port as object)), JSON.stringify(port));
    assert.deepEqual(port, script);
  }
});

test("kafka protocol port: a flipped byte, a broken snappy payload, a wrong record count or a bad record is refused as the script refuses it", () => {
  const good = buildBatch({ baseOffset: 5, records: records(10), codec: "snappy" });
  const flipped = Buffer.from(good);
  flipped[flipped.length - 1] ^= 0x01;
  const magic1 = Buffer.from(good);
  magic1[16] = 1;
  const badSnappy = Buffer.concat([good.subarray(0, ts.BATCH_HEADER), Buffer.from([0x20, 0x00, 0x61])]);
  badSnappy.writeInt32BE(badSnappy.length - 12, 8);
  const moreDeclared = Buffer.from(buildBatch({ baseOffset: 0, records: records(4), codec: "none" }));
  moreDeclared.writeInt32BE(5, 57);
  const fewerDeclared = Buffer.from(buildBatch({ baseOffset: 0, records: records(4), codec: "none" }));
  fewerDeclared.writeInt32BE(3, 57);
  const recBody = Buffer.concat([Buffer.from([0]), varint(0), varint(0), varint(-1), varint(1), Buffer.from("x"), varint(0)]);
  const badRecord = Buffer.concat([good.subarray(0, ts.BATCH_HEADER), varint(recBody.length + 1), recBody, Buffer.from([0])]);
  badRecord.writeInt32BE(badRecord.length - 12, 8);
  badRecord.writeInt16BE(0, 21);
  badRecord.writeInt32BE(1, 57);
  const cases: [string, Buffer, string][] = [
    ["a flipped byte", flipped, "crc"],
    ["a batch cut inside its header", good.subarray(0, 40), "truncated"],
    ["magic 1", magic1, "magic"],
    ["a snappy payload that does not decode", reCrc(badSnappy), "snappy"],
    ["one record more declared than held", reCrc(moreDeclared), "records"],
    ["one record fewer declared than held", reCrc(fewerDeclared), "records"],
    ["a record longer than its length prefix", reCrc(badRecord), "records"],
    ["lz4", buildBatch({ baseOffset: 0, records: records(2), codec: "lz4" }), "codec"],
  ];
  for (const [name, bytes, kind] of cases) {
    const { port, script } = both(bytes);
    assert.deepEqual(port, script, name);
    assert.equal((port as { error: string }).error, "KafkaDecodeError", name);
    assert.equal((port as { kind: string }).kind, kind, name);
  }
});

test("kafka protocol port: gzip and zstd batches, which the script decodes with node:zlib, are refused as codec failures", () => {
  for (const codec of ["gzip", "zstd"]) {
    const bytes = buildBatch({ baseOffset: 0, records: records(2), codec });
    const { port, script } = both(bytes);
    assert.equal((script as AnyBatch).codec, codec, "the script decodes it");
    assert.deepEqual(port, { error: "KafkaDecodeError", kind: "codec", message: `codec: compression ${codec} is not decoded by this reader` });
  }
});

test("kafka protocol port: a response with bytes left over, a dishonest count or an int64 past 2^53 is refused", () => {
  const r = (h: string) => new ts.Reader(Buffer.from(h, "hex"), "x");
  assert.throws(() => ts.parseApiVersions(r("0000000000000099")), ts.ProtocolError);
  assert.throws(() => ts.parseListOffsets(r("7fffffff")), ts.ProtocolError);
  assert.throws(() => r("0000").int32(), ts.ProtocolError);
  assert.throws(() => r("ffffffffffffffffffffffff").varint(), ts.ProtocolError);
  assert.throws(() => r("7fffffffffffffff").int64(), ts.ProtocolError);
  assert.throws(() => ts.splitBatches(Buffer.from("000000000000000000000001ffffffff00", "hex")), ts.ProtocolError);
  for (const n of [0, -1, 1, 63, -64, 64, 300, -300, 2 ** 31 - 1, -(2 ** 31), 2 ** 40]) {
    const reader = new ts.Reader(varint(n), "v");
    assert.equal(n > 2 ** 31 ? reader.varlong() : reader.varint(), n);
  }
});

test("kafka snappy port: data from an independent compressor, in every literal and copy form, decodes as the script decodes it", () => {
  const samples = [
    Buffer.alloc(0),
    Buffer.from("a"),
    Buffer.from("a".repeat(48)),
    Buffer.from("0123456789".repeat(50)),
    Buffer.from(JSON.stringify({ domain_list: Array.from({ length: 200 }, (_, i) => `h${i}.example.com`) })),
    randomBytes(70_000),
  ];
  for (const s of samples) {
    for (const options of [{}, { maxLiteral: 7 }, { copy4: true }]) {
      const block = snappyCompress(s, options);
      const out = tsSnappy.snappyRaw(new Uint8Array(block));
      assert.equal(hex(out), s.toString("hex"));
      assert.equal(hex(out), hex(mjsSnappy.snappyRaw(block)));
    }
  }
  const stream = xerial([snappyCompress(Buffer.from("first block, first block")), snappyCompress(Buffer.from("second"))]);
  assert.ok(tsSnappy.isXerial(stream));
  assert.equal(Buffer.from(tsSnappy.snappyKafka(stream)).toString(), "first block, first blocksecond");
});

test("kafka snappy port: every malformed block or stream is refused with the script's message", () => {
  const b = (...xs: number[]) => Uint8Array.from(xs);
  const raw: [string, Uint8Array][] = [
    ["an empty input", b()],
    ["a varint that never ends", b(0x80, 0x80)],
    ["a varint longer than 5 bytes", b(0x80, 0x80, 0x80, 0x80, 0x80, 0x01)],
    ["a length far above the input", b(0xff, 0xff, 0x03, 0)],
    ["a literal past the input", b(4, 3 << 2, 0x61)],
    ["a literal past the declared length", b(1, 1 << 2, 0x61, 0x62)],
    ["a long literal length past the input", b(70, 61 << 2, 1)],
    ["a copy before the start", b(4, 0, 0x61, 1, 2)],
    ["a copy with offset 0", b(5, 0, 0x61, 1, 0)],
    ["a copy past the declared length", b(3, 0, 0x61, 1, 1)],
    ["a 2-byte-offset copy cut short", b(3, 0, 0x61, 2, 1)],
    ["a 4-byte-offset copy cut short", b(3, 0, 0x61, 3, 1, 0)],
    ["fewer bytes than declared", b(5, 1 << 2, 0x61, 0x62)],
  ];
  const refusal = (fn: () => unknown): string => {
    try {
      fn();
    } catch (err) {
      assert.equal((err as Error).name, "SnappyError");
      return (err as Error).message;
    }
    return "decoded";
  };
  for (const [name, block] of raw) {
    const port = refusal(() => tsSnappy.snappyRaw(block));
    assert.notEqual(port, "decoded", name);
    assert.equal(
      port,
      refusal(() => mjsSnappy.snappyRaw(block)),
      name,
    );
  }
  const stream = xerial([snappyCompress(Buffer.from("first block, first block")), snappyCompress(Buffer.from("second"))]);
  const streams: [string, Uint8Array][] = [
    ["a chunk cut short", stream.subarray(0, stream.length - 3)],
    ["trailing bytes", Buffer.concat([stream, Buffer.from([0, 0])])],
    ["a zero-length chunk", Buffer.concat([stream.subarray(0, 16), Buffer.from([0, 0, 0, 0])])],
  ];
  for (const [name, bytes] of streams) {
    const port = refusal(() => tsSnappy.snappyKafka(bytes));
    assert.notEqual(port, "decoded", name);
    assert.equal(
      port,
      refusal(() => mjsSnappy.snappyKafka(bytes)),
      name,
    );
  }
});
