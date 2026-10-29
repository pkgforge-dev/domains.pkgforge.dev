// packages/feed/test/helpers.ts — what the tests of packages/feed share: a
// seeded generator, a source table, the payload shapes of the entry's Premise
// turned into domain events, and feed packs written to memory with the
// production compressor (node:zlib at level 9, @domains/pack/node).
//
// The source table holds the bits, families, precisions and kinds that
// docs/sources.md gives for the sources these tests use (READ, the table "Sources
// with a bit"); config/sources.json holds no row yet. The OpenINTEL payloads are
// recorded: `recorded(topic, offset)` reads them from design A's broker answers,
// docs/research/2026-10-27-design-a/kafka/offsets.json, by topic and offset.
// Every other domain name and time made here is synthetic. A failure names its
// seed, and the same seed makes the same rows.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { key } from "@domains/names";
import { DOMAINS_CODEC, type Evidence, FEED_CODEC, FEED_TIME_CODEC, type FeedRecord, MemorySink, PackReader, type PackSummary, partsSource, type Seen } from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import { type DomainEvent, type LivePack, type OpenedPack, type SourceTable, sourceTable, writeFeedPack } from "../src/index.ts";

export const DAY = 86_400;
export const HOUR = 3600;
// 2026-01-01T00:00:00Z in Unix seconds: the epoch of every stored time.
export const EPOCH_UNIX = Date.UTC(2026, 0, 1) / 1000;
// Day 298 is 2026-10-26.
export const D = 298;

export const SOURCE_ROWS = [
  { id: "thc-ct", bit: 0, family: "ct", precision: "day", kind: "ct_name" },
  { id: "oi-nrd", bit: 1, family: "ct", precision: "second", kind: "claimed_new" },
  { id: "oi-nrd-confirmed", bit: 3, family: "registry+ct", precision: "second", kind: "registered_claim" },
  { id: "ct-le", bit: 5, family: "ct", precision: "second", kind: "ct_name" },
  { id: "isc-new", bit: 8, family: "isc", precision: "day", kind: "claimed_new" },
  { id: "whoisds", bit: 9, family: "whoisds", precision: "day", kind: "claimed_new" },
  { id: "hagezi-nrd", bit: 11, family: "stamus", precision: "day", kind: "claimed_new" },
  { id: "oi-zone", bit: 12, family: "registry", precision: "day", kind: "zone_add" },
  { id: "rdap", bit: 16, family: "registry", precision: "second", kind: "registered_claim" },
] as const;

export const BIT = Object.freeze({ thc: 0, oiNrd: 1, oiConfirmed: 3, ctLe: 5, isc: 8, whoisds: 9, hagezi: 11, oiZone: 12, rdap: 16 });

export const table: SourceTable = sourceTable(SOURCE_ROWS);

// mulberry32: a small seeded generator.
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Seconds since the epoch of an ISO 8601 UTC time, and back.
export const at = (iso: string): number => (Date.parse(iso) - Date.UTC(2026, 0, 1)) / 1000;
export const iso = (t: number): string => new Date(Date.UTC(2026, 0, 1) + t * 1000).toISOString().replace(".000Z", "Z");
const dayIndex = (date: string): number => at(`${date}T00:00:00Z`) / DAY;

const keyOfDomain = (domain: string): string => key(domain.endsWith(".") ? domain.slice(0, -1) : domain);

// ---- the payload shapes of the Premise

export interface OiNrdPayload {
  readonly domain: string;
  readonly cert_index: number;
  readonly ct_name: string;
  readonly timestamp: number;
  readonly submission_timestamp: number;
}

// The repository root: the first directory above this file that holds
// AGENTS.md, so a copy of this package under .tmp/ reads the same files.
export const ROOT = (() => {
  let at = import.meta.dirname;
  while (!existsSync(join(at, "AGENTS.md"))) {
    const up = dirname(at);
    if (up === at) throw new Error("no AGENTS.md above packages/feed/test");
    at = up;
  }
  return at;
})();
export const OFFSETS_PATH = join(ROOT, "docs", "research", "2026-10-27-design-a", "kafka", "offsets.json");

