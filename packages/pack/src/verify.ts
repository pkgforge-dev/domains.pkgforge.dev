// packages/pack/src/verify.ts — the verifier of a pack (DOM-018,
// docs/architecture.md section 5.8). A pack counts only after it passes: a
// segment before it is pushed, a tier before the root names it.
//
//   const result = await verifyPack(idxBytes, parts, expectFromAnnotations(annotations), { psl, registry, volume, require });
//   result.ok          true when no check failed and no check of `require` skipped
//   result.verdict     ok, fail, unverified, hold or quarantine
//   result.errors      [{ check, detail }], in the order of CHECKS
//   result.checks      every check, with pass, fail or skip and why
//   result.unverified  the checks that skipped, in the order of CHECKS
//
// `expect` is what the pack's annotations state; `parts` reads the parts by
// range and gives the bytes each part holds as stored. The checks, in order:
//   idx        the index parses whole: the head, every page, the tiling (readIdx)
//   dataset    the index's dataset is the annotation's, and is one of 1, 2, 3
//              and 5, whose keys are reversed names
//   length     each part holds the bytes the index's parts table gives it, so
//              every block lies inside its part (readIdx tiles the blocks over
//              the table); the parts and the index make the `bytes` annotation
//   header     each part's 16-byte header names the index's dataset, records a
//              block and codec, and its own number
//   inflate, crc, record, count   every block through PackReader's own
//              readBlock and decodeBlock, the reader the Worker runs: it reads
//              whole, inflates to its raw length, matches its CRC-32, decodes
//              and holds its count; the records then sum to the index's count
//              and to the `count` annotation
//   order, unique   the first key of each block is above the last key of the
//              block before it; decodeBlock holds the order inside a block, where
//              a repeated key cannot be written and fails as `order` or `record`
//   bounds     the head's key bounds are the first and the last key
//   name       every key is a reversed name that normalise (@domains/names) keeps
//              unchanged: [a-z0-9_.-], no empty label, labels of at most 63 bytes,
//              at most 253 bytes, no upper case, not itself a public suffix
//   sha256     the SHA-256 of the raw blocks is the `sha256` annotation
//   refind     1,000 keys drawn with a seeded generator, and the first and the
//              last, are found by PackReader.get over the index read by range
//   psl        the `psl` annotation is the hash of the list the names were checked with
//   sources    every source bit of a record belongs to a source the annotation names
//   precision  each named source has the registry's precision, and every time of
//              a record lies inside the pack's span read in its source's unit
//   volume     the count against the source's own history, by the rule the
//              caller passes (checkBand of @domains/adapter): ok, hold or quarantine
//
// What runs after a failure. A failure of idx, dataset, length or header ends
// the run: nothing after them can trust the bytes. A block that fails inflate,
// crc, record or count is reported and the pass goes on to the next block; the
// checks of the whole pack then do not run: sha256 needs every block read
// whole, and the count sum, bounds, refind and volume need every block
// decoded. refind runs only when every check before it passed, because the
// reader it drives refuses what they refuse. It opens that reader on the index
// read by range, held to the part sizes, so an index that changed since the
// pass fails refind with the reader's code. A check that does not run is listed
// as skip with its reason, never as pass (AGENTS.md absolute 11). So is a check
// of the pass that ran on no block: inflate, crc, record, order, unique and
// name skip when the pack holds no block, or when every block stopped at a
// check before them; record counts only the blocks whose decode ended. On a
// pack of no record, sources and precision pass on the registry half alone,
// and their detail says the pack held no record to check.
//
// A check with nothing to compare against is listed as skip too, even when the
// half of it that reads the pack alone held: dataset with no dataset
// annotation, length with no bytes annotation, count with no count annotation,
// sha256, psl, sources and precision with no annotation, precision with no
// span, no clock and no precision annotation, refind on a pack of no record,
// volume with no rule. Such a half still fails as itself. So a run given no
// annotation is not ok by default for a caller that needs them: it names them
// in `require`, and a check of `require` that skipped makes the verdict
// unverified. The verdicts rank fail, unverified, then the volume's quarantine
// or hold, then ok.
//
// ⚠ The unit of a time is its source's precision (docs/format.md section 1),
// so `last - first` of a day source is a whole number of days by construction.
// A day source written in seconds holds a value 86,400 times its day number
// and more, far past its span, which the precision check refuses.
//
// No content regular expression: a key is checked by the names package's one
// character loop (scan) and by normalise. A key in a detail is quoted by
// quoteKey: at most KEY_SHOWN bytes, every byte outside printable ASCII escaped.
//
// This module imports nothing from `node:`, so it runs in Node and in workerd.
// The volume rule is passed in, not imported, so @domains/pack, which the
// Worker imports for its reader, does not depend on @domains/adapter.
import { fromKey, normalise, type Psl, scan } from "@domains/names";
import { BUILTIN_CODECS, type DatasetCodec, type DomainRecord, type FeedRecord, type NameRecord, type PackRecord } from "./codec.ts";
import { PackError, type PackErrorCode } from "./errors.ts";
import { ANNOTATIONS, DATASET_DOMAINS, DATASET_FEED, DATASET_LABELS, DATASET_NAMES, DATASET_NEW_NAME, PART_HEADER_BYTES, partTitle, readPartHeader } from "./format.ts";
import { type Idx, PackIndex, readIdx } from "./idx.ts";
import { PackReader } from "./reader.ts";
import { Sha256 } from "./sha256.ts";
import { type ByteSource, bytesSource, type RangeSource, readExact, readPart } from "./source.ts";

