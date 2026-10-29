// packages/adapter/src/writer.ts and json.ts on synthetic records. node:crypto's
// SHA-256 is the oracle for the writer's Web Crypto digest.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { canonicalJson, JsonError, jsonEqual } from "../src/json.ts";
import type { SegmentDraft } from "../src/types.ts";
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
