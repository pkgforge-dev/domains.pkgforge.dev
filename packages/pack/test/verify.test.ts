// packages/pack/src/verify.ts on synthetic packs (test/verify/synthetic.ts).
//
// The entry's eleven planted defects, each a pack or an expectation built on
// its own, then the further guards of the verifier. Each refusal plants the
// fault that its own check alone catches, and the test holds the failing checks
// to exactly that one, so a fault caught by another check fails the test:
//   - out of order and repeated keys: packs assembled by hand (assemble), whose
//     blocks are each in order and whose index is valid, so only the order
//     across a block boundary is wrong;
//   - an upper-case key and a key that is a public suffix: written by the real
//     writer, which takes any key bytes in order, with the pack's own
//     annotations, so only the name check refuses them;
//   - the flipped byte: a stored (level 0) block, so the block still inflates to
//     its length and only its CRC-32 differs;
//   - the cut at a block boundary: a whole pack of the first three blocks,
//     whose bytes and digest are its own, under the count of the 600 names;
//   - the volume: checkBand of @domains/adapter, the rule the CLI passes.
//
//   node scripts/test.mjs packages/pack --name "verify"
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { crc32 as zlibCrc32, deflateRawSync } from "node:zlib";
import { loadPsl } from "@domains/names";
import { type BandDay, checkBand, validateBits, validateRegistry } from "@domains/adapter";
import { nodeCompress } from "../node/index.ts";
import {
  type BlockEntry,
  BUILTIN_CODECS,
  type ByteSource,
  ByteWriter,
  type DatasetCodec,
  DOMAINS_CODEC,
  type DomainRecord,
  encodeIdx,
  encodePartHeader,
  FEED_CODEC,
  FEED_SUSPECT,
  FEED_SUSPECT_CERT,
  FEED_TIME_CODEC,
  type FeedRecord,
  FLAG_EXACT,
  FLAG_WILDCARD,
  NAMES_CODEC,
  type NameRecord,
  NEW_NAME_CODEC,
  NEW_NAME_TIME_CODEC,
  PackReader,
  partsSource,
  Sha256,
  timeKey,
  writeKey,
} from "../src/index.ts";
import { CHECKS, type CheckName, type Expect, expectFromAnnotations, KEY_SHOWN, type PartSource, quoteKey, type VerifyOptions, type VerifyResult, verifyPack } from "../src/verify.ts";
import { collect, type MemPack, writeMem } from "./helpers.ts";
import { FIELD, fixCrcs, fixHead, layout, view } from "./plant.ts";
import { CLEAN_COUNT, CLEAN_SEED, DAY, DAY_START, PAGE_ENTRIES, PAIR_SEED, PSL_FILE, RECORDS_PER_BLOCK, REGISTRY, SOURCES, SPAN, syntheticNames, syntheticRegistry } from "./verify/synthetic.ts";

const PSL = await loadPsl(readFileSync(PSL_FILE));
const FIXTURES = join(import.meta.dirname, "verify");
const ROOT = join(import.meta.dirname, "..", "..", "..");

interface TestPack {
  readonly idx: Uint8Array;
  readonly parts: Uint8Array[];
  readonly expect: Expect;
}

// Every annotation the verifier reads, as the pack's writer would state them.
const expectOf = (p: { idx: Uint8Array; parts: Uint8Array[]; count: number; sha256: string }, dataset = "names"): Expect => ({
  count: p.count,
  bytes: p.parts.reduce((s, b) => s + b.length, 0) + p.idx.length,
  dataset,
  sha256: p.sha256,
  psl: PSL.sha256,
  sources: SOURCES,
  span: SPAN,
});

const fromMem = (m: MemPack, dataset = "names"): TestPack => ({
  idx: m.summary.idx,
  parts: m.parts,
  expect: expectOf({ idx: m.summary.idx, parts: m.parts, count: m.summary.records, sha256: m.summary.sha256 }, dataset),
});

async function packOf(records: NameRecord[], options: { partLimit?: number; compress?: (codec: number, raw: Uint8Array) => Uint8Array } = {}): Promise<TestPack> {
  return fromMem(await writeMem(records, { codec: NAMES_CODEC, recordsPerBlock: RECORDS_PER_BLOCK, pageEntries: PAGE_ENTRIES, ...options }));
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
};

// A one-part names pack built by hand: the records cut into blocks in the order
// given, each block written by the codec (which holds the order inside it) and
// compressed by the production compressor, and an index of those blocks. The
// writer's own order check across blocks is not on this path. `blocks` gives
// the records of each block (RECORDS_PER_BLOCK each by default); the index
// gives each block the records the header makes it, whatever it holds.
async function assemble(records: NameRecord[], options: { keyMin?: string; keyMax?: string; blocks?: readonly number[] } = {}): Promise<TestPack> {
  const chunks: Uint8Array[] = [encodePartHeader({ dataset: 1, recordsPerBlock: RECORDS_PER_BLOCK, part: 0, codec: 1 })];
  const entries: BlockEntry[] = [];
  const sha = new Sha256();
  const sizes = options.blocks ?? Array.from({ length: Math.ceil(records.length / RECORDS_PER_BLOCK) }, () => RECORDS_PER_BLOCK);
  let offset = 16;
  for (let b = 0, start = 0; b < sizes.length; start += sizes[b], b += 1) {
    const block = records.slice(start, start + sizes[b]);
    const out = new ByteWriter();
    let prev: NameRecord | null = null;
    for (const r of block) {
      NAMES_CODEC.encodeRecord(prev, r, out);
      prev = r;
    }
    const raw = out.take();
    sha.update(raw);
    const packed = await nodeCompress(1, raw);
    const stated = b === sizes.length - 1 ? records.length - (sizes.length - 1) * RECORDS_PER_BLOCK : RECORDS_PER_BLOCK;
    entries.push({ index: entries.length, key: block[0].key, part: 0, offset, packed: packed.length, raw: raw.length, records: stated, crc: zlibCrc32(raw) });
    chunks.push(packed);
    offset += packed.length;
  }
  const part = concat(chunks);
  const idx = encodeIdx({
    dataset: 1,
    codec: 1,
    recordsPerBlock: RECORDS_PER_BLOCK,
    pageEntries: PAGE_ENTRIES,
    records: records.length,
    parts: [{ bytes: part.length, firstBlock: 0, blocks: entries.length }],
    keyMin: options.keyMin ?? records[0].key,
    keyMax: options.keyMax ?? records[records.length - 1].key,
    entries,
  });
  return { idx, parts: [part], expect: expectOf({ idx, parts: [part], count: records.length, sha256: sha.hex() }) };
}

const sized = (parts: readonly Uint8Array[], sizes = parts.map((p) => p.length)): PartSource => ({ ...partsSource(parts), sizes });

const verify = (p: TestPack, expect: Expect = p.expect, extra: Partial<VerifyOptions> = {}, parts: PartSource = sized(p.parts)): Promise<VerifyResult> =>
  verifyPack(p.idx, parts, expect, { psl: PSL, registry: REGISTRY, ...extra });

const failed = (r: VerifyResult): CheckName[] => [...new Set(r.errors.map((e) => e.check))];

// The result fails `check` and no other, and its verdict is `verdict`.
function failsAlone(r: VerifyResult, check: CheckName, pattern: RegExp, verdict: VerifyResult["verdict"] = "fail"): void {
  assert.deepEqual(failed(r), [check], JSON.stringify(r.errors, null, 1));
  assert.equal(r.ok, false);
  assert.equal(r.verdict, verdict);
  assert.match(r.errors[0].detail, pattern);
  assert.equal(r.checks.find((c) => c.check === check)?.status, "fail");
}

const status = (r: VerifyResult): Record<string, string> => Object.fromEntries(r.checks.map((c) => [c.check, c.status]));
const detailOf = (r: VerifyResult, check: CheckName): string => r.checks.find((c) => c.check === check)?.detail ?? "";
// The checks of the pass over the blocks: each skips when it ran on no block.
const OF_BLOCKS: readonly CheckName[] = ["inflate", "crc", "record", "order", "unique", "name"];

