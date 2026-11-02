// apps/api/test/pack.test.ts — a pack opened by the Worker (apps/api/src/pack.ts)
// with the two reader options of packages/pack, the Found of 2026-10-29T04:54Z
// in TODO/serve.md DOM-030: a part size that differs from the index is refused
// `tiling` at open, and a block above the bound is refused `page` before its
// bytes are read. The packs are written here with synthetic names, and their
// blobs are served by the testkit's GHCR stand-in.
import assert from "node:assert/strict";
import { test } from "node:test";
import { MemorySink, NAMES_CODEC, type NameRecord, PART_HEADER_BYTES, PackError, writePack } from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import { BLOB_HOST, type World } from "@domains/testkit";
import { ApiCache } from "../src/cache.ts";
import { ImmutableError, readerOf } from "../src/ghcr.ts";
import { MAX_IDX_BYTES, MAX_PAGE_ENTRIES, MAX_RAW_BLOCK_BYTES, MAX_RECORDS_PER_BLOCK, openPack, type PackBlobs } from "../src/pack.ts";
import { apiWorld, type Blobs, sha256 } from "./helpers.ts";

const REPO = "pkgforge-dev/domains.pkgforge.dev/names";
const RECORDS_PER_BLOCK = 8192;
// A names key is at most 253 bytes. 8,192 keys of 247 bytes, which share no
// more than a few leading bytes, make a block of about 2 MB raw, above 1 MiB.
const LONG = 240;

const seen = [{ bit: 0, first: 1_767_225_600, last: 1_767_225_600 }];
// Synthetic letters from a fixed linear congruential sequence: a key shares
// almost nothing with the key before it, so front coding cannot shorten it.
function letters(seed: number, n: number): string {
  let x = seed >>> 0;
  let out = "";
  for (let i = 0; i < n; i += 1) {
    x = (Math.imul(x, 1_664_525) + 1_013_904_223) >>> 0;
    out += String.fromCharCode(97 + ((x >>> 27) % 26));
  }
  return out;
}
const smallKeys = Array.from({ length: RECORDS_PER_BLOCK }, (_, i) => `a.example.k${String(i).padStart(5, "0")}`);
const longKeys = Array.from({ length: RECORDS_PER_BLOCK }, (_, i) => `b${String(i).padStart(5, "0")}.${letters(i + 1, LONG)}`);

interface Written {
  pack: PackBlobs;
  partDigest: string;
}

// A names pack of two blocks: block 0 of small keys, block 1 of keys whose
// block passes MAX_RAW_BLOCK_BYTES raw. Its idx and its one part are planted as
// blobs of REPO.
async function plantPack(w: World, blobs: Blobs): Promise<Written> {
  const sink = new MemorySink();
  const records: NameRecord[] = [...smallKeys, ...longKeys].map((key) => ({ key, flags: 1, sources: seen }));
  const summary = await writePack(records, { codec: NAMES_CODEC, compress: nodeCompress, sink, recordsPerBlock: RECORDS_PER_BLOCK });
  assert.equal(summary.blocks, 2);
  assert.ok(summary.entries[0]!.raw < MAX_RAW_BLOCK_BYTES);
  assert.ok(summary.entries[1]!.raw > MAX_RAW_BLOCK_BYTES, `block 1 is ${summary.entries[1]!.raw} B raw`);
  const [part] = sink.parts();
  assert.ok(part);
  const idxDigest = await sha256(summary.idx);
  const partDigest = await sha256(part);
  for (const [d, bytes] of [
    [idxDigest, summary.idx],
    [partDigest, part],
  ] as const) {
    blobs.set(d, bytes);
    w.blobs.set(`names@${d}`, true);
  }
  return {
    pack: { repo: REPO, tag: "names-d-20261026", idx: { digest: idxDigest, size: summary.idx.byteLength }, parts: [{ digest: partDigest, size: part.byteLength }], sources: ["thc-ct"] },
    partDigest,
  };
}

// The reader and the Cache API entries of one request; `waits` holds its cache writes.
const io = (w: World) => {
  const waits: Promise<unknown>[] = [];
  const cache = new ApiCache({ host: "domains.example.test", ray: "-", waitUntil: (p) => waits.push(p), cache: w.cache });
  return { g: readerOf(cache), cache, waits };
};