// One message of design A's recorded broker answers, parsed.
export function recorded<T>(topic: string, offset: number): T {
  const file = JSON.parse(readFileSync(OFFSETS_PATH, "utf8")) as { res: Record<string, { sample: { off: number; v: string }[] }> };
  const message = file.res[topic]?.sample.find((m) => m.off === offset);
  if (message === undefined) throw new Error(`${OFFSETS_PATH} holds no message ${offset} of ${topic}`);
  return JSON.parse(message.v) as T;
}

// newly_registered_domain at offset 166,475,059: its certificate is 3,514,451 s
// (40.7 days) older than the event. The entry's Premise prints this payload
// with cert_index 167897527; the recorded message holds 1864170391.
export const OLD_CERT_EVENT = recorded<OiNrdPayload>("newly_registered_domain", 166_475_059);
// newly_registered_domain at offset 166,475,060: a certificate 3.863 s old.
export const FRESH_CERT_EVENT = recorded<OiNrdPayload>("newly_registered_domain", 166_475_060);

// An oi-nrd event: sighted at `timestamp`, evidence `nrd-list` (docs/sources.md:
// B nrd-list), and the certificate age `timestamp - submission_timestamp`.
export function oiNrd(p: OiNrdPayload): DomainEvent {
  const first = Math.floor(p.timestamp - EPOCH_UNIX);
  return {
    key: keyOfDomain(p.domain),
    flags: 0,
    sources: [{ bit: BIT.oiNrd, first, last: first }],
    evidence: [{ tier: 2, basis: 2, source: BIT.oiNrd, at: first, confidence: 0 }],
    facts: { certAges: [{ bit: BIT.oiNrd, seconds: p.timestamp - p.submission_timestamp }] },
  };
}

export interface OiConfirmedPayload {
  readonly domain: string;
  readonly cert_index: number;
  readonly ct_name: string;
  readonly timestamp: number;
  readonly confidence: number;
}

// confirmed_newly_registered_domain at offset 80,191,643: level 3.
export const CONFIRMED_EVENT = recorded<OiConfirmedPayload>("confirmed_newly_registered_domain", 80_191_643);

// A confirmed_newly_registered_domain event: evidence `nrd-ct+rdap` with its
// level, or `zone` for a zone row (ct_name "zone_data", cert_index -1).
export function oiConfirmed(p: OiConfirmedPayload): DomainEvent {
  const first = Math.floor(p.timestamp - EPOCH_UNIX);
  const zone = p.ct_name === "zone_data";
  return {
    key: keyOfDomain(p.domain),
    flags: 0,
    sources: [{ bit: BIT.oiConfirmed, first, last: first }],
    evidence: [{ tier: zone ? 1 : 2, basis: zone ? 0 : 3, source: BIT.oiConfirmed, at: first, confidence: zone ? 0 : p.confidence }],
  };
}

export interface IscRow {
  readonly domainname: string;
  readonly ip?: number;
  readonly firstseen: string;
  readonly score: number;
  readonly scorereason: string;
}

// An ISC row: a day source, evidence `nrd-list` on its own date.
export function isc(row: IscRow): DomainEvent {
  const day = dayIndex(row.firstseen);
  return {
    key: keyOfDomain(row.domainname),
    flags: 0,
    sources: [{ bit: BIT.isc, first: day, last: day }],
    evidence: [{ tier: 2, basis: 2, source: BIT.isc, at: day, confidence: 0 }],
  };
}

// A WhoisDS row of the file dated `fileDate`: the adapter dates it D-1
// (docs/architecture.md section 9).
export function whoisds(domain: string, fileDate: string): DomainEvent {
  const day = dayIndex(fileDate) - 1;
  return {
    key: keyOfDomain(domain),
    flags: 0,
    sources: [{ bit: BIT.whoisds, first: day, last: day }],
    evidence: [{ tier: 2, basis: 2, source: BIT.whoisds, at: day, confidence: 0 }],
  };
}

