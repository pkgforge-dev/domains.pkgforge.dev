// packages/compact/src/hour.ts — the hour pack of the feed (DOM-023,
// docs/architecture.md sections 4.5 and 5.8 step 5): the registrable domains
// that the segments of one UTC hour saw and that the provisional filter of the
// hourly job did not hold, each row `provisional`. No hour pack of new-name is
// built: new-name enters the package feed only through the exact day pack of
// DOM-041, whose Decision rules out a name-level filter, which an hour pack
// would need (TODO/storage.md, DOM-041).
//
//   const hour = hourOf("2026102705");                        the span, its seconds since 2026-01-01, the tag feed-h-2026102705
//   const plan = planHour(segments, hour, registry);          ready, wait or skip: the segments the pack reads, and why each other is left
//   const membership = membershipOf(filterBytes, deltaBytes, hour);   ledger-filter and ledger-delta, paired, the filter older than the hour
//   const built = await buildHour(readers, membership, { registry, hour, compress, sink, time: { sink } });
//   membership.delta.encode()                                 the next ledger-delta: the hour's new domains added
//
// The segments. A segment is the pack of one adapter window, of one source
// (docs/architecture.md sections 3.4 and 4.5). The hour reads the segments of
// the domains dataset (dataset 2) whose source is of precision `second`, and
// leaves each other one, with the reason:
//   - a quarantined segment (the annotation dev.pkgforge.domains.quarantine):
//     ruling 23 serves its names and never as new;
//   - a segment of a day source: its first_seen is the start of its day, which
//     no hour but the first holds, and its rows enter the feed through the day
//     pack (buildFeedDay);
//   - a segment of the names dataset: the feed of the hour reads domain
//     records. A names source reaches it through a domains segment of its own,
//     as thc-ct writes one (TODO/ingest.md, DOM-029).
// A segment that crosses an edge of the hour is refused (straddle), and so is
// one wholly outside it, or two segments of one source that overlap (plan).
// Each source the pack reads must cover the hour with its segments: a hole
// is `wait`, so a lane behind its clock does not leave its domains out of a
// write-once pack. With no segment to read the verdict is `skip`, and no pack
// is written: a pack names at least one source.
//
// The filter. `ledger-filter-DATE` holds the domains table through its
// `as_of`, and `ledger-delta` the domains first seen since (docs/format.md
// section 15). A filter whose as_of is after the hour's start holds the
// hour's own domains and judges them all old, so it is refused (plan); a
// delta of another filter is refused by ProvisionalFilter (LedgerError pair).
//
// It imports nothing from `node:` and is type-checked as Worker code
// (tsconfig.worker.json); no test runs it in workerd.
import { buildFeedHour, type FeedPack, type SourceRowLike, sourceTable, writeFeedPack } from "@domains/feed";
import { repoOf, tierTag } from "@domains/ghcr";
import { BloomFilter, HashDelta, ProvisionalFilter } from "@domains/ledger";
import {
  type Compress,
  DATASET_DOMAINS,
  DOMAINS_CODEC,
  type DomainRecord,
  FEED_CODEC,
  IDX_TITLE,
  mergePacks,
  type PackReader,
  type PackSink,
  parseHead,
  sha256Hex,
  VERIFY_ANNOTATIONS,
} from "@domains/pack";
import { isoOf, type ManifestFacts, msOf, type PackEntry, packFromManifest, QUARANTINE_ANNOTATION, RootError } from "@domains/root";
import { CompactError } from "./errors.ts";

const HOUR_MS = 3_600_000;
const EPOCH_MS = Date.UTC(2026, 0, 1);
const HOUR_TEXT = /^(\d{4})(\d{2})(\d{2})(\d{2})$/;
const TITLE = "org.opencontainers.image.title";