const BAND = Object.freeze({ metric: "count" as const, min: 0.4, max: 2.5, relative: true });
// Seven accepted days of `count` records each, before 2026-10-26.
const history = (count: number): BandDay[] => Array.from({ length: 7 }, (_, i) => ({ day: `2026-10-${String(19 + i).padStart(2, "0")}`, count, quarantined: false }));
const volumeAt = (median: number, precision: "day" | "second" = "day", value?: number): VerifyOptions["volume"] => ({
  source: precision === "day" ? "thc-ct" : "ct-le",
  ...(value === undefined ? {} : { value }),
  judge: (v: number) => checkBand(v, history(median), BAND, { precision }),
});

const CLEAN = syntheticNames(CLEAN_COUNT, CLEAN_SEED);
const clean = await packOf(CLEAN);

// The clean names as the records of the other name datasets: one evidence
// entry of thc-ct each (domains), and a first_seen of a second of the span with
// thc-ct alone (feed and new-name).
const domainRows = (): DomainRecord[] => CLEAN.map((r) => ({ ...r, evidence: [{ tier: 3, basis: 4, source: 0, at: DAY, confidence: 0 }] }));
const feedRows = (): FeedRecord[] => CLEAN.map((r, i) => ({ key: r.key, flags: r.flags, firstSeen: DAY_START + i, sources: [0], basis: 1 << 4, confidence: 0, feedFlags: 0 }));
const domainsPack = async (rows: DomainRecord[]): Promise<TestPack> => fromMem(await writeMem(rows, { codec: DOMAINS_CODEC, recordsPerBlock: RECORDS_PER_BLOCK }), "domains");
const feedPack = async (rows: FeedRecord[], codec = FEED_CODEC): Promise<TestPack> => fromMem(await writeMem(rows, { codec, recordsPerBlock: RECORDS_PER_BLOCK }), codec.name);

// ---- the clean pack

