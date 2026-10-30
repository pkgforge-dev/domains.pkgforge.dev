// packages/adapter/src/validate.ts — the hand-written checks of the registry and
// of what an adapter returns. No schema library: the registry is a few dozen
// rows and one grammar (DOM-016's Decision).
//
//   validateBits(json)                     config/source-bits.json → the id-to-bit map
//   bitsAppendOnly(before, after)          an id removed or a bit changed between two maps
//   validateSource(json, bits)             one source of a source.json → Source
//   validateSourceFile(json, bits)         adapters/<dir>/source.json → SourceFile
//   buildRegistry(files, bits)             every source.json → config/sources.json
//   validateRegistry(json, bits)           config/sources.json as a reader checks it
//   checkCursor(value, what)               opaque JSON of at most 4 KiB
//   validateSegment(json, what)            one segment an adapter returned
//
// A registry fault throws SourceError, which lists every problem found, each
// with a stable `code`. A fault of a cursor, a segment or a run throws
// ContractError with the name of the check. Nothing pads, guesses or drops a
// field: a source.json that does not validate is not in the registry.
import { canonicalJson, JsonError, utf8 } from "./json.ts";
import {
  BASES,
  BITS_FORMAT,
  type Band,
  type Cursor,
  DATASETS,
  FAMILIES,
  KINDS,
  MASKED_DATASETS,
  METRICS,
  PRECISIONS,
  REGISTRY_FORMAT,
  type Registry,
  type RegistryRow,
  SOURCE_FORMAT,
  type Segment,
  type Source,
  type SourceBits,
  type SourceFile,
} from "./types.ts";

export const PROBLEM_CODES = Object.freeze([
  "json",
  "type",
  "format",
  "missing",
  "unknown-field",
  "runtime-field",
  "grammar",
  "enum",
  "empty",
  "duplicate",
  "range",
  "order",
  "url",
  "credential",
  "bit-mismatch",
  "bit-taken",
  "bit-unknown",
  "bit-required",
] as const);
export type ProblemCode = (typeof PROBLEM_CODES)[number];

export interface Problem {
  readonly at: string;
  readonly code: ProblemCode;
  readonly detail: string;
}

export class SourceError extends Error {
  readonly problems: readonly Problem[];
  constructor(problems: readonly Problem[]) {
    super(problems.map((p) => `${p.at}: ${p.code}: ${p.detail}`).join("\n"));
    this.name = "SourceError";
    this.problems = problems;
  }
}

export const CONTRACT_CHECKS = Object.freeze([
  "cursor",
  "segment",
  "draft",
  "record",
  "result",
  "threw",
  "reported",
  "source",
  "deterministic",
  "continuation",
  "unrecorded",
  "user-agent",
  "global-fetch",
  "recording",
  "options",
] as const);
export type ContractCheck = (typeof CONTRACT_CHECKS)[number];

export class ContractError extends Error {
  readonly check: ContractCheck;
  constructor(check: ContractCheck, detail: string, options?: { cause?: unknown }) {
    super(`${check}: ${detail}`, options);
    this.name = "ContractError";
    this.check = check;
  }
}

// docs/architecture.md section 3.5: ids and adapter directories.
export const ID_GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
// The longest tag a source names, `raw-ID.START.END` with 16-character times
// (DOM-024's tag shapes), is the id plus 38 characters; 63 keeps it under
// GHCR's 128-character reference.
export const MAX_ID = 63;
// No source id starts with this: it begins the raw lane's tags of obs
// (rawTag of @domains/ghcr, RAW_PREFIX there), so a segment of one source
// never takes the raw lane tag of another. An adapter directory may.
export const RAW_ID_PREFIX = "raw-";
// The most characters of a source's urls joined by one space: a segment
// carries them as its annotation dev.pkgforge.domains.url, and the push tool
// takes a value of at most ANNOTATION_MAX_CHARS of @domains/ghcr, which a
// test of scripts/ingest holds equal to this.
export const MAX_URLS_CHARS = 1024;
// docs/architecture.md section 3.5: at most 64 sources carry a bit.
export const MAX_BIT = 63;
export const MAX_CURSOR_BYTES = 4096;
export const URL_SCHEMES = Object.freeze(["https:", "http:", "wss:", "kafka:"] as const);
export const RETENTION_WORDS = Object.freeze(["unbounded", "unknown"] as const);
const PARSER_GRAMMAR = /^[a-z0-9]+(?:-[a-z0-9]+)*\/[1-9][0-9]{0,5}$/;
const DURATION = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const SHA256 = /^[0-9a-f]{64}$/;