// Two events of one domain as one, by the merge every tier uses.
export function mergeEvents(a: DomainEvent, b: DomainEvent): DomainEvent {
  const merged = DOMAINS_CODEC.merge(a, b);
  return {
    ...merged,
    facts: {
      certAges: [...(a.facts?.certAges ?? []), ...(b.facts?.certAges ?? [])],
      rdapCreated: [...(a.facts?.rdapCreated ?? []), ...(b.facts?.rdapCreated ?? [])],
    },
  };
}

export const seen = (bit: number, first: number, last = first): Seen => ({ bit, first, last });
export const evidence = (basis: number, source: number, atValue: number, confidence = 0): Evidence => ({ tier: [1, 1, 2, 2, 3][basis], basis, source, at: atValue, confidence });

// ---- packs in memory

// A pack in memory: the key copy, and the time copy unless it was written without one.
export interface MemCopy {
  readonly summary: PackSummary;
  readonly parts: Uint8Array<ArrayBuffer>[];
}

export interface MemFeed extends MemCopy {
  readonly time: MemCopy | null;
}

// A feed pack written to memory with the production writer: 64 records a
// block and 4 index entries a page, so a few hundred rows make several blocks
// and pages; the time copy at `timeRecordsPerBlock` (64 by default) unless
// `time` is false.
export async function writeFeed(rows: Iterable<FeedRecord> | AsyncIterable<FeedRecord>, options: { recordsPerBlock?: number; timeRecordsPerBlock?: number; time?: boolean } = {}): Promise<MemFeed> {
  const sink = new MemorySink();
  const timeSink = new MemorySink();
  const pack = await writeFeedPack(rows, {
    compress: nodeCompress,
    sink,
    recordsPerBlock: options.recordsPerBlock ?? 64,
    pageEntries: 4,
    ...(options.time === false ? {} : { time: { sink: timeSink, recordsPerBlock: options.timeRecordsPerBlock ?? 64, pageEntries: 4 } }),
  });
  return { summary: pack.summary, parts: sink.parts(), time: pack.time === null ? null : { summary: pack.time, parts: timeSink.parts() } };
}

export const digestOf = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// The live set's entry of a pack in memory: its time copy listed as root.json
// lists it, by the digests and sizes of its layers.
export function livePack(tag: string, tier: string, start: number, end: number, pack: MemFeed): LivePack {
  const time =
    pack.time === null ? null : { idx: { digest: digestOf(pack.time.summary.idx), size: pack.time.summary.idx.length }, parts: pack.time.parts.map((p) => ({ digest: digestOf(p), size: p.length })) };
  return { tag, tier, span: { start: iso(start), end: iso(end) }, key_min: pack.summary.keyMin, key_max: pack.summary.keyMax, time };
}

// An open() for readFeed over packs held in memory, by tag: both copies, each
// held to the part sizes the live set gives, with no page cache.
export function memoryOpen(packs: ReadonlyMap<string, MemFeed>): (pack: LivePack) => Promise<OpenedPack> {
  return async (pack) => {
    const mem = packs.get(pack.tag);
    if (mem === undefined) throw new Error(`no pack ${pack.tag} in memory`);
    const reader = await PackReader.open(mem.summary.idx, partsSource(mem.parts), FEED_CODEC, { pageCache: 0 });
    const timeRef = pack.time ?? null;
    if (timeRef === null || mem.time === null) return { reader, time: null };
    const time = await PackReader.open(mem.time.summary.idx, partsSource(mem.time.parts), FEED_TIME_CODEC, { pageCache: 0, partSizes: timeRef.parts.map((p) => p.size) });
    return { reader, time };
  };
}

export async function collect<T>(items: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
}

// A feed row with the defaults of a second-precision oi-nrd row.
export function row(k: string, firstSeen: number, fields: Partial<FeedRecord> = {}): FeedRecord {
  return { key: k, flags: 0, firstSeen, sources: [BIT.oiNrd], basis: 4, confidence: 0, feedFlags: 0, ...fields };
}
