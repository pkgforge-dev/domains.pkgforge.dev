// packages/pack/src/idx.ts: the index layer of docs/format.md section 6.
//
// A planted fault is a byte changed in a written index. When the fault is meant
// for a check behind a CRC, the test computes the CRCs again from the layout
// tables (test/plant.ts walks the bytes by docs/format.md, not by idx.ts), so
// that only the check under test can refuse it. When the fault is meant for a
// CRC, it changes a byte that every other check accepts.
import assert from "node:assert/strict";
import { test } from "node:test";
import { packedLimit } from "../src/format.ts";
import { encodeIdx, PackIndex, parseHead, parsePage, readIdx } from "../src/idx.ts";
import { PackReader } from "../src/reader.ts";
import { bytesSource, partsSource } from "../src/source.ts";
import { NAMES_CODEC, randomNames, writeMem } from "./helpers.ts";
import { FIELD, fixCrcs, fixHead, layout, refusedWith, view } from "./plant.ts";

async function pack(n = 300, extra = {}) {
  return writeMem(randomNames(n, 11), { codec: NAMES_CODEC, recordsPerBlock: 10, pageEntries: 4, partLimit: 900, ...extra });
}

test("pack idx: an index parses to the content it was written from, and encodes back to the same bytes", async () => {
  const { summary } = await pack();
  assert.ok(summary.parts.length > 2, `${summary.parts.length} parts`);
  assert.ok(summary.blocks > 8, `${summary.blocks} blocks`);
  const read = readIdx(summary.idx);
  assert.deepEqual(read.entries, summary.entries);
  assert.deepEqual(read.head.parts, summary.parts);
  assert.equal(read.head.keyMin, summary.keyMin);
  assert.equal(read.head.keyMax, summary.keyMax);
  const again = encodeIdx({ ...read.head.header, parts: read.head.parts, keyMin: read.head.keyMin, keyMax: read.head.keyMax, entries: read.entries });
  assert.deepEqual(again, summary.idx);
});

test("pack idx: open reads the head in one read, or two when it is larger than the first read", async () => {
  const { summary } = await pack();
  const reads: [number, number][] = [];
  const counted = (headRead?: number) => {
    reads.length = 0;
    const src = bytesSource(summary.idx);
    return PackIndex.open({ size: src.size, read: (o, n) => (reads.push([o, n]), src.read(o, n)) }, { headRead });
  };
  const whole = await counted();
  assert.equal(reads.length, 1);
  assert.deepEqual(reads[0], [0, summary.idx.length]);
  const split = await counted(64);
  assert.equal(reads.length, 2);
  assert.deepEqual(split.head, whole.head);
  // A lookup with the head held reads one page.
  reads.length = 0;
  assert.equal(await split.locate(summary.entries[7].key), 7);
  assert.equal(reads.length, 1);
  assert.equal(await split.locate("\u0000"), -1);
  assert.equal(reads.length, 1);
});

test("pack idx: locate finds the last block whose key is not above the key, across pages", async () => {
  const { summary } = await pack();
  const index = await PackIndex.open(summary.idx);
  for (const e of summary.entries) {
    assert.equal(await index.locate(e.key), e.index);
    assert.equal(await index.locate(`${e.key}\u0000`), e.index);
  }
  assert.equal(await index.locate(`${summary.keyMax}~`), summary.blocks - 1);
});

test("pack idx: a byte changed in the top level fails the head CRC and nothing else", async () => {
  const { summary } = await pack();
  const l = layout(summary.idx);
  // The last byte of the key of page 1 raised by one: the keys still ascend, so
  // without the CRC the head parses.
  const page1 = l.top[1];
  const keyEnd = page1.at + 2 + view(summary.idx).getUint16(page1.at, true) - 1;
  const bad = summary.idx.slice();
  bad[keyEnd] += 1;
  assert.ok(bad[keyEnd] < 0x7f, "the key byte stays ASCII");
  await refusedWith(() => PackIndex.open(bad), "head", /head CRC-32/);
  // The same change with the CRC computed again is caught by the page, whose
  // first entry no longer has the page's key: the CRC was the guard above.
  await refusedWith(async () => readIdx(fixCrcs(bad)), "page", /starts with another key/);
});