// The fields of one source, in the order the registry writes them.
export const SOURCE_FIELDS = Object.freeze(["id", "bit", "family", "datasets", "precision", "kind", "basis", "cadence", "band", "urls", "retention", "parser", "failure_modes"] as const);
// docs/architecture.md section 3.5 fields that only a run or a reader computes.
export const RUNTIME_FIELDS = Object.freeze(["fetched", "status", "through"] as const);
const BAND_FIELDS = Object.freeze(["metric", "min", "max", "relative"] as const);
export const REGISTRY_COMMENT = "Written by node scripts/sources/build.mjs from adapters/*/source.json; never edited by hand. Sorted by bit, then the sources with no bit by id.";

type Obj = Readonly<Record<string, unknown>>;
const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const has = (o: object, k: string): boolean => Object.hasOwn(o, k);
const join = (at: string, field: string): string => (at ? `${at}.${field}` : field);

// Seconds of an ISO 8601 duration of days, hours, minutes and seconds, or null.
// Years and months are refused: their length varies.
export function parseDuration(text: string): number | null {
  const m = DURATION.exec(text);
  if (m === null || text === "P" || text.endsWith("T")) return null;
  const [d, h, min, s] = [m[1], m[2], m[3], m[4]].map((x) => (x === undefined ? 0 : Number(x)));
  return d! * 86400 + h! * 3600 + min! * 60 + s!;
}

// True for `YYYY-MM-DDTHH:MM:SS(.sss)Z` naming a real instant.
export function isIsoUtc(text: unknown): text is string {
  if (typeof text !== "string" || !ISO_UTC.test(text)) return false;
  const ms = Date.parse(text);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === text.slice(0, 19);
}

// Collects problems for one object under the path `at`.
class Collector {
  readonly problems: Problem[] = [];
  readonly at: string;
  constructor(at: string) {
    this.at = at;
  }
  add(field: string, code: ProblemCode, detail: string): void {
    this.problems.push({ at: join(this.at, field), code, detail });
  }
  // Refuses missing fields and fields not in `known`.
  fields(o: Obj, known: readonly string[], required: readonly string[], runtime: readonly string[] = []): void {
    for (const k of Object.keys(o)) {
      if (runtime.includes(k)) this.add(k, "runtime-field", "written by a run or derived by a reader, never by source.json (docs/architecture.md section 3.5)");
      else if (!known.includes(k)) this.add(k, "unknown-field", "not a field of this file");
    }
    for (const k of required) if (!has(o, k)) this.add(k, "missing", "required");
  }
  oneOf(o: Obj, field: string, values: readonly string[]): void {
    if (!has(o, field)) return;
    const v = o[field];
    if (typeof v !== "string") this.add(field, "type", "not a string");
    else if (!values.includes(v)) this.add(field, "enum", `${JSON.stringify(v)} is not one of ${values.join(", ")}`);
  }
  // A list of distinct values, each passing `each`; non-empty unless mayBeEmpty.
  list(o: Obj, field: string, each: (v: unknown, at: string) => void, mayBeEmpty = false): void {
    if (!has(o, field)) return;
    const v = o[field];
    if (!Array.isArray(v)) {
      this.add(field, "type", "not a list");
      return;
    }
    if (v.length === 0 && !mayBeEmpty) {
      this.add(field, "empty", "at least one value");
      return;
    }
    const seen = new Set<string>();
    v.forEach((x, i) => {
      const key = typeof x === "string" ? x : JSON.stringify(x);
      if (seen.has(key)) this.add(`${field}[${i}]`, "duplicate", `${key} is listed twice`);
      seen.add(key);
      each(x, `${field}[${i}]`);
    });
  }
  enumList(o: Obj, field: string, values: readonly string[], mayBeEmpty = false): void {
    this.list(
      o,
      field,
      (x, at) => {
        if (typeof x !== "string") this.add(at, "type", "not a string");
        else if (!values.includes(x)) this.add(at, "enum", `${JSON.stringify(x)} is not one of ${values.join(", ")}`);
      },
      mayBeEmpty,
    );
  }
}

