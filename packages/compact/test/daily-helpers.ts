// Synthetic segments, hour packs and day packs for the tests of the hourly
// and daily jobs: packages/compact/src/hour.ts and daily.ts, and
// scripts/compact/hour.mjs and day.mjs. Every key, time and record here is
// made up for the test. The source rows copy the bits, families, kinds and
// precisions of docs/sources.md (READ, the table "Sources with a bit"). PSL is
// the sha256 of packages/names/test/fixtures/psl-2026-10-27.dat, the list
// scripts/verify-pack.mjs reads by default (MEASURED 2026-10-29T22:06Z,
// `sha256sum packages/names/test/fixtures/psl-2026-10-27.dat`).
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type SourceRowLike, writeFeedPack } from "@domains/feed";
import { artifactType, repoOf, SOURCE_URL, segTag, type TierDataset, tierTag } from "@domains/ghcr";
import {
  type DatasetCodec,
  DOMAINS_CODEC,
  type DomainRecord,
  FEED_CODEC,
  type FeedRecord,
  IDX_TITLE,
  MemorySink,
  NAMES_CODEC,
  type NameRecord,
  PackReader,
  type PackSummary,
  packAnnotations,
  parseHead,
  partsSource,
  partTitle,
  TIME_IDX_TITLE,
  timePartTitle,
  VERIFY_ANNOTATIONS,
  writePack,
} from "@domains/pack";
import { nodeCompress, writerId } from "@domains/pack/node";
import { type PackEntry, packFromManifest, QUARANTINE_ANNOTATION, TIER_ANNOTATION } from "@domains/root";
import { CREATED_ANNOTATION, EMPTY_CONFIG, type ExtraLayer, LAYER_MEDIA_TYPE, MANIFEST_MEDIA_TYPE, packManifest, RUN_ANNOTATION, SOURCE_ANNOTATION } from "../src/index.ts";

export const PSL = "0232f4df0831911356e8ee1f4d5c3b6b12c0ed3f6bd66b0f81c8ab5d3d49e9ca";
export const EPOCH_MS = Date.UTC(2026, 0, 1);
export const DAY = 86_400;
export const HOUR = 3600;

export const REGISTRY: SourceRowLike[] = [
  { id: "thc-ct", bit: 0, family: "ct", precision: "day", kind: "ct_name" },
  { id: "oi-nrd", bit: 1, family: "ct", precision: "second", kind: "claimed_new" },
  { id: "oi-nrd-confirmed", bit: 3, family: "registry+ct", precision: "second", kind: "registered_claim" },
  { id: "ct-le", bit: 5, family: "ct", precision: "second", kind: "ct_name" },
  { id: "isc-new", bit: 8, family: "isc", precision: "day", kind: "claimed_new" },
];
export const BIT: Readonly<Record<string, number>> = Object.freeze(Object.fromEntries(REGISTRY.map((r) => [r.id, r.bit as number])));
const precisionOf = (id: string): string => (REGISTRY.find((r) => r.id === id) as SourceRowLike).precision;

// Seconds since 2026-01-01T00:00:00Z of an ISO time, and the day index of a date.
export const secs = (iso: string): number => (Date.parse(iso) - EPOCH_MS) / 1000;
export const dayNo = (date: string): number => secs(`${date}T00:00:00Z`) / DAY;

const sha = (bytes: Uint8Array | string): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const TITLE = "org.opencontainers.image.title";

// A domain record of one source: `first` in the unit of the source (a day
// index for a day source, seconds for a second source).
export const domain = (key: string, source: string, first: number, last = first): DomainRecord => ({ key, flags: 0, sources: [{ bit: BIT[source], first, last }], evidence: [] });
export const name = (key: string, source: string, first: number): NameRecord => ({ key, flags: 1, sources: [{ bit: BIT[source], first, last: first }] });

export interface MemManifest {
  readonly tag: string;
  readonly digest: string;
  readonly text: string;
  readonly json: Record<string, unknown> & {
    readonly annotations: Record<string, string>;
    readonly layers: { mediaType: string; digest: string; size: number; annotations: Record<string, string> }[];
  };
}