test("pack idx: a byte changed in a page fails the page CRC and nothing else", async () => {
  const { summary } = await pack();
  const l = layout(summary.idx);
  // The raw length of block 5 raised by one: every check of the page accepts
  // it; only the CRC refuses it.
  const bad = summary.idx.slice();
  const rawAt = l.entries[5].fields + 2 + 8 + 4;
  view(bad).setUint32(rawAt, view(bad).getUint32(rawAt, true) + 1, true);
  const index = await PackIndex.open(bad);
  await refusedWith(() => index.entry(5), "page", /CRC-32/);
  const head = parseHead(fixCrcs(bad));
  assert.equal(parsePage(head, 1, fixCrcs(bad).subarray(l.headBytes + l.top[1].offset, l.headBytes + l.top[1].offset + l.top[1].bytes))[1].raw, summary.entries[5].raw + 1);
});

test("pack idx: header fields out of range are refused by their own check", async () => {
  const { summary } = await pack();
  const planted = (at: number, value: number, size: 1 | 2 | 4 = 1) => {
    const bad = summary.idx.slice();
    if (size === 1) bad[at] = value;
    else if (size === 2) view(bad).setUint16(at, value, true);
    else view(bad).setUint32(at, value, true);
    return fixHead(bad);
  };
  await refusedWith(() => PackIndex.open(planted(0, 0x58)), "magic", /does not start with DPKI/);
  await refusedWith(() => PackIndex.open(planted(4, 2)), "version", /version 2/);
  await refusedWith(() => PackIndex.open(planted(8, 9)), "codec", /codec 9/);
  await refusedWith(() => PackIndex.open(planted(5, 0)), "dataset", /dataset 0/);
  await refusedWith(() => PackIndex.open(planted(9, 1)), "header", /reserved byte 9/);
  await refusedWith(() => PackIndex.open(planted(16, summary.records + 10, 4)), "header", /do not fill/);
  await refusedWith(() => PackIndex.open(planted(28, summary.idx.length, 4)), "header", /pages/);
  await refusedWith(() => PackIndex.open(planted(6, 0, 2)), "header", /0 records a block/);
  // The version is read before the CRC: a version 2 index with its old CRC is
  // refused as a version, never as a bad CRC.
  const v2 = summary.idx.slice();
  v2[4] = 2;
  await refusedWith(() => PackIndex.open(v2), "version", /version 2/);
});

test("pack idx: a gap between two pages of one part is refused by the tiling across pages", async () => {
  const { summary } = await pack(300, { partLimit: 2 ** 30 });
  assert.equal(summary.parts.length, 1);
  const l = layout(summary.idx);
  // Every block of pages 1 and on moves one byte later, and the part grows by
  // one byte: within each page the blocks still tile, and the last block still
  // ends at the end of the part. Only the check across pages sees the gap.
  const bad = summary.idx.slice();
  const dv = view(bad);
  const firstMoved = summary.pageEntries;
  for (let i = firstMoved; i < l.entries.length; i += 1) {
    const at = l.entries[i].fields + 2;
    dv.setBigUint64(at, dv.getBigUint64(at, true) + 1n, true);
  }
  dv.setBigUint64(64, dv.getBigUint64(64, true) + 1n, true);
  const fixed = fixCrcs(bad);
  await refusedWith(async () => readIdx(fixed), "tiling", new RegExp(`block ${firstMoved} starts at`));
  const index = await PackIndex.open(fixed);
  assert.equal((await index.entry(firstMoved)).offset, summary.entries[firstMoved].offset + 1);
  await refusedWith(
    async () => {
      for await (const _ of index.entries()) {
        // Each entry is checked against the one before it.
      }
    },
    "tiling",
    /starts at/,
  );
});

test("pack idx: a block that does not start its part at byte 16 is refused within its page", async () => {
  const { summary } = await pack();
  const l = layout(summary.idx);
  const second = summary.parts[1].firstBlock;
  const bad = summary.idx.slice();
  const at = l.entries[second].fields + 2;
  view(bad).setBigUint64(at, 17n, true);
  await refusedWith(async () => readIdx(fixCrcs(bad)), "tiling", /first block of part 1 and starts at 17/);
});

