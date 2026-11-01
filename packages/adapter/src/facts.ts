// packages/adapter/src/facts.ts — the certificate facts of a pack's keys, the
// layer facts.json of a segment of obs or of a domains day pack (docs/format.md
// section 19; DOM-026). A domains record holds no certificate age, and the
// feed's confidence reads one per event (EventFacts.certAges of
// packages/feed), so the age travels beside the records in this layer.
//
//   encodeFacts(table)       a FactsTable → the layer's bytes
//   parseFacts(bytes)        the layer's bytes → a FactsTable, held to the format
//   mergeFacts(tables)       the minimum of each fact per key and bit, over tables
//   factsOfRows(rows, bit)   a draft's facts (SegmentDraft.facts) as the table of one source bit
//   factsRef(rows)           Segment.facts: { bytes, sha256 } of the rows' canonical JSON
//
// The layer is canonical JSON and one final newline, at most FACTS_MAX_BYTES:
//   {"facts":[["com.example",{"1":{"cert_age":3456789}}]],"format":"domains.facts.v1"}
// One item a key, the keys strictly ascending in code-unit order (byte order
// for a pack key), each a key of the pack's records. Per key an object keyed
// by source bit in decimal, 0 to 63, each the facts of that source's events:
// `cert_age`, the minimum certificate age in whole seconds. A reader refuses
// another format, a field beside `facts` and `format`, keys out of order or
// repeated, a key with no bit, a bit outside 0 to 63 or written otherwise
// than in decimal, and a `cert_age` that is not a safe whole number of at
// least 0. It ignores a fact field it does not know (DOM-050 may add
// rdap_created), as a reader of members.json ignores a member field; encodeFacts
// writes `cert_age` alone. No pack reader and no Worker reads the layer (the
// root build keeps parts and indexes only): the hour and day builds do.
//
// FACTS_MAX_BYTES bounds a segment's layer and a day pack's alike (settled S1
// of DOM-026): a day of oi-nrd is about 14.2 MB [E] at 35.4 B a message
// day-merged, MEASURED over 37,863 messages.
//
// Segment.facts names the rows a draft gave, not the layer: the rows carry no
// source bit, so the memory writer, which knows none, and the disk writer of
// scripts/ingest compute it alike, and the harness's equality of two runs
// covers the facts (settled S2). The disk writer also writes the layer, keyed
// by its source's bit.
//
// Pure: nothing from `node:`, so it runs in Node and in workerd alike.
import { canonicalJson, sha256Hex, utf8 } from "./json.ts";
import type { FactRow, FactsRef } from "./types.ts";
import { MAX_BIT } from "./validate.ts";

export const FACTS_FORMAT = "domains.facts.v1";
export const FACTS_TITLE = "facts.json";
export const FACTS_MEDIA_TYPE = "application/json";
export const FACTS_MAX_BYTES = 64 << 20;

// The facts of one source's events for one key.
export interface Facts {
  readonly cert_age?: number;
}

// Key → source bit → facts, keys ascending and each key's bits ascending.
export type FactsTable = ReadonlyMap<string, ReadonlyMap<number, Facts>>;

export const FACTS_ERRORS = Object.freeze(["usage", "size", "format", "order", "range"] as const);
export type FactsErrorCode = (typeof FACTS_ERRORS)[number];

export class FactsError extends Error {
  readonly code: FactsErrorCode;
  constructor(code: FactsErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "FactsError";
    this.code = code;
  }
}

type Obj = Readonly<Record<string, unknown>>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isAge = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
// A bit as the layer writes it: decimal, no leading zero.
const BIT_TEXT = /^(?:0|[1-9][0-9]?)$/;

function checkBit(bit: unknown, what: string): number {
  if (typeof bit !== "number" || !Number.isInteger(bit) || bit < 0 || bit > MAX_BIT)
    throw new FactsError("range", `${what}: the bit ${JSON.stringify(bit)} is not a whole number from 0 to ${MAX_BIT}`);
  return bit;
}