function checkId(c: Collector, field: string, v: unknown): v is string {
  if (typeof v !== "string") {
    c.add(field, "type", "not a string");
    return false;
  }
  if (!ID_GRAMMAR.test(v) || v.length > MAX_ID) {
    c.add(field, "grammar", `${JSON.stringify(v)} is not lowercase letters and digits in hyphen-joined words of at most ${MAX_ID} characters`);
    return false;
  }
  if (v.startsWith(RAW_ID_PREFIX)) {
    c.add(field, "grammar", `${JSON.stringify(v)} starts ${RAW_ID_PREFIX}, which begins the raw lane's tags: no source id takes it`);
    return false;
  }
  return true;
}

function ownerOf(bits: SourceBits, bit: number): string | undefined {
  return Object.keys(bits).find((k) => bits[k] === bit);
}

function checkBit(c: Collector, o: Obj, id: string | null, bits: SourceBits): void {
  if (!has(o, "bit")) return;
  const bit = o.bit;
  if (bit === null) {
    if (id !== null && has(bits, id)) {
      c.add("bit", "bit-mismatch", `config/source-bits.json gives ${id} bit ${bits[id]}, not null`);
      return;
    }
    const datasets = Array.isArray(o.datasets) ? o.datasets : [];
    const masked = datasets.filter((d) => (MASKED_DATASETS as readonly unknown[]).includes(d));
    if (masked.length > 0) c.add("bit", "bit-required", `the datasets ${masked.join(", ")} store a source mask, so the source needs a bit`);
    return;
  }
  if (typeof bit !== "number" || !Number.isInteger(bit)) {
    c.add("bit", "type", "not an integer or null");
    return;
  }
  if (bit < 0 || bit > MAX_BIT) {
    c.add("bit", "range", `${bit} is outside 0 to ${MAX_BIT}`);
    return;
  }
  if (id === null) return;
  const owner = ownerOf(bits, bit);
  if (has(bits, id) && bits[id] === bit) return;
  if (owner !== undefined && owner !== id) {
    c.add("bit", "bit-taken", `bit ${bit} belongs to ${owner} in config/source-bits.json`);
    return;
  }
  if (has(bits, id)) {
    c.add("bit", "bit-mismatch", `config/source-bits.json gives ${id} bit ${bits[id]}, not ${bit}`);
    return;
  }
  c.add("bit", "bit-unknown", `${id} has no bit in config/source-bits.json: append it there first`);
}

function checkBandField(c: Collector, v: unknown): void {
  if (!isObject(v)) {
    c.add("band", "type", "not an object");
    return;
  }
  const b = new Collector(join(c.at, "band"));
  b.fields(v, BAND_FIELDS, BAND_FIELDS);
  b.oneOf(v, "metric", METRICS);
  if (has(v, "relative") && typeof v.relative !== "boolean") b.add("relative", "type", "not true or false");
  let ok = true;
  for (const k of ["min", "max"] as const) {
    if (!has(v, k)) {
      ok = false;
      continue;
    }
    const n = v[k];
    if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
      b.add(k, "range", "not a finite number of at least 0");
      ok = false;
    }
  }
  if (ok) {
    const min = v.min as number;
    const max = v.max as number;
    if (max <= min) b.add("max", "range", `max ${max} is not above min ${min}`);
    // A relative band holds the median itself, or every day of a steady source fails.
    else if (v.relative === true && !(min < 1 && max > 1)) b.add("min", "range", `a relative band ${min} to ${max} does not hold 1, the median`);
  }
  c.problems.push(...b.problems);
}

// The problems of a band alone, as checkBand (band.ts) reads its argument.
export function bandProblems(v: unknown): Problem[] {
  const c = new Collector("");
  checkBandField(c, v);
  return c.problems;
}

