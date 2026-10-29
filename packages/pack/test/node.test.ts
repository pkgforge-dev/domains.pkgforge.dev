// packages/pack/node: the production compressor and a pack on disk. A pack is
// written into a temporary directory, read back by range from its files, and
// refused when a file of it is cut or when the directory already holds one. A
// range past the end of a file answers what the file holds, with no buffer of
// the length asked.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { gunzipSync, inflateRawSync } from "node:zlib";
import { nodeCompress, openPackFiles, WRITER_LEVEL, writePackFiles, writerId } from "../node/index.ts";
import { ANNOTATIONS, CODEC_DEFLATE_RAW, CODEC_GZIP, NAMES_CODEC, PackError, PackReader } from "../src/index.ts";
import { collect, randomNames } from "./helpers.ts";
import { refusedWith } from "./plant.ts";

const dir = mkdtempSync(join(tmpdir(), "pack-node-"));
after(() => rmSync(dir, { recursive: true, force: true }));

test("pack node: nodeCompress gives deflate-raw and gzip at level 9 that decompress to the block", async () => {
  assert.equal(WRITER_LEVEL, 9);
  const raw = new TextEncoder().encode("com.example.www ".repeat(500));
  const d = await nodeCompress(CODEC_DEFLATE_RAW, raw);
  assert.deepEqual(new Uint8Array(inflateRawSync(d)), raw);
  const g = await nodeCompress(CODEC_GZIP, raw);
  assert.deepEqual(new Uint8Array(gunzipSync(g)), raw);
  assert.deepEqual([g[0], g[1]], [0x1f, 0x8b]);
  assert.throws(
    () => nodeCompress(3, raw),
    (e: unknown) => e instanceof PackError && e.code === "codec",
  );
  assert.match(writerId(), /^node v\d+\.\d+\.\d+, zlib \S+$/);
});

test("pack node: a pack written to files reads back by range from them", async () => {
  const records = randomNames(3000, 51);
  const out = join(dir, "names");
  const written = await writePackFiles(records, out, { codec: NAMES_CODEC, recordsPerBlock: 100, partLimit: 20_000 });
  assert.ok(written.summary.parts.length > 1);
  assert.deepEqual(
    written.files.map((f) => f.slice(out.length + 1)),
    [...written.summary.parts.map((_, i) => `part.${String(i).padStart(3, "0")}`), "idx"],
  );
  assert.deepEqual(new Uint8Array(readFileSync(join(out, "idx"))), written.summary.idx);
  assert.equal(written.annotations[ANNOTATIONS.sha256], written.summary.sha256);
  assert.equal(written.annotations[ANNOTATIONS.writer], writerId());
  const files = await openPackFiles(out);
  try {
    const reader = await PackReader.open(files.idx, files.parts, NAMES_CODEC);
    assert.deepEqual(await collect(reader.scan()), records);
    assert.deepEqual(await reader.get(records[1234].key), records[1234]);
  } finally {
    await files.close();
  }
  // A second pack into the same directory is refused: a pack is written once.
  await assert.rejects(() => writePackFiles(records, out, { codec: NAMES_CODEC }), /EEXIST/);
});

test("pack node: a part file cut short is refused when the block in its cut is read", async () => {
  const records = randomNames(500, 52);
  const out = join(dir, "cut");
  const written = await writePackFiles(records, out, { codec: NAMES_CODEC, recordsPerBlock: 100 });
  const part = written.files[0];
  const size = statSync(part).size;
  truncateSync(part, size - 3);
  const files = await openPackFiles(out);
  try {
    const reader = await PackReader.open(files.idx, files.parts, NAMES_CODEC);
    assert.deepEqual(await reader.get(records[0].key), records[0]);
    await refusedWith(() => reader.get(records[499].key), "short-read", /answered/);
    // Given the sizes the directory holds, the reader refuses the cut at open.
    assert.deepEqual(files.partSizes, [size - 3]);
    await refusedWith(
      () => PackReader.open(files.idx, files.parts, NAMES_CODEC, { partSizes: files.partSizes }),
      "tiling",
      new RegExp(`part 0: the index gives it ${size} B and the store holds ${size - 3} B`),
    );
  } finally {
    await files.close();
  }
  await assert.rejects(() => openPackFiles(dir), /holds no idx/);
});

test("pack node: a range past the end of a file answers the bytes the file holds, and allocates no more", async () => {
  const out = join(dir, "clamp");
  const written = await writePackFiles(randomNames(200, 53), out, { codec: NAMES_CODEC, recordsPerBlock: 100 });
  const files = await openPackFiles(out);
  try {
    assert.deepEqual(
      files.partSizes,
      written.summary.parts.map((p) => p.bytes),
    );
    // 2^40 B is far past any machine's memory: a buffer of the length asked
    // would throw, so the answer shows the read was cut to the file first.
    assert.equal((await files.parts.read(0, 0, 2 ** 40)).length, files.partSizes[0]);
    assert.equal((await files.parts.read(0, 10, 2 ** 40)).length, files.partSizes[0] - 10);
    assert.equal((await files.parts.read(0, files.partSizes[0] + 5, 4)).length, 0);
    assert.deepEqual(await files.idx.read(0, 2 ** 40), written.summary.idx);
  } finally {
    await files.close();
  }
});
