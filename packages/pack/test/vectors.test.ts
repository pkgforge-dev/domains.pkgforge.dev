// The test vectors of packages/pack/test/vectors/ and the two places
// docs/format.md states a value the code also holds.
//
// A vector's parts and index are the bytes one writer wrote (its `written_by`
// names the Node and zlib builds). The reader must read them to the vector's
// records. The writer must give the same raw blocks, CRCs, counts and keys,
// which no zlib build changes. The writer's compressed bytes, and the index
// with them, match the vector only under the same zlib build; the test says
// which it saw and holds the index to the vector whenever the parts match.
// The index layout alone is held byte for byte: the vector's index, parsed and
// encoded again, gives the same bytes.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { inflateRawSync } from "node:zlib";
import {
  DEFAULT_CODEC,
  DEFAULT_PAGE_ENTRIES,
  DEFAULT_PART_LIMIT,
  DEFAULT_RECORDS_PER_BLOCK,
  encodeIdx,
  fromHex,
  hex32,
  MAX_RAW_BLOCK_BYTES,
  NAMES_CODEC,
  PackReader,
  partsSource,
  readIdx,
  toHex,
} from "../src/index.ts";
import { collect, writeMem } from "./helpers.ts";
import { makeVector, SPECS, type Vector, VECTOR_DIR, VECTOR_FORMAT } from "./make-vectors.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const FORMAT_DOC = readFileSync(join(ROOT, "docs", "format.md"), "utf8");
const vectors: Vector[] = SPECS.map((s) => JSON.parse(readFileSync(join(VECTOR_DIR, s.file), "utf8")) as Vector);

test("pack vectors: the directory holds the three vectors and nothing else", () => {
  assert.deepEqual(readdirSync(VECTOR_DIR).sort(), SPECS.map((s) => s.file).sort());
  for (const v of vectors) {
    assert.equal(v.format, VECTOR_FORMAT);
    assert.match(v.synthetic, /synthetic/);
  }
});

test("pack vectors: the reader reads each vector's parts and index to its records and raw blocks", async () => {
  for (const v of vectors) {
    const reader = await PackReader.open(fromHex(v.idx), partsSource(v.parts.map(fromHex)), NAMES_CODEC);
    assert.deepEqual(await collect(reader.scan()), v.records, v.title);
    const raws: Uint8Array[] = [];
    for await (const e of reader.index.entries()) raws.push(await reader.readBlock(e));
    assert.deepEqual(raws.map(toHex), v.raw_blocks, v.title);
    assert.equal(createHash("sha256").update(Buffer.concat(raws)).digest("hex"), v.sha256, v.title);
    for (const r of v.records) assert.deepEqual(await reader.get(r.key), r);
  }
});

test("pack vectors: an index parsed and encoded again gives the vector's bytes", () => {
  for (const v of vectors) {
    const idx = fromHex(v.idx);
    const read = readIdx(idx);
    const again = encodeIdx({ ...read.head.header, parts: read.head.parts, keyMin: read.head.keyMin, keyMax: read.head.keyMax, entries: read.entries });
    assert.equal(toHex(again), v.idx, v.title);
  }
});

test("pack vectors: the writer gives each vector's raw blocks, block entries and SHA-256", async (t) => {
  for (const v of vectors) {
    const { summary, parts } = await writeMem(v.records, { codec: NAMES_CODEC, recordsPerBlock: v.records_per_block, pageEntries: v.page_entries });
    const raw = summary.entries.map((e) => toHex(inflateRawSync(parts[e.part].subarray(e.offset, e.offset + e.packed))));
    assert.deepEqual(raw, v.raw_blocks, v.title);
    assert.deepEqual(
      summary.entries.map((e) => ({ key: e.key, part: e.part, raw: e.raw, records: e.records, crc32: hex32(e.crc) })),
      v.blocks,
      v.title,
    );
    assert.equal(summary.sha256, v.sha256, v.title);
    const sameParts = parts.map(toHex).join() === v.parts.join();
    if (sameParts) assert.equal(toHex(summary.idx), v.idx, v.title);
    else t.diagnostic(`${v.title}: this zlib (${process.versions.zlib}) compresses otherwise than the vector's writer (${v.written_by}); the raw blocks agree`);
  }
  // With the zlib build that wrote the vectors, the generator writes them again exactly.
  for (const spec of SPECS) {
    const v = vectors.find((x) => x.title === spec.title)!;
    if (v.written_by !== `node ${process.version}, zlib ${process.versions.zlib}`) continue;
    assert.deepEqual(await makeVector(spec), v);
  }
});

test("pack vectors: the worked example of docs/format.md is the raw block of the first vector", () => {
  const section = FORMAT_DOC.slice(FORMAT_DOC.indexOf("## 12. A worked example"));
  const hex = section.match(/```text\n([0-9a-f]+)\n```/);
  assert.ok(hex, "docs/format.md section 12 holds a hex block");
  assert.equal(hex[1], vectors[0].raw_blocks[0]);
  assert.equal(fromHex(hex[1]).length, 36);
});

test("pack vectors: the defaults table of docs/format.md equals the constants of the code", () => {
  const section = FORMAT_DOC.slice(FORMAT_DOC.indexOf("## 9. Defaults"), FORMAT_DOC.indexOf("## 10."));
  const table = Object.fromEntries([...section.matchAll(/^\| `([A-Z_]+)` \| (\d+) \|$/gm)].map((m) => [m[1], Number(m[2])]));
  assert.deepEqual(table, {
    DEFAULT_RECORDS_PER_BLOCK,
    DEFAULT_CODEC,
    DEFAULT_PART_LIMIT,
    DEFAULT_PAGE_ENTRIES,
    MAX_RAW_BLOCK_BYTES,
  });
});