test("verify: the clean pack passes every check but time, which skips: a names pack has no time copy; and its volume at the median is ok", async () => {
  const r = await verify(clean, clean.expect, { volume: volumeAt(CLEAN_COUNT) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "ok");
  assert.deepEqual(
    r.checks.map((c) => c.check),
    [...CHECKS],
  );
  for (const c of r.checks) assert.equal(c.status, c.check === "time" ? "skip" : "pass", `${c.check}: ${c.detail}`);
  assert.equal(detailOf(r, "time"), "no time copy given");
  assert.deepEqual(r.unverified, ["time"]);
  assert.equal(r.stats.records, CLEAN_COUNT);
  assert.equal(r.stats.blocks, 10);
  assert.equal(r.stats.sha256, clean.expect.sha256);
  // 600 records hold fewer than the 1,000 draws and the first and last: every key is found again.
  assert.equal(r.stats.refound, CLEAN_COUNT);
  assert.equal(r.volume?.verdict, "ok");
});

test("verify: 60% of the median volume is ok", async () => {
  const r = await verify(clean, clean.expect, { volume: volumeAt(1000) });
  assert.deepEqual(r.errors, []);
  assert.equal(r.verdict, "ok");
  assert.equal(r.volume?.verdict, "ok");
  assert.equal(r.volume?.median, 1000);
  assert.match(r.checks.find((c) => c.check === "volume")?.detail ?? "", /^ok \(within\): 600 against the median 1000/);
});

// ---- the eleven planted defects of the entry

test("verify: two keys out of order across a block boundary fail order alone", async () => {
  const records = [...CLEAN];
  // Records 63 and 64 change places: block 0 ends with 64 and block 1 starts
  // with 63, each block in order and the index keys still ascending.
  [records[63], records[64]] = [records[64], records[63]];
  const r = await verify(await assemble(records));
  failsAlone(r, "order", new RegExp(`block 1 starts with ${literal(quoteKey(CLEAN[63].key))}, below ${literal(quoteKey(CLEAN[64].key))}`));
});

test("verify: a key repeated across a block boundary fails unique alone", async () => {
  // Record 63 ends block 0 and, once more, starts block 1.
  const records = [...CLEAN.slice(0, 64), CLEAN[63], ...CLEAN.slice(64)];
  const r = await verify(await assemble(records));
  failsAlone(r, "unique", new RegExp(`block 1 starts with ${literal(quoteKey(CLEAN[63].key))}, the last key of the block before it`));
});

test("verify: an upper-case byte in a key fails name alone", async () => {
  const records = CLEAN.map((r, i) => (i === 100 ? { ...r, key: r.key.replace("synth", "Synth") } : r)).sort(byKey);
  const r = await verify(await packOf(records));
  failsAlone(r, "name", /: upper case$/);
  assert.equal(r.errors.length, 1);
});

// The name check reads the key alone, never the flags: a key that is a public
// suffix fails whatever its flags say. The entry's planted defect is the
// wildcard-only name *.co.uk, whose key is uk.co with the wildcard flag alone.
test("verify: a key that is itself a public suffix (uk.co, as the wildcard-only *.co.uk gives) fails name alone, whatever its flags", async () => {
  for (const flags of [FLAG_WILDCARD, FLAG_EXACT, FLAG_EXACT | FLAG_WILDCARD]) {
    const suffix: NameRecord = { key: "uk.co", flags, sources: [{ bit: 0, first: DAY, last: DAY }] };
    const r = await verify(await packOf([...CLEAN, suffix].sort(byKey)));
    failsAlone(r, "name", /^the key "uk\.co": normalise refuses its name: public-suffix$/);
  }
});

test("verify: a pack cut to half its bytes fails length alone, and no later check runs", async () => {
  const whole = clean.parts[0].length;
  const half = clean.parts[0].subarray(0, Math.floor(whole / 2));
  const r = await verify(clean, clean.expect, {}, sized([half]));
  failsAlone(r, "length", new RegExp(`^part\\.000 holds ${half.length} B, the index says ${whole} B$`));
  const at = CHECKS.indexOf("length");
  for (const c of r.checks.slice(at + 1)) assert.deepEqual([c.status, c.detail], ["skip", "not run: the length check failed"], c.check);
});

test("verify: a pack cut at a block boundary, its bytes and digest its own, fails count alone", async () => {
  const cut = await packOf(CLEAN.slice(0, 3 * RECORDS_PER_BLOCK));
  // The count is the source's: the 600 names the adapter read.
  const r = await verify(cut, { ...cut.expect, count: CLEAN_COUNT });
  failsAlone(r, "count", /^the pack holds 192 records, the count annotation says 600$/);
});

test("verify: a flipped byte in a stored block fails crc alone", async () => {
  const stored = (_codec: number, raw: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(raw, { level: 0 }));
  const pack = await packOf(CLEAN, { compress: stored });
  const block1 = await (await PackReader.open(pack.idx, partsSource(pack.parts))).index.entry(1);
  const parts = pack.parts.map((p) => p.slice());
  // One final stored block: a header byte of 0x01, LEN and NLEN, then the raw
  // bytes. A raw byte flipped there still inflates to the same length.
  assert.equal(parts[0][block1.offset], 0x01);
  parts[0][block1.offset + 5 + 20] ^= 0x01;
  const r = await verify({ ...pack, parts });
  failsAlone(r, "crc", /^block 1: the CRC-32 of its raw bytes is [0-9a-f]{8}, the index says [0-9a-f]{8}$/);
  assert.equal(status(r).sha256, "skip");
  assert.equal(status(r).refind, "skip");
});

test("verify: a count annotation off by one fails count alone", async () => {
  const r = await verify(clean, { ...clean.expect, count: CLEAN_COUNT + 1 });
  failsAlone(r, "count", /^the pack holds 600 records, the count annotation says 601$/);
});

test("verify: a wrong PSL hash fails psl alone", async () => {
  const other = createHash("sha256").update("a list other than the pinned one").digest("hex");
  const r = await verify(clean, { ...clean.expect, psl: other });
  failsAlone(r, "psl", new RegExp(`^the psl annotation is ${other}, the pinned list is ${PSL.sha256}$`));
});

test("verify: a day source with a time of day, written in seconds, fails precision alone", async () => {
  const records = CLEAN.map((r, i) => (i === 10 ? { ...r, sources: r.sources.map((s) => (s.bit === 0 ? { bit: 0, first: DAY_START + 3600, last: DAY_START + 3600 } : s)) } : r));
  const r = await verify(await packOf(records));
  failsAlone(r, "precision", new RegExp(`^the record ${literal(quoteKey(CLEAN[10].key))} has first of thc-ct, a day source, ${DAY_START + 3600}, outside 298 to 298 days: the span`));
  // first and last are both outside.
  assert.equal(r.errors.length, 2);
});

test("verify: 39% of the median volume is quarantined, and volume fails alone", async () => {
  // 600 / 1539 = 0.3899: below the floor of 0.4 of the median.
  const r = await verify(clean, clean.expect, { volume: volumeAt(1539) });
  failsAlone(r, "volume", /^quarantine \(below\): 600 against the median 1539 of thc-ct \(floor 615\.6/, "quarantine");
  assert.equal(r.volume?.verdict, "quarantine");
});

// ---- the further guards

test("verify: a pack of three parts passes, and a part not given fails length alone", async () => {
  const pack = await packOf(CLEAN, { partLimit: 3000 });
  assert.equal(pack.parts.length, 3);
  const r = await verify(pack);
  assert.deepEqual(r.errors, []);
  const missing = await verify(pack, pack.expect, {}, sized(pack.parts.slice(0, 2)));
  failsAlone(missing, "length", /^the index names 3 part\(s\) and 2 were given$/);
});

test("verify: a bytes annotation off by one fails length alone", async () => {
  const part = clean.parts[0].length;
  const total = part + clean.idx.length;
  const r = await verify(clean, { ...clean.expect, bytes: total + 1 });
  failsAlone(r, "length", new RegExp(`^the parts \\(${part} B\\) and the index \\(${clean.idx.length} B\\) make ${total} B, the bytes annotation says ${total + 1} B$`));
});

test("verify: a part header that names another dataset fails header alone", async () => {
  // Byte 5 the dataset, 6 and 7 the records a block, 8 and 9 the part number,
  // 10 the codec (docs/format.md section 3).
  const cases: [number, number, RegExp][] = [
    [5, 2, /^part\.000 names dataset 2, the index 1$/],
    [6, 65, /^part\.000 names 65 records a block, the index 64$/],
    [8, 1, /^part\.000 names part number 1$/],
    [10, 2, /^part\.000 names codec 2, the index 1$/],
  ];
  for (const [at, value, pattern] of cases) {
    const parts = clean.parts.map((p) => p.slice());
    parts[0][at] = value;
    failsAlone(await verify({ ...clean, parts }), "header", pattern);
  }
});

test("verify: an index with a changed byte in a page fails idx alone", async () => {
  const idx = clean.idx.slice();
  idx[layout(idx).headBytes + 3] ^= 0x01;
  const r = await verify({ ...clean, idx });
  failsAlone(r, "idx", /^index page 0: its CRC-32 is/);
  for (const c of r.checks.slice(1)) assert.deepEqual([c.status, c.detail], ["skip", "not run: the idx check failed"], c.check);
  assert.deepEqual(r.unverified, CHECKS.slice(1));
});

test("verify: a dataset annotation of another dataset fails dataset alone", async () => {
  const r = await verify(clean, { ...clean.expect, dataset: "domains" });
  failsAlone(r, "dataset", /^the index is dataset 1 \(names\), the annotation says domains$/);
});

test("verify: a pack of dataset 4, whose keys are not names, fails dataset alone, even with a codec registered for it", async () => {
  const idx = clean.idx.slice();
  idx[5] = 4;
  const parts = clean.parts.map((p) => p.slice());
  parts[0][5] = 4;
  const pack = { idx: fixHead(idx), parts, expect: {} };
  const refused = /^the pack is dataset 4; this verifier checks the datasets 1, 2, 3 and 5, whose keys are reversed names$/;
  failsAlone(await verify(pack), "dataset", refused);
  // DOM-043 is to register the codec of dataset 4. Registered here for the
  // length of the test (the map is a Map at run time; its type is read-only for
  // every other caller), as a synthetic codec that reads these records, the
  // verifier still refuses the dataset rather than check binary keys as names.
  const codecs = BUILTIN_CODECS as Map<number, unknown>;
  codecs.set(4, { ...NAMES_CODEC, id: 4, name: "rev" });
  try {
    failsAlone(await verify(pack), "dataset", refused);
  } finally {
    codecs.delete(4);
  }
});

test("verify: a block whose index entry says one raw byte more fails inflate alone", async () => {
  const idx = clean.idx.slice();
  const at = layout(idx).entries[2].fields + FIELD.raw;
  view(idx).setUint32(at, view(idx).getUint32(at, true) + 1, true);
  const r = await verify({ ...clean, idx: fixCrcs(idx) });
  failsAlone(r, "inflate", /^block 2 decompresses to \d+ bytes, its index entry says \d+$/);
});

test("verify: a sha256 annotation of other bytes fails sha256 alone", async () => {
  const other = createHash("sha256").update("other raw blocks").digest("hex");
  const r = await verify(clean, { ...clean.expect, sha256: other });
  failsAlone(r, "sha256", new RegExp(`^the raw blocks hash to ${clean.expect.sha256}, the sha256 annotation says ${other}$`));
});

test("verify: head key bounds that are not the first key fail bounds alone", async () => {
  const r = await verify(await assemble(CLEAN, { keyMin: CLEAN[1].key }));
  failsAlone(r, "bounds", new RegExp(`^the head's smallest key is ${literal(quoteKey(CLEAN[1].key))}, the first record's is ${literal(quoteKey(CLEAN[0].key))}$`));
});

test("verify: a head whose largest key is one key short of the last fails bounds alone", async () => {
  // PackReader.get answers null for a key above the head's largest, so the
  // last key would be lost to every lookup.
  const last = CLEAN.length - 1;
  const r = await verify(await assemble(CLEAN, { keyMax: CLEAN[last - 1].key }));
  failsAlone(r, "bounds", new RegExp(`^the head's largest key is ${literal(quoteKey(CLEAN[last - 1].key))}, the last record's is ${literal(quoteKey(CLEAN[last].key))}$`));
  assert.equal(r.errors.length, 1);
});

test("verify: a block that holds another number of records than its index entry fails count alone", async () => {
  // Block 8 holds 63 records and block 9 the 25 left, where the index, by the
  // records a block, gives them 64 and 24.
  const r = await verify(await assemble(CLEAN, { blocks: [64, 64, 64, 64, 64, 64, 64, 64, 63, 25] }));
  failsAlone(r, "count", /^block 8 holds 63 records, its index entry says 64$/);
  assert.deepEqual(
    r.errors.map((e) => e.detail),
    ["block 8 holds 63 records, its index entry says 64", "block 9 holds more than the 24 records of its index entry"],
  );
});

// The clean part at its own size, whose reads chosen by `cut` answer one byte
// short, as a file cut after its size was read or a short HTTP body does.
const short = (cut: (offset: number) => boolean): PartSource => ({
  sizes: [clean.parts[0].length],
  read: async (_part, offset, length) => clean.parts[0].subarray(offset, offset + length - (cut(offset) ? 1 : 0)),
});

test("verify: a part that answers fewer bytes than its size, at its header or at a block, fails length alone", async () => {
  const header = await verify(
    clean,
    clean.expect,
    {},
    short((offset) => offset === 0),
  );
  failsAlone(header, "length", /^part\.000: asked 16 B at 0 of part 0, the source answered 15 B$/);
  for (const c of header.checks.slice(CHECKS.indexOf("length") + 1)) assert.deepEqual([c.status, c.detail], ["skip", "not run: the length check failed"], c.check);
  const block = await verify(
    clean,
    clean.expect,
    {},
    short((offset) => offset > 0),
  );
  failsAlone(block, "length", /^block 0: asked \d+ B at 16 of part 0, the source answered \d+ B$/);
  assert.equal(block.errors.length, 10);
});

test("verify: a check of the pass that ran on no block skips with the reason, one that ran on some passes, and the verdict stays fail", async () => {
  const none = (stoppedAt: string): string => `not run: none of the 10 block(s) ${stoppedAt}`;
  const shown = (r: VerifyResult): string[][] => OF_BLOCKS.map((check) => [check, status(r)[check], detailOf(r, check)]);
  // Every block read short: length fails, and no block reaches inflate.
  const unread = await verify(
    clean,
    clean.expect,
    {},
    short((offset) => offset > 0),
  );
  failsAlone(unread, "length", /^block 0: asked/);
  assert.equal(status(unread).header, "pass");
  assert.deepEqual(shown(unread), [
    ["inflate", "skip", none("was read whole")],
    ["crc", "skip", none("inflated")],
    ["record", "skip", none("matched its CRC-32")],
    ["order", "skip", none("decoded")],
    ["unique", "skip", none("decoded")],
    ["name", "skip", none("decoded")],
  ]);
  // Block 0 read short and the 9 others whole: each check ran on 9 blocks and
  // passes over them.
  const one = await verify(
    clean,
    clean.expect,
    {},
    short((offset) => offset === 16),
  );
  failsAlone(one, "length", /^block 0: asked/);
  assert.equal(one.errors.length, 1);
  assert.deepEqual(shown(one), [
    ["inflate", "pass", "9 of 10 block(s) read whole and inflate to their raw length"],
    ["crc", "pass", "9 of 9 inflated block(s) match the CRC-32 of the index"],
    ["record", "pass", "9 of 9 checked block(s) decode"],
    ["order", "pass", "8 block boundaries; decodeBlock holds the order inside each block"],
    ["unique", "pass", "8 block boundaries; decodeBlock holds the order inside each block"],
    ["name", "pass", `${CLEAN_COUNT - RECORDS_PER_BLOCK} keys are reversed names that normalise keeps, under the list ${PSL.sha256.slice(0, 12)}`],
  ]);
  // Every block inflates and none matches its CRC-32: crc fails, inflate ran on
  // all of them, and no block reaches the decode.
  const stored = (_codec: number, raw: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(raw, { level: 0 }));
  const pack = await packOf(CLEAN, { compress: stored });
  const index = (await PackReader.open(pack.idx, partsSource(pack.parts))).index;
  const parts = pack.parts.map((p) => p.slice());
  // Each block is one final stored block, as in the flipped-byte test above: a
  // raw byte after its header byte, LEN and NLEN is flipped.
  for (let b = 0; b < 10; b += 1) parts[0][(await index.entry(b)).offset + 5 + 20] ^= 0x01;
  const flipped = await verify({ ...pack, parts });
  failsAlone(flipped, "crc", /^block 0: the CRC-32 of its raw bytes is/);
  assert.equal(flipped.errors.length, 10);
  assert.deepEqual(shown(flipped), [
    ["inflate", "pass", "10 of 10 block(s) read whole and inflate to their raw length"],
    ["crc", "fail", flipped.errors[0].detail],
    ["record", "skip", none("matched its CRC-32")],
    ["order", "skip", none("decoded")],
    ["unique", "skip", none("decoded")],
    ["name", "skip", none("decoded")],
  ]);
  // Every block matches its CRC-32 and holds another number of records than
  // its index entry (63 for 64, and 33 for the last 24): count fails on each,
  // no decode ends, so record and the checks after it skip.
  const miscounted = await verify(await assemble(CLEAN, { blocks: [63, 63, 63, 63, 63, 63, 63, 63, 63, 33] }));
  failsAlone(miscounted, "count", /^block 0 holds 63 records, its index entry says 64$/);
  assert.equal(miscounted.errors.length, 10);
  assert.deepEqual(shown(miscounted), [
    ["inflate", "pass", "10 of 10 block(s) read whole and inflate to their raw length"],
    ["crc", "pass", "10 of 10 inflated block(s) match the CRC-32 of the index"],
    ["record", "skip", none("decoded whole")],
    ["order", "skip", none("decoded")],
    ["unique", "skip", none("decoded")],
    ["name", "skip", none("decoded")],
  ]);
});

test("verify: parts whose bytes change after the pass fail refind alone, and 20 failures are listed with a count", async () => {
  // The source answers the pass with the pack's bytes, then, from the second
  // read of the index (the reader opened for the re-find), with every byte
  // after the part header inverted: a cache that went stale between reads.
  let idxReads = 0;
  const stale = clean.parts.map((p) => p.map((b, i) => (i < 16 ? b : b ^ 0xff)));
  const idx = {
    size: clean.idx.length,
    read: async (offset: number, length: number) => {
      idxReads += 1;
      return clean.idx.subarray(offset, offset + length);
    },
  };
  const parts: PartSource = { sizes: [clean.parts[0].length], read: async (part, offset, length) => (idxReads > 1 ? stale : clean.parts)[part].subarray(offset, offset + length) };
  const r = await verifyPack(idx, parts, clean.expect, { psl: PSL, registry: REGISTRY });
  failsAlone(r, "refind", /^get\(".+"\) is refused: (inflate|crc): /);
  assert.equal(r.errors.length, 21);
  assert.equal(r.errors[20].detail, `${CLEAN_COUNT - 20} more failures of this check are not listed`);
});

test("verify: an index whose head changes between the pass and the re-find fails refind alone with the reader's code, and verifyPack does not reject", async () => {
  // The source answers the pass with the clean index and, from the second read
  // (the head read of the reader opened for the re-find), with `after`.
  const changing = (after: Uint8Array): ByteSource => {
    let reads = 0;
    return {
      size: clean.idx.length,
      read: async (offset: number, length: number) => {
        reads += 1;
        return (reads > 1 ? after : clean.idx).subarray(offset, offset + length);
      },
    };
  };
  const run = (after: Uint8Array): Promise<VerifyResult> => verifyPack(changing(after), sized(clean.parts), clean.expect, { psl: PSL, registry: REGISTRY });
  // A byte of the head's fixed header: its CRC-32 no longer matches.
  const flipped = clean.idx.slice();
  flipped[20] ^= 0xff;
  const crc = await run(flipped);
  failsAlone(crc, "refind", /^the index read by range is refused: head: the head CRC-32 is [0-9a-f]{8}, the head says [0-9a-f]{8}$/);
  assert.equal(crc.errors.length, 1);
  // A head, whole and with its own CRC-32, whose parts table gives part 0 one
  // byte more than the part holds (docs/format.md section 6.2): the pages are
  // unchanged, so only the part sizes the reader is held to refuse it.
  const longer = clean.idx.slice();
  view(longer).setBigUint64(64, BigInt(clean.parts[0].length + 1), true);
  const tiling = await run(fixHead(longer));
  failsAlone(tiling, "refind", new RegExp(`^the index read by range is refused: tiling: part 0: the index gives it ${clean.parts[0].length + 1} B and the store holds ${clean.parts[0].length} B$`));
  assert.equal(tiling.errors.length, 1);
});

// The clean records at level 0, and the same records with one change that
// keeps every block's length, so one index layout serves both. The source
// answers the pass with the first and, from the second read of the index, with
// the second: a whole pack, consistent in itself, that is not the one checked.
async function staleAfterPass(change: (records: NameRecord[]) => NameRecord[]): Promise<VerifyResult> {
  const stored = (_codec: number, raw: Uint8Array): Uint8Array => new Uint8Array(deflateRawSync(raw, { level: 0 }));
  const before = await packOf(CLEAN, { compress: stored });
  const after = await packOf(change([...CLEAN]), { compress: stored });
  assert.equal(after.idx.length, before.idx.length);
  assert.deepEqual(
    after.parts.map((p) => p.length),
    before.parts.map((p) => p.length),
  );
  let idxReads = 0;
  const now = (): TestPack => (idxReads > 1 ? after : before);
  const idx = {
    size: before.idx.length,
    read: async (offset: number, length: number) => {
      idxReads += 1;
      return now().idx.subarray(offset, offset + length);
    },
  };
  const parts: PartSource = { sizes: before.parts.map((p) => p.length), read: async (part, offset, length) => now().parts[part].subarray(offset, offset + length) };
  return verifyPack(idx, parts, before.expect, { psl: PSL, registry: REGISTRY });
}

test("verify: a key the reader by range does not find fails refind alone", async () => {
  // Record 70 (inside block 1) gets another key of its length between its
  // neighbours, whose front coding keeps the block's length.
  const r = await staleAfterPass((records) => {
    const k = records[70].key;
    for (const c of "abcdefghijklmnopqrstuvwxyz0123456789") {
      const other = k.slice(0, -1) + c;
      if (other !== k && other > records[69].key && other < records[71].key) {
        records[70] = { ...records[70], key: other };
        return records;
      }
    }
    throw new Error("no key of the same length fits between the neighbours of record 70");
  });
  failsAlone(r, "refind", new RegExp(`^get\\(${literal(quoteKey(CLEAN[70].key))}\\) finds nothing$`));
  assert.equal(r.errors.length, 1);
});

test("verify: a record the reader by range answers otherwise fails refind alone", async () => {
  // Record 70's day source: day 299 for 298, a varint of the same length.
  const r = await staleAfterPass((records) => {
    records[70] = { ...records[70], sources: records[70].sources.map((s) => (s.bit === 0 ? { bit: 0, first: DAY + 1, last: DAY + 1 } : s)) };
    return records;
  });
  failsAlone(r, "refind", new RegExp(`^get\\(${literal(quoteKey(CLEAN[70].key))}\\) answers another record than the block holds$`));
  assert.equal(r.errors.length, 1);
});

test("verify: refind 0 still finds the first and the last key", async () => {
  const r = await verify(clean, clean.expect, { refind: 0 });
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.refound, 2);
  assert.equal((await verify(clean, clean.expect, { refind: 10, seed: 7 })).stats.refound, 12);
});

test("verify: a record with a source bit the annotation does not name fails sources alone", async () => {
  const records = CLEAN.map((r, i) => (i === 5 ? { ...r, sources: [...r.sources, { bit: 7, first: DAY, last: DAY }].sort((a, b) => a.bit - b.bit) } : r));
  const r = await verify(await packOf(records));
  failsAlone(r, "sources", new RegExp(`^the record ${literal(quoteKey(CLEAN[5].key))} carries source bit 7, which is not a bit of thc-ct, ct-le$`));
});

test("verify: a source the registry does not hold fails sources alone", async () => {
  const r = await verify(clean, { ...clean.expect, sources: [...SOURCES, "no-such-source"] });
  failsAlone(r, "sources", /^the source no-such-source is not in the registry$/);
});

test("verify: a named source whose registry row has no bit fails sources alone", async () => {
  // Synthetic: a source of the registry that holds no bit.
  const registry = [...REGISTRY, { id: "synthetic-no-bit", bit: null, precision: "day" as const }];
  const r = await verify(clean, { ...clean.expect, sources: [...SOURCES, "synthetic-no-bit"] }, { registry });
  failsAlone(r, "sources", /^the source synthetic-no-bit has no bit, so no record can carry it$/);
});

test("verify: a feed, new-name or domains record, or a domains evidence entry, with a source bit the annotation does not name fails sources alone", async () => {
  const unnamed = new RegExp(`^the record ${literal(quoteKey(CLEAN[5].key))} carries source bit 7, which is not a bit of thc-ct, ct-le$`);
  for (const codec of [FEED_CODEC, NEW_NAME_CODEC]) {
    const rows = feedRows().map((x, i) => (i === 5 ? { ...x, sources: [0, 7] } : x));
    failsAlone(await verify(await feedPack(rows, codec)), "sources", unnamed);
  }
  const seen = domainRows().map((x, i) => (i === 5 ? { ...x, sources: [...x.sources, { bit: 7, first: DAY, last: DAY }] } : x));
  failsAlone(await verify(await domainsPack(seen)), "sources", unnamed);
  // The bit 7 only in the evidence: tier 3, basis 4 (ct-first), source 7.
  const evidence = domainRows().map((x, i) => (i === 5 ? { ...x, evidence: [{ tier: 3, basis: 4, source: 7, at: DAY, confidence: 0 }] } : x));
  const r = await verify(await domainsPack(evidence));
  failsAlone(r, "sources", unnamed);
  assert.equal(r.errors.length, 1);
});

test("verify: a domains evidence time outside the span fails precision alone", async () => {
  // thc-ct is a day source: day 299 is the day after the span.
  const rows = domainRows().map((x, i) => (i === 5 ? { ...x, evidence: [{ tier: 3, basis: 4, source: 0, at: DAY + 1, confidence: 0 }] } : x));
  const r = await verify(await domainsPack(rows));
  failsAlone(r, "precision", new RegExp(`^the record ${literal(quoteKey(CLEAN[5].key))} has evidence at of thc-ct, a day source, ${DAY + 1}, outside ${DAY} to ${DAY} days: the span`));
  assert.equal(r.errors.length, 1);
});

test("verify: a precision annotation that is not the registry's fails precision alone", async () => {
  const r = await verify(clean, { ...clean.expect, precision: { "thc-ct": "second" } });
  failsAlone(r, "precision", /^the annotation gives thc-ct the precision second, the registry day$/);
});

test("verify: with no span the clock bounds the times, and with neither the times are said to be unbounded", async () => {
  const noSpan: Expect = { ...clean.expect, span: undefined };
  assert.deepEqual((await verify(clean, noSpan, { now: "2026-10-29T00:00:00Z" })).errors, []);
  const early = await verify(clean, noSpan, { now: "2026-10-25T00:00:00Z" });
  assert.deepEqual(failed(early), ["precision"]);
  assert.match(early.errors[0].detail, /outside 0 to 297 days: 2026-01-01 to the clock 2026-10-25T00:00:00Z$/);
  // With neither, and no precision annotation, the check compared nothing.
  const unbounded = await verify(clean, noSpan);
  assert.equal(status(unbounded).precision, "skip");
  assert.match(detailOf(unbounded, "precision"), /not bounded: no span and no clock, and no precision annotation to compare$/);
  const stated = await verify(clean, { ...noSpan, precision: { "thc-ct": "day" } });
  assert.equal(status(stated).precision, "pass");
  assert.match(detailOf(stated, "precision"), /^the annotation's precision is the registry's; the times are not bounded: no span and no clock$/);
});

test("verify: a domains pack and a feed pack pass, and a feed first_seen outside the span fails precision alone", async () => {
  assert.deepEqual((await verify(await domainsPack(domainRows()))).errors, []);
  assert.deepEqual((await verify(await feedPack(feedRows()))).errors, []);
  // A day number where seconds belong.
  const bad = await feedPack(feedRows().map((r, i) => (i === 7 ? { ...r, firstSeen: DAY } : r)));
  failsAlone(await verify(bad), "precision", new RegExp(`^the record ${literal(quoteKey(CLEAN[7].key))} has first_seen 298, outside ${DAY_START} to ${DAY_START + 86_399} seconds`));
});

test("verify: a new-name pack (dataset 5) is checked as a feed pack: it passes, and a first_seen outside the span fails precision alone", async () => {
  const n = await feedPack(feedRows(), NEW_NAME_CODEC);
  const r = await verify(n);
  assert.deepEqual(r.errors, []);
  assert.equal(r.stats.dataset, 5);
  assert.match(detailOf(r, "dataset"), /^5 \(new-name\), as the annotation says$/);
  // Every check but the time copy, which is not given, and the volume, which has no rule here.
  assert.deepEqual(r.unverified, ["time", "volume"]);
  const bad = await feedPack(
    feedRows().map((x, i) => (i === 7 ? { ...x, firstSeen: DAY } : x)),
    NEW_NAME_CODEC,
  );
  failsAlone(await verify(bad), "precision", new RegExp(`^the record ${literal(quoteKey(CLEAN[7].key))} has first_seen 298, outside ${DAY_START} to ${DAY_START + 86_399} seconds`));
  failsAlone(await verify(n, { ...n.expect, dataset: "feed" }), "dataset", /^the index is dataset 5 \(new-name\), the annotation says feed$/);
});

test("verify: an empty pack fails no check, and the checks over its blocks and refind skip: it holds no block and no record", async () => {
  const empty = fromMem(await writeMem([], { codec: NAMES_CODEC }));
  const r = await verify(empty);
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.ok, r.verdict], [true, "ok"]);
  assert.equal(r.stats.records, 0);
  assert.equal(r.stats.sha256, createHash("sha256").digest("hex"));
  // Nothing to read or to find: skip, never a pass over 0 blocks or 0 keys.
  for (const check of OF_BLOCKS) assert.deepEqual([status(r)[check], detailOf(r, check)], ["skip", "the pack holds no block"], check);
  assert.deepEqual([status(r).refind, detailOf(r, "refind")], ["skip", "the pack holds no record to find"]);
  assert.deepEqual(r.unverified, [...OF_BLOCKS, "refind", "time", "volume"]);
  // The checks that compared the pack with its head and its annotations pass,
  // and sources and precision say that only the registry was compared.
  for (const check of ["count", "bounds", "sha256"] as const) assert.equal(status(r)[check], "pass", check);
  assert.match(detailOf(r, "sources"), /^the registry holds .+; the pack holds no record to check$/);
  assert.match(detailOf(r, "precision"), /^the registry's precision; the pack holds no time to bound by /);
  // A caller that requires the re-find gets unverified, not ok.
  const required = await verify(empty, empty.expect, { require: ["refind"] });
  assert.deepEqual([required.ok, required.verdict, required.errors], [false, "unverified", []]);
});

