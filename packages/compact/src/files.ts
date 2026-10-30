// packages/compact/src/files.ts — the JSON files the jobs of one compaction
// pass to each other (scripts/compact/plan.mjs, range.mjs, assemble.mjs).
//
//   plan    domains.compact-plan.v1    the unit, its verdict, its inputs, the cuts of each copy, the matrix
//   count   domains.compact-count.v1   stage 1: one range's distinct keys
//   range   domains.compact-range.v1   stage 2: one range's part, its digest and the keys that join it
//
// Each count and range file names the plan by its `id`, the SHA-256 of the
// plan's canonical JSON with no id, so a file of another plan, or of a plan
// that was edited, is refused (CompactError plan) and never assembled into
// this one. A key is a JSON string of one code unit a byte, as @domains/pack
// holds keys, so a time key's four bytes of time survive the round trip.
//
// It imports nothing from `node:` and is type-checked as Worker code
// (tsconfig.worker.json); no test runs it in workerd.
import type { TierDataset } from "@domains/ghcr";
import { type DatasetCodec, DEFAULT_PAGE_ENTRIES, DEFAULT_RECORDS_PER_BLOCK, DOMAINS_CODEC, FEED_CODEC, type FeedRecord, NAMES_CODEC, NEW_NAME_CODEC, sha256Hex, timeCodecOf } from "@domains/pack";
import { canonical, type PackEntry, TIME_COPY_TIERS, TIME_DATASETS } from "@domains/root";
import { CompactError } from "./errors.ts";
import { MAX_LAYERS } from "./manifest.ts";
import type { CompactTier, TierPlan } from "./plan.ts";
import type { RangeCount, RangeOutput, RangePlan } from "./range.ts";
import { MAX_RANGES } from "./range.ts";
import type { TimeMode } from "./time.ts";

export const PLAN_FORMAT = "domains.compact-plan.v1";
export const COUNT_FORMAT = "domains.compact-count.v1";
export const RANGE_FORMAT = "domains.compact-range.v1";

export type Copy = "key" | "time";

export interface CopyPlan {
  readonly ranges: number;
  readonly cuts: readonly string[];
  // The compressed input bytes each range is planned to read.
  readonly bytes: readonly number[];
}

export interface TimePlan extends CopyPlan {
  // merge: the inputs' time copies, by range, when no key is in two inputs
  // (the key counts say); sort: the assemble job sorts the merged rows.
  readonly mode: TimeMode;
}

export interface PlanFile {
  readonly format: typeof PLAN_FORMAT;
  readonly id: string;
  readonly dataset: TierDataset;
  readonly tier: CompactTier;
  readonly span: { readonly start: string; readonly end: string };
  readonly tag: string;
  readonly verdict: TierPlan["verdict"];
  readonly reason: string;
  // The root the plan read: its manifest digest, or sha256:<hex> of a root.json file.
  readonly root: string;
  readonly inputs: readonly PackEntry[];
  readonly replaces: readonly string[];
  readonly excluded: TierPlan["excluded"];
  readonly missing: TierPlan["missing"];
  readonly gap_days: readonly string[];
  readonly sources: readonly string[];
  readonly psl: readonly string[];
  readonly records: number;
  readonly records_per_block: number;
  readonly page_entries: number;
  readonly key: CopyPlan | null;
  readonly time: TimePlan | null;
  readonly matrix: { readonly include: readonly { readonly range: number }[] };
}

// The codec of a dataset's records; rev's codec is DOM-043's.
export function codecOf(dataset: TierDataset): DatasetCodec<unknown> {
  const codec = { names: NAMES_CODEC, domains: DOMAINS_CODEC, feed: FEED_CODEC, "new-name": NEW_NAME_CODEC }[dataset as string];
  if (codec === undefined) throw new CompactError("usage", `no codec merges ${dataset}: the record of rev is DOM-043's`);
  return codec as DatasetCodec<unknown>;
}

// The time codec of a dataset, or null when its packs of `tier` carry no time copy.
export function timeCodecFor(dataset: TierDataset, tier: CompactTier): DatasetCodec<FeedRecord> | null {
  if (!Object.hasOwn(TIME_DATASETS, dataset) || !TIME_COPY_TIERS.includes(tier)) return null;
  return timeCodecOf((codecOf(dataset) as DatasetCodec<FeedRecord>).id);
}

// The layers of the pack a plan writes, at most: one part a key range (a range
// owns at most one part), the idx, and for a time copy one part a time range
// (a sorted copy is planned as one range) and the time.idx.
export const layersOf = (key: { readonly ranges: number }, time: { readonly ranges: number } | null): number => key.ranges + 1 + (time === null ? 0 : time.ranges + 1);