// A small names pack written with `options`, its idx and parts planted as blobs of REPO.
async function plantSmall(
  w: World,
  blobs: Blobs,
  keys: readonly string[],
  options: { recordsPerBlock: number; pageEntries?: number; partLimit?: number },
): Promise<{ pack: PackBlobs; parts: Uint8Array[] }> {
  const sink = new MemorySink();
  const records: NameRecord[] = keys.map((key) => ({ key, flags: 1, sources: seen }));
  const summary = await writePack(records, { codec: NAMES_CODEC, compress: nodeCompress, sink, ...options });
  const parts = sink.parts();
  const refs = [];
  for (const bytes of [summary.idx, ...parts]) {
    const d = await sha256(bytes);
    blobs.set(d, bytes);
    w.blobs.set(`names@${d}`, true);
    refs.push({ digest: d, size: bytes.byteLength });
  }
  const [idx, ...partRefs] = refs as [{ digest: string; size: number }, ...{ digest: string; size: number }[]];
  return { pack: { repo: REPO, tag: "names-d-20261027", idx, parts: partRefs, sources: ["thc-ct"] }, parts };
}

// The `body` entry of a pack's part, by the part's digest.
const partEntry = (w: World, digest: string) => {
  const url = [...w.cache.entries.keys()].find((k) => decodeURIComponent(k).includes(`@${digest}/`));
  assert.ok(url, `a body entry of ${digest}`);
  return { url, entry: w.cache.entries.get(url)! };
};

// The reads of the part's blob a world saw from index `from` on: its 307 at GHCR and its signed URL.
const partReads = (w: World, digest: string, from = 0) => w.since(from).filter((r) => r.url.includes(digest));

test("pack: a manifest whose part size differs from the index is refused tiling at open, before any block is read", async () => {
  await apiWorld(
    () => undefined,
    async (w, blobs) => {
      const { pack, partDigest } = await plantPack(w, blobs);
      const { g, cache } = io(w);
      const wrong = { ...pack, parts: [{ ...pack.parts[0]!, size: pack.parts[0]!.size + 1 }] };
      await assert.rejects(
        () => openPack(g, cache, wrong, []),
        (err: unknown) => err instanceof PackError && err.code === "tiling" && /part 0: the index gives it \d+ B and the store holds \d+ B/.test(err.message),
      );
      const twoParts = { ...pack, parts: [pack.parts[0]!, pack.parts[0]!] };
      await assert.rejects(
        () => openPack(g, cache, twoParts, []),
        (err: unknown) => err instanceof PackError && err.code === "tiling",
      );
      assert.equal(partReads(w, partDigest).length, 0, "no part was read");
      // The same pack with the manifest's true sizes opens and reads.
      const reader = await openPack(g, cache, pack, []);
      assert.equal((await reader.get(smallKeys[3]!))?.key, smallKeys[3]);
    },
  );
});

test("pack: a block above maxRawBlockBytes is refused page with no part read, and a block under it reads", async () => {
  await apiWorld(
    () => undefined,
    async (w, blobs) => {
      const { pack, partDigest } = await plantPack(w, blobs);
      const { g, cache } = io(w);
      const reads: Parameters<typeof openPack>[3] = [];
      const reader = await openPack(g, cache, pack, reads);
      assert.equal(reader.maxRawBlockBytes, MAX_RAW_BLOCK_BYTES);
      const from = w.requests.length;
      await assert.rejects(
        () => reader.get(longKeys[5]!),
        (err: unknown) => err instanceof PackError && err.code === "page" && /block 1 has \d+ raw bytes, above the 1048576 this reader reads/.test(err.message),
      );
      assert.equal(partReads(w, partDigest, from).length, 0, "no part read for the refused block");
      const record = await reader.get(smallKeys[7]!);
      assert.equal(record?.key, smallKeys[7]);
      assert.ok(partReads(w, partDigest, from).length > 0, "block 0 was read from the part");
      assert.ok(reads.length > 0 && reads.every((r) => r.pack === "names-d-20261026" && r.sources[0] === "thc-ct"));
    },
  );
});

test("pack: the bound is 1 MiB by default, a tighter one applies, and one above 1 MiB is refused", async () => {
  assert.equal(MAX_RAW_BLOCK_BYTES, 1_048_576);
  await apiWorld(
    () => undefined,
    async (w, blobs) => {
      const { pack } = await plantPack(w, blobs);
      const { g, cache } = io(w);
      const tight = await openPack(g, cache, pack, [], { maxRawBlockBytes: 100 });
      await assert.rejects(
        () => tight.get(smallKeys[0]!),
        (err: unknown) => err instanceof PackError && err.code === "page",
      );
      await assert.rejects(
        () => openPack(g, cache, pack, [], { maxRawBlockBytes: MAX_RAW_BLOCK_BYTES + 1 }),
        (err: unknown) => err instanceof PackError && err.code === "usage",
      );
    },
  );
});