function checkUrl(c: Collector, at: string, v: unknown): void {
  if (typeof v !== "string") {
    c.add(at, "type", "not a string");
    return;
  }
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    c.add(at, "url", `${JSON.stringify(v)} is not a URL`);
    return;
  }
  if (!(URL_SCHEMES as readonly string[]).includes(u.protocol)) c.add(at, "url", `the scheme ${u.protocol} is not one of ${URL_SCHEMES.join(", ")}`);
  // AGENTS.md absolute 4: no credential in the tree. config/sources.json is
  // committed and pushed to the public `ref` package.
  if (u.username !== "" || u.password !== "") c.add(at, "credential", "a URL holds a user name or a password");
  // A fragment is never sent to the publisher, so a source URL has no use for
  // one; what a fragment carries in practice is a token. href keeps an empty one.
  if (u.href.includes("#")) c.add(at, "credential", "a URL holds a fragment");
  const names = [...new Set(u.searchParams.keys())].filter(isCredentialParam);
  if (names.length > 0) c.add(at, "credential", `the query parameter ${names.join(", ")} names a credential`);
}

// A word of a query parameter's name that names a credential: `apikey`,
// `access_token`, `X-Amz-Signature`, `sasl.password`. The name is split into
// words at every character that is not a letter or digit and at each lower-to-
// upper case change, so `keyword` and `author` are not credentials.
const CREDENTIAL_WORD = /^(?:[a-z0-9]*(?:keys?|tokens?|secrets?|password|passwd)|pass|pwd|auth|authorization|sig|signature|credentials?|sasl)$/;

function isCredentialParam(name: string): boolean {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((w) => CREDENTIAL_WORD.test(w));
}

function sourceProblems(json: unknown, bits: SourceBits, at: string): Problem[] {
  const c = new Collector(at);
  if (!isObject(json)) {
    c.add("", "type", "a source is an object");
    return c.problems;
  }
  c.fields(json, SOURCE_FIELDS, SOURCE_FIELDS, RUNTIME_FIELDS);
  const id = has(json, "id") && checkId(c, "id", json.id) ? (json.id as string) : null;
  checkBit(c, json, id, bits);
  c.oneOf(json, "family", FAMILIES);
  c.enumList(json, "datasets", DATASETS);
  c.oneOf(json, "precision", PRECISIONS);
  c.oneOf(json, "kind", KINDS);
  // docs/architecture.md section 3.5: a source that writes no newness evidence lists no basis.
  c.enumList(json, "basis", BASES, true);
  if (has(json, "cadence")) {
    const s = typeof json.cadence === "string" ? parseDuration(json.cadence) : null;
    if (s === null) c.add("cadence", "grammar", "not an ISO 8601 duration of days, hours, minutes and seconds, such as PT10M or P1D");
    else if (s === 0) c.add("cadence", "range", "a cadence of zero");
  }
  if (has(json, "band")) checkBandField(c, json.band);
  c.list(json, "urls", (v, field) => checkUrl(c, field, v));
  if (Array.isArray(json.urls) && json.urls.every((u) => typeof u === "string")) {
    const joined = (json.urls as string[]).join(" ").length;
    if (joined > MAX_URLS_CHARS) c.add("urls", "range", `the urls joined by a space are ${joined} characters, over ${MAX_URLS_CHARS}: a segment carries them as one annotation`);
  }
  if (has(json, "retention")) {
    const r = json.retention;
    const ok = typeof r === "string" && ((RETENTION_WORDS as readonly string[]).includes(r) || (parseDuration(r) ?? 0) > 0);
    if (!ok) c.add("retention", "grammar", `not an ISO 8601 duration above zero, nor one of ${RETENTION_WORDS.join(", ")}`);
  }
  if (has(json, "parser") && (typeof json.parser !== "string" || !PARSER_GRAMMAR.test(json.parser))) c.add("parser", "grammar", "not NAME/VERSION, such as thc-lines/1");
  c.list(json, "failure_modes", (v, field) => {
    if (typeof v !== "string" || v.trim() === "") c.add(field, "empty", "a failure mode is a non-empty sentence");
  });
  return c.problems;
}

