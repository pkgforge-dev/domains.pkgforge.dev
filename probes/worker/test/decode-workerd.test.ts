// probes/worker/test/decode-workerd.test.ts — DOM-008's /decode route in workerd
// (Miniflare, through @domains/testkit), under the compatibility date and flags
// the probe deploys with, against an in-memory R2 bucket holding sample packs
// that scripts/measure/make-sample-pack.mjs builds from synthetic names. It
// proves that DecompressionStream("deflate-raw") of that runtime reads the
// blocks node:zlib writes, and that the decoded names equal the input. The
// route runs from test/decode-entry.ts, a Worker that serves it alone. The
// local-integration tier: the deployed probe is the acceptance test.
//
//   node scripts/test.mjs probes/worker --name decode
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COMPATIBILITY_DATE, COMPATIBILITY_FLAGS, withWorker } from "@domains/testkit";
import { buildPack } from "../../../scripts/measure/make-sample-pack.mjs";
import { dnsOrder, hex32, type SampleEntry, samplePackKey } from "../src/decode.ts";

const ENTRY = fileURLToPath(new URL("./decode-entry.ts", import.meta.url));
const WRANGLER_TOML = fileURLToPath(new URL("../wrangler.toml", import.meta.url));

type Rec = [key: string, flags: number];

// Synthetic names, reversed and sorted as the writer keeps them: 3,000 keys,
// so 1,024 names a block makes three blocks, the last one short.
function syntheticRecords(n: number): Rec[] {
  const keys: string[] = [];
  for (let i = 0; i < n; i += 1) keys.push(`np.com.zone${String(i % 41).padStart(2, "0")}.host-${String(i).padStart(5, "0")}${i % 7 === 0 ? ".api" : ""}`);
  keys.sort();
  return keys.map((key, i) => [key, 1 + (i % 3)]);
}

const RECORDS = syntheticRecords(3000);

function pack(per: number): { bytes: Uint8Array; entries: SampleEntry[] } {
  const built = buildPack(RECORDS, per) as { bytes: Buffer; entries: SampleEntry[] };
  return { bytes: new Uint8Array(built.bytes), entries: built.entries };
}

interface Answer {
  names: number;
  crc32: string;
  first_key: string;
  last_key: string;
  blocks: number;
  read_from: string;
  rows?: { name: string; exact: boolean; wildcard: boolean }[];
  error?: string;
}

test("probe decode workerd: the harness runs the date and flags that wrangler.toml deploys", async () => {
  const { readFileSync } = await import("node:fs");
  const toml = readFileSync(WRANGLER_TOML, "utf8");
  assert.match(toml, new RegExp(`^compatibility_date = "${COMPATIBILITY_DATE}"$`, "m"));
  assert.match(toml, new RegExp(`^compatibility_flags = \\[${COMPATIBILITY_FLAGS.map((f) => `"${f}"`).join(", ")}\\]$`, "m"));
});

test("probe decode workerd: blocks and rows of a sample pack decode with deflate-raw to the names that went in", async () => {
  const p1024 = pack(1024);
  const p4096 = pack(4096);
  await withWorker({ scriptPath: ENTRY, r2Buckets: ["PROBE"] }, async (w) => {
    const bucket = await w.miniflare.getR2Bucket("PROBE");
    await bucket.put(samplePackKey(1024), p1024.bytes);
    await bucket.put(samplePackKey(4096), p4096.bytes);

    const blocks = await w.fetch("/decode?blocks=3&per=1024&tag=w.1");
    assert.equal(blocks.status, 200);
    assert.equal(blocks.headers.get("cache-control"), "no-store");
    const b = (await blocks.json()) as Answer;
    assert.equal(b.names, 3000);
    assert.equal(b.crc32, hex32(p1024.entries[2]!.crcThrough));
    assert.equal(b.first_key, RECORDS[0]![0]);
    assert.equal(b.last_key, RECORDS[2999]![0]);
    assert.equal(b.read_from, "R2 binding PROBE: 2 ranged gets of sample/v1/per-1024.pack");

    // Every name, through the rows: the decoded names equal the input.
    const rows = await w.fetch("/decode?rows=3000&per=1024");
    assert.equal(rows.status, 200);
    const r = (await rows.json()) as Answer;
    assert.deepEqual(
      r.rows,
      RECORDS.map(([key, flags]) => ({ name: dnsOrder(key), exact: (flags & 1) !== 0, wildcard: (flags & 2) !== 0 })),
    );

    // One block of 4,096 that holds all 3,000 names, as rows=1000 reads it.
    const one = (await (await w.fetch("/decode?rows=1000")).json()) as Answer;
    assert.equal(one.blocks, 1);
    assert.equal(one.names, 3000);
    assert.equal(one.crc32, hex32(p4096.entries[0]!.crcThrough));
    assert.equal(one.rows!.length, 1000);

    const past = await w.fetch("/decode?blocks=4&per=1024");
    assert.equal(past.status, 400);
    assert.match(((await past.json()) as Answer).error!, /holds 3 blocks, fewer than the 4 asked for/);
    const missing = await w.fetch("/decode?blocks=1&per=16384");
    assert.equal(missing.status, 503);
    assert.equal((await w.fetch("/decode?blocks=17")).status, 400);
    assert.deepEqual(w.outbound, [], "the route fetches nothing outside R2");
  });
});

test("probe decode workerd: a flipped byte in a block is a 500 that names the block", async () => {
  const p = pack(1024);
  const bytes = new Uint8Array(p.bytes);
  const at = p.entries[1]!.offset + Math.floor(p.entries[1]!.packed / 2);
  bytes[at] = bytes[at]! ^ 0x10;
  await withWorker({ scriptPath: ENTRY, r2Buckets: ["PROBE"] }, async (w) => {
    const bucket = await w.miniflare.getR2Bucket("PROBE");
    await bucket.put(samplePackKey(1024), bytes);
    assert.equal((await w.fetch("/decode?blocks=1&per=1024")).status, 200, "block 0 is whole");
    const res = await w.fetch("/decode?blocks=2&per=1024");
    assert.equal(res.status, 500);
    // A flipped bit either breaks the deflate stream or changes the bytes it gives.
    assert.match(((await res.json()) as Answer).error!, /sample\/v1\/per-1024\.pack block 1 (does not inflate|inflates|: the CRC-32 through it)/);
  });
});