// A pack or a segment in memory: its manifest, its layers and a reader.
export interface MemPack<R> extends MemManifest {
  readonly summary: PackSummary;
  readonly idx: Uint8Array;
  readonly parts: Uint8Array[];
  readonly time: { readonly idx: Uint8Array; readonly parts: Uint8Array[] } | null;
  readonly reader: PackReader<R>;
  readonly dataset: TierDataset;
}

const layer = (bytes: Uint8Array, title: string) => ({ mediaType: LAYER_MEDIA_TYPE, digest: sha(bytes), size: bytes.length, annotations: { [TITLE]: title } });

export interface SegmentOptions {
  readonly dataset?: "domains" | "names";
  readonly quarantine?: boolean;
  readonly psl?: string;
  // The precision the manifest states; the registry's by default.
  readonly precision?: string;
  readonly recordsPerBlock?: number;
}

// A segment of `source` over [start, end): its records written with the
// production writer, its manifest as an adapter's would be (docs/architecture.md
// sections 3.4 and 4.2): artifact type segment, tier seg, one source and its
// precision.
export async function segment(source: string, start: string, end: string, records: readonly (DomainRecord | NameRecord)[], o: SegmentOptions = {}): Promise<MemPack<DomainRecord>> {
  const dataset = o.dataset ?? "domains";
  const codec = (dataset === "names" ? NAMES_CODEC : DOMAINS_CODEC) as DatasetCodec<DomainRecord | NameRecord>;
  const sink = new MemorySink();
  const summary = await writePack(
    [...records].sort((a, b) => (a.key < b.key ? -1 : 1)),
    { codec, compress: nodeCompress, sink, recordsPerBlock: o.recordsPerBlock ?? 4, pageEntries: 2 },
  );
  const parts = sink.parts();
  const A = VERIFY_ANNOTATIONS;
  const annotations: Record<string, string> = {
    ...packAnnotations(summary, writerId()),
    [TIER_ANNOTATION]: "seg",
    [A.spanStart]: start,
    [A.spanEnd]: end,
    [A.psl]: o.psl ?? PSL,
    [A.source]: source,
    [A.precision]: o.precision ?? precisionOf(source),
    [RUN_ANNOTATION]: "1",
    [CREATED_ANNOTATION]: end,
    [SOURCE_ANNOTATION]: SOURCE_URL,
    ...(o.quarantine === true ? { [QUARANTINE_ANNOTATION]: "1" } : {}),
  };
  const json = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    artifactType: artifactType("segment"),
    config: { ...EMPTY_CONFIG },
    layers: [...parts.map((p, i) => layer(p, partTitle(i))), layer(summary.idx, IDX_TITLE)],
    annotations,
  };
  const text = JSON.stringify(json);
  const reader = (await PackReader.open(summary.idx, partsSource(parts), codec, { partSizes: parts.map((p) => p.length) })) as PackReader<DomainRecord>;
  return { tag: segTag(source, start, end), digest: sha(text), text, json, summary, idx: summary.idx, parts, time: null, reader, dataset };
}

export interface TierOptions {
  readonly sources: readonly string[];
  readonly psl?: string;
  readonly recordsPerBlock?: number;
  // Layers after the pack's own (packManifest's extra), such as summary.json.
  readonly extra?: readonly ExtraLayer[];
}