test("pack: a second read of a block comes from the body entry, byte for byte, and names the tier hit", async () => {
  await apiWorld(
    () => undefined,
    async (w, blobs) => {
      const { pack } = await plantPack(w, blobs);
      const { g, cache, waits } = io(w);
      const cold: Parameters<typeof openPack>[3] = [];
      const first = await openPack(g, cache, pack, cold);
      assert.equal((await first.get(smallKeys[1]!))?.key, smallKeys[1]);
      // Each write is handed to waitUntil: the signed URL and the body of the index, then of the block.
      assert.equal(waits.length, 4, "every cache write runs in waitUntil");
      await Promise.all(waits);
      assert.ok(cold.every((r) => r.tier === "ghcr"));
      assert.ok(w.cache.ofKind("body").length >= 2, "the index and the block are kept");
      const warm: Parameters<typeof openPack>[3] = [];
      const from = w.requests.length;
      const second = await openPack(g, cache, pack, warm);
      assert.equal((await second.get(smallKeys[2]!))?.key, smallKeys[2]);
      assert.ok(warm.length > 0 && warm.every((r) => r.tier === "cache"));
      assert.equal(w.since(from).filter((r) => r.url.startsWith(BLOB_HOST) || r.url.startsWith("https://ghcr.io/")).length, 0);
    },
  );
});

test("pack: an index of more than 8,192 records a block or 256 entries a page is refused page at open with no block read, and an index above 1 MiB before any read", async () => {
  assert.equal(MAX_RECORDS_PER_BLOCK, 8192);
  assert.equal(MAX_PAGE_ENTRIES, 256);
  assert.equal(MAX_IDX_BYTES, 1_048_576);
  const keys = smallKeys.slice(0, 10);
  for (const [label, options, message] of [
    ["recordsPerBlock 65,535", { recordsPerBlock: 65_535 }, /holds 65535 records a block; this Worker reads at most 8192/],
    ["pageEntries 257", { recordsPerBlock: 4096, pageEntries: 257 }, /holds 257 entries a page; this Worker reads at most 256/],
  ] as const) {
    await apiWorld(
      () => undefined,
      async (w, blobs) => {
        const { pack } = await plantSmall(w, blobs, keys, options);
        const { g, cache } = io(w);
        await assert.rejects(
          () => openPack(g, cache, pack, []),
          (err: unknown) => err instanceof PackError && err.code === "page" && message.test(err.message),
          label,
        );
        assert.equal(partReads(w, pack.parts[0]!.digest).length, 0, `${label}: no part read`);
      },
    );
  }
  await apiWorld(
    () => undefined,
    async (w, blobs) => {
      const { pack } = await plantSmall(w, blobs, keys, { recordsPerBlock: 4096 });
      const { g, cache } = io(w);
      await assert.rejects(
        () => openPack(g, cache, { ...pack, idx: { ...pack.idx, size: MAX_IDX_BYTES + 1 } }, []),
        (err: unknown) => err instanceof PackError && err.code === "page" && /is 1048577 B; this Worker reads an index of 1 to 1048576 B/.test(err.message),
      );
      assert.equal(w.requests.length, 0, "no read at all");
    },
  );
});

test("pack: an index whose bytes do not hash to its digest is refused, from GHCR and from the cache, and never kept", async () => {
  await apiWorld(
    () => undefined,
    async (w, blobs) => {
      const { pack } = await plantSmall(w, blobs, smallKeys.slice(0, 10), { recordsPerBlock: 4096 });
      const good = blobs.get(pack.idx.digest)!;
      const bad = good.slice();
      bad[bad.length - 1] = bad[bad.length - 1]! ^ 1;
      blobs.set(pack.idx.digest, bad);
      const { g, cache, waits } = io(w);
      await assert.rejects(
        () => openPack(g, cache, pack, []),
        (err: unknown) => err instanceof ImmutableError && /hashes to sha256:/.test(err.message),
      );
      await Promise.all(waits);
      assert.equal(w.cache.ofKind("body").length, 0, "nothing kept");
      // A good read keeps it; an entry changed afterwards is a logged miss, read again.
      blobs.set(pack.idx.digest, good);
      await openPack(g, cache, pack, []);
      await Promise.all(waits);
      const { entry } = partEntry(w, pack.idx.digest);
      entry.bytes = bad;
      const reads: Parameters<typeof openPack>[3] = [];
      await openPack(g, cache, pack, reads);
      assert.deepEqual(
        reads.map((r) => r.tier),
        ["ghcr"],
      );
      assert.ok(w.errors.some((e) => /do not hash to the digest/.test(String(e[0]))));
    },
  );
});