test("verify: a second source below the floor is held, and volume fails alone with the verdict hold", async () => {
  const r = await verify(clean, clean.expect, { volume: volumeAt(1539, "second") });
  failsAlone(r, "volume", /^hold \(below\): 600 against the median 1539 of ct-le/, "hold");
});

test("verify: a volume rule given a value judges that value, not the count", async () => {
  // The count (600) is 39% of the median; the value (1000) is 65% of it.
  const r = await verify(clean, clean.expect, { volume: volumeAt(1539, "day", 1000) });
  assert.deepEqual(r.errors, []);
  assert.match(r.checks.find((c) => c.check === "volume")?.detail ?? "", /^ok \(within\): 1000 against the median 1539/);
});

test("verify: a check with nothing to compare against is listed as skip, never as pass, and the result lists it as unverified", async () => {
  const r = await verify(clean, {});
  assert.equal(r.ok, true);
  assert.equal(r.verdict, "ok");
  const skipped: CheckName[] = ["dataset", "length", "count", "sha256", "time", "psl", "sources", "precision", "volume"];
  const s = status(r);
  for (const check of CHECKS) assert.equal(s[check], skipped.includes(check) ? "skip" : "pass", check);
  assert.deepEqual(r.unverified, skipped);
  // The half of each that reads the pack alone held, and the detail says so.
  assert.equal(detailOf(r, "dataset"), "no dataset annotation to compare; the index is dataset 1 (names), which this verifier checks");
  assert.equal(detailOf(r, "length"), `no bytes annotation to compare; the parts hold ${clean.parts[0].length} B as the index says, ${clean.parts[0].length + clean.idx.length} B with the index`);
  assert.equal(detailOf(r, "count"), "no count annotation to compare; the blocks hold 600 records, as the index header says");
  // That half still fails as itself with nothing to compare: a part not given.
  failsAlone(await verify(clean, {}, {}, sized([])), "length", /^the index names 1 part\(s\) and 0 were given$/);
});