// A compacted pack of `dataset` (domains, or feed with its time copy) of tier
// d or h from `start`, its manifest by packManifest of packages/compact.
export async function tierPack(
  dataset: "domains" | "feed",
  tier: "d" | "h",
  start: string,
  records: readonly (DomainRecord | FeedRecord)[],
  o: TierOptions,
): Promise<MemPack<DomainRecord | FeedRecord>> {
  const end = new Date(Date.parse(start) + (tier === "d" ? DAY : HOUR) * 1000).toISOString().replace(".000Z", "Z");
  const sink = new MemorySink();
  const rpb = o.recordsPerBlock ?? 4;
  let summary: PackSummary;
  let time: { idx: Uint8Array; parts: Uint8Array[] } | null = null;
  let codec: DatasetCodec<DomainRecord | FeedRecord>;
  if (dataset === "domains") {
    codec = DOMAINS_CODEC as DatasetCodec<DomainRecord | FeedRecord>;
    summary = await writePack(records as DomainRecord[], { codec: DOMAINS_CODEC, compress: nodeCompress, sink, recordsPerBlock: rpb, pageEntries: 2 });
  } else {
    codec = FEED_CODEC as DatasetCodec<DomainRecord | FeedRecord>;
    const timeSink = new MemorySink();
    const pack = await writeFeedPack(records as FeedRecord[], {
      codec: FEED_CODEC,
      compress: nodeCompress,
      sink,
      recordsPerBlock: rpb,
      pageEntries: 2,
      time: { sink: timeSink, recordsPerBlock: rpb, pageEntries: 2 },
    });
    summary = pack.summary;
    time = { idx: (pack.time as PackSummary).idx, parts: timeSink.parts() };
  }
  const parts = sink.parts();
  const sources = [...o.sources].sort();
  const tag = tierTag(dataset, tier, start);
  const built = packManifest({
    dataset,
    tier,
    span: { start, end },
    tag,
    sources,
    ...(sources.length === 1 ? { precision: precisionOf(sources[0]) as "day" | "second" } : {}),
    psl: o.psl ?? PSL,
    run: "1",
    summary,
    writer: writerId(),
    parts: parts.map((p) => ({ digest: sha(p), size: p.length })),
    idx: { digest: sha(summary.idx), size: summary.idx.length },
    time: time === null ? null : { idxBytes: time.idx, parts: time.parts.map((p) => ({ digest: sha(p), size: p.length })), idx: { digest: sha(time.idx), size: time.idx.length } },
    ...(o.extra === undefined ? {} : { extra: o.extra }),
  });
  const reader = await PackReader.open(summary.idx, partsSource(parts), codec, { partSizes: parts.map((p) => p.length) });
  return { tag, digest: built.digest, text: built.text, json: built.json as MemManifest["json"], summary, idx: summary.idx, parts, time, reader, dataset };
}

const headFacts = (bytes: Uint8Array) => {
  const h = parseHead(bytes, bytes.length);
  return { dataset: h.header.dataset, records: h.header.records, keyMin: h.keyMin, keyMax: h.keyMax, parts: h.parts.map((p) => p.bytes) };
};

// The root entry of a pack in memory, read as the promotion reads it.
export function entryOf(p: MemPack<unknown>): { dataset: TierDataset; pack: PackEntry } {
  const repo = p.json.artifactType === artifactType("segment") ? repoOf("obs") : repoOf(p.dataset === "feed" ? "feed" : "names");
  return packFromManifest({ repo, tag: p.tag, digest: p.digest, json: p.json, head: headFacts(p.idx), timeHead: p.time === null ? null : headFacts(p.time.idx) });
}

// The pack's layers in DIR/<tag>/, as `oras pull` names them, and its
// manifest as manifest.json, as `oras manifest fetch` prints it.
export function writeDir(dir: string, p: MemPack<unknown>): string {
  const at = join(dir, p.tag);
  mkdirSync(at, { recursive: true });
  writeFileSync(join(at, "manifest.json"), p.text);
  writeFileSync(join(at, IDX_TITLE), p.idx);
  for (const [i, part] of p.parts.entries()) writeFileSync(join(at, partTitle(i)), part);
  if (p.time !== null) {
    writeFileSync(join(at, TIME_IDX_TITLE), p.time.idx);
    for (const [i, part] of p.time.parts.entries()) writeFileSync(join(at, timePartTitle(i)), part);
  }
  return at;
}

// Every blob of a pack by digest, for a GHCR double.
export function blobsOf(p: MemPack<unknown>): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const b of [p.idx, ...p.parts, ...(p.time === null ? [] : [p.time.idx, ...p.time.parts])]) out.set(sha(b), b);
  return out;
}

export async function collect<R>(records: AsyncIterable<R>): Promise<R[]> {
  const out: R[] = [];
  for await (const r of records) out.push(r);
  return out;
}
