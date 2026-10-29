// packages/pack's reader in workerd (Miniflare, through @domains/testkit), under
// the harness's compatibility date and flags (no nodejs_compat): the Worker path
// is run, not assumed. test/pack-worker.ts reads packs written in Node and
// answers what its reader gives; each answer is held equal to the vector's
// records or to Node's reader on the same bytes.
//
//   node scripts/test.mjs packages/pack --name workerd
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { withWorker } from "@domains/testkit";
import { CODEC_GZIP, NAMES_CODEC, toHex } from "../src/index.ts";
import { collect, type MemPack, randomNames, readerOf, writeMem } from "./helpers.ts";
import { SPECS, type Vector, VECTOR_DIR } from "./make-vectors.ts";

const WORKER = join(import.meta.dirname, "pack-worker.ts");
const asked = (pack: { idx: Uint8Array; parts: Uint8Array[] }, extra: Record<string, unknown> = {}) => ({
  method: "POST",
  body: JSON.stringify({ idx: toHex(pack.idx), parts: pack.parts.map(toHex), ...extra }),
});
const memAsked = (pack: MemPack, extra: Record<string, unknown> = {}) => asked({ idx: pack.summary.idx, parts: pack.parts }, extra);

test("pack workerd: the reader in workerd reads each vector to its records", async () => {
  const vectors = SPECS.map((s) => JSON.parse(readFileSync(join(VECTOR_DIR, s.file), "utf8")) as Vector);
  await withWorker({ scriptPath: WORKER }, async (w) => {
    for (const v of vectors) {
      const keys = [...v.records.map((r) => r.key), "com.absent"];
      const res = await w.fetch("/read", { method: "POST", body: JSON.stringify({ idx: v.idx, parts: v.parts, get: keys }) });
      assert.equal(res.status, 200, v.title);
      const body = (await res.json()) as { records: unknown[]; got: Record<string, unknown>; dataset: number; codec: number };
      assert.deepEqual(body.records, v.records, v.title);
      assert.equal(body.dataset, 1);
      assert.equal(body.codec, 1);
      for (const r of v.records) assert.deepEqual(body.got[r.key], r);
      assert.equal(body.got["com.absent"], null);
    }
  });
});

test("pack workerd: packs of 3,000 names over parts and pages, deflate-raw and gzip, read in workerd as in Node", async () => {
  const records = randomNames(3000, 61);
  const deflate = await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 64, pageEntries: 4, partLimit: 20_000 });
  const gzip = await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: 64, pageEntries: 4, blockCodec: CODEC_GZIP });
  assert.ok(deflate.parts.length > 1);
  const keys = records.filter((_, i) => i % 50 === 0).map((r) => r.key);
  const lo = records[700].key;
  const hi = records[1300].key;
  await withWorker({ scriptPath: WORKER }, async (w) => {
    for (const [label, pack] of [
      ["deflate-raw", deflate],
      ["gzip", gzip],
    ] as const) {
      const res = await w.fetch("/read", memAsked(pack, { get: keys, lo, hi }));
      assert.equal(res.status, 200, label);
      const body = (await res.json()) as { records: unknown[]; got: Record<string, unknown>; range: unknown[]; codec: number };
      assert.equal(body.codec, label === "gzip" ? CODEC_GZIP : 1);
      assert.deepEqual(body.records, records, label);
      const node = await readerOf(pack, NAMES_CODEC);
      for (const k of keys) assert.deepEqual(body.got[k], await node.get(k), `${label} ${k}`);
      assert.deepEqual(body.range, await collect(node.scan(lo, hi)), label);
      assert.equal(body.range.length, 600);
    }
  });
});

test("pack workerd: a byte changed in a stored block fails the CRC in workerd", async () => {
  const records = randomNames(40, 62);
  const pack = await writeMem(records, { codec: NAMES_CODEC, compress: (_c, raw) => new Uint8Array(deflateRawSync(raw, { level: 0 })), recordsPerBlock: 20 });
  const parts = pack.parts.map((p) => p.slice());
  const e = pack.summary.entries[0];
  parts[0][e.offset + e.packed - 1] += 1;
  await withWorker({ scriptPath: WORKER }, async (w) => {
    const res = await w.fetch("/read", asked({ idx: pack.summary.idx, parts }));
    assert.equal(res.status, 422);
    const body = (await res.json()) as { code: string; message: string };
    assert.equal(body.code, "crc");
    assert.match(body.message, /block 0: the CRC-32 of its raw bytes/);
  });
});
