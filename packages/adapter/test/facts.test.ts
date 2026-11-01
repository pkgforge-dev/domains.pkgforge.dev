// packages/adapter/src/facts.ts on synthetic tables: the layer facts.json
// (docs/format.md section 19, DOM-026), its reader's refusals, the merge, the
// cap of settled S1 and Segment.facts of settled S2. node:crypto's SHA-256 is
// the oracle for factsRef's Web Crypto digest. No key or age here was read
// from a source.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  encodeFacts,
  FACTS_FORMAT,
  FACTS_MAX_BYTES,
  FACTS_MEDIA_TYPE,
  FACTS_TITLE,
  type Facts,
  FactsError,
  type FactsErrorCode,
  type FactsTable,
  factsOfRows,
  factsRef,
  mergeFacts,
  parseFacts,
} from "../src/facts.ts";
import * as adapter from "../src/index.ts";
import { canonicalJson } from "../src/json.ts";
import { ContractError } from "../src/validate.ts";
import { memoryWriter } from "../src/writer.ts";

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const bytesOf = (s: string): Uint8Array => new TextEncoder().encode(s);
const table = (entries: [string, [number, Facts][]][]): FactsTable => new Map(entries.map(([k, bits]) => [k, new Map(bits)]));
// The table as plain lists, so deepEqual compares order too.
const listOf = (t: FactsTable): [string, [number, Facts][]][] => [...t].map(([k, bits]) => [k, [...bits]]);

function refused(fn: () => unknown, code: FactsErrorCode, why: RegExp): void {
  assert.throws(fn, (e: unknown) => e instanceof FactsError && e.code === code && why.test(e.message), String(why));
}

test("adapter facts: the layer is canonical JSON and one newline, keys in code-unit order and bits ascending, whatever order the maps hold", () => {
  const t = table([
    ["net.example", [[1, { cert_age: 4 }]]],
    [
      "com.example",
      [
        [10, { cert_age: 7 }],
        [2, { cert_age: 3456789 }],
        [3, {}],
      ],
    ],
  ]);
  const layer = encodeFacts(t);
  assert.equal(text(layer), '{"facts":[["com.example",{"10":{"cert_age":7},"2":{"cert_age":3456789},"3":{}}],["net.example",{"1":{"cert_age":4}}]],"format":"domains.facts.v1"}\n');
  const back = parseFacts(layer);
  assert.deepEqual(listOf(back), [
    [
      "com.example",
      [
        [2, { cert_age: 3456789 }],
        [3, {}],
        [10, { cert_age: 7 }],
      ],
    ],
    ["net.example", [[1, { cert_age: 4 }]]],
  ]);
  assert.deepEqual(encodeFacts(back), layer);
  // An empty table is a layer of no fact.
  assert.equal(text(encodeFacts(new Map())), '{"facts":[],"format":"domains.facts.v1"}\n');
  assert.deepEqual([FACTS_FORMAT, FACTS_TITLE, FACTS_MEDIA_TYPE, FACTS_MAX_BYTES], ["domains.facts.v1", "facts.json", "application/json", 64 * 1024 * 1024]);
});

test("adapter facts: the encoder writes canonicalJson's text, bits in the code-unit order of their decimal text", () => {
  // Every bit from 0 to 63 on one key, inserted in reverse, ages with and without; keys that sort by code unit.
  const bits: [number, Facts][] = Array.from({ length: 64 }, (_, i) => [63 - i, i % 3 === 0 ? {} : { cert_age: i * 1_000_003 }]);
  const t = table([
    ["org.example", bits],
    ["com.example-b", [[5, { cert_age: Number.MAX_SAFE_INTEGER }]]],
    ["com.example", [[0, { cert_age: 0 }]]],
    ['com.q"uote\\', [[7, {}]]],
  ]);
  const value = {
    format: FACTS_FORMAT,
    facts: [...t.keys()].sort().map((k) => [k, Object.fromEntries([...t.get(k)!].map(([bit, f]) => [String(bit), f]))]),
  };
  assert.equal(text(encodeFacts(t)), `${canonicalJson(value)}\n`);
});

