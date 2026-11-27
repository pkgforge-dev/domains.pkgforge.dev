// packages/adapter/src/writer.ts and json.ts on synthetic records. node:crypto's
// SHA-256 is the oracle for the writer's Web Crypto digest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson, JsonError, jsonEqual } from "../src/json.ts";
import type { SegmentDraft, Source } from "../src/types.ts";
import { ContractError } from "../src/validate.ts";
import { memoryWriter } from "../src/writer.ts";

const DRAFT: SegmentDraft = {
  source: "example-day",
  dataset: "names",
  window: { start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z" },
  cursorBefore: { last_day: "2026-10-25" },
  cursorAfter: { last_day: "2026-10-26" },
  precision: "day",
};
const sha = (b: string | Uint8Array): string => createHash("sha256").update(b).digest("hex");

async function rejects(p: Promise<unknown>, check: string, why: RegExp): Promise<void> {
  await assert.rejects(p, (e: unknown) => e instanceof ContractError && e.check === check && why.test(e.message));
}

test("adapter writer: canonical JSON sorts keys, so field order does not change the text", () => {
  assert.equal(canonicalJson({ b: 1, a: [true, null, "x"] }), '{"a":[true,null,"x"],"b":1}');
  assert.ok(jsonEqual({ a: 1, b: { c: 2, d: 3 } }, { b: { d: 3, c: 2 }, a: 1 }));
  assert.ok(!jsonEqual({ a: 1 }, { a: "1" }));
  for (const bad of [undefined, Number.POSITIVE_INFINITY, new Map(), [1, undefined], { f: () => 1 }]) assert.throws(() => canonicalJson(bad), JsonError);
});

test("adapter writer: a segment's sha256 and bytes are those of the canonical record stream", async () => {
  const w = memoryWriter();
  const seg = await w.write(DRAFT, [
    { key: "com.example.a", first: 299 },
    { first: 299, key: "org.example.b" },
  ]);
  const stream = '{"first":299,"key":"com.example.a"}\n{"first":299,"key":"org.example.b"}\n';
  assert.equal(seg.sha256, sha(stream));
  assert.equal(seg.bytes, Buffer.byteLength(stream));
  assert.equal(seg.count, 2);
  assert.equal(seg.raw, undefined);
  assert.deepEqual(w.written[0]!.records, [
    { key: "com.example.a", first: 299 },
    { key: "org.example.b", first: 299 },
  ]);
  // No record is an empty stream.
  assert.equal((await w.write(DRAFT, [])).sha256, sha(""));
});

test("adapter writer: raw bytes as one array or as chunks give the same reference", async () => {
  const w = memoryWriter();
  const bytes = new TextEncoder().encode("a.example.com\nb.example.org\n");
  const one = await w.write(DRAFT, [], bytes);
  async function* chunks() {
    yield bytes.subarray(0, 5);
    yield bytes.subarray(5);
  }
  const two = await w.write(DRAFT, [], chunks());
  assert.deepEqual(one.raw, { bytes: bytes.byteLength, sha256: sha(bytes) });
  assert.deepEqual(two.raw, one.raw);
});

test("adapter writer: records out of key order, a key twice, a record with no key or non-JSON fields are refused", async () => {
  const w = memoryWriter();
  await rejects(w.write(DRAFT, [{ key: "b" }, { key: "a" }]), "record", /does not sort after/);
  await rejects(w.write(DRAFT, [{ key: "a" }, { key: "a" }]), "record", /does not sort after/);
  await rejects(w.write(DRAFT, [{ key: "" }]), "record", /has no key/);
  await rejects(w.write(DRAFT, [{ key: "a", t: Number.NaN }]), "record", /record 0: t:/);
  assert.equal(w.written.length, 0);
});

test("adapter writer: a draft with a bad source, window or cursor is refused before any record is read", async () => {
  const w = memoryWriter();
  let read = false;
  function* records() {
    read = true;
    yield { key: "a" };
  }
  await rejects(w.write({ ...DRAFT, source: "Example" }, records()), "draft", /source is not an id/);
  await rejects(w.write({ ...DRAFT, window: { start: "2026-10-26T06:00:00Z", end: "2026-10-27T00:00:00Z" } }, records()), "segment", /00:00:00Z/);
  await rejects(w.write({ ...DRAFT, cursorAfter: { p: "x".repeat(5000) } }, records()), "cursor", /cursorAfter/);
  await rejects(w.write({ ...DRAFT, dataset: "nope" as "names" }, records()), "draft", /dataset/);
  await rejects(w.write({ ...DRAFT, precision: "hour" as "day" }, records()), "draft", /precision/);
  assert.equal(read, false);
});

// A window of a second-precision stream, the shape oi-nrd writes (DOM-026).
const STREAM: SegmentDraft = {
  source: "example-stream",
  dataset: "domains",
  window: { start: "2026-10-30T08:00:00Z", end: "2026-10-30T08:10:00Z" },
  cursorBefore: { next: 0 },
  cursorAfter: { next: 1 },
  precision: "second",
};
const MEMBER = { topic: "newly_registered_domain", partition: 0, base_offset: 100, last_offset: 101, batches: 2 };

test("adapter writer: rawMember and facts are recorded as given, and Segment.facts is the rows' size and SHA-256, none for no facts or an empty list", async () => {
  const w = memoryWriter();
  const facts = [
    { key: "com.example.a", cert_age: 3_456_789 },
    { key: "org.example.b", cert_age: 4 },
  ];
  const records = [{ key: "com.example.a" }, { key: "net.example.c" }, { key: "org.example.b" }];
  const seg = await w.write({ ...STREAM, rawMember: MEMBER, facts }, records, new Uint8Array([1, 2, 3]));
  const rows = '[["com.example.a",3456789],["org.example.b",4]]';
  assert.deepEqual(seg.facts, { bytes: rows.length, sha256: sha(rows) });
  assert.deepEqual(w.written[0]!.rawMember, MEMBER);
  assert.deepEqual(w.written[0]!.facts, facts);
  // No facts, or an empty list: no Segment.facts; the record of what was given keeps the difference.
  const none = await w.write({ ...STREAM, source: "example-other" }, records);
  const empty = await w.write({ ...STREAM, source: "example-third", facts: [] }, records);
  assert.equal(none.facts, undefined);
  assert.equal(empty.facts, undefined);
  assert.deepEqual(
    w.written.slice(1).map((x) => [x.rawMember, x.facts]),
    [
      [null, null],
      [null, []],
    ],
  );
  // The writer's copies: a change to the draft after the write does not reach them.
  const mutable = { ...MEMBER };
  const later = [{ key: "com.example.a", cert_age: 1 }];
  await w.write({ ...STREAM, source: "example-fourth", rawMember: mutable, facts: later }, records, new Uint8Array([1]));
  mutable.partition = 9;
  later[0]!.cert_age = 9;
  assert.deepEqual([w.written[3]!.rawMember?.partition, w.written[3]!.facts?.[0]?.cert_age], [0, 1]);
});

test("adapter writer: a rawMember on a day write, on a write with no raw byte, or of a bad shape is refused as draft", async () => {
  const w = memoryWriter();
  await rejects(w.write({ ...DRAFT, rawMember: MEMBER }, [], new Uint8Array([1])), "draft", /keeps its file in its segment's own layer raw/);
  await rejects(w.write({ ...STREAM, rawMember: MEMBER }, []), "draft", /the write has no raw byte/);
  await rejects(w.write({ ...STREAM, rawMember: MEMBER }, [], new Uint8Array(0)), "draft", /the write has no raw byte/);
  await rejects(w.write({ ...STREAM, rawMember: { offset: 5 } }, [], new Uint8Array([1])), "draft", /field offset is one the writer writes/);
  assert.equal(w.written.length, 0);
});

test("adapter writer: facts out of order, of a key not written, or with an age that is not a safe whole number are refused as draft", async () => {
  const w = memoryWriter();
  const records = [{ key: "com.example.a" }, { key: "org.example.b" }];
  let read = false;
  function* counted() {
    read = true;
    yield* records;
  }
  await rejects(
    w.write(
      {
        ...STREAM,
        facts: [
          { key: "org.example.b", cert_age: 1 },
          { key: "com.example.a", cert_age: 1 },
        ],
      },
      counted(),
    ),
    "draft",
    /facts\[1\]: the key "com\.example\.a" does not sort after/,
  );
  await rejects(w.write({ ...STREAM, facts: [{ key: "com.example.a", cert_age: -1 }] }, counted()), "draft", /the cert_age -1/);
  assert.equal(read, false, "a draft's facts are held before any record is read");
  await rejects(w.write({ ...STREAM, facts: [{ key: "net.example.c", cert_age: 1 }] }, records), "draft", /facts: the fact of "net\.example\.c" names a key no record of the segment has/);
  await rejects(w.write({ ...STREAM, facts: [{ key: "org.example.z", cert_age: 1 }] }, records), "draft", /the fact of "org\.example\.z"/);
  assert.equal(w.written.length, 0);
});

test("adapter writer: a draft's url is recorded as given, held to its row's urls when the writer has the sources, and refused as draft otherwise", async () => {
  const row = { id: "example-day", precision: "day", datasets: ["names"], urls: ["https://feed.example.test/"] } as unknown as Source;
  const w = memoryWriter({ sources: [row] });
  await w.write({ ...DRAFT, url: "https://feed.example.test/2026-10-26.txt" }, [{ key: "com.example.a" }], new Uint8Array([1]));
  await w.write({ ...DRAFT, dataset: "domains" }, [{ key: "com.example" }], new Uint8Array([1]));
  assert.deepEqual(
    w.written.map((x) => x.url),
    ["https://feed.example.test/2026-10-26.txt", null],
  );
  await rejects(w.write({ ...DRAFT, url: "https://other.example.test/x" }, []), "draft", /is not one of the source's urls nor under one \(https:\/\/feed\.example\.test\/\)/);
  await rejects(w.write({ ...DRAFT, url: "https://feed.example.test/x?token=abc" }, []), "draft", /the query parameter token names a credential/);
  await rejects(w.write({ ...DRAFT, source: "example-other", url: "https://feed.example.test/x" }, []), "draft", /the source is not one of the adapter's \(example-day\)/);
  assert.equal(w.written.length, 2);
  // Without the sources, the URL rules alone.
  const bare = memoryWriter();
  await bare.write({ ...DRAFT, url: "https://anywhere.example.test/x" }, []);
  await rejects(bare.write({ ...DRAFT, url: "https://u:p@anywhere.example.test/x" }, []), "draft", /a user name or a password/);
});