export interface Hour {
  // YYYY-MM-DDTHH:00:00Z, and the start of the next hour.
  readonly start: string;
  readonly end: string;
  // Seconds since 2026-01-01T00:00:00Z: the window [t0, t1) of the pack.
  readonly t0: number;
  readonly t1: number;
  // The tag of its feed pack (tierTag), feed-h-YYYYMMDDHH.
  readonly tag: string;
}

// The hour of `text`, YYYYMMDDHH, an hour that exists, from 2026-01-01T00:00:00Z.
export function hourOf(text: string): Hour {
  const m = typeof text === "string" ? HOUR_TEXT.exec(text) : null;
  const ms = m === null ? Number.NaN : Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]));
  if (m === null || Number.isNaN(ms) || isoOf(ms) !== `${m[1]}-${m[2]}-${m[3]}T${m[4]}:00:00Z`)
    throw new CompactError("usage", `the hour ${JSON.stringify(text)} is not YYYYMMDDHH of an hour that exists`);
  if (ms < EPOCH_MS) throw new CompactError("usage", `the hour ${text} is before 2026-01-01T00:00:00Z, the epoch of every stored time`);
  const start = isoOf(ms);
  return { start, end: isoOf(ms + HOUR_MS), t0: (ms - EPOCH_MS) / 1000, t1: (ms + HOUR_MS - EPOCH_MS) / 1000, tag: tierTag("feed", "h", start) };
}

// One segment as the job holds it: its tag, its manifest as the registry
// answered it (digest and parsed JSON), and the bytes of its layer idx.
export interface SegmentInput {
  readonly tag: string;
  readonly digest: string;
  readonly json: ManifestFacts["json"];
  readonly idx: Uint8Array;
}

export interface Skipped {
  readonly tag: string;
  readonly why: string;
}

export interface HourMissing {
  readonly source: string;
  readonly start: string;
  readonly end: string;
}

export interface HourPlan {
  readonly verdict: "ready" | "wait" | "skip";
  readonly hour: Hour;
  readonly reason: string;
  // The segments the pack reads, by span start then tag, read through
  // packFromManifest of @domains/root, as the promotion reads them.
  readonly inputs: readonly PackEntry[];
  readonly skipped: readonly Skipped[];
  readonly missing: readonly HourMissing[];
  // The sources of the inputs, sorted, and the PSL hashes they were built under.
  readonly sources: readonly string[];
  readonly psl: readonly string[];
  // The records of the inputs, summed.
  readonly records: number;
}

interface Interval {
  readonly a: number;
  readonly b: number;
}

const headFacts = (bytes: Uint8Array) => {
  const head = parseHead(bytes, bytes.length);
  return { dataset: head.header.dataset, records: head.header.records, keyMin: head.keyMin, keyMax: head.keyMax, parts: head.parts.map((p) => p.bytes) };
};

// The precision of each source id of the registry rows (config/sources.json).
function precisionById(registry: readonly SourceRowLike[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const row of registry) if (row.bit !== null) out.set(row.id, row.precision);
  return out;
}