export const CHECKS = Object.freeze([
  "idx",
  "dataset",
  "length",
  "header",
  "inflate",
  "crc",
  "record",
  "count",
  "order",
  "unique",
  "bounds",
  "name",
  "sha256",
  "refind",
  "psl",
  "sources",
  "precision",
  "volume",
] as const);
export type CheckName = (typeof CHECKS)[number];

export const DEFAULT_REFIND = 1000;
export const DEFAULT_SEED = 1;
// The failures one check lists; the rest are counted in one more line.
export const DEFAULT_MAX_FAILURES = 20;
// The bytes of a key a detail shows.
export const KEY_SHOWN = 80;

// The datasets whose keys are reversed names (docs/format.md section 1), the
// ones this verifier checks. Named here rather than read from BUILTIN_CODECS:
// a codec registered there for dataset 4, whose keys are binary, must not get
// the name check.
const NAME_DATASETS: ReadonlySet<number> = new Set([DATASET_NAMES, DATASET_DOMAINS, DATASET_FEED, DATASET_NEW_NAME]);
// The datasets whose record is the feed record (docs/format.md section 5.4).
const FEED_SHAPED: ReadonlySet<number> = new Set([DATASET_FEED, DATASET_NEW_NAME]);

// The annotations the verifier reads beside those of format.ts
// (docs/architecture.md section 4.2 names them).
export const VERIFY_ANNOTATIONS = Object.freeze({
  ...ANNOTATIONS,
  psl: "dev.pkgforge.domains.psl",
  source: "dev.pkgforge.domains.source",
  precision: "dev.pkgforge.domains.precision",
  spanStart: "dev.pkgforge.domains.span.start",
  spanEnd: "dev.pkgforge.domains.span.end",
});

export type Precision = "day" | "second";

// What the annotations of a pack state. Every field is optional: a check with
// nothing to compare against says so.
export interface Expect {
  // The records of the pack.
  readonly count?: number;
  // The bytes of every part and the index.
  readonly bytes?: number;
  // names, domains, feed, rev or new-name.
  readonly dataset?: string;
  // The SHA-256 of the raw blocks in order, lowercase hex.
  readonly sha256?: string;
  // The sha256 of the Public Suffix List the names were normalised with.
  readonly psl?: string;
  // The ids of the sources the records carry.
  readonly sources?: readonly string[];
  // The precision of each named source, as the annotation states it.
  readonly precision?: Readonly<Record<string, Precision>>;
  // The window the pack covers, [start, end), ISO 8601 UTC to the second.
  readonly span?: { readonly start: string; readonly end: string };
}

// One row of the source registry (config/sources.json); a RegistryRow of
// @domains/adapter is one.
export interface SourceRow {
  readonly id: string;
  readonly bit: number | null;
  readonly precision: Precision;
}

// The verdict of a volume rule; a BandResult of @domains/adapter is one.
export interface VolumeVerdict {
  readonly verdict: "ok" | "hold" | "quarantine";
  readonly reason: string;
  readonly median: number | null;
  readonly floor: number | null;
  readonly ceiling: number | null;
}

export interface VolumeCheck {
  // The source whose history the rule reads.
  readonly source: string;
  // The value the band measures when it is not the record count (the bytes of
  // the raw file); absent, the verifier passes the count it decoded.
  readonly value?: number;
  judge(value: number): VolumeVerdict;
}

export interface VerifyOptions {
  // The pinned list: the name check runs normalise with it.
  readonly psl: Psl;
  // Needed when `expect.sources` names sources.
  readonly registry?: readonly SourceRow[];
  readonly volume?: VolumeCheck;
  // The clock, ISO 8601 UTC to the second: with no span, the times of a record
  // must not lie after it.
  readonly now?: string;
  readonly seed?: number;
  readonly refind?: number;
  readonly maxFailures?: number;
  // The checks that must not skip: one of them that skipped makes the verdict
  // unverified and `ok` false. A promote job names the annotations it needs
  // compared (count, length, sha256 and up).
  readonly require?: readonly CheckName[];
}

// The parts of a pack read by range, and the bytes each part holds as stored:
// the size of a file, or of a layer as the registry serves it.
export interface PartSource extends RangeSource {
  readonly sizes: readonly number[];
}

export interface VerifyFailure {
  readonly check: CheckName;
  readonly detail: string;
}

export interface CheckOutcome {
  readonly check: CheckName;
  readonly status: "pass" | "fail" | "skip";
  readonly detail: string;
}

export interface VerifyStats {
  readonly dataset: number | null;
  readonly parts: number;
  readonly blocks: number;
  // The records decoded.
  readonly records: number;
  readonly idxBytes: number;
  readonly partBytes: number;
  readonly rawBytes: number;
  // Of the raw blocks, when every block was read whole.
  readonly sha256: string | null;
  readonly refound: number;
  // Quoted by quoteKey.
  readonly keyMin: string | null;
  readonly keyMax: string | null;
}