// The written index with one change made by `change`, and every CRC computed
// again, so that only the check under test can refuse it.
async function planted(change: (dv: DataView, l: ReturnType<typeof layout>, idx: Uint8Array) => void) {
  const { summary } = await pack();
  const bad = summary.idx.slice();
  const l = layout(bad);
  change(view(bad), l, bad);
  return { summary, l, idx: fixCrcs(bad) };
}

test("pack idx: a part longer than the end of its last block is refused by the tiling of that block", async () => {
  // Part 0 one byte longer in the parts table: every block of it still tiles
  // from byte 16, and only the end of its last block shows the slack.
  const { summary, idx } = await planted((dv) => dv.setBigUint64(64, dv.getBigUint64(64, true) + 1n, true));
  const last = summary.parts[0].blocks - 1;
  await refusedWith(async () => readIdx(idx), "tiling", new RegExp(`block ${last} is the last block of part 0 and ends at ${summary.parts[0].bytes}, not ${summary.parts[0].bytes + 1}`));
});

test("pack idx: a block entry with another record count than the header makes is refused by the page", async () => {
  const { idx } = await planted((dv, l) => dv.setUint16(l.entries[2].fields + FIELD.records, 11, true));
  await refusedWith(async () => readIdx(idx), "page", /block 2 holds 11 records, the header makes it 10/);
});

test("pack idx: a block key below the key of the block before it in one page is refused by the page", async () => {
  // Block 2 is the third entry of page 0, so the page key and the key of the
  // page after it do not change.
  const { summary, idx } = await planted((_dv, l, bytes) => {
    bytes[l.entries[2].at + 2] = 0x01;
  });
  assert.equal(summary.pageEntries, 4);
  await refusedWith(async () => readIdx(idx), "page", /block 2 has a key below the key of the block before it/);
});

test("pack idx: a block entry of 0 raw bytes, or of one above 16 MiB, is refused by the page", async () => {
  const zero = await planted((dv, l) => dv.setUint32(l.entries[2].fields + FIELD.raw, 0, true));
  await refusedWith(async () => readIdx(zero.idx), "page", /block 2 has 0 raw bytes, not 1 to 16777216/);
  const over = await planted((dv, l) => dv.setUint32(l.entries[2].fields + FIELD.raw, 16_777_217, true));
  await refusedWith(async () => readIdx(over.idx), "page", /block 2 has 16777217 raw bytes, not 1 to 16777216/);
});

test("pack idx: a block entry that names a part the index does not hold is a PackError of the page", async () => {
  const { summary, idx } = await planted((dv, l) => dv.setUint16(l.entries[2].fields + FIELD.part, 99, true));
  await refusedWith(async () => readIdx(idx), "page", new RegExp(`block 2 names part 99 of ${summary.parts.length}`));
});

test("pack idx: a compressed length above the bound of its raw length is refused before any read", async () => {
  // The last block of part 0 claims more compressed bytes, and the part grows
  // with it, so the blocks still tile: only the bound refuses the claim.
  const grow = (extra: number) =>
    planted((dv, l) => {
      // The parts table entry of part 0: bytes at 64, its block count at 76.
      const e = l.entries[dv.getUint32(76, true) - 1];
      const raw = dv.getUint32(e.fields + FIELD.raw, true);
      const offset = Number(dv.getBigUint64(e.fields + FIELD.offset, true));
      const packed = packedLimit(raw) + extra;
      dv.setUint32(e.fields + FIELD.packed, packed, true);
      dv.setBigUint64(64, BigInt(offset + packed), true);
    });
  // The bound of docs/format.md section 4: raw + floor(raw / 8) + 1,024.
  assert.deepEqual([packedLimit(1), packedLimit(8), packedLimit(15), packedLimit(16_777_216)], [1025, 1033, 1040, 18_875_392]);
  const atBound = await grow(0);
  assert.equal(readIdx(atBound.idx).entries.length, atBound.summary.blocks);
  const past = await grow(1);
  const last = past.summary.parts[0].blocks - 1;
  const raw = past.summary.entries[last].raw;
  await refusedWith(async () => readIdx(past.idx), "page", new RegExp(`block ${last} has ${packedLimit(raw) + 1} compressed bytes for ${raw} raw bytes, above ${packedLimit(raw)}`));
});