test("verify: a check of require that skipped makes the verdict unverified, below a failure and above the volume's", async () => {
  const r = await verify(clean, {}, { require: ["count", "sha256"] });
  assert.deepEqual(r.errors, []);
  assert.equal(r.ok, false);
  assert.equal(r.verdict, "unverified");
  // Every annotation the pack states, each required: ok.
  const all = await verify(clean, clean.expect, { require: ["dataset", "length", "count", "sha256", "psl", "sources", "precision"] });
  assert.deepEqual([all.ok, all.verdict, all.unverified], [true, "ok", ["time", "volume"]]);
  // A failure ranks above it.
  const failing = await verify(clean, { count: CLEAN_COUNT + 1 }, { require: ["sha256"] });
  assert.deepEqual([failing.ok, failing.verdict, failed(failing)], [false, "fail", ["count"]]);
  // A quarantine ranks below it.
  const quarantined = await verify(clean, { ...clean.expect, sha256: undefined }, { require: ["sha256"], volume: volumeAt(1539) });
  assert.deepEqual([quarantined.ok, quarantined.verdict, failed(quarantined)], [false, "unverified", ["volume"]]);
  // require names checks, and only checks: the bytes annotation is the length check's.
  await assert.rejects(() => verify(clean, {}, { require: ["bytes" as CheckName] }), /^PackError: require names "bytes", which is not a check; the checks are idx, dataset, length,/);
});

