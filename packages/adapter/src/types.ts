// packages/adapter/src/types.ts — the shapes every adapter shares: a source's
// registry row (`source.json`), the segment it writes, its cursor, and the
// module contract `run(cursor, ctx)`.
//
// docs/architecture.md section 3.5 names the registry fields and section 5.6 the
// adapter contract. The value lists below are the ones the code accepts; the
// docs test (test/docs.test.ts) holds every label of docs/sources.md to them.
//
// A source's `fetched`, `status` and `through` (section 3.5) are not fields of
// `source.json`: `through` is written by the promotion job, `status` is derived
// by the Worker at read time, and `fetched` is the time of one fetch. A file
// that carries one is refused (RUNTIME_FIELDS).

// The persisted formats, each named in its own `format` field.
export const SOURCE_FORMAT = "domains.source.v1";
export const REGISTRY_FORMAT = "domains.sources.v1";
export const BITS_FORMAT = "domains.source-bits.v1";

// The eight families of docs/architecture.md section 2; the docs test holds
// the labels of docs/sources.md to them.
export const FAMILIES = Object.freeze(["ct", "registry+ct", "isc", "whoisds", "stamus", "registry", "nsec-walk", "dns"] as const);
export type Family = (typeof FAMILIES)[number];

// The datasets of docs/architecture.md section 3.3. Every one but `rev` stores a
// source mask, so a source that feeds one needs a bit.
export const DATASETS = Object.freeze(["names", "domains", "feed", "new-name", "rev"] as const);
export type Dataset = (typeof DATASETS)[number];
export const MASKED_DATASETS: readonly Dataset[] = Object.freeze(["names", "domains", "feed", "new-name"]);

export const PRECISIONS = Object.freeze(["second", "day"] as const);
export type Precision = (typeof PRECISIONS)[number];

// docs/architecture.md section 3.5.
export const KINDS = Object.freeze(["ct_name", "claimed_new", "registered_claim", "zone_add", "list", "dns"] as const);
export type Kind = (typeof KINDS)[number];

// The five evidence bases of docs/architecture.md section 3.3, in the order of
// their DPK1 ids (BASIS of packages/pack/src/codec.ts; test/basis.test.ts
// holds the two equal). A source lists the bases it writes, and a source that
// writes no newness evidence (`oi-measure`) lists none (section 3.5).
export const BASES = Object.freeze(["zone", "rdap", "nrd-list", "nrd-ct+rdap", "ct-first"] as const);
export type Basis = (typeof BASES)[number];

// What a band measures: the records of a segment, or the bytes of the raw file.
export const METRICS = Object.freeze(["count", "bytes"] as const);
export type Metric = (typeof METRICS)[number];

// The expected volume of one day (docs/architecture.md section 5.8). Relative:
// min and max are fractions of the median of recent accepted days (0.4 and 2.5
// for THC). Absolute: min and max are the metric's own numbers.
export interface Band {
  readonly metric: Metric;
  readonly min: number;
  readonly max: number;
  readonly relative: boolean;
}

// One source, as `source.json` and `config/sources.json` hold it.
export interface Source {
  readonly id: string;
  // 0 to 63, equal to the source's entry of config/source-bits.json. null only
  // for a source that feeds no masked dataset (`thc-rdns` feeds `rev` alone).
  readonly bit: number | null;
  readonly family: Family;
  readonly datasets: readonly Dataset[];
  readonly precision: Precision;
  readonly kind: Kind;
  // Empty for a source that writes no newness evidence.
  readonly basis: readonly Basis[];
  // How often the source runs: an ISO 8601 duration of days, hours, minutes
  // and seconds (`PT10M`, `P1D`).
  readonly cadence: string;
  readonly band: Band;
  // The publisher URLs: https, http, wss or kafka, with no credential.
  readonly urls: readonly string[];
  // How long the publisher keeps what it published: an ISO 8601 duration,
  // `unbounded`, or `unknown` until a measurement says.
  readonly retention: string;
  // The parser and its version, `NAME/N`. A new version marks segments whose
  // records a re-read of the kept raw bytes would change.
  readonly parser: string;
  readonly failure_modes: readonly string[];
}