// A deep copy of a validated source, its fields in SOURCE_FIELDS order.
function normaliseSource(json: Obj): Source {
  const out: Record<string, unknown> = {};
  for (const k of SOURCE_FIELDS) out[k] = json[k];
  const band = json.band as Band;
  out.band = { metric: band.metric, min: band.min, max: band.max, relative: band.relative };
  for (const k of ["datasets", "basis", "urls", "failure_modes"]) out[k] = [...(json[k] as unknown[])];
  return out as unknown as Source;
}

export function validateSource(json: unknown, bits: SourceBits, at = ""): Source {
  const problems = sourceProblems(json, bits, at);
  if (problems.length > 0) throw new SourceError(problems);
  return normaliseSource(json as Obj);
}

function fileProblems(json: unknown, bits: SourceBits, at: string): { problems: Problem[]; sources: Source[] } {
  const c = new Collector(at);
  const sources: Source[] = [];
  if (!isObject(json)) {
    c.add("", "type", "a source.json is an object");
    return { problems: c.problems, sources };
  }
  c.fields(json, ["format", "sources"], ["format", "sources"]);
  if (has(json, "format") && json.format !== SOURCE_FORMAT) c.add("format", "format", `not ${SOURCE_FORMAT}`);
  if (has(json, "sources")) {
    if (!Array.isArray(json.sources)) c.add("sources", "type", "not a list");
    else if (json.sources.length === 0) c.add("sources", "empty", "at least one source");
    else
      json.sources.forEach((s: unknown, i: number) => {
        const p = sourceProblems(s, bits, join(at, `sources[${i}]`));
        c.problems.push(...p);
        if (p.length === 0) sources.push(normaliseSource(s as Obj));
      });
  }
  const seen = new Set<string>();
  for (const s of sources) {
    if (seen.has(s.id)) c.add("sources", "duplicate", `${s.id} is listed twice`);
    seen.add(s.id);
  }
  return { problems: c.problems, sources };
}

export function validateSourceFile(json: unknown, bits: SourceBits, at = ""): SourceFile {
  const { problems, sources } = fileProblems(json, bits, at);
  if (problems.length > 0) throw new SourceError(problems);
  return { format: SOURCE_FORMAT, sources };
}

// config/source-bits.json: ids of the registry grammar, each an integer bit 0 to
// 63, no bit twice, listed in increasing bit order (a new id is appended).
export function validateBits(json: unknown): SourceBits {
  const c = new Collector("config/source-bits.json");
  if (!isObject(json)) throw new SourceError([{ at: c.at, code: "type", detail: "not an object" }]);
  c.fields(json, ["format", "comment", "bits"], ["format", "bits"]);
  if (has(json, "format") && json.format !== BITS_FORMAT) c.add("format", "format", `not ${BITS_FORMAT}`);
  if (has(json, "comment") && typeof json.comment !== "string") c.add("comment", "type", "not a string");
  const out: Record<string, number> = Object.create(null);
  if (has(json, "bits")) {
    const bits = json.bits;
    if (!isObject(bits)) c.add("bits", "type", "not an object");
    else {
      const owner = new Map<number, string>();
      let last = -1;
      for (const [id, bit] of Object.entries(bits)) {
        const at = `bits.${id}`;
        if (!checkId(c, at, id)) continue;
        if (typeof bit !== "number" || !Number.isInteger(bit) || bit < 0 || bit > MAX_BIT) {
          c.add(at, "range", `${JSON.stringify(bit)} is not an integer from 0 to ${MAX_BIT}`);
          continue;
        }
        const other = owner.get(bit);
        if (other !== undefined) c.add(at, "bit-taken", `bit ${bit} belongs to ${other}`);
        else owner.set(bit, id);
        if (bit < last) c.add(at, "order", `bit ${bit} is listed after bit ${last}: a new id is appended with the next bit`);
        last = Math.max(last, bit);
        out[id] = bit;
      }
    }
  }
  if (c.problems.length > 0) throw new SourceError(c.problems);
  return Object.freeze(out);
}

// The append-only rule between two versions of config/source-bits.json: every
// id of `before` keeps its bit in `after`. A bit given twice in `after` is
// validateBits's refusal.
export function bitsAppendOnly(before: SourceBits, after: SourceBits): Problem[] {
  const problems: Problem[] = [];
  for (const id of Object.keys(before)) {
    const at = `config/source-bits.json: bits.${id}`;
    if (!has(after, id)) problems.push({ at, code: "missing", detail: `removed; its bit ${before[id]} stays allocated to it forever` });
    else if (after[id] !== before[id]) problems.push({ at, code: "bit-mismatch", detail: `bit ${before[id]} changed to ${after[id]}` });
  }
  return problems;
}