test("verify: a source that throws is not a finding: verifyPack rejects with its error", async () => {
  const parts: PartSource = { sizes: [clean.parts[0].length], read: async () => Promise.reject(new Error("synthetic: the connection reset")) };
  await assert.rejects(() => verifyPack(clean.idx, parts, clean.expect, { psl: PSL, registry: REGISTRY }), /synthetic: the connection reset/);
  await assert.rejects(() => verifyPack(clean.idx, sized(clean.parts), clean.expect, { psl: PSL }), /no registry was given/);
});

// ---- keys in a detail

test("verify: quoteKey shows at most 80 bytes and escapes every byte outside printable ASCII", () => {
  assert.equal(quoteKey('com.a"b\\c\x1b[2Jz\xe9'), '"com.a\\x22b\\x5cc\\x1b[2Jz\\xe9"');
  const long = `com.${"q".repeat(200)}`;
  assert.equal(quoteKey(long), `"${long.slice(0, KEY_SHOWN)}" (the first 80 of 204 bytes)`);
});

test("verify: a hostile key in a failure is shown escaped and cut at 80 bytes", async () => {
  const key = `com.\x1b${"q".repeat(190)}`;
  const r = await verify(await packOf([...CLEAN, { key, flags: 1, sources: [{ bit: 0, first: DAY, last: DAY }] }].sort(byKey)));
  failsAlone(r, "name", /^the key "com\.\\x1bq{75}" \(the first 80 of 195 bytes\): a byte outside \[a-z0-9_.-\]$/);
  for (const e of r.errors) assert.equal(e.detail.includes("\x1b"), false);
});

// ---- the annotations and the fixtures

test("verify: expectFromAnnotations reads a pack's annotations and refuses one it cannot read", () => {
  const annotations = JSON.parse(readFileSync(join(FIXTURES, "clean.annotations.json"), "utf8"));
  const e = expectFromAnnotations(annotations);
  assert.deepEqual(e, { count: 600, bytes: 7291, dataset: "names", sha256: annotations["dev.pkgforge.domains.sha256"], psl: PSL.sha256, sources: ["thc-ct", "ct-le"], span: SPAN });
  const one = { "dev.pkgforge.domains.source": "thc-ct" };
  assert.deepEqual(expectFromAnnotations({ ...one, "dev.pkgforge.domains.precision": "day" }).precision, { "thc-ct": "day" });
  const refused: [Record<string, string>, RegExp][] = [
    [{ "dev.pkgforge.domains.count": "6e2" }, /count is "6e2", not a whole number/],
    [{ "dev.pkgforge.domains.bytes": "-1" }, /bytes is "-1", not a whole number/],
    [{ "dev.pkgforge.domains.sha256": "ABC" }, /sha256 is not 64 lowercase hex digits/],
    [{ "dev.pkgforge.domains.precision": "day" }, /needs dev\.pkgforge\.domains\.source to name exactly one source/],
    [{ "dev.pkgforge.domains.source": "thc-ct,ct-le", "dev.pkgforge.domains.precision": "day" }, /exactly one source/],
    [{ ...one, "dev.pkgforge.domains.precision": "hour" }, /precision of thc-ct is hour, not day or second/],
    [{ "dev.pkgforge.domains.span.start": SPAN.start }, /come together/],
    [{ "dev.pkgforge.domains.span.start": SPAN.end, "dev.pkgforge.domains.span.end": SPAN.start }, /ends before it starts/],
    [{ "dev.pkgforge.domains.span.start": "2026-10-26", "dev.pkgforge.domains.span.end": SPAN.end }, /is not YYYY-MM-DDTHH:MM:SSZ/],
  ];
  for (const [a, pattern] of refused) assert.throws(() => expectFromAnnotations(a), pattern, JSON.stringify(a));
});