// The segments of the hour: which the pack reads, which it leaves and why,
// and whether each source it reads covers the hour.
export function planHour(segments: readonly SegmentInput[], hour: Hour, registry: readonly SourceRowLike[]): HourPlan {
  const H: Interval = { a: msOf(hour.start, "the hour"), b: msOf(hour.end, "the hour's end") };
  const precision = precisionById(registry);
  const inputs: PackEntry[] = [];
  const skipped: Skipped[] = [];
  const seen = new Set<string>();
  for (const s of segments) {
    if (seen.has(s.tag)) throw new CompactError("plan", `the segment ${s.tag} is given twice`);
    seen.add(s.tag);
    const a = s.json.annotations ?? {};
    // packFromManifest refuses a quarantined manifest: ruling 23 leaves it
    // out of every new window, so it is left here first, with its reason.
    if (Object.hasOwn(a, QUARANTINE_ANNOTATION)) {
      skipped.push({ tag: s.tag, why: "quarantined: its names are served and never as new (ruling 23)" });
      continue;
    }
    const idxLayer = (s.json.layers ?? []).find((l) => l.annotations?.[TITLE] === IDX_TITLE);
    const got = `sha256:${sha256Hex(s.idx)}`;
    if (idxLayer === undefined || idxLayer.digest !== got || idxLayer.size !== s.idx.length)
      throw new CompactError(
        "plan",
        `the idx given for ${s.tag} is ${s.idx.length} B hashing to ${got}; its manifest names ${idxLayer === undefined ? "no idx layer" : `${idxLayer.size} B, ${idxLayer.digest}`}`,
      );
    let entry: PackEntry;
    let dataset: string;
    try {
      const read = packFromManifest({ repo: repoOf("obs"), tag: s.tag, digest: s.digest, json: s.json, head: headFacts(s.idx) });
      entry = read.pack;
      dataset = read.dataset;
    } catch (e) {
      if (e instanceof RootError) throw new CompactError("plan", e.message);
      throw e;
    }
    if (entry.tier !== "seg") throw new CompactError("plan", `${s.tag} is a pack of tier ${entry.tier}, not a segment`);
    const span = { a: msOf(entry.span.start, `${s.tag} span.start`), b: msOf(entry.span.end, `${s.tag} span.end`) };
    if (span.b <= H.a || span.a >= H.b) throw new CompactError("plan", `the segment ${s.tag} (${entry.span.start} to ${entry.span.end}) lies outside the hour ${hour.start} to ${hour.end}`);
    if (span.a < H.a || span.b > H.b)
      throw new CompactError("straddle", `the segment ${s.tag} (${entry.span.start} to ${entry.span.end}) crosses an edge of the hour ${hour.start} to ${hour.end}: no hour pack can take it`);
    if (entry.sources.length !== 1) throw new CompactError("plan", `the segment ${s.tag} names the sources ${entry.sources.join(", ")}; a segment is of one source`);
    const source = entry.sources[0];
    if (dataset === "names") {
      skipped.push({ tag: s.tag, why: "a names segment: the feed of the hour reads domain records, which a names source gives in a domains segment of its own" });
      continue;
    }
    // A segment of feed, new-name or rev holds no domain records, and the
    // merge of the hour reads domain records alone.
    if (dataset !== "domains") throw new CompactError("plan", `the segment ${s.tag} is of the dataset ${dataset}; the hour reads names and domains segments`);
    const p = precision.get(source);
    if (p === undefined) throw new CompactError("plan", `the source ${source} of ${s.tag} has no row with a bit in the registry`);
    const annotated = a[VERIFY_ANNOTATIONS.precision];
    if (annotated !== p) throw new CompactError("plan", `the segment ${s.tag} says precision ${JSON.stringify(annotated ?? null)}; the registry gives ${source} the precision ${p}`);
    if (p === "day") {
      skipped.push({ tag: s.tag, why: `the source ${source} is of day precision: its rows enter the feed through the day pack` });
      continue;
    }
    inputs.push(entry);
  }
  inputs.sort((x, y) => (x.span.start < y.span.start ? -1 : x.span.start > y.span.start ? 1 : x.tag < y.tag ? -1 : x.tag > y.tag ? 1 : 0));

  const missing: HourMissing[] = [];
  const sources = [...new Set(inputs.map((p) => p.sources[0]))].sort();
  for (const source of sources) {
    const spans = inputs.filter((p) => p.sources[0] === source).map((p) => ({ tag: p.tag, a: msOf(p.span.start, p.tag), b: msOf(p.span.end, p.tag) }));
    let at = H.a;
    for (const [i, s] of spans.entries()) {
      if (i > 0 && s.a < spans[i - 1].b) throw new CompactError("plan", `the segments ${spans[i - 1].tag} and ${s.tag} of the source ${source} overlap`);
      if (s.a > at) missing.push({ source, start: isoOf(at), end: isoOf(s.a) });
      at = Math.max(at, s.b);
    }
    if (at < H.b) missing.push({ source, start: isoOf(at), end: hour.end });
  }
  const psl = [...new Set(inputs.map((p) => p.psl))].sort();
  const records = inputs.reduce((n, p) => n + p.count, 0);
  const base = { hour, inputs, skipped, missing, sources, psl, records };
  if (missing.length > 0) return { ...base, verdict: "wait", reason: `the hour is not whole: ${missing.map((m) => `${m.source} ${m.start} to ${m.end}`).join("; ")}` };
  if (inputs.length === 0) return { ...base, verdict: "skip", reason: "no segment of the hour gives domain records of a second-precision source: no pack is written" };
  return { ...base, verdict: "ready", reason: `${inputs.length} segment(s) of ${sources.length} source(s) cover the hour` };
}