// Registry order: by bit, then the sources with no bit by id.
function byBit(a: Source, b: Source): number {
  if (a.bit !== null && b.bit !== null) return a.bit - b.bit;
  if (a.bit !== null) return -1;
  if (b.bit !== null) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export interface SourceFileText {
  // The adapter directory under adapters/.
  readonly adapter: string;
  readonly text: string;
}

// The registry of every adapter's source.json. Throws SourceError listing every
// problem of every file, so one run names them all.
export function buildRegistry(files: readonly SourceFileText[], bits: SourceBits): Registry {
  const problems: Problem[] = [];
  const rows: RegistryRow[] = [];
  const where = new Map<string, string>();
  for (const f of files) {
    const at = `adapters/${f.adapter}/source.json`;
    if (!ID_GRAMMAR.test(f.adapter) || f.adapter.length > MAX_ID) {
      problems.push({ at: `adapters/${f.adapter}`, code: "grammar", detail: "an adapter directory is named in the id grammar" });
      continue;
    }
    let json: unknown;
    try {
      json = JSON.parse(f.text);
    } catch (err) {
      problems.push({ at, code: "json", detail: (err as Error).message });
      continue;
    }
    const r = fileProblems(json, bits, at);
    problems.push(...r.problems);
    for (const s of r.sources) {
      const first = where.get(s.id);
      if (first !== undefined) problems.push({ at, code: "duplicate", detail: `${s.id} is also in ${first}` });
      else where.set(s.id, at);
      rows.push({ ...s, adapter: f.adapter });
    }
  }
  if (problems.length > 0) throw new SourceError(problems);
  rows.sort(byBit);
  return { format: REGISTRY_FORMAT, comment: REGISTRY_COMMENT, sources: rows };
}

// The bytes of config/sources.json: two-space JSON and a final newline.
export function renderRegistry(registry: Registry): string {
  return `${JSON.stringify(registry, null, 2)}\n`;
}

// config/sources.json as a reader (DOM-018, DOM-019) checks it before use.
export function validateRegistry(json: unknown, bits: SourceBits): Registry {
  const c = new Collector("config/sources.json");
  if (!isObject(json)) throw new SourceError([{ at: c.at, code: "type", detail: "not an object" }]);
  c.fields(json, ["format", "comment", "sources"], ["format", "comment", "sources"]);
  if (has(json, "format") && json.format !== REGISTRY_FORMAT) c.add("format", "format", `not ${REGISTRY_FORMAT}`);
  if (has(json, "comment") && typeof json.comment !== "string") c.add("comment", "type", "not a string");
  const rows: RegistryRow[] = [];
  if (has(json, "sources")) {
    if (!Array.isArray(json.sources)) c.add("sources", "type", "not a list");
    else
      json.sources.forEach((row: unknown, i: number) => {
        const at = `sources[${i}]`;
        if (!isObject(row)) {
          c.add(at, "type", "a row is an object");
          return;
        }
        const { adapter, ...source } = row;
        if (!has(row, "adapter")) c.add(`${at}.adapter`, "missing", "required");
        else if (typeof adapter !== "string" || !ID_GRAMMAR.test(adapter) || adapter.length > MAX_ID) c.add(`${at}.adapter`, "grammar", "an adapter directory is named in the id grammar");
        const p = sourceProblems(source, bits, join(c.at, at));
        c.problems.push(...p);
        if (p.length === 0 && typeof adapter === "string") rows.push({ ...normaliseSource(source), adapter });
      });
  }
  const ids = new Set<string>();
  rows.forEach((r, i) => {
    if (ids.has(r.id)) c.add(`sources[${i}]`, "duplicate", `${r.id} is listed twice`);
    ids.add(r.id);
    if (i > 0 && byBit(rows[i - 1]!, r) > 0) c.add(`sources[${i}]`, "order", `${r.id} is listed after ${rows[i - 1]!.id}`);
  });
  if (c.problems.length > 0) throw new SourceError(c.problems);
  return { format: REGISTRY_FORMAT, comment: json.comment as string, sources: rows };
}

// Throws ContractError unless value is plain JSON of at most MAX_CURSOR_BYTES.
export function checkCursor(value: unknown, what: string): Cursor {
  let text: string;
  try {
    text = canonicalJson(value);
  } catch (err) {
    if (!(err instanceof JsonError)) throw err;
    throw new ContractError("cursor", `${what}: ${err.message}`);
  }
  const n = utf8(text).length;
  if (n > MAX_CURSOR_BYTES) throw new ContractError("cursor", `${what}: ${n} bytes of JSON, over ${MAX_CURSOR_BYTES}`);
  return value as Cursor;
}

const SEGMENT_FIELDS = Object.freeze(["source", "dataset", "window", "cursorBefore", "cursorAfter", "count", "precision", "bytes", "sha256", "raw"] as const);
const isCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

// Throws ContractError("segment") unless window is ISO 8601 UTC times, start
// before end, both at 00:00:00Z for a `day` source.
export function checkWindow(window: unknown, precision: unknown, what: string): void {
  if (!isObject(window) || Object.keys(window).sort().join(",") !== "end,start") throw new ContractError("segment", `${what}: window is not { start, end }`);
  const { start, end } = window;
  if (!isIsoUtc(start) || !isIsoUtc(end)) throw new ContractError("segment", `${what}: window ${JSON.stringify(window)} is not two ISO 8601 UTC times`);
  if (Date.parse(start) >= Date.parse(end)) throw new ContractError("segment", `${what}: window start ${start} is not before end ${end}`);
  // docs/architecture.md section 2: a day value is never shown as a time of day.
  if (precision === "day" && (Date.parse(start) % 86_400_000 !== 0 || Date.parse(end) % 86_400_000 !== 0)) {
    throw new ContractError("segment", `${what}: a day source's window ${start} to ${end} does not start and end at 00:00:00Z`);
  }
}

export function validateSegment(json: unknown, what: string): Segment {
  if (!isObject(json)) throw new ContractError("segment", `${what}: not an object`);
  for (const k of Object.keys(json)) if (!(SEGMENT_FIELDS as readonly string[]).includes(k)) throw new ContractError("segment", `${what}: unknown field ${k}`);
  for (const k of SEGMENT_FIELDS) if (k !== "raw" && !has(json, k)) throw new ContractError("segment", `${what}: missing ${k}`);
  const s = json as Obj;
  if (typeof s.source !== "string" || !ID_GRAMMAR.test(s.source)) throw new ContractError("segment", `${what}: source ${JSON.stringify(s.source)} is not an id`);
  if (!(DATASETS as readonly unknown[]).includes(s.dataset)) throw new ContractError("segment", `${what}: dataset ${JSON.stringify(s.dataset)} is not one of ${DATASETS.join(", ")}`);
  if (!(PRECISIONS as readonly unknown[]).includes(s.precision)) throw new ContractError("segment", `${what}: precision ${JSON.stringify(s.precision)} is not one of ${PRECISIONS.join(", ")}`);
  checkWindow(s.window, s.precision, what);
  checkCursor(s.cursorBefore, `${what}: cursorBefore`);
  checkCursor(s.cursorAfter, `${what}: cursorAfter`);
  if (!isCount(s.count)) throw new ContractError("segment", `${what}: count ${JSON.stringify(s.count)} is not a whole number`);
  if (!isCount(s.bytes)) throw new ContractError("segment", `${what}: bytes ${JSON.stringify(s.bytes)} is not a whole number`);
  if (typeof s.sha256 !== "string" || !SHA256.test(s.sha256)) throw new ContractError("segment", `${what}: sha256 is not 64 lowercase hex digits`);
  if (has(s, "raw")) {
    const raw = s.raw;
    if (!isObject(raw) || Object.keys(raw).sort().join(",") !== "bytes,sha256" || !isCount(raw.bytes) || typeof raw.sha256 !== "string" || !SHA256.test(raw.sha256)) {
      throw new ContractError("segment", `${what}: raw is not { bytes, sha256 }`);
    }
  }
  return s as unknown as Segment;
}