test("adapter facts: a reader ignores a fact field it does not know, and keeps the facts it knows", () => {
  const t = parseFacts(bytesOf('{"facts":[["com.example",{"1":{"cert_age":5,"rdap_created":7},"2":{"rdap_created":7}}]],"format":"domains.facts.v1"}\n'));
  assert.deepEqual(listOf(t), [
    [
      "com.example",
      [
        [1, { cert_age: 5 }],
        [2, {}],
      ],
    ],
  ]);
});

test("adapter facts: a reader refuses another format, a stray field, keys out of order or twice, a key with no bit, a bit out of range or not decimal, a bad cert_age, bytes that are not UTF-8 or JSON, and a layer over the cap", () => {
  const layer = (facts: unknown, more: Record<string, unknown> = {}) => bytesOf(`${JSON.stringify({ facts, format: FACTS_FORMAT, ...more })}\n`);
  const one = (bits: unknown) => layer([["com.example", bits]]);
  const cases: [Uint8Array, FactsErrorCode, RegExp][] = [
    [bytesOf('{"facts":[],"format":"domains.facts.v2"}\n'), "format", /not domains\.facts\.v1/],
    [bytesOf('{"facts":[]}\n'), "format", /the format is undefined/],
    [layer([], { extra: 1 }), "format", /the field "extra"/],
    [bytesOf("[]"), "format", /not a JSON object/],
    [layer({}), "format", /facts is not a list/],
    [layer([["com.example"]]), "format", /facts\[0\] is not \[key, bits\]/],
    [layer([["", { 1: {} }]]), "format", /the key is not a non-empty string/],
    [layer([[7, { 1: {} }]]), "format", /the key is not a non-empty string/],
    [
      layer([
        ["net.example", { 1: {} }],
        ["com.example", { 1: {} }],
      ]),
      "order",
      /"com\.example" does not sort after "net\.example"/,
    ],
    [
      layer([
        ["com.example", { 1: {} }],
        ["com.example", { 1: {} }],
      ]),
      "order",
      /does not sort after/,
    ],
    [one({}), "format", /names no source bit/],
    [one([]), "format", /names no source bit/],
    [one({ 64: { cert_age: 1 } }), "range", /bit 64 is not a whole number from 0 to 63/],
    [one({ "01": { cert_age: 1 } }), "range", /the bit "01", not a decimal/],
    [one({ "-1": { cert_age: 1 } }), "range", /the bit "-1"/],
    [one({ 1: 5 }), "format", /are not an object/],
    [one({ 1: { cert_age: -1 } }), "range", /cert_age -1 .* not a safe whole number/],
    [one({ 1: { cert_age: 1.5 } }), "range", /cert_age 1\.5/],
    [one({ 1: { cert_age: "5" } }), "range", /cert_age "5"/],
    [one({ 1: { cert_age: 2 ** 53 } }), "range", /cert_age 9007199254740992/],
    [new Uint8Array([0x7b, 0xff, 0x7d]), "format", /not UTF-8/],
    [bytesOf("﻿{}"), "format", /not JSON/],
    [bytesOf("{"), "format", /not JSON/],
    [new Uint8Array(FACTS_MAX_BYTES + 1), "size", /67108865 bytes, over 67108864/],
  ];
  for (const [bytes, code, why] of cases) refused(() => parseFacts(bytes), code, why);
  refused(() => parseFacts("{}" as unknown as Uint8Array), "usage", /not bytes/);
});

test("adapter facts: the encoder refuses an empty key, a key with no bit, a bit out of range, a cert_age that is not a safe whole number, and what is not a table", () => {
  refused(() => encodeFacts(table([["", [[1, {}]]]])), "format", /not a non-empty string/);
  refused(() => encodeFacts(table([["com.example", []]])), "format", /names no source bit/);
  refused(() => encodeFacts(table([["com.example", [[64, {}]]]])), "range", /bit 64/);
  refused(() => encodeFacts(table([["com.example", [[1.5, {}]]]])), "range", /bit 1\.5/);
  refused(() => encodeFacts(table([["com.example", [[1, { cert_age: -3 }]]]])), "range", /cert_age -3/);
  refused(() => encodeFacts(table([["com.example", [[1, { cert_age: Number.NaN }]]]])), "range", /cert_age null/);
  refused(() => encodeFacts({} as unknown as FactsTable), "usage", /not a Map/);
  refused(() => factsOfRows([{ key: "com.example", cert_age: 1 }], 64), "range", /the source: the bit 64/);
  // The review of DOM-026: bit -1, and facts that are not an object.
  refused(() => encodeFacts(table([["com.example", [[-1, {}]]]])), "range", /the bit -1 is not a whole number from 0 to 63/);
  refused(() => factsOfRows([{ key: "com.example", cert_age: 1 }], -1), "range", /the source: the bit -1/);
  refused(() => encodeFacts(table([["com.example", [[1, 5 as unknown as Facts]]]])), "format", /the facts of "com\.example" bit 1 are not an object/);
  refused(() => encodeFacts(table([["com.example", [[1, null as unknown as Facts]]]])), "format", /are not an object/);
});