// The provisional membership of the hour: the filter `ledger-filter-DATE`
// and its delta `ledger-delta`, decoded and checked (docs/format.md section
// 15), the filter no newer than the hour's start.
export function membershipOf(filterBytes: Uint8Array, deltaBytes: Uint8Array, hour: Hour): ProvisionalFilter {
  const filter = BloomFilter.decode(filterBytes);
  if (filter.asOf > hour.t0)
    throw new CompactError(
      "plan",
      `the filter holds the domains table through ${isoOf(EPOCH_MS + filter.asOf * 1000)}, after the hour starts at ${hour.start}: it holds the hour's own domains and judges them old`,
    );
  // ProvisionalFilter refuses a delta built against another filter (LedgerError pair).
  return new ProvisionalFilter(filter, HashDelta.decode(deltaBytes));
}

export interface HourOptions {
  readonly registry: readonly SourceRowLike[];
  readonly hour: Hour;
  readonly compress: Compress;
  readonly sink: PackSink;
  // The time copy of the hour pack (docs/format.md section 14): the rows of
  // an hour are few, and a page of the hour then reads its time copy.
  readonly time?: { readonly sink: PackSink };
  readonly recordsPerBlock?: number;
  readonly pageEntries?: number;
}

export interface BuiltHour extends FeedPack {
  // The domain records of the segments, merged by key.
  readonly domains: number;
  // The rows written: the domains the membership did not hold.
  readonly rows: number;
  // The hashes the delta held before and after.
  readonly deltaBefore: number;
  readonly deltaAfter: number;
}

// The rows of the hour pack, from the planned segments' readers: their domain
// records merged by key, each asked of the membership and added to it
// (buildFeedHour of @domains/feed), written with writeFeedPack.
export async function buildHour(readers: readonly PackReader<DomainRecord>[], membership: ProvisionalFilter, options: HourOptions): Promise<BuiltHour> {
  for (const [i, r] of readers.entries()) {
    if (r.index.header.dataset !== DATASET_DOMAINS) throw new CompactError("usage", `buildHour: segment ${i} is dataset ${r.index.header.dataset}, not ${DATASET_DOMAINS} (domains)`);
  }
  const table = sourceTable(options.registry);
  const deltaBefore = membership.delta.size;
  let domains = 0;
  let rows = 0;
  async function* records(): AsyncGenerator<DomainRecord> {
    for await (const r of mergePacks(readers, DOMAINS_CODEC)) {
      domains += 1;
      yield r;
    }
  }
  async function* counted() {
    for await (const row of buildFeedHour(records(), membership, { table, window: { t0: options.hour.t0, t1: options.hour.t1 } })) {
      rows += 1;
      yield row;
    }
  }
  const pack = await writeFeedPack(counted(), {
    codec: FEED_CODEC,
    compress: options.compress,
    sink: options.sink,
    recordsPerBlock: options.recordsPerBlock,
    pageEntries: options.pageEntries,
    ...(options.time === undefined ? {} : { time: { sink: options.time.sink, recordsPerBlock: options.recordsPerBlock, pageEntries: options.pageEntries } }),
  });
  return { ...pack, domains, rows, deltaBefore, deltaAfter: membership.delta.size };
}