// The most key ranges of a merge of `dataset` and `tier` whose pack fits one
// manifest of MAX_LAYERS layers. The time copy is cut into no more ranges than
// the key copy (planFile holds it), so a pack with a time copy holds at most
// 2N + 2 layers and one without N + 1: 127 and 255 ranges.
export function rangeCeiling(dataset: TierDataset, tier: CompactTier): number {
  const timed = Object.hasOwn(TIME_DATASETS, dataset) && TIME_COPY_TIERS.includes(tier);
  return Math.min(MAX_RANGES, timed ? Math.floor((MAX_LAYERS - 2) / 2) : MAX_LAYERS - 1);
}

const idOf = (body: Record<string, unknown>): string => sha256Hex(new TextEncoder().encode(canonical(body)));

export interface PlanFileInput {
  readonly plan: TierPlan;
  readonly root: string;
  readonly key: RangePlan | null;
  readonly time: (RangePlan & { readonly mode: TimeMode }) | null;
  readonly recordsPerBlock?: number;
  readonly pageEntries?: number;
}

const copyOf = (p: RangePlan): CopyPlan => ({ ranges: p.ranges, cuts: [...p.cuts], bytes: [...p.bytes] });

export function planFile(input: PlanFileInput): PlanFile {
  const p = input.plan;
  const ready = p.verdict === "ready";
  if (ready !== (input.key !== null)) throw new CompactError("usage", "a ready plan has key cuts, and no other plan has");
  if (input.time !== null && input.key !== null && input.time.ranges > input.key.ranges) throw new CompactError("usage", "the time copy is cut into more ranges than the key copy");
  if (input.key !== null && layersOf(input.key, input.time) > MAX_LAYERS)
    throw new CompactError("usage", `the pack would hold ${layersOf(input.key, input.time)} layers, and one manifest holds at most ${MAX_LAYERS}: plan fewer ranges`);
  const body = {
    format: PLAN_FORMAT,
    dataset: p.dataset,
    tier: p.tier,
    span: { ...p.span },
    tag: p.tag,
    verdict: p.verdict,
    reason: p.reason,
    root: input.root,
    inputs: p.inputs,
    replaces: p.replaces,
    excluded: p.excluded,
    missing: p.missing,
    gap_days: p.gapDays,
    sources: p.sources,
    psl: p.psl,
    records: p.records,
    records_per_block: input.recordsPerBlock ?? DEFAULT_RECORDS_PER_BLOCK,
    page_entries: input.pageEntries ?? DEFAULT_PAGE_ENTRIES,
    key: input.key === null ? null : copyOf(input.key),
    time: input.time === null ? null : { ...copyOf(input.time), mode: input.time.mode },
    matrix: { include: input.key === null ? [] : Array.from({ length: input.key.ranges }, (_, range) => ({ range })) },
  };
  const plain = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
  return { ...plain, id: idOf(plain) } as unknown as PlanFile;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isWhole = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max;
const bad = (message: string): CompactError => new CompactError("plan", message);

function checkCopy(v: unknown, what: string): CopyPlan {
  if (!isObj(v) || !isWhole(v.ranges, 1, MAX_RANGES) || !Array.isArray(v.cuts) || !Array.isArray(v.bytes)) throw bad(`${what} is not { ranges, cuts, bytes }`);
  if (v.cuts.length !== v.ranges - 1 || v.bytes.length !== v.ranges) throw bad(`${what} holds ${v.ranges} ranges and ${v.cuts.length} cuts`);
  for (const [i, c] of v.cuts.entries()) if (typeof c !== "string" || c.length === 0 || (i > 0 && !(c > v.cuts[i - 1]))) throw bad(`${what}: cut ${i} is not a key above the one before it`);
  return v as unknown as CopyPlan;
}

// A plan file read back: its format, its id, and the shape the jobs read.
export function checkPlanFile(v: unknown): PlanFile {
  if (!isObj(v) || v.format !== PLAN_FORMAT) throw bad(`the plan is not ${PLAN_FORMAT}`);
  const { id, ...body } = v;
  if (typeof id !== "string" || id !== idOf(body)) throw bad("the plan's id is not the SHA-256 of its body: the plan was edited after it was written");
  if (!Array.isArray(v.inputs) || !Array.isArray(v.sources) || !Array.isArray(v.psl) || !isWhole(v.records)) throw bad("the plan lacks its inputs, sources, psl or records");
  if (!isWhole(v.records_per_block, 1, 0xffff) || !isWhole(v.page_entries, 1, 0xffff)) throw bad("the plan's records_per_block or page_entries is not a whole number of 1 to 65535");
  if (v.verdict === "ready") {
    const key = checkCopy(v.key, "key");
    let time: TimePlan | null = null;
    if (v.time !== null) {
      time = checkCopy(v.time, "time") as TimePlan;
      if (time.mode !== "merge" && time.mode !== "sort") throw bad("time.mode is not merge or sort");
      if (time.ranges > key.ranges) throw bad("the time copy is cut into more ranges than the key copy");
    }
    if (layersOf(key, time) > MAX_LAYERS) throw bad(`the pack would hold ${layersOf(key, time)} layers, and one manifest holds at most ${MAX_LAYERS}`);
  } else if (v.key !== null || v.time !== null) throw bad(`a plan whose verdict is ${String(v.verdict)} has no cuts`);
  return v as unknown as PlanFile;
}

// ---------------------------------------------------------------- count and range files

export interface CountFile {
  readonly format: typeof COUNT_FORMAT;
  readonly plan: string;
  readonly copy: Copy;
  readonly range: number;
  readonly of: number;
  readonly count: number;
  readonly input_records: number;
  readonly first: string | null;
  readonly last: string | null;
}

export const countFile = (plan: PlanFile, copy: Copy, c: RangeCount): CountFile => ({
  format: COUNT_FORMAT,
  plan: plan.id,
  copy,
  range: c.range,
  of: c.of,
  count: c.count,
  input_records: c.inputRecords,
  first: c.first,
  last: c.last,
});

// The counts of `copy` among `files` for `plan`, as windowOf takes them. A
// file of another plan is refused, never passed over.
export function countsOf(plan: PlanFile, copy: Copy, files: readonly unknown[]): RangeCount[] {
  const out: RangeCount[] = [];
  for (const f of files) {
    if (!isObj(f) || f.format !== COUNT_FORMAT) throw bad(`a count file is not ${COUNT_FORMAT}`);
    if (f.plan !== plan.id) throw bad(`the count of range ${String(f.range)} is of the plan ${String(f.plan)}, not ${plan.id}`);
    if (f.copy !== copy) continue;
    if (!isWhole(f.range) || !isWhole(f.of, 1, MAX_RANGES) || !isWhole(f.count) || !isWhole(f.input_records)) throw bad("a count file's range, of, count or input_records is not a whole number");
    out.push({ range: f.range, of: f.of, count: f.count, inputRecords: f.input_records, first: f.first as string | null, last: f.last as string | null });
  }
  return out;
}

export interface RangeFile {
  readonly format: typeof RANGE_FORMAT;
  readonly plan: string;
  readonly copy: Copy;
  readonly range: number;
  readonly of: number;
  readonly part: number | null;
  readonly records: number;
  readonly first: string | null;
  readonly last: string | null;
  readonly next: string | null;
  // True when no key of the merge was in two inputs, so the time copy merges by range.
  readonly disjoint: boolean;
  readonly writer: string;
  // The part's file, its OCI digest and size; null for a range that owns no block.
  readonly file: string | null;
  readonly digest: string | null;
  readonly size: number;
  // The range's own index (its blocks as part 0), which assembly reads.
  readonly idx: { readonly file: string; readonly digest: string; readonly size: number } | null;
  // The SHA-256 of the range's raw blocks.
  readonly sha256: string | null;
}

export interface RangeFileInput {
  readonly out: RangeOutput;
  readonly disjoint: boolean;
  readonly writer: string;
  readonly part: { readonly file: string; readonly digest: string; readonly size: number } | null;
  readonly idx: { readonly file: string; readonly digest: string; readonly size: number } | null;
}

export function rangeFile(plan: PlanFile, copy: Copy, input: RangeFileInput): RangeFile {
  const o = input.out;
  return {
    format: RANGE_FORMAT,
    plan: plan.id,
    copy,
    range: o.range,
    of: o.of,
    part: o.part,
    records: o.records,
    first: o.first,
    last: o.last,
    next: o.next,
    disjoint: input.disjoint,
    writer: input.writer,
    file: input.part?.file ?? null,
    digest: input.part?.digest ?? null,
    size: input.part?.size ?? 0,
    idx: input.idx,
    sha256: o.summary?.sha256 ?? null,
  };
}

// The range files of `copy` among `files` for `plan`.
export function rangesOf(plan: PlanFile, copy: Copy, files: readonly unknown[]): RangeFile[] {
  const out: RangeFile[] = [];
  for (const f of files) {
    if (!isObj(f) || f.format !== RANGE_FORMAT) throw bad(`a range file is not ${RANGE_FORMAT}`);
    if (f.plan !== plan.id) throw bad(`the output of range ${String(f.range)} is of the plan ${String(f.plan)}, not ${plan.id}`);
    if (f.copy !== copy) continue;
    if (!isWhole(f.range) || !isWhole(f.of, 1, MAX_RANGES) || !isWhole(f.records) || typeof f.disjoint !== "boolean" || typeof f.writer !== "string")
      throw bad("a range file's fields are not of their kinds");
    if ((f.part === null) !== (f.file === null) || (f.part === null) !== (f.idx === null)) throw bad(`range ${f.range}: a part, its file and its index are given all or none`);
    out.push(f as unknown as RangeFile);
  }
  return out;
}