// `adapters/<dir>/source.json`: one adapter directory may hold several sources
// (the three OpenINTEL NRD topics, the three names-tile operators).
export interface SourceFile {
  readonly format: typeof SOURCE_FORMAT;
  readonly sources: readonly Source[];
}

// A row of `config/sources.json`: the source and the adapter directory it came from.
export interface RegistryRow extends Source {
  readonly adapter: string;
}

// `config/sources.json`, sorted by bit, then the sources with no bit by id.
export interface Registry {
  readonly format: typeof REGISTRY_FORMAT;
  readonly comment: string;
  readonly sources: readonly RegistryRow[];
}

// `config/source-bits.json`: the append-only map from id to bit.
export type SourceBits = Readonly<Record<string, number>>;

export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

// An adapter's cursor: opaque JSON of at most MAX_CURSOR_BYTES (validate.ts).
export type Cursor = Json;

// A window of observations: ISO 8601 UTC times, start before end. A `day`
// source's window starts and ends at 00:00:00Z.
export interface Window {
  readonly start: string;
  readonly end: string;
}

// The raw bytes a segment was derived from, as fetched.
export interface RawRef {
  readonly bytes: number;
  readonly sha256: string;
}

// One segment: what an adapter wrote for one source, one dataset and one window.
// Its identity is (source, window, cursorBefore, cursorAfter) (docs/architecture.md
// section 5.4). `bytes` and `sha256` are the writer's: the stored size, and the
// SHA-256 of the decoded record stream.
export interface Segment {
  readonly source: string;
  readonly dataset: Dataset;
  readonly window: Window;
  readonly cursorBefore: Cursor;
  readonly cursorAfter: Cursor;
  readonly count: number;
  readonly precision: Precision;
  readonly bytes: number;
  readonly sha256: string;
  readonly raw?: RawRef;
}

// What an adapter hands its writer for one segment; the writer adds count,
// bytes, sha256 and raw.
export interface SegmentDraft {
  readonly source: string;
  readonly dataset: Dataset;
  readonly window: Window;
  readonly cursorBefore: Cursor;
  readonly cursorAfter: Cursor;
  readonly precision: Precision;
}

// One record of a segment. Every dataset sorts by `key` (docs/architecture.md
// section 3.2); the other fields are the dataset codec's (DOM-017).
export interface SegmentRecord {
  readonly key: string;
  readonly [field: string]: Json;
}

export type RawInput = Uint8Array | AsyncIterable<Uint8Array>;

// The one way an adapter stores a segment. Records arrive in strictly increasing
// key order, one per key. DOM-017's pack writer and DOM-019's push tool supply
// the real writer; writer.ts holds the in-memory one the harness uses.
export interface SegmentWriter {
  write(draft: SegmentDraft, records: Iterable<SegmentRecord> | AsyncIterable<SegmentRecord>, raw?: RawInput): Promise<Segment>;
}

// The fetch an adapter is given. Production passes the global fetch; the
// harness passes a replay of recorded answers.
export type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface AdapterContext {
  readonly fetch: Fetch;
  // The time of the run, ISO 8601 UTC. An adapter reads no clock of its own, so
  // two runs with the same inputs write the same segments.
  readonly now: string;
  // Sent on every request (TODO/RULES.md section 5, ruling 11).
  readonly userAgent: string;
  readonly writer: SegmentWriter;
}

// A fault of one source in one run. A failed adapter fails alone.
export interface AdapterFault {
  readonly source: string;
  readonly code: string;
  readonly detail: string;
}

export interface RunResult {
  readonly segments: readonly Segment[];
  readonly cursor: Cursor;
  readonly stats: Readonly<Record<string, number>>;
  readonly errors: readonly AdapterFault[];
}

export interface AdapterModule {
  run(cursor: Cursor, ctx: AdapterContext): Promise<RunResult>;
}