// The layer of `table`: its keys in code-unit order and each key's bits
// ascending, whatever order the maps hold them in. FactsError when a key is
// empty or names no bit, a bit is out of range, a cert_age is not a safe whole
// number of at least 0, or the layer passes FACTS_MAX_BYTES.
//
// The text is canonicalJson's (a test holds the two equal), written here for
// the one shape it has: the generic walk builds a path string for every value.
// MEASURED 2026-10-31T07:17Z on Node 26.7.0, a table of 450,000 keys (23.0 MB
// of layer): 780 ms through canonicalJson, 287 to 415 ms this way.
// canonicalJson sorts an object's keys by code unit, so the bits are written
// in that order of their decimal text ("10" before "2"); JSON.stringify is its
// encoding of a string.
export function encodeFacts(table: FactsTable): Uint8Array {
  if (!(table instanceof Map)) throw new FactsError("usage", "the facts are not a Map of key to bit to facts");
  const keys = [...table.keys()].sort();
  const items: string[] = [];
  for (const key of keys) {
    if (typeof key !== "string" || key === "") throw new FactsError("format", `the key ${JSON.stringify(key)} is not a non-empty string`);
    const bits = table.get(key);
    if (!(bits instanceof Map) || bits.size === 0) throw new FactsError("format", `the key ${JSON.stringify(key)} names no source bit`);
    const byBit: [string, string][] = [];
    for (const [bit, facts] of bits) {
      checkBit(bit, `the key ${JSON.stringify(key)}`);
      if (!isObject(facts)) throw new FactsError("format", `the facts of ${JSON.stringify(key)} bit ${bit} are not an object`);
      if (facts.cert_age !== undefined && !isAge(facts.cert_age))
        throw new FactsError("range", `the cert_age ${JSON.stringify(facts.cert_age)} of ${JSON.stringify(key)} bit ${bit} is not a safe whole number of at least 0`);
      byBit.push([String(bit), facts.cert_age === undefined ? "{}" : `{"cert_age":${facts.cert_age}}`]);
    }
    if (byBit.length > 1) byBit.sort(([a], [b]) => (a < b ? -1 : 1));
    items.push(`[${JSON.stringify(key)},{${byBit.map(([bit, facts]) => `"${bit}":${facts}`).join(",")}}]`);
  }
  const bytes = utf8(`{"facts":[${items.join(",")}],"format":${JSON.stringify(FACTS_FORMAT)}}\n`);
  if (bytes.byteLength > FACTS_MAX_BYTES) throw new FactsError("size", `the layer is ${bytes.byteLength} bytes, over ${FACTS_MAX_BYTES}`);
  return bytes;
}