export interface VerifyResult {
  readonly ok: boolean;
  readonly verdict: "ok" | "fail" | "unverified" | "hold" | "quarantine";
  readonly errors: readonly VerifyFailure[];
  readonly checks: readonly CheckOutcome[];
  // The checks whose status is skip, in the order of CHECKS.
  readonly unverified: readonly CheckName[];
  readonly stats: VerifyStats;
  readonly volume: VolumeVerdict | null;
}

const usage = (message: string): PackError => new PackError("usage", message);

// ---- quoting

const hex2 = (n: number): string => n.toString(16).padStart(2, "0");

// A key for a detail: in double quotes, at most KEY_SHOWN bytes of it, every
// byte outside printable ASCII (and `"` and `\`) written as \xHH, so a hostile
// key cannot reach a terminal as itself.
export function quoteKey(key: string): string {
  let out = "";
  const n = Math.min(key.length, KEY_SHOWN);
  for (let i = 0; i < n; i += 1) {
    const c = key.charCodeAt(i);
    out += c >= 0x20 && c <= 0x7e && c !== 0x22 && c !== 0x5c ? key[i] : `\\x${hex2(c & 0xff)}`;
  }
  return key.length > KEY_SHOWN ? `"${out}" (the first ${KEY_SHOWN} of ${key.length} bytes)` : `"${out}"`;
}

// ---- the expectation

const HEX64 = /^[0-9a-f]{64}$/;
const WHOLE = /^(?:0|[1-9][0-9]{0,15})$/;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const EPOCH_MS = Date.UTC(2026, 0, 1);
const DAY_SECONDS = 86_400;

const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// Seconds since 2026-01-01T00:00:00Z of an ISO 8601 UTC time to the second.
function secondsOf(iso: string, what: string): number {
  const ms = ISO_SECOND.test(iso) ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== `${iso.slice(0, 19)}.000Z`) throw usage(`${what} ${JSON.stringify(iso)} is not YYYY-MM-DDTHH:MM:SSZ`);
  return (ms - EPOCH_MS) / 1000;
}

function checkExpect(e: Expect): Expect {
  if (typeof e !== "object" || e === null) throw usage("expect is not an object");
  for (const k of ["count", "bytes"] as const) if (e[k] !== undefined && !isWhole(e[k])) throw usage(`expect.${k} ${String(e[k])} is not a whole number`);
  if (e.dataset !== undefined && (typeof e.dataset !== "string" || e.dataset === "")) throw usage("expect.dataset is not a name");
  for (const k of ["sha256", "psl"] as const) if (e[k] !== undefined && (typeof e[k] !== "string" || !HEX64.test(e[k]))) throw usage(`expect.${k} is not 64 lowercase hex digits`);
  if (e.sources !== undefined) {
    if (!Array.isArray(e.sources) || e.sources.length === 0) throw usage("expect.sources is not a list of ids");
    for (const id of e.sources) if (typeof id !== "string" || id === "") throw usage("expect.sources holds an empty id");
    if (new Set(e.sources).size !== e.sources.length) throw usage("expect.sources names a source twice");
  }
  if (e.precision !== undefined) {
    for (const [id, unit] of Object.entries(e.precision)) {
      if (unit !== "day" && unit !== "second") throw usage(`expect.precision of ${id} is ${String(unit)}, not day or second`);
      if (e.sources === undefined || !e.sources.includes(id)) throw usage(`expect.precision names ${id}, which expect.sources does not`);
    }
  }
  if (e.span !== undefined && !(secondsOf(e.span.end, "expect.span.end") > secondsOf(e.span.start, "expect.span.start"))) throw usage("expect.span ends before it starts");
  return e;
}

const wholeOf = (v: string, key: string): number => {
  if (!WHOLE.test(v) || !Number.isSafeInteger(Number(v))) throw usage(`the annotation ${key} is ${JSON.stringify(v)}, not a whole number`);
  return Number(v);
};

// The expectation the OCI annotations of a pack state. An annotation this
// verifier does not read is ignored (docs/architecture.md section 11); one it
// reads and cannot parse is refused with PackError "usage".
//   source      one id, or ids separated by commas
//   precision   day or second, of the one source `source` names
//   span.start, span.end   both or neither
export function expectFromAnnotations(annotations: Readonly<Record<string, string>>): Expect {
  if (typeof annotations !== "object" || annotations === null || Array.isArray(annotations)) throw usage("the annotations are not an object");
  const get = (key: string): string | undefined => {
    const v: unknown = annotations[key];
    if (v === undefined) return undefined;
    if (typeof v !== "string") throw usage(`the annotation ${key} is not a string`);
    return v;
  };
  const A = VERIFY_ANNOTATIONS;
  const out: {
    count?: number;
    bytes?: number;
    dataset?: string;
    sha256?: string;
    psl?: string;
    sources?: string[];
    precision?: Record<string, Precision>;
    span?: { start: string; end: string };
  } = {};
  const count = get(A.count);
  if (count !== undefined) out.count = wholeOf(count, A.count);
  const bytes = get(A.bytes);
  if (bytes !== undefined) out.bytes = wholeOf(bytes, A.bytes);
  const dataset = get(A.dataset);
  if (dataset !== undefined) out.dataset = dataset;
  const sha = get(A.sha256);
  if (sha !== undefined) out.sha256 = sha;
  const psl = get(A.psl);
  if (psl !== undefined) out.psl = psl;
  const source = get(A.source);
  if (source !== undefined) out.sources = source.split(",").map((s) => s.trim());
  const precision = get(A.precision);
  if (precision !== undefined) {
    if (out.sources === undefined || out.sources.length !== 1) throw usage(`the annotation ${A.precision} needs ${A.source} to name exactly one source`);
    out.precision = { [out.sources[0]]: precision as Precision };
  }
  const start = get(A.spanStart);
  const end = get(A.spanEnd);
  if ((start === undefined) !== (end === undefined)) throw usage(`the annotations ${A.spanStart} and ${A.spanEnd} come together`);
  if (start !== undefined && end !== undefined) out.span = { start, end };
  return checkExpect(out);
}