test("adapter facts: mergeFacts answers each key's bits ascending even when one table holds them out of order", () => {
  const merged = mergeFacts([
    table([
      [
        "com.example",
        [
          [3, { cert_age: 9 }],
          [1, { cert_age: 4 }],
        ],
      ],
    ]),
  ]);
  assert.deepEqual([...merged.get("com.example")!.keys()], [1, 3]);
});

test("adapter facts: a layer of exactly FACTS_MAX_BYTES is written and read; the memory writer holds the size at the widest bit, 63, where it is over", async () => {
  // 1,025 keys of 65,500 bytes, the last cut so the layer at bit 0 is exactly the cap.
  const rows = Array.from({ length: 1025 }, (_, i) => ({ key: `${String(i).padStart(4, "0")}${"k".repeat(65_496)}`, cert_age: 0 }));
  // The layer's size at bit 0, counted from its text (the keys are ASCII), as the encoder refuses it whole.
  const size0 = `{"facts":[],"format":"${FACTS_FORMAT}"}\n`.length + rows.reduce((n, r) => n + `["${r.key}",{"0":{"cert_age":0}}]`.length, 0) + rows.length - 1;
  const over = size0 - FACTS_MAX_BYTES;
  const last = rows.at(-1)!;
  rows[rows.length - 1] = { key: last.key.slice(0, last.key.length - over), cert_age: 0 };
  const exact = encodeFacts(factsOfRows(rows, 0));
  assert.equal(exact.byteLength, FACTS_MAX_BYTES);
  assert.equal(parseFacts(exact).size, rows.length);
  // At bit 63 each key is a byte longer.
  refused(() => encodeFacts(factsOfRows(rows, 63)), "size", new RegExp(`the layer is ${FACTS_MAX_BYTES + rows.length} bytes, over ${FACTS_MAX_BYTES}`));
  const draft = {
    source: "example-stream",
    dataset: "domains" as const,
    window: { start: "2026-10-30T08:00:00Z", end: "2026-10-30T08:10:00Z" },
    cursorBefore: null,
    cursorAfter: { next: 1 },
    precision: "second" as const,
    facts: rows,
  };
  await assert.rejects(memoryWriter().write(draft, [][Symbol.iterator]()), (e: unknown) => e instanceof ContractError && e.check === "draft" && /facts: size: /.test(e.message));
});

test("adapter facts: mergeFacts takes the minimum per key and bit, keeps each bit apart, and orders keys and bits", () => {
  const segment1 = table([
    ["com.example", [[1, { cert_age: 3_456_789 }]]],
    ["org.example", [[1, {}]]],
  ]);
  // A fresh event of com.example in another segment of the day clears the old certificate's age.
  const segment2 = table([
    [
      "com.example",
      [
        [3, { cert_age: 900 }],
        [1, { cert_age: 12 }],
      ],
    ],
    ["net.example", [[1, { cert_age: 604_801 }]]],
    ["org.example", [[1, { cert_age: 40 }]]],
  ]);
  const merged = mergeFacts([segment1, segment2]);
  assert.deepEqual(listOf(merged), [
    [
      "com.example",
      [
        [1, { cert_age: 12 }],
        [3, { cert_age: 900 }],
      ],
    ],
    ["net.example", [[1, { cert_age: 604_801 }]]],
    ["org.example", [[1, { cert_age: 40 }]]],
  ]);
  // The order of the tables does not change the merge.
  assert.deepEqual(encodeFacts(mergeFacts([segment2, segment1])), encodeFacts(merged));
  assert.deepEqual(listOf(mergeFacts([])), []);
  refused(() => mergeFacts([{} as unknown as FactsTable]), "usage", /tables\[0\] is not a Map/);
});