test("pack: a pack of several parts reads each block from its own part", async () => {
  await apiWorld(
    () => undefined,
    async (w, blobs) => {
      const keys = Array.from({ length: 3000 }, (_, i) => `c${String(i).padStart(5, "0")}.${letters(i + 7, 20)}`);
      const probe = new MemorySink();
      const sized = await writePack(
        keys.map((key) => ({ key, flags: 1, sources: seen })),
        { codec: NAMES_CODEC, compress: nodeCompress, sink: probe, recordsPerBlock: 1000 },
      );
      const largest = Math.max(...sized.entries.map((e) => e.packed));
      const { pack } = await plantSmall(w, blobs, keys, { recordsPerBlock: 1000, partLimit: PART_HEADER_BYTES + largest });
      assert.equal(pack.parts.length, 3, "one block a part");
      const { g, cache } = io(w);
      const reader = await openPack(g, cache, pack, []);
      for (const i of [5, 1500, 2999]) assert.equal((await reader.get(keys[i]!))?.key, keys[i]);
      for (const part of pack.parts) assert.equal(partReads(w, part.digest).length, 2, "one 307 and one range read of each part");
    },
  );
});

test("pack: a cached block of the wrong length, or of the right length whose bytes fail the CRC-32, is a logged miss: read again from GHCR and the entry overwritten", async () => {
  for (const [label, spoil] of [
    ["one byte short", (b: Uint8Array) => b.slice(0, b.length - 1)],
    [
      "one byte flipped",
      (b: Uint8Array) => {
        const out = b.slice();
        out[Math.floor(out.length / 2)] = out[Math.floor(out.length / 2)]! ^ 0xff;
        return out;
      },
    ],
  ] as const) {
    await apiWorld(
      () => undefined,
      async (w, blobs) => {
        const { pack, partDigest } = await plantPack(w, blobs);
        const { g, cache, waits } = io(w);
        assert.equal((await (await openPack(g, cache, pack, [])).get(smallKeys[1]!))?.key, smallKeys[1], label);
        await Promise.all(waits);
        const { url, entry } = partEntry(w, partDigest);
        const good = entry.bytes.slice();
        entry.bytes = spoil(good);
        const reads: Parameters<typeof openPack>[3] = [];
        const from = w.requests.length;
        const reader = await openPack(g, cache, pack, reads);
        assert.equal((await reader.get(smallKeys[2]!))?.key, smallKeys[2], label);
        await Promise.all(waits);
        assert.ok(partReads(w, partDigest, from).length > 0, `${label}: the block was read from GHCR`);
        assert.ok(
          w.errors.some((e) => /cache read of body .* failed: (it holds|block 0 fails its check)/.test(String(e[0]))),
          `${label}: logged`,
        );
        assert.deepEqual(w.cache.entries.get(url)!.bytes, good, `${label}: the entry holds GHCR's bytes again`);
        assert.ok(reads.some((r) => r.tier === "ghcr"));
        // The next read is the entry's, with no request.
        const after = w.requests.length;
        assert.equal((await (await openPack(g, cache, pack, [])).get(smallKeys[3]!))?.key, smallKeys[3]);
        assert.equal(w.since(after).length, 0, `${label}: no request once healed`);
      },
    );
  }
});

test("pack: a block whose bytes fail the CRC-32 at GHCR fails the read and is never kept", async () => {
  await apiWorld(
    () => undefined,
    async (w, blobs) => {
      const { pack, partDigest } = await plantPack(w, blobs);
      const part = blobs.get(partDigest)!.slice();
      part[PART_HEADER_BYTES + 8] = part[PART_HEADER_BYTES + 8]! ^ 0xff;
      blobs.set(partDigest, part);
      const { g, cache, waits } = io(w);
      const reader = await openPack(g, cache, pack, []);
      for (let i = 0; i < 2; i += 1) {
        await assert.rejects(
          () => reader.get(smallKeys[1]!),
          (err: unknown) => err instanceof PackError && (err.code === "crc" || err.code === "inflate"),
        );
        await Promise.all(waits);
      }
      assert.equal(
        [...w.cache.entries.keys()].some((k) => decodeURIComponent(k).includes(`@${partDigest}/`)),
        false,
        "no entry of the bad block",
      );
      assert.equal(partReads(w, partDigest).filter((r) => r.url.startsWith(BLOB_HOST)).length, 2, "each read went to GHCR");
    },
  );
});