test("verify: the committed fixtures hold the synthetic records and match their annotations", async () => {
  const read = (name: string): Uint8Array => new Uint8Array(readFileSync(join(FIXTURES, name)));
  const part = read("clean.part.000");
  const idx = read("clean.idx");
  const reader = await PackReader.open(idx, partsSource([part]), NAMES_CODEC);
  assert.deepEqual(await collect(reader.scan()), CLEAN);
  // The digest of the raw blocks does not depend on the zlib build.
  const annotations = JSON.parse(readFileSync(join(FIXTURES, "clean.annotations.json"), "utf8"));
  assert.equal(annotations["dev.pkgforge.domains.sha256"], clean.expect.sha256);
  assert.equal(Number(annotations["dev.pkgforge.domains.bytes"]), part.length + idx.length);
  assert.deepEqual(read("truncated.part.000"), part.subarray(0, Math.floor(part.length / 2)));
  const pair = await PackReader.open(read("pair.idx"), partsSource([read("pair.part.000")]), NAMES_CODEC);
  assert.deepEqual(await collect(pair.scan()), syntheticNames(2, PAIR_SEED));
  // registry.json is the synthetic registry, and validates against the real bit map.
  const registry = JSON.parse(readFileSync(join(FIXTURES, "registry.json"), "utf8"));
  assert.deepEqual(registry, syntheticRegistry());
  const bits = validateBits(JSON.parse(readFileSync(join(ROOT, "config", "source-bits.json"), "utf8")));
  assert.deepEqual(
    validateRegistry(registry, bits).sources.map((s) => [s.id, s.bit, s.precision]),
    REGISTRY.map((s) => [s.id, s.bit, s.precision]),
  );
  // The committed clean pack passes with its own annotations.
  const r = await verifyPack(idx, sized([part]), expectFromAnnotations(annotations), { psl: PSL, registry: REGISTRY });
  assert.deepEqual(r.errors, []);
});

// ---- the time copy (docs/format.md section 14)

// The feed rows in (first_seen, key) order.
const byTime = (a: FeedRecord, b: FeedRecord): number => a.firstSeen - b.firstSeen || byKey(a, b);

// A time copy written from `rows` (sorted here) with `codec`, at 16 records a
// block, as the PartSource and index verifyPack takes.
async function timeCopy(rows: FeedRecord[], codec = FEED_TIME_CODEC): Promise<{ idx: Uint8Array; parts: PartSource; mem: MemPack }> {
  const mem = await writeMem([...rows].sort(byTime), { codec, recordsPerBlock: 16, pageEntries: 4 });
  return { idx: mem.summary.idx, parts: sized(mem.parts), mem };
}

// Synthetic feed rows whose first_seen values repeat and do not follow the
// keys: the time copy is in another order than the key copy.
const timedRows = (): FeedRecord[] => feedRows().map((r, i) => ({ ...r, firstSeen: DAY_START + ((i * 7919) % 300) * 60 }));

test("verify: a feed pack's time copy passes time, holding the key copy's rows in (first_seen, key) order; with none, time skips and --require time is unverified", async () => {
  const rows = timedRows();
  const pack = await feedPack(rows);
  const time = await timeCopy(rows);
  assert.ok(time.mem.summary.blocks > 1);
  const r = await verify(pack, pack.expect, { time });
  assert.deepEqual(r.errors, []);
  assert.equal(status(r).time, "pass");
  assert.match(detailOf(r, "time"), /^the time copy \(1 part\(s\), 38 block\(s\)\) holds the 600 rows of the key copy in \(first_seen, key\) order, inside the span$/);
  assert.deepEqual(r.stats.time, { parts: 1, blocks: 38, records: 600, idxBytes: time.idx.length, partBytes: time.mem.summary.partBytes });
  // new-name with its own time copy, dataset 7.
  const nn = await feedPack(rows, NEW_NAME_CODEC);
  assert.equal(status(await verify(nn, nn.expect, { time: await timeCopy(rows, NEW_NAME_TIME_CODEC) })).time, "pass");
  // No time copy: skip, and a job that requires it gets unverified.
  const none = await verify(pack, pack.expect, { require: ["time"] });
  assert.deepEqual([none.ok, none.verdict, status(none).time, detailOf(none, "time")], [false, "unverified", "skip", "no time copy given"]);
  assert.deepEqual([(await verify(pack, pack.expect, { time, require: ["time"] })).verdict], ["ok"]);
});

test("verify: a time copy of other rows fails time alone, by its bind or by its rows: fewer or more records, another dataset, rows outside the span, one row changed", async () => {
  const rows = timedRows();
  const pack = await feedPack(rows);
  const timeOf = (other: FeedRecord[], codec = FEED_TIME_CODEC) => timeCopy(other, codec);
  // One row fewer, and one row more: the bind's records, each way.
  failsAlone(await verify(pack, pack.expect, { time: await timeOf(rows.slice(1)) }), "time", /^the time copy holds 599 records and its key copy 600$/);
  const extra: FeedRecord = { ...rows[0], key: "com.synthetic-extra-row" };
  assert.ok(!rows.some((x) => x.key === extra.key));
  failsAlone(await verify(pack, pack.expect, { time: await timeOf([...rows, extra]) }), "time", /^the time copy holds 601 records and its key copy 600$/);
  // The time copy of new-name beside a feed key copy: the bind's dataset.
  failsAlone(await verify(pack, pack.expect, { time: await timeOf(rows, NEW_NAME_TIME_CODEC) }), "time", /^the time copy is dataset 7; the time copy of dataset 3 is dataset 6$/);
  // Every row a day later: outside the span of the annotations.
  failsAlone(await verify(pack, pack.expect, { time: await timeOf(rows.map((x) => ({ ...x, firstSeen: x.firstSeen + 86_400 }))) }), "time", /outside the span \[\d+, \d+\) of the pack$/);
  // The same count, the same span, one row's confidence changed: the bind holds
  // and the sums differ. A reader's bind check cannot see this; the verifier does.
  const changed = rows.map((x, i) => (i === 300 ? { ...x, confidence: 3 } : x));
  failsAlone(
    await verify(pack, pack.expect, { time: await timeOf(changed) }),
    "time",
    /^the time copy's 600 rows are not the 600 rows of the key copy: their sums are [0-9a-f]{16}… and [0-9a-f]{16}…$/,
  );
  // One row moved by a second inside the span: its time key is another.
  const moved = rows.map((x, i) => (i === 7 ? { ...x, firstSeen: x.firstSeen + 1 } : x));
  failsAlone(await verify(pack, pack.expect, { time: await timeOf(moved) }), "time", /are not the 600 rows of the key copy/);
});