test("adapter facts: a table of 400,000 keys merges, encodes under FACTS_MAX_BYTES and reads back (settled S1)", () => {
  // Two segments' tables of 300,000 keys each, half shared: 450,000 keys merged.
  const key = (i: number): string => `com.synthetic-${i.toString(36).padStart(5, "0")}`;
  const a = new Map<string, Map<number, Facts>>();
  const b = new Map<string, Map<number, Facts>>();
  for (let i = 0; i < 300_000; i++) a.set(key(i), new Map([[1, { cert_age: (i * 7919) % 15_000_000 }]]));
  for (let i = 150_000; i < 450_000; i++) b.set(key(i), new Map([[1, { cert_age: (i * 104_729) % 15_000_000 }]]));
  const merged = mergeFacts([a, b]);
  assert.equal(merged.size, 450_000);
  const layer = encodeFacts(merged);
  assert.ok(layer.byteLength < FACTS_MAX_BYTES, `${layer.byteLength} B`);
  const back = parseFacts(layer);
  assert.equal(back.size, 450_000);
  const shared = key(200_000);
  assert.deepEqual(back.get(shared)?.get(1), { cert_age: Math.min((200_000 * 7919) % 15_000_000, (200_000 * 104_729) % 15_000_000) });
  assert.deepEqual(encodeFacts(back), layer);
});

test("adapter facts: a layer over FACTS_MAX_BYTES is refused by the encoder, and by the memory writer before any record is read, at the widest bit", async () => {
  // 1,030 keys of 65,535 bytes, the longest pack key: 67.5 MB of layer, over 64 MiB.
  const rows = Array.from({ length: 1030 }, (_, i) => ({ key: `${String(i).padStart(4, "0")}${"k".repeat(65_531)}`, cert_age: i }));
  refused(() => encodeFacts(factsOfRows(rows, 1)), "size", /over 67108864/);
  let read = false;
  function* records() {
    read = true;
    yield { key: "a" };
  }
  const draft = {
    source: "example-stream",
    dataset: "domains" as const,
    window: { start: "2026-10-30T08:00:00Z", end: "2026-10-30T08:10:00Z" },
    cursorBefore: null,
    cursorAfter: { next: 1 },
    precision: "second" as const,
    facts: rows,
  };
  await assert.rejects(memoryWriter().write(draft, records()), (e: unknown) => e instanceof ContractError && e.check === "draft" && /facts: size: .* over 67108864/.test(e.message));
  assert.equal(read, false);
});

test("adapter facts: factsRef is the UTF-8 size and SHA-256 of the rows' canonical JSON, [[key, cert_age], ...], with no source bit", async () => {
  const rows = [
    { key: "com.example", cert_age: 3_456_789 },
    { key: "net.example", cert_age: 0 },
  ];
  const json = '[["com.example",3456789],["net.example",0]]';
  assert.deepEqual(await factsRef(rows), { bytes: json.length, sha256: createHash("sha256").update(json).digest("hex") });
  assert.deepEqual(await factsRef([]), { bytes: 2, sha256: createHash("sha256").update("[]").digest("hex") });
  // The same rows under any bit give one ref: the layer differs, the ref does not.
  assert.notDeepEqual(encodeFacts(factsOfRows(rows, 1)), encodeFacts(factsOfRows(rows, 3)));
});

test("adapter facts: the package exports the facts format and the draft checks", () => {
  for (const name of [
    "FACTS_FORMAT",
    "FACTS_TITLE",
    "FACTS_MEDIA_TYPE",
    "FACTS_MAX_BYTES",
    "FACTS_ERRORS",
    "FactsError",
    "encodeFacts",
    "parseFacts",
    "mergeFacts",
    "factsOfRows",
    "factsRef",
    "checkRawMember",
    "checkRawMemberBytes",
    "factsProblem",
    "factKeysWalk",
    "MAX_RAW_MEMBER_BYTES",
    "RAW_MEMBER_OWN",
  ])
    assert.ok((adapter as Record<string, unknown>)[name] !== undefined, name);
  assert.equal(adapter.parseFacts, parseFacts);
});