test("pack idx: a pack of no block with more than one part is refused", async () => {
  const empty = { bytes: 16, firstBlock: 0, blocks: 0 };
  const content = { dataset: 1, codec: 1, recordsPerBlock: 10, records: 0, keyMin: null, keyMax: null, entries: [] };
  assert.equal(readIdx(encodeIdx({ ...content, parts: [empty] })).head.parts.length, 1);
  // encodeIdx reads back what it wrote, so the reader's check refuses here.
  await refusedWith(async () => encodeIdx({ ...content, parts: [empty, empty, empty] }), "head", /a pack of no block has 3 parts, not 1/);
});

test("pack idx: the part sizes a store gives are held against the parts table at open", async () => {
  const { summary } = await pack();
  const sizes = summary.parts.map((p) => p.bytes);
  assert.deepEqual((await PackIndex.open(summary.idx, { partSizes: sizes })).head.parts, summary.parts);
  const cut = sizes.map((n, i) => (i === 1 ? n - 3 : n));
  await refusedWith(() => PackIndex.open(summary.idx, { partSizes: cut }), "tiling", new RegExp(`part 1: the index gives it ${sizes[1]} B and the store holds ${sizes[1] - 3} B`));
  await refusedWith(() => PackIndex.open(summary.idx, { partSizes: sizes.slice(1) }), "tiling", new RegExp(`the index names ${sizes.length} part\\(s\\) and the store holds ${sizes.length - 1}`));
  // A reader given an index already open holds it to the sizes too.
  const index = await PackIndex.open(summary.idx);
  await refusedWith(() => PackReader.open(index, partsSource([]), NAMES_CODEC, { partSizes: cut }), "tiling", /part 1: the index gives it/);
});

test("pack idx: a reader given maxRawBlockBytes reads no block above it, and refuses a bound outside 1 to 16 MiB", async () => {
  const { summary, parts } = await pack();
  const largest = Math.max(...summary.entries.map((e) => e.raw));
  const big = summary.entries.find((e) => e.raw === largest);
  assert.ok(big !== undefined);
  const reads: number[] = [];
  const counted = partsSource(parts);
  const source = { ...counted, read: async (part: number, offset: number, length: number) => (reads.push(part), counted.read(part, offset, length)) };
  // At the largest raw length every block reads; one byte below, that block is
  // refused from its index entry and no part byte is read for it.
  const at = await PackReader.open(summary.idx, source, NAMES_CODEC, { maxRawBlockBytes: largest });
  assert.equal((await at.readBlock(big)).length, largest);
  const below = await PackReader.open(summary.idx, source, NAMES_CODEC, { maxRawBlockBytes: largest - 1 });
  reads.length = 0;
  await refusedWith(() => below.readBlock(big), "page", new RegExp(`block ${big.index} has ${largest} raw bytes, above the ${largest - 1} this reader reads$`));
  assert.deepEqual(reads, []);
  for (const bad of [0, 16 * 1024 * 1024 + 1, 1.5])
    await refusedWith(() => PackReader.open(summary.idx, source, NAMES_CODEC, { maxRawBlockBytes: bad }), "usage", /maxRawBlockBytes is .*, not 1 to 16777216/);
});

test("pack idx: an index source that answers short is refused", async () => {
  const { summary } = await pack();
  const short = { size: summary.idx.length, read: async (o: number, n: number) => summary.idx.subarray(o, o + n - 1) };
  await refusedWith(() => PackIndex.open(short), "short-read", /answered/);
  await refusedWith(() => PackIndex.open(summary.idx.subarray(0, 40)), "head", /shorter than/);
  await refusedWith(() => PackIndex.open(summary.idx.subarray(0, summary.idx.length - 1)), "head", /do not make/);
});