test("verify: a time copy whose bytes break fails time alone: a part shorter than its index, a part more than it names, a part header that differs in each field, a block that does not inflate", async () => {
  const rows = timedRows();
  const pack = await feedPack(rows);
  const time = await timeCopy(rows);
  const part = time.mem.parts[0];
  const withPart = (bytes: Uint8Array, size = bytes.length) => ({ idx: time.idx, parts: sized([bytes], [size]) });
  // A part shorter than the index says.
  failsAlone(await verify(pack, pack.expect, { time: withPart(part.subarray(0, part.length - 1)) }), "time", /^time\.part\.000 holds \d+ B, the time copy's index says \d+ B$/);
  // A second time part that the index does not name.
  failsAlone(await verify(pack, pack.expect, { time: { idx: time.idx, parts: sized([part, part]) } }), "time", /^the time copy's index names 1 part\(s\) and 2 were given$/);
  // A part header that differs from its index in one field: byte 5 the
  // dataset, 6 the records a block, 8 the part number, 10 the codec (2, gzip,
  // a codec the reader knows).
  for (const [at, value, said] of [
    [5, 3, "dataset 3, 16 records a block, codec 1 and part 0"],
    [6, 17, "dataset 6, 17 records a block, codec 1 and part 0"],
    [8, 1, "dataset 6, 16 records a block, codec 1 and part 1"],
    [10, 2, "dataset 6, 16 records a block, codec 2 and part 0"],
  ] as const) {
    const changed = part.slice();
    changed[at] = value;
    failsAlone(await verify(pack, pack.expect, { time: withPart(changed) }), "time", new RegExp(`^time\\.part\\.000 names ${said}; its index 6, 16, 1 and 0$`));
  }
  // A byte of a block flipped: the block of the time copy is refused by the reader.
  const flipped = part.slice();
  flipped[40] ^= 0xff;
  const r = await verify(pack, pack.expect, { time: withPart(flipped) });
  failsAlone(r, "time", /^block 0 of the time copy: (inflate|crc): /);
  // A time copy given for a names pack.
  failsAlone(await verify(clean, clean.expect, { time }), "time", /^a time copy is given for dataset 1 \(names\), which has none: only feed and new-name do$/);
  // An index that does not parse.
  failsAlone(await verify(pack, pack.expect, { time: { idx: time.idx.subarray(0, 63), parts: time.parts } }), "time", /^the time copy's index is refused: head: /);
});

test("verify: the time check skips when a block of the key copy did not decode, and a time option that is not a copy is a usage error", async () => {
  const rows = timedRows();
  const pack = await feedPack(rows);
  const time = await timeCopy(rows);
  const broken = pack.parts[0].slice();
  broken[40] ^= 0xff;
  const r = await verify(pack, pack.expect, { time }, sized([broken]));
  assert.equal(status(r).time, "skip");
  assert.equal(detailOf(r, "time"), "a block of the key copy did not decode, so its rows are not known to compare");
  await assert.rejects(() => verify(pack, pack.expect, { time: { idx: time.idx } as never }), /^PackError: the time copy is not an index and a PartSource/);
});

// A one-part time copy of dataset 6 built by hand: each block written by
// FEED_TIME_CODEC (which holds the order inside it) and compressed by the
// production compressor, and an index of those blocks with the head bounds
// given, by default the first and the last time key of `rows`. The writer's
// own order check across blocks and its bounds are not on this path.
async function assembleTime(blocks: readonly FeedRecord[][], rows: readonly FeedRecord[], bounds: { keyMin?: string; keyMax?: string } = {}): Promise<{ idx: Uint8Array; parts: PartSource }> {
  const chunks: Uint8Array[] = [encodePartHeader({ dataset: 6, recordsPerBlock: 16, part: 0, codec: 1 })];
  const entries: BlockEntry[] = [];
  let offset = 16;
  for (const block of blocks) {
    const out = new ByteWriter();
    let prev: FeedRecord | null = null;
    for (const r of block) {
      FEED_TIME_CODEC.encodeRecord(prev, r, out);
      prev = r;
    }
    const raw = out.take();
    const packed = await nodeCompress(1, raw);
    entries.push({ index: entries.length, key: FEED_TIME_CODEC.key(block[0]), part: 0, offset, packed: packed.length, raw: raw.length, records: block.length, crc: zlibCrc32(raw) });
    chunks.push(packed);
    offset += packed.length;
  }
  const part = concat(chunks);
  const sorted = [...rows].sort(byTime);
  const idx = encodeIdx({
    dataset: 6,
    codec: 1,
    recordsPerBlock: 16,
    pageEntries: 4,
    records: rows.length,
    parts: [{ bytes: part.length, firstBlock: 0, blocks: entries.length }],
    keyMin: bounds.keyMin ?? FEED_TIME_CODEC.key(sorted[0]),
    keyMax: bounds.keyMax ?? FEED_TIME_CODEC.key(sorted[sorted.length - 1]),
    entries,
  });
  return { idx, parts: sized([part]) };
}

test("verify: a time copy whose blocks overlap across a boundary, or whose head bounds are a second off, fails time alone", async () => {
  const rows = timedRows();
  const pack = await feedPack(rows);
  const inTime = [...rows].sort(byTime);
  const blocks: FeedRecord[][] = [];
  for (let i = 0; i < inTime.length; i += 16) blocks.push(inTime.slice(i, i + 16));
  // The blocks of the writer, assembled by hand: the control passes.
  const control = await verify(pack, pack.expect, { time: await assembleTime(blocks, rows) });
  assert.deepEqual(control.errors, []);
  assert.equal(status(control).time, "pass");
  // The first row of block 1 and the last row of block 0 change places: each
  // block in order, the index keys ascending, the same rows and bounds, and
  // block 1 starts below the last time key of block 0.
  const a = [...blocks[0].slice(0, 15), blocks[1][0]];
  const b = [blocks[0][15], ...blocks[1].slice(1)];
  const overlap = await verify(pack, pack.expect, { time: await assembleTime([a, b, ...blocks.slice(2)], rows) });
  failsAlone(overlap, "time", /^block 1 of the time copy starts at or below the last time key of the block before it$/);
  // The head's smallest time key a second after the first row's, and,
  // apart, its largest a second before the last row's: both inside the span.
  const first = inTime[0];
  const last = inTime[inTime.length - 1];
  const bounds = /^the time copy's head bounds are not its first and last time key$/;
  failsAlone(await verify(pack, pack.expect, { time: await assembleTime(blocks, rows, { keyMin: timeKey(first.firstSeen + 1, first.key) }) }), "time", bounds);
  failsAlone(await verify(pack, pack.expect, { time: await assembleTime(blocks, rows, { keyMax: timeKey(last.firstSeen - 1, last.key) }) }), "time", bounds);
});

// A writer other than encodeRecord (synthetic): the record layout of `codec`
// with every field written as given, the feed_flags rule left out.
const laxFeed = (codec: DatasetCodec<FeedRecord>): DatasetCodec<FeedRecord> => ({
  ...codec,
  encodeRecord(prev: FeedRecord | null, r: FeedRecord, out: ByteWriter): void {
    writeKey(prev === null ? null : prev.key, r.key, r.flags, out, codec.maxKeyBytes);
    out.varint(r.firstSeen);
    out.mask(r.sources);
    out.varint(r.basis);
    out.u8(r.confidence);
    out.u8(r.feedFlags);
  },
});

test("verify: a feed or new-name row whose feed_flags break the rule of section 5.4 fails record alone: suspect with no reason, a reason with no suspect, a reserved bit", async () => {
  const at = (flags: number) => feedRows().map((x, i) => (i === 9 ? { ...x, feedFlags: flags } : x));
  for (const codec of [FEED_CODEC, NEW_NAME_CODEC]) {
    // The strict codec refuses each of these rows; the lax writer writes them.
    assert.throws(() => codec.encodeRecord(null, at(FEED_SUSPECT)[9], new ByteWriter()), /suspect \(bit 1\) is set exactly when a reason is/);
    // Control: a suspect row with its reason, written by the lax writer, passes.
    assert.deepEqual((await verify(await feedPack(at(FEED_SUSPECT | FEED_SUSPECT_CERT), laxFeed(codec)))).errors, [], codec.name);
    const key = literal(quoteKey(CLEAN[9].key));
    for (const [flags, said] of [
      [FEED_SUSPECT, "feed flags 2: suspect \\(bit 1\\) is set exactly when a reason is \\(bit 4 suspect-cert, bit 5 suspect-rdap\\)"],
      [FEED_SUSPECT_CERT, "feed flags 16: suspect \\(bit 1\\) is set exactly when a reason is"],
      [64 | FEED_SUSPECT | FEED_SUSPECT_CERT, "feed flags 82; the known bits are 0 to 5"],
    ] as const) {
      const r = await verify(await feedPack(at(flags), laxFeed(codec)));
      failsAlone(r, "record", new RegExp(`^the record ${key} has ${said}`));
      assert.equal(r.errors.length, 1, `${codec.name} ${flags}`);
    }
  }
});

function byKey(a: { key: string }, b: { key: string }): number {
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

// A literal for a RegExp.
function literal(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