// The table of a layer's bytes, held to the format (see the header).
export function parseFacts(bytes: Uint8Array): FactsTable {
  if (!(bytes instanceof Uint8Array)) throw new FactsError("usage", "the layer is not bytes");
  if (bytes.byteLength > FACTS_MAX_BYTES) throw new FactsError("size", `the layer is ${bytes.byteLength} bytes, over ${FACTS_MAX_BYTES}`);
  let json: unknown;
  try {
    // ignoreBOM keeps a byte order mark, which JSON.parse then refuses.
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes));
  } catch (e) {
    if (e instanceof TypeError) throw new FactsError("format", "the layer is not UTF-8");
    if (e instanceof SyntaxError) throw new FactsError("format", `the layer is not JSON: ${e.message}`);
    throw e;
  }
  if (!isObject(json)) throw new FactsError("format", "the layer is not a JSON object");
  if (json.format !== FACTS_FORMAT) throw new FactsError("format", `the format is ${JSON.stringify(json.format)}, not ${FACTS_FORMAT}`);
  for (const k of Object.keys(json)) if (k !== "facts" && k !== "format") throw new FactsError("format", `the layer holds the field ${JSON.stringify(k)}`);
  if (!Array.isArray(json.facts)) throw new FactsError("format", "facts is not a list");
  const table = new Map<string, Map<number, Facts>>();
  let prev: string | null = null;
  for (const [i, item] of json.facts.entries()) {
    if (!Array.isArray(item) || item.length !== 2) throw new FactsError("format", `facts[${i}] is not [key, bits]`);
    const [key, bits] = item as [unknown, unknown];
    if (typeof key !== "string" || key === "") throw new FactsError("format", `facts[${i}]: the key is not a non-empty string`);
    if (prev !== null && key <= prev) throw new FactsError("order", `facts[${i}]: the key ${JSON.stringify(key)} does not sort after ${JSON.stringify(prev)}`);
    prev = key;
    if (!isObject(bits) || Object.keys(bits).length === 0) throw new FactsError("format", `facts[${i}]: ${JSON.stringify(key)} names no source bit`);
    const byBit = new Map<number, Facts>();
    const order = Object.keys(bits).map((text) => {
      if (!BIT_TEXT.test(text)) throw new FactsError("range", `facts[${i}]: ${JSON.stringify(key)} names the bit ${JSON.stringify(text)}, not a decimal from 0 to ${MAX_BIT}`);
      return checkBit(Number(text), `facts[${i}]`);
    });
    if (order.length > 1) order.sort((a, b) => a - b);
    for (const bit of order) {
      const facts = bits[String(bit)];
      if (!isObject(facts)) throw new FactsError("format", `facts[${i}]: the facts of ${JSON.stringify(key)} bit ${bit} are not an object`);
      if (facts.cert_age === undefined) byBit.set(bit, {});
      else if (isAge(facts.cert_age)) byBit.set(bit, { cert_age: facts.cert_age });
      else throw new FactsError("range", `facts[${i}]: the cert_age ${JSON.stringify(facts.cert_age)} of ${JSON.stringify(key)} bit ${bit} is not a safe whole number of at least 0`);
    }
    table.set(key, byBit);
  }
  return table;
}

// One table of every key and bit of `tables`, each fact the minimum the
// tables give it (a fresh event of a domain clears an old certificate's age).
// The keys and each key's bits ascend.
export function mergeFacts(tables: readonly FactsTable[]): FactsTable {
  if (!Array.isArray(tables)) throw new FactsError("usage", "the tables are not a list");
  const merged = new Map<string, Map<number, Facts>>();
  for (const [i, table] of tables.entries()) {
    if (!(table instanceof Map)) throw new FactsError("usage", `tables[${i}] is not a Map of key to bit to facts`);
    for (const [key, bits] of table) {
      let into = merged.get(key);
      if (into === undefined) merged.set(key, (into = new Map()));
      for (const [bit, facts] of bits) {
        const was = into.get(bit)?.cert_age;
        const age = facts.cert_age;
        into.set(bit, was === undefined ? (age === undefined ? {} : { cert_age: age }) : { cert_age: age === undefined ? was : Math.min(was, age) });
      }
    }
  }
  const out = new Map<string, Map<number, Facts>>();
  for (const key of [...merged.keys()].sort()) {
    const bits = merged.get(key)!;
    out.set(key, bits.size === 1 ? bits : new Map([...bits.entries()].sort(([a], [b]) => a - b)));
  }
  return out;
}

// A draft's facts as the table of the source `bit`. The rows are held to their
// own rule by the writer first (factsProblem of validate.ts).
export function factsOfRows(rows: readonly FactRow[], bit: number): FactsTable {
  checkBit(bit, "the source");
  return new Map(rows.map((r) => [r.key, new Map([[bit, { cert_age: r.cert_age }]])]));
}

// Segment.facts of a draft's facts: the UTF-8 size and the hex SHA-256 of the
// canonical JSON of the rows as [[key, cert_age], ...]. The one way both
// writers compute it (settled S2 of DOM-026).
export async function factsRef(rows: readonly FactRow[]): Promise<FactsRef> {
  const bytes = utf8(canonicalJson(rows.map((r) => [r.key, r.cert_age])));
  return { bytes: bytes.byteLength, sha256: await sha256Hex(bytes) };
}