// ---- the report

class Report {
  readonly #limit: number;
  readonly #failures = new Map<CheckName, string[]>();
  readonly #more = new Map<CheckName, number>();
  readonly #notes = new Map<CheckName, CheckOutcome>();

  constructor(limit: number) {
    this.#limit = limit;
  }

  fail(check: CheckName, detail: string): void {
    const list = this.#failures.get(check) ?? [];
    this.#failures.set(check, list);
    if (list.length < this.#limit) list.push(detail);
    else this.#more.set(check, (this.#more.get(check) ?? 0) + 1);
  }

  failed(check: CheckName): boolean {
    return this.#failures.has(check);
  }

  // True when a check before `check` in CHECKS failed.
  failedBefore(check: CheckName): boolean {
    const at = CHECKS.indexOf(check);
    return CHECKS.some((c, i) => i < at && this.#failures.has(c));
  }

  failedAny(checks: readonly CheckName[]): boolean {
    return checks.some((c) => this.#failures.has(c));
  }

  // The outcome of a check that did not fail: pass, or skip with its reason.
  note(check: CheckName, status: "pass" | "skip", detail: string): void {
    this.#notes.set(check, { check, status, detail });
  }

  outcomes(stoppedBy: CheckName | null): { errors: VerifyFailure[]; checks: CheckOutcome[] } {
    const errors: VerifyFailure[] = [];
    const checks: CheckOutcome[] = [];
    for (const check of CHECKS) {
      const list = this.#failures.get(check);
      if (list !== undefined) {
        const more = this.#more.get(check) ?? 0;
        const details = more > 0 ? [...list, `${more} more failures of this check are not listed`] : list;
        for (const detail of details) errors.push({ check, detail });
        checks.push({ check, status: "fail", detail: details[0] });
        continue;
      }
      const note = this.#notes.get(check);
      if (note !== undefined) checks.push(note);
      else checks.push({ check, status: "skip", detail: stoppedBy === null ? "not run" : `not run: the ${stoppedBy} check failed` });
    }
    return { errors, checks };
  }
}

// ---- the parts of the run

// A PackError of the reader to the check that owns it; anything else is not a
// finding about the pack and is thrown on (the run could not go on).
const CHECK_OF_CODE: Partial<Record<PackErrorCode, CheckName>> = {
  "short-read": "length",
  inflate: "inflate",
  codec: "inflate",
  crc: "crc",
  record: "record",
  count: "count",
  order: "order",
};

function checkOf(error: unknown): { check: CheckName; detail: string } {
  if (error instanceof PackError) {
    const check = CHECK_OF_CODE[error.code];
    if (check !== undefined) return { check, detail: error.message };
  }
  throw error;
}

// mulberry32: a small seeded generator. The draw is a reproducible sample, not
// an identifier, so it needs no cryptographic source.
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// The ordinals of the records to find again: the first, the last, and `n`
// more drawn from the seed; every record when the pack holds no more.
function drawOrdinals(records: number, n: number, seed: number): Set<number> {
  const out = new Set<number>();
  if (records === 0) return out;
  out.add(0);
  out.add(records - 1);
  const target = Math.min(records, n + out.size);
  const next = rng(seed);
  while (out.size < target) out.add(Math.floor(next() * records));
  return out;
}

const FAULT_TEXT: Readonly<Record<string, string>> = {
  charset: "a byte outside [a-z0-9_.-]",
  high: "a byte above 0x7f",
  "label-empty": "an empty label",
  "label-long": "a label over 63 bytes",
  "name-long": "more than 253 bytes",
};

// Why a key is not a reversed name that normalise keeps, or null.
function nameFault(key: string, psl: Psl): string | null {
  const s = scan(key);
  if (s.fault !== null) return FAULT_TEXT[s.fault] ?? s.fault;
  if (s.upper) return "upper case";
  const name = fromKey(key);
  const n = normalise(name, psl);
  if ("refused" in n) return `normalise refuses its name: ${n.refused}`;
  if (n.name !== name || n.wild) return "normalise changes its name";
  return null;
}

interface Bounds {
  readonly day: readonly [number, number];
  readonly second: readonly [number, number];
  readonly text: string;
}

// The times a record may hold, in each unit: the span [start, end), or from
// 2026-01-01 to the clock.
function boundsOf(span: Expect["span"], now: string | undefined): Bounds | null {
  if (span !== undefined) {
    const s0 = secondsOf(span.start, "span.start");
    const s1 = secondsOf(span.end, "span.end");
    return { second: [s0, s1 - 1], day: [Math.floor(s0 / DAY_SECONDS), Math.floor((s1 - 1) / DAY_SECONDS)], text: `the span ${span.start} to ${span.end}` };
  }
  if (now !== undefined) {
    const n = Math.floor(secondsOf(now, "now"));
    return { second: [0, n], day: [0, Math.floor(n / DAY_SECONDS)], text: `2026-01-01 to the clock ${now}` };
  }
  return null;
}

interface SourceContext {
  readonly allowed: ReadonlySet<number>;
  readonly unitOf: ReadonlyMap<number, Precision>;
  readonly idOf: ReadonlyMap<number, string>;
  readonly bounds: Bounds | null;
  readonly names: string;
}

function sourceContext(want: Expect, registry: readonly SourceRow[] | undefined, now: string | undefined, report: Report): SourceContext | null {
  if (want.sources === undefined) return null;
  if (registry === undefined) throw usage("the pack names its sources and no registry was given to check them");
  const byId = new Map(registry.map((r) => [r.id, r]));
  const allowed = new Set<number>();
  const unitOf = new Map<number, Precision>();
  const idOf = new Map<number, string>();
  for (const id of want.sources) {
    const row = byId.get(id);
    if (row === undefined) {
      report.fail("sources", `the source ${id} is not in the registry`);
      continue;
    }
    if (row.bit === null) {
      report.fail("sources", `the source ${id} has no bit, so no record can carry it`);
      continue;
    }
    allowed.add(row.bit);
    unitOf.set(row.bit, row.precision);
    idOf.set(row.bit, id);
    const stated = want.precision?.[id];
    if (stated !== undefined && stated !== row.precision) report.fail("precision", `the annotation gives ${id} the precision ${stated}, the registry ${row.precision}`);
  }
  return { allowed, unitOf, idOf, bounds: boundsOf(want.span, now), names: want.sources.join(", ") };
}

// The sources and times of one record against the pack's sources and span.
function checkStamps(dataset: number, record: PackRecord, key: string, ctx: SourceContext, report: Report): void {
  const bit = (b: number): void => {
    if (!ctx.allowed.has(b)) report.fail("sources", `the record ${quoteKey(key)} carries source bit ${b}, which is not a bit of ${ctx.names}`);
  };
  const time = (b: number | null, value: number, what: string): void => {
    const unit = b === null ? "second" : ctx.unitOf.get(b);
    if (unit === undefined || ctx.bounds === null) return;
    const [lo, hi] = ctx.bounds[unit];
    if (value < lo || value > hi) {
      const who = b === null ? "" : ` of ${ctx.idOf.get(b)}, a ${unit} source,`;
      report.fail("precision", `the record ${quoteKey(key)} has ${what}${who} ${value}, outside ${lo} to ${hi} ${unit === "day" ? "days" : "seconds"}: ${ctx.bounds.text}`);
    }
  };
  if (FEED_SHAPED.has(dataset)) {
    const r = record as FeedRecord;
    for (const b of r.sources) bit(b);
    time(null, r.firstSeen, "first_seen");
    return;
  }
  const r = record as NameRecord;
  for (const s of r.sources) {
    bit(s.bit);
    time(s.bit, s.first, "first");
    time(s.bit, s.last, "last");
  }
  if (dataset === DATASET_DOMAINS)
    for (const e of (record as DomainRecord).evidence) {
      bit(e.source);
      time(e.source, e.at, "evidence at");
    }
}

function checkOptions(o: VerifyOptions): { refind: number; seed: number; maxFailures: number; required: readonly CheckName[] } {
  if (typeof o !== "object" || o === null || typeof o.psl !== "object" || o.psl === null || typeof o.psl.sha256 !== "string") throw usage("verifyPack needs options with the pinned psl");
  const refind = o.refind ?? DEFAULT_REFIND;
  const seed = o.seed ?? DEFAULT_SEED;
  const maxFailures = o.maxFailures ?? DEFAULT_MAX_FAILURES;
  if (!isWhole(refind)) throw usage(`refind ${String(refind)} is not a whole number`);
  if (!isWhole(seed) || seed > 0xffff_ffff) throw usage(`seed ${String(seed)} is not a whole number below 2^32`);
  if (!isWhole(maxFailures) || maxFailures < 1) throw usage(`maxFailures ${String(maxFailures)} is not a whole number above 0`);
  if (o.now !== undefined) secondsOf(o.now, "now");
  if (o.volume !== undefined) {
    if (typeof o.volume.judge !== "function") throw usage("the volume check has no judge");
    if (o.volume.value !== undefined && !isWhole(o.volume.value)) throw usage(`the volume value ${String(o.volume.value)} is not a whole number`);
  }
  const required = o.require ?? [];
  if (!Array.isArray(required)) throw usage("require is not a list of checks");
  for (const c of required) if (!(CHECKS as readonly unknown[]).includes(c)) throw usage(`require names ${JSON.stringify(c)}, which is not a check; the checks are ${CHECKS.join(", ")}`);
  return { refind, seed, maxFailures, required };
}

// ---- the verifier

export async function verifyPack(idx: ByteSource | Uint8Array, parts: PartSource, expect: Expect, options: VerifyOptions): Promise<VerifyResult> {
  const want = checkExpect(expect);
  const opts = checkOptions(options);
  if (typeof parts !== "object" || parts === null || typeof parts.read !== "function" || !Array.isArray(parts.sizes) || !parts.sizes.every(isWhole))
    throw usage("the parts are not a RangeSource with the whole-number size of each part");
  const idxSource = idx instanceof Uint8Array ? bytesSource(idx) : idx;
  if (!isWhole(idxSource.size)) throw usage(`the index size ${String(idxSource.size)} is not a whole number`);
  const report = new Report(opts.maxFailures);
  const stats = {
    dataset: null as number | null,
    parts: 0,
    blocks: 0,
    records: 0,
    idxBytes: idxSource.size,
    partBytes: 0,
    rawBytes: 0,
    sha256: null as string | null,
    refound: 0,
    keyMin: null as string | null,
    keyMax: null as string | null,
  };
  let volume: VolumeVerdict | null = null;
  const finish = (stoppedBy: CheckName | null): VerifyResult => {
    const { errors, checks } = report.outcomes(stoppedBy);
    const unverified = checks.filter((c) => c.status === "skip").map((c) => c.check);
    const missing = opts.required.some((c) => unverified.includes(c));
    const others = errors.some((e) => e.check !== "volume");
    const verdict = others ? "fail" : missing ? "unverified" : volume !== null && volume.verdict !== "ok" ? volume.verdict : "ok";
    return { ok: errors.length === 0 && !missing, verdict, errors, checks, unverified, stats: { ...stats }, volume };
  };

  // idx. The index is read whole, so every page and the tiling across pages are
  // checked once; the parts are read a block at a time.
  let whole: Idx;
  let idxBytes: Uint8Array;
  try {
    idxBytes = await readExact(idxSource, 0, idxSource.size, "the index");
    whole = readIdx(idxBytes);
  } catch (error) {
    if (!(error instanceof PackError)) throw error;
    report.fail("idx", error.message);
    return finish("idx");
  }
  const { header } = whole.head;
  stats.dataset = header.dataset;
  stats.parts = header.parts;
  stats.blocks = header.blocks;
  report.note("idx", "pass", `${header.parts} part(s), ${header.blocks} block(s) in ${header.pages} page(s), ${header.records} record(s)`);

  // dataset
  const label = DATASET_LABELS[header.dataset] ?? null;
  if (want.dataset !== undefined && want.dataset !== label) report.fail("dataset", `the index is dataset ${header.dataset} (${label ?? "unknown"}), the annotation says ${want.dataset}`);
  // The verifier only decodes: encodeRecord, the one member whose parameter
  // type differs between the codecs, is never called through it.
  const codec = NAME_DATASETS.has(header.dataset) ? (BUILTIN_CODECS.get(header.dataset) as DatasetCodec<PackRecord> | undefined) : undefined;
  if (codec === undefined) report.fail("dataset", `the pack is dataset ${header.dataset}; this verifier checks the datasets 1, 2, 3 and 5, whose keys are reversed names`);
  if (codec === undefined || report.failed("dataset")) return finish("dataset");
  if (want.dataset === undefined) report.note("dataset", "skip", `no dataset annotation to compare; the index is dataset ${header.dataset} (${label}), which this verifier checks`);
  else report.note("dataset", "pass", `${header.dataset} (${label}), as the annotation says`);

  // length
  const table = whole.head.parts;
  const sizes = parts.sizes;
  stats.partBytes = sizes.reduce((sum, n) => sum + n, 0);
  if (sizes.length !== table.length) report.fail("length", `the index names ${table.length} part(s) and ${sizes.length} were given`);
  for (let i = 0; i < Math.min(sizes.length, table.length); i += 1) if (sizes[i] !== table[i].bytes) report.fail("length", `${partTitle(i)} holds ${sizes[i]} B, the index says ${table[i].bytes} B`);
  const total = stats.partBytes + idxBytes.length;
  if (want.bytes !== undefined && total !== want.bytes)
    report.fail("length", `the parts (${stats.partBytes} B) and the index (${idxBytes.length} B) make ${total} B, the bytes annotation says ${want.bytes} B`);
  if (report.failed("length")) return finish("length");
  if (want.bytes === undefined) report.note("length", "skip", `no bytes annotation to compare; the parts hold ${stats.partBytes} B as the index says, ${total} B with the index`);
  else report.note("length", "pass", `the parts hold ${stats.partBytes} B as the index says, ${total} B with the index, as the annotation says`);

  // header
  for (let i = 0; i < table.length; i += 1) {
    const title = partTitle(i);
    try {
      const h = readPartHeader(await readPart(parts, i, 0, PART_HEADER_BYTES, title), title);
      const diffs: string[] = [];
      if (h.dataset !== header.dataset) diffs.push(`dataset ${h.dataset}, the index ${header.dataset}`);
      if (h.recordsPerBlock !== header.recordsPerBlock) diffs.push(`${h.recordsPerBlock} records a block, the index ${header.recordsPerBlock}`);
      if (h.codec !== header.codec) diffs.push(`codec ${h.codec}, the index ${header.codec}`);
      if (h.part !== i) diffs.push(`part number ${h.part}`);
      if (diffs.length > 0) report.fail("header", `${title} names ${diffs.join("; ")}`);
    } catch (error) {
      if (!(error instanceof PackError)) throw error;
      report.fail(error.code === "short-read" ? "length" : "header", error.message);
    }
  }
  if (report.failedAny(["length", "header"])) return finish(report.failed("length") ? "length" : "header");
  report.note("header", "pass", `${table.length} part header(s) agree with the index`);

  // The pass over every block: inflate, crc, record, count, order, unique,
  // name, sources, precision, and the sample to find again.
  const reader = new PackReader<PackRecord>(await PackIndex.open(idxBytes), parts, codec);
  const sources = sourceContext(want, options.registry, options.now, report);
  const draw = drawOrdinals(header.records, opts.refind, opts.seed);
  const sample: { key: string; json: string }[] = [];
  const sha = new Sha256();
  // Blocks that inflated, that also matched their CRC-32, that also decoded.
  let inflated = 0;
  let checked = 0;
  let decoded = 0;
  let firstKey: string | null = null;
  let lastKey: string | null = null;
  let boundaries = 0;
  for (const entry of whole.entries) {
    let raw: Uint8Array;
    let records: PackRecord[];
    try {
      raw = await reader.readBlock(entry);
    } catch (error) {
      const f = checkOf(error);
      report.fail(f.check, f.detail);
      // readBlock checks the CRC-32 of what it inflated.
      if (f.check === "crc") inflated += 1;
      continue;
    }
    inflated += 1;
    checked += 1;
    sha.update(raw);
    stats.rawBytes += raw.length;
    try {
      records = reader.decodeBlock(raw, entry);
    } catch (error) {
      const f = checkOf(error);
      report.fail(f.check, f.detail);
      continue;
    }
    decoded += 1;
    const first = codec.key(records[0]);
    if (lastKey !== null) {
      boundaries += 1;
      if (first === lastKey) report.fail("unique", `block ${entry.index} starts with ${quoteKey(first)}, the last key of the block before it`);
      else if (first < lastKey) report.fail("order", `block ${entry.index} starts with ${quoteKey(first)}, below ${quoteKey(lastKey)} that ends the block before it`);
    }
    firstKey ??= first;
    const base = entry.index * header.recordsPerBlock;
    for (let k = 0; k < records.length; k += 1) {
      const record = records[k];
      const key = codec.key(record);
      const fault = nameFault(key, options.psl);
      if (fault !== null) report.fail("name", `the key ${quoteKey(key)}: ${fault}`);
      if (sources !== null) checkStamps(header.dataset, record, key, sources, report);
      if (draw.has(base + k)) sample.push({ key, json: JSON.stringify(record) });
    }
    lastKey = codec.key(records[records.length - 1]);
    stats.records += records.length;
  }
  const blocks = header.blocks;
  const rawWhole = checked === blocks;
  const decodedWhole = decoded === blocks;
  // A check of the pass that did not fail: pass over the `ran` blocks it ran
  // on, or skip when it ran on none, so no pass is listed over nothing.
  const ofBlocks = (check: CheckName, ran: number, none: string, detail: string): void => {
    if (report.failed(check)) return;
    if (ran > 0) report.note(check, "pass", detail);
    else report.note(check, "skip", blocks === 0 ? "the pack holds no block" : `not run: none of the ${blocks} block(s) ${none}`);
  };
  ofBlocks("inflate", inflated, "was read whole", `${inflated} of ${blocks} block(s) read whole and inflate to their raw length`);
  ofBlocks("crc", inflated, "inflated", `${checked} of ${inflated} inflated block(s) match the CRC-32 of the index`);
  // record passes only over blocks that decoded whole: a block refused for its
  // count parsed its records, but its decode did not end.
  ofBlocks("record", decoded, checked === 0 ? "matched its CRC-32" : "decoded whole", `${decoded} of ${checked} checked block(s) decode`);

  // count
  if (decodedWhole) {
    if (stats.records !== header.records) report.fail("count", `the blocks hold ${stats.records} records, the index header says ${header.records}`);
    if (want.count !== undefined && stats.records !== want.count) report.fail("count", `the pack holds ${stats.records} records, the count annotation says ${want.count}`);
    if (!report.failed("count")) {
      if (want.count === undefined) report.note("count", "skip", `no count annotation to compare; the blocks hold ${stats.records} records, as the index header says`);
      else report.note("count", "pass", `${stats.records} records, as the index header and the annotation say`);
    }
  } else if (!report.failed("count")) report.note("count", "skip", "the sum is not checked: a block did not decode");

  // order, unique, bounds
  for (const check of ["order", "unique"] as const) ofBlocks(check, decoded, "decoded", `${boundaries} block boundaries; decodeBlock holds the order inside each block`);
  if (decodedWhole) {
    stats.keyMin = firstKey === null ? null : quoteKey(firstKey);
    stats.keyMax = lastKey === null ? null : quoteKey(lastKey);
    const { keyMin, keyMax } = whole.head;
    if (keyMin !== firstKey)
      report.fail("bounds", `the head's smallest key is ${keyMin === null ? "none" : quoteKey(keyMin)}, the first record's is ${firstKey === null ? "none" : quoteKey(firstKey)}`);
    if (keyMax !== lastKey) report.fail("bounds", `the head's largest key is ${keyMax === null ? "none" : quoteKey(keyMax)}, the last record's is ${lastKey === null ? "none" : quoteKey(lastKey)}`);
    if (!report.failed("bounds")) report.note("bounds", "pass", "the head's key bounds are the first and the last key");
  } else report.note("bounds", "skip", "a block did not decode");

  // name
  ofBlocks("name", decoded, "decoded", `${stats.records} keys are reversed names that normalise keeps, under the list ${options.psl.sha256.slice(0, 12)}`);

  // sha256
  if (rawWhole) {
    stats.sha256 = sha.hex();
    if (want.sha256 === undefined) report.note("sha256", "skip", `no sha256 annotation; the raw blocks hash to ${stats.sha256}`);
    else if (stats.sha256 !== want.sha256) report.fail("sha256", `the raw blocks hash to ${stats.sha256}, the sha256 annotation says ${want.sha256}`);
    else report.note("sha256", "pass", stats.sha256);
  } else report.note("sha256", "skip", "a block was not read whole");

  // refind
  if (!decodedWhole || report.failedBefore("refind")) report.note("refind", "skip", "a check before it failed");
  else if (stats.records === 0) report.note("refind", "skip", "the pack holds no record to find");
  else {
    // A reader as a lookup opens one: the index read by range again, held to
    // the part sizes the store gives (docs/format.md section 6.6). An index
    // that changed since the pass is refused here, and that refusal is a
    // finding about the pack, not a run that could not go on.
    let live: PackReader<PackRecord> | null = null;
    try {
      live = await PackReader.open(idxSource, parts, codec, { partSizes: parts.sizes });
    } catch (error) {
      if (!(error instanceof PackError)) throw error;
      report.fail("refind", `the index read by range is refused: ${error.code}: ${error.message}`);
    }
    if (live !== null)
      for (const s of sample) {
        let got: PackRecord | null;
        try {
          got = await live.get(s.key);
        } catch (error) {
          if (!(error instanceof PackError)) throw error;
          report.fail("refind", `get(${quoteKey(s.key)}) is refused: ${error.code}: ${error.message}`);
          continue;
        }
        if (got === null) report.fail("refind", `get(${quoteKey(s.key)}) finds nothing`);
        else if (JSON.stringify(got) !== s.json) report.fail("refind", `get(${quoteKey(s.key)}) answers another record than the block holds`);
        else stats.refound += 1;
      }
    if (!report.failed("refind")) report.note("refind", "pass", `${stats.refound} key(s), the first and the last among them, found by get through the index read by range (seed ${opts.seed})`);
  }

  // psl
  if (want.psl === undefined) report.note("psl", "skip", `no psl annotation; the names were checked under the list ${options.psl.sha256}`);
  else if (want.psl !== options.psl.sha256) report.fail("psl", `the psl annotation is ${want.psl}, the pinned list is ${options.psl.sha256}`);
  else report.note("psl", "pass", want.psl);

  // sources, precision
  if (sources === null) {
    report.note("sources", "skip", "no source annotation");
    report.note("precision", "skip", "no source annotation");
  } else {
    // With no record, only the registry half compared something: say so.
    if (!report.failed("sources"))
      report.note("sources", "pass", stats.records === 0 ? `the registry holds ${sources.names}; the pack holds no record to check` : `every record carries only ${sources.names}`);
    // With no bounds and no precision annotation the check compared nothing.
    if (!report.failed("precision")) {
      if (sources.bounds === null && want.precision === undefined) report.note("precision", "skip", "the times are not bounded: no span and no clock, and no precision annotation to compare");
      else
        report.note(
          "precision",
          "pass",
          sources.bounds === null
            ? "the annotation's precision is the registry's; the times are not bounded: no span and no clock"
            : stats.records === 0
              ? `the registry's precision; the pack holds no time to bound by ${sources.bounds.text}`
              : `the registry's precision; every time inside ${sources.bounds.text}`,
        );
    }
  }

  // volume
  if (options.volume === undefined) report.note("volume", "skip", "no volume rule given");
  else if (!decodedWhole) report.note("volume", "skip", "a block did not decode, so the count is not known");
  else {
    const value = options.volume.value ?? stats.records;
    volume = options.volume.judge(value);
    const text = `${value} against the median ${volume.median ?? "none"} of ${options.volume.source} (floor ${volume.floor ?? "none"}, ceiling ${volume.ceiling ?? "none"})`;
    if (volume.verdict !== "ok") report.fail("volume", `${volume.verdict} (${volume.reason}): ${text}`);
    else report.note("volume", "pass", `ok (${volume.reason}): ${text}`);
  }
  return finish(null);
}
