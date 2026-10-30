// packages/ghcr/src/layout.ts — where everything of this project lives in GHCR
// (docs/architecture.md sections 4.1 and 4.2): the namespace, the eight
// packages, the artifact types, and the one builder of each tag shape.
//
//   repoOf("ref")                                          "pkgforge-dev/domains.pkgforge.dev/ref"
//   segTag("oi-cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z")
//                                                          "oi-cs.20261026t080000z.20261026t081000z"
//   segTag("oi-cs", same window, "d")                      "oi-cs.20261026t080000z.20261026t081000z-d"
//   rawTag("oi-cs", same window)                           "raw-oi-cs.20261026t080000z.20261026t081000z"
//   fileTag("thc-ct", "2026-10-26", SHA256)                "thc-ct.20261026.0232f4df0831"
//   fileTag("thc-ct", "2026-10-26", SHA256, "d")           "thc-ct.20261026.0232f4df0831-d"
//   tierTag("names", "w", "2026-10-26T00:00:00Z")          "names-w-2026w44"
//   tierTag("names", "d", "2026-10-26T00:00:00Z", 2)       "names-d-20261026-r2"
//   nextTierTag("names", "d", "2026-10-26T00:00:00Z", ["names-d-20261026"])
//                                                          "names-d-20261026-r2"
//   parseTierTag("names-d-20261026-r2")                    { base: "names-d-20261026", dataset: "names", tier: "d",
//                                                            start: "2026-10-26T00:00:00Z", rebuild: 2 }
//   rootTag("2026-10-29T05:13:00Z")                        "r-20261029t051300z"
//   stateTag("2026-10-29")                                 "state-20261029"
//   stateRunTag("2026-10-30T08:30:12Z")                    "state-20261030t083012z"
//   ledgerFilterTag("2026-10-27")                          "ledger-filter-20261027"
//   LEDGER_DELTA_TAG                                       "ledger-delta"
//   ledgerDeltaRunTag("2026-10-30T09:00:41Z")              "ledger-delta-20261030t090041z"
//   refTag("psl", SHA256)                                  "psl-0232f4df0831"
//
// Every builder returns a lowercase tag that matches TAG and throws LayoutError
// otherwise: GHCR resolves tags without regard to case, so two spellings of
// one tag are one tag, and every tag here is lowercase (section 4.1). A tag
// that ends in -r and digits is a rebuild of a tier pack's span (ruling 25,
// section 4.7 rule 2): checkTag accepts it on a tier tag alone, as -r2 and up
// with no leading zero, so a segment, a root, a state, a ref or a file
// variant never takes a tag that reads as a rebuild. A time is
// an ISO 8601 UTC string `YYYY-MM-DDTHH:MM:SSZ` or a Date, and must fall on a
// whole second: a tag has second precision, so two windows that differ below
// it would share a tag. TODO/ingest.md DOM-024 fixes the time form
// `YYYYMMDDTHHMMSSZ`, lowercased here. A tier's span starts on its boundary
// (an hour, a day, a Monday, the first of a month, the first of a year), or
// the builder throws: a misaligned span would name a pack the live-set rule of
// section 4.5 cannot place.
//
// Runs in Node and in workerd alike: it imports nothing.

export class LayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LayoutError";
  }
}

export const REGISTRY_HOST = "ghcr.io";
export const OWNER = "pkgforge-dev";
// The repository's own name, as mirror-archlinux does it (section 4.1).
export const NAMESPACE = `${OWNER}/domains.pkgforge.dev`;
export const SOURCE_URL = "https://github.com/pkgforge-dev/domains.pkgforge.dev";

// The eight packages of section 4.1. A push names one of these and nothing else:
// a push to a misspelt name would create a package, and nothing is ever deleted
// from GHCR (ruling 5), so the stray package would stay for good.
export const PACKAGES = Object.freeze(["root", "obs", "names", "feed", "rev", "dumps", "state", "ref"] as const);
export type PackageName = (typeof PACKAGES)[number];

// The OCI distribution grammar of one path component.
const COMPONENT = /^[a-z0-9]+(?:(?:\.|_|__|-+)[a-z0-9]+)*$/;
// A tag (section 4.1), lowercase only.
export const TAG = /^[a-z0-9_][a-z0-9._-]{0,127}$/;
// A source id: packages/adapter/src/validate.ts ID_GRAMMAR and MAX_ID, which
// packages/ghcr/test/layout.test.ts holds equal to these.
export const SOURCE_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SOURCE_ID = 63;
// The start of every raw lane tag (rawTag). A source id never starts with it,
// so segTag of one source is never rawTag of another: `raw-oi-cs.<window>` is
// oi-cs's raw lane object, and no source `raw-oi-cs` writes a segment there.
export const RAW_PREFIX = "raw-";
// The run annotation of a manifest, dev.pkgforge.domains.run: a workflow run
// id (GITHUB_RUN_ID), digits with no leading zero, at most 20. packManifest of
// @domains/compact and the scripts hold a run to it; the state's RUN_ID
// (@domains/state) is this or "local".
export const WORKFLOW_RUN_ID = /^[1-9][0-9]{0,19}$/;
// The longest annotation value scripts/ghcr/push.mjs takes, in characters.
// annotationProblem holds every value to it: the push tool, packManifest of
// @domains/compact and the disk writer of scripts/ingest/ apply that one rule.
export const ANNOTATION_MAX_CHARS = 1024;

// The artifact kinds of section 4.2. `ref` is the kind of the objects of the
// `ref` package (the PSL, the CT log list, sources.json): one layer, the file
// as fetched or as committed.
export const ARTIFACT_KINDS = Object.freeze(["pack", "segment", "root", "state", "rawchunk", "raw", "ref"] as const);
export type ArtifactKind = (typeof ARTIFACT_KINDS)[number];

// The datasets of section 3.3 that tier packs hold, and the package of each.
export const TIER_DATASETS = Object.freeze({ names: "names", domains: "names", feed: "feed", "new-name": "feed", rev: "rev" } as const);
export type TierDataset = keyof typeof TIER_DATASETS;
// The tiers of section 4.5 above `seg`, which has no tier tag.
export const TIERS = Object.freeze(["h", "d", "w", "m", "y"] as const);
export type Tier = (typeof TIERS)[number];
// The objects of the `ref` package.
export const REF_KINDS = Object.freeze(["psl", "ctlogs", "sources"] as const);
export type RefKind = (typeof REF_KINDS)[number];

// The tags that move are `latest` of `root` and of `state`, and
// LEDGER_DELTA_TAG of `state` (section 4.7): every other tag is write-once.
// Each moves by a write-once run tag first (rootTag, stateRunTag,
// ledgerDeltaRunTag), then a guarded `oras tag` (DOM-024).
export const LATEST = "latest";

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

const notTag = (tag: unknown): LayoutError => new LayoutError(`${JSON.stringify(tag)} is not a tag: lowercase letters, digits, _ . and -, at most 128 characters, not starting with . or -`);

// The rebuild suffix of ruling 25, as a tag ends in it: the tag before it and
// the digits. Only a tier tag takes it (parseTierTag).
const REBUILD = /^(.+)-r([0-9]+)$/;

// `tag` when it is a tag of this project, else LayoutError. A tag that ends
// in the rebuild suffix is held to parseTierTag: a tier tag of a valid span,
// with -r2 and up.
export function checkTag(tag: unknown): string {
  if (typeof tag !== "string" || !TAG.test(tag)) throw notTag(tag);
  if (REBUILD.test(tag)) parseTierTag(tag);
  return tag;
}

// The repository path of a package of the namespace. Any component name reads
// (the measurement package `probe` among them); checkPackage is the writer's.
export function repoOf(name: string): string {
  if (typeof name !== "string" || !COMPONENT.test(name)) throw new LayoutError(`${JSON.stringify(name)} is not a package name: lowercase letters and digits joined by . _ __ or -`);
  return `${NAMESPACE}/${name}`;
}

// `name` when it is one of the eight packages, else LayoutError.
export function checkPackage(name: unknown): PackageName {
  if (!isOneOf(PACKAGES, name)) throw new LayoutError(`${JSON.stringify(name)} is not one of the packages ${PACKAGES.join(", ")}`);
  return name;
}

export function artifactType(kind: ArtifactKind): string {
  if (!isOneOf(ARTIFACT_KINDS, kind)) throw new LayoutError(`${JSON.stringify(kind)} is not an artifact kind: ${ARTIFACT_KINDS.join(", ")}`);
  return `application/vnd.pkgforge.domains.${kind}.v1`;
}

// The package a tier pack of `dataset` goes to.
export function packageOfDataset(dataset: TierDataset): PackageName {
  if (!Object.hasOwn(TIER_DATASETS, dataset)) throw new LayoutError(`${JSON.stringify(dataset)} is not a dataset with tiers: ${Object.keys(TIER_DATASETS).join(", ")}`);
  return TIER_DATASETS[dataset];
}

const ISO_SECOND = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

// A time as a Date on a whole second, from `YYYY-MM-DDTHH:MM:SSZ` or a Date.
function instant(t: Date | string, what: string): Date {
  let d: Date;
  if (t instanceof Date) {
    d = new Date(t.getTime());
  } else if (typeof t === "string" && ISO_SECOND.test(t)) {
    d = new Date(t);
    // Date.parse rolls 2026-02-30 over to March; a round trip catches it.
    if (Number.isNaN(d.getTime()) || d.toISOString().replace(".000Z", "Z") !== t) throw new LayoutError(`${what} ${JSON.stringify(t)} is not a calendar time`);
  } else {
    throw new LayoutError(`${what} ${JSON.stringify(t)} is not a time: give YYYY-MM-DDTHH:MM:SSZ or a Date`);
  }
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new LayoutError(`${what} is an invalid Date`);
  if (ms % 1000 !== 0) throw new LayoutError(`${what} ${d.toISOString()} is not on a whole second; a tag has second precision`);
  if (d.getUTCFullYear() < 1000 || d.getUTCFullYear() > 9999) throw new LayoutError(`${what} ${d.toISOString()} is outside the years 1000 to 9999`);
  return d;
}

// A day as a Date at 00:00:00Z, from `YYYY-MM-DD`, `YYYY-MM-DDT00:00:00Z` or a Date.
function day(t: Date | string, what: string): Date {
  const d = typeof t === "string" && ISO_DAY.test(t) ? instant(`${t}T00:00:00Z`, what) : instant(t, what);
  if (d.getTime() % 86_400_000 !== 0) throw new LayoutError(`${what} ${d.toISOString()} is not 00:00:00Z of a day`);
  return d;
}

const pad = (n: number, w: number): string => String(n).padStart(w, "0");
const ymd = (d: Date): string => `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1, 2)}${pad(d.getUTCDate(), 2)}`;
// `YYYYMMDDTHHMMSSZ`, lowercased.
const stamp = (d: Date): string => `${ymd(d)}t${pad(d.getUTCHours(), 2)}${pad(d.getUTCMinutes(), 2)}${pad(d.getUTCSeconds(), 2)}z`;

function sourceId(source: unknown): string {
  if (typeof source !== "string" || !SOURCE_ID.test(source) || source.length > MAX_SOURCE_ID) {
    throw new LayoutError(`${JSON.stringify(source)} is not a source id: lowercase letters and digits joined by single dashes, at most ${MAX_SOURCE_ID} characters`);
  }
  if (source.startsWith(RAW_PREFIX)) throw new LayoutError(`${JSON.stringify(source)} is not a source id: ${RAW_PREFIX} begins the raw lane's tags, so no source id takes it`);
  return source;
}

// The first 12 hex digits of a sha256: 64 hex digits, `sha256:` and 64, or the 12 alone.
function sha12(sha: unknown): string {
  const m = typeof sha === "string" ? /^(?:sha256:)?([0-9a-f]{64})$|^([0-9a-f]{12})$/.exec(sha) : null;
  if (!m) throw new LayoutError(`${JSON.stringify(sha)} is not a sha256: 64 lowercase hex digits, with or without sha256:, or the first 12`);
  return (m[1] ?? m[2] ?? "").slice(0, 12);
}

function windowOf(start: Date | string, end: Date | string): [string, string] {
  const s = instant(start, "the window start");
  const e = instant(end, "the window end");
  if (s.getTime() >= e.getTime()) throw new LayoutError(`the window start ${s.toISOString()} is not before its end ${e.toISOString()}`);
  return [stamp(s), stamp(e)];
}

// The suffix `-<variant>` of a segment or file tag, none without one: 1 to 8
// lowercase letters or digits.
function variantSuffix(variant: unknown): string {
  if (variant === undefined) return "";
  if (typeof variant !== "string" || !/^[a-z0-9]{1,8}$/.test(variant)) throw new LayoutError(`the variant ${JSON.stringify(variant)} is not 1 to 8 lowercase letters or digits`);
  return `-${variant}`;
}

// `<source>.<window start>.<window end>`: a segment of a windowed source
// (`obs`). `variant` names the dataset of a second segment of the same window,
// as `-d` names a stream source's domains segment beside its names segment
// (DOM-024).
export function segTag(source: string, start: Date | string, end: Date | string, variant?: string): string {
  const [s, e] = windowOf(start, end);
  return checkTag(`${sourceId(source)}.${s}.${e}${variantSuffix(variant)}`);
}

// `raw-<source>.<window start>.<window end>`: the raw lane of `obs` (section 3.4).
export function rawTag(source: string, start: Date | string, end: Date | string): string {
  const [s, e] = windowOf(start, end);
  return checkTag(`raw-${sourceId(source)}.${s}.${e}`);
}

// `<source>.<YYYYMMDD>.<sha12>`: a segment of a file source (`obs`), where sha12
// is of the file as fetched. `variant` names a second segment of the same file,
// as `-d` names THC's domains segment beside its names segment (DOM-029).
export function fileTag(source: string, date: Date | string, sha256: string, variant?: string): string {
  const suffix = variantSuffix(variant);
  return checkTag(`${sourceId(source)}.${ymd(day(date, "the file date"))}.${sha12(sha256)}${suffix}`);
}

// Why `value` is not an annotation value the push tool takes, or null: a
// string of 1 to ANNOTATION_MAX_CHARS characters with no control character
// (U+0000 to U+001F, U+007F), as `--annotation KEY=VALUE` passes it to oras.
export function annotationProblem(value: unknown): string | null {
  if (typeof value !== "string") return `is ${value === null ? "null" : typeof value}, not a string`;
  if (value === "") return "is empty";
  if (value.length > ANNOTATION_MAX_CHARS) return `is ${value.length} characters, over ${ANNOTATION_MAX_CHARS}`;
  if (/[\u0000-\u001f\u007f]/.test(value)) return "holds a control character";
  return null;
}

const SOURCE_PART = /^([a-z0-9]+(?:-[a-z0-9]+)*)\./;
const FILE_FORM = /^[a-z0-9-]+\.[0-9]{8}\.([0-9a-f]{12})(?:-[a-z0-9]{1,8})?$/;

// Why `tag` is not the tag of a `dataset` segment (names or domains) from
// start to end, or null: segTag of the window, or fileTag of the window's
// first day for a file segment, with the dataset's variant (none for names,
// `d` for domains; DOM-024). `source`, when known, must be the tag's. The
// disk writer, packManifest of a segment and the state's readers hold a
// segment's tag to its facts with this one rule.
export function segmentTagProblem(tag: string, dataset: string, start: string, end: string, source?: string): string | null {
  if (typeof tag !== "string") return `${JSON.stringify(tag)} is not a tag`;
  if (dataset !== "names" && dataset !== "domains") return `${tag}: a segment holds names or domains, not ${JSON.stringify(dataset)}`;
  const own = SOURCE_PART.exec(tag)?.[1];
  const src = source ?? own;
  if (src === undefined) return `${tag} is not <source>.<start>.<end>[-d] nor <source>.<YYYYMMDD>.<sha12>[-d]`;
  const variant = dataset === "domains" ? "d" : undefined;
  const file = FILE_FORM.exec(tag);
  let want: string;
  try {
    want = file !== null ? fileTag(src, start, file[1] ?? "", variant) : segTag(src, start, end, variant);
  } catch (e) {
    if (e instanceof LayoutError) return `${tag}: a ${dataset} segment of ${src} from ${start} to ${end} has no tag: ${e.message}`;
    throw e;
  }
  return want === tag ? null : `${tag} is not the tag of a ${dataset} segment of ${src} from ${start} to ${end}, which is ${want}`;
}

// ISO 8601 week-year and week of a Monday: the week holding its Thursday.
function isoWeek(monday: Date): [number, number] {
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  return [year, Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1];
}

// The suffix of build `rebuild` of a span (ruling 25): none for the first
// build (no number, or 1), `-rN` for a rebuild, N from 2.
function rebuildSuffix(rebuild: unknown): string {
  if (rebuild === undefined || rebuild === 1) return "";
  if (typeof rebuild !== "number" || !Number.isSafeInteger(rebuild) || rebuild < 2) {
    const shown = typeof rebuild === "number" ? String(rebuild) : JSON.stringify(rebuild);
    throw new LayoutError(`the rebuild ${shown} is not a whole number from 2: the first build of a span carries no suffix (give none, or 1), and its rebuilds take -r2, -r3 and up (ruling 25)`);
  }
  return `-r${rebuild}`;
}

// `<dataset>-<tier>-<span>` (sections 4.1 and 4.5): `names-h-2026102608`,
// `names-d-20261026`, `names-w-2026w44`, `rev-m-202609`, `names-y-2026`. `start`
// is the first second of the span. `rebuild` names a rebuild of the span:
// with 2 and up the tag ends in `-rN`, `names-d-20261026-r2`, since a tag is
// write-once and nothing is deleted from GHCR (section 4.7 rules 1 and 2,
// ruling 25); with none, or 1, it is the first build's tag.
export function tierTag(dataset: TierDataset, tier: Tier, start: Date | string, rebuild?: number): string {
  packageOfDataset(dataset);
  if (!isOneOf(TIERS, tier)) throw new LayoutError(`${JSON.stringify(tier)} is not a tier: ${TIERS.join(", ")}`);
  const d = instant(start, "the span start");
  const at = `the span start ${d.toISOString()}`;
  const midnight = d.getTime() % 86_400_000 === 0;
  let span: string;
  switch (tier) {
    case "h":
      if (d.getTime() % 3_600_000 !== 0) throw new LayoutError(`${at} is not the start of an hour`);
      span = `${ymd(d)}${pad(d.getUTCHours(), 2)}`;
      break;
    case "d":
      if (!midnight) throw new LayoutError(`${at} is not the start of a day`);
      span = ymd(d);
      break;
    case "w": {
      if (!midnight || d.getUTCDay() !== 1) throw new LayoutError(`${at} is not 00:00:00Z of a Monday, the start of an ISO week`);
      const [year, week] = isoWeek(d);
      span = `${pad(year, 4)}w${pad(week, 2)}`;
      break;
    }
    case "m":
      if (!midnight || d.getUTCDate() !== 1) throw new LayoutError(`${at} is not the start of a month`);
      span = `${pad(d.getUTCFullYear(), 4)}${pad(d.getUTCMonth() + 1, 2)}`;
      break;
    case "y":
      if (!midnight || d.getUTCDate() !== 1 || d.getUTCMonth() !== 0) throw new LayoutError(`${at} is not the start of a year`);
      span = pad(d.getUTCFullYear(), 4);
      break;
  }
  return checkTag(`${dataset}-${tier}-${span}${rebuildSuffix(rebuild)}`);
}

// A tier tag read back: the tag its span gives (`base`), the dataset, the
// tier, the span's first second, and the build of the span (`rebuild`: 1 for
// the first build, which carries no suffix, N for `-rN`).
export interface TierTagParts {
  readonly base: string;
  readonly dataset: TierDataset;
  readonly tier: Tier;
  readonly start: string;
  readonly rebuild: number;
}

// The span of each tier as its tag writes it, read back to the span's start.
const SPAN_FORMS: Readonly<Record<Tier, RegExp>> = Object.freeze({
  h: /^(\d{4})(\d{2})(\d{2})(\d{2})$/,
  d: /^(\d{4})(\d{2})(\d{2})$/,
  w: /^(\d{4})w(\d{2})$/,
  m: /^(\d{4})(\d{2})$/,
  y: /^(\d{4})$/,
});
const TIER_BASE = /^(.+)-([a-z])-([0-9w]+)$/;
const DAY_MS = 86_400_000;

// The Monday that starts ISO week `week` of ISO week-year `year`: week 1 holds
// 4 January. A week the year does not have gives another year's tag, which
// the round trip of parseTierTag refuses.
function isoWeekStart(year: number, week: number): string {
  const jan4 = Date.UTC(year, 0, 4);
  const monday = jan4 - ((new Date(jan4).getUTCDay() + 6) % 7) * DAY_MS + (week - 1) * 7 * DAY_MS;
  return new Date(monday).toISOString().replace(".000Z", "Z");
}

// `tag` read as a tier tag, `<dataset>-<tier>-<span>` with an optional
// `-rN` (N from 2 to 2^53 - 1, no leading zero), or LayoutError. The base
// must be the tag tierTag gives the span it names, so a span off its boundary
// or off the calendar (hour 24, 30 February, a week 53 the year lacks) is
// refused.
export function parseTierTag(tag: unknown): TierTagParts {
  if (typeof tag !== "string" || !TAG.test(tag)) throw notTag(tag);
  const r = REBUILD.exec(tag);
  const base = r === null ? tag : (r[1] ?? "");
  const fail = (why: string): LayoutError =>
    new LayoutError(
      r === null
        ? `${tag} is not a tier tag <dataset>-<tier>-<span>: ${why}`
        : `${tag} carries the rebuild suffix -r${r[2]}, which only a tier tag takes, <dataset>-<tier>-<span>-rN (ruling 25): ${why}`,
    );
  const b = TIER_BASE.exec(base);
  if (b === null) throw fail(`${base} is not <dataset>-<tier>-<span>`);
  const [, dataset = "", tier = "", span = ""] = b;
  if (!Object.hasOwn(TIER_DATASETS, dataset)) throw fail(`${JSON.stringify(dataset)} is not a dataset with tiers: ${Object.keys(TIER_DATASETS).join(", ")}`);
  if (!isOneOf(TIERS, tier)) throw fail(`${JSON.stringify(tier)} is not a tier: ${TIERS.join(", ")}`);
  const s = SPAN_FORMS[tier].exec(span);
  if (s === null) throw fail(`${span} is not the span of a pack of tier ${tier}`);
  let start: string;
  switch (tier) {
    case "h":
      start = `${s[1]}-${s[2]}-${s[3]}T${s[4]}:00:00Z`;
      break;
    case "d":
      start = `${s[1]}-${s[2]}-${s[3]}T00:00:00Z`;
      break;
    case "w":
      start = isoWeekStart(Number(s[1]), Number(s[2]));
      break;
    case "m":
      start = `${s[1]}-${s[2]}-01T00:00:00Z`;
      break;
    case "y":
      start = `${s[1]}-01-01T00:00:00Z`;
      break;
  }
  let want: string;
  try {
    want = tierTag(dataset as TierDataset, tier, start);
  } catch (e) {
    if (e instanceof LayoutError) throw fail(e.message);
    throw e;
  }
  if (want !== base) throw fail(`the span ${span} is not a span of tier ${tier}: its start ${start} gives ${want}`);
  let rebuild = 1;
  if (r !== null) {
    const digits = r[2] ?? "";
    rebuild = Number(digits);
    if (digits !== String(rebuild) || !Number.isSafeInteger(rebuild) || rebuild < 2) {
      throw new LayoutError(`${tag} carries -r${digits}: a rebuild of a span is -r2, -r3 and up, with no leading zero, and the first build carries no suffix (ruling 25)`);
    }
  }
  return { base, dataset: dataset as TierDataset, tier, start, rebuild };
}

// The tag the next build of a span takes, given `existing`, every tag of the
// package (all the pages of its tag list): the span's tag when no build of it
// is listed, else its tag with -rN, N one above the highest build listed. A
// listed tag of another form is not a build of the span, and no tag this
// gives equals it, so it is passed over. GHCR resolves tags without regard to case
// (section 4.1), so each is read lowercased. A tag left out of `existing` may
// be named again; the push then finds another digest under it and stops the
// job (section 4.7 rule 1). A re-run of a build already pushed finds its own
// tag by its digest first: this names a tag for bytes no tag of the span holds.
export function nextTierTag(dataset: TierDataset, tier: Tier, start: Date | string, existing: Iterable<string>): string {
  const base = tierTag(dataset, tier, start);
  if (existing === null || typeof existing !== "object" || typeof (existing as Partial<Iterable<unknown>>)[Symbol.iterator] !== "function") {
    throw new LayoutError("the existing tags are not a list of tags");
  }
  let last = 0;
  for (const t of existing as Iterable<unknown>) {
    if (typeof t !== "string") throw new LayoutError(`the existing tags hold a ${t === null ? "null" : typeof t}, which is not a tag`);
    const lower = t.toLowerCase();
    if (lower !== base && !lower.startsWith(`${base}-r`)) continue;
    let parts: TierTagParts;
    try {
      parts = parseTierTag(lower);
    } catch (e) {
      if (e instanceof LayoutError) continue;
      throw e;
    }
    if (parts.base === base && parts.rebuild > last) last = parts.rebuild;
  }
  // parseTierTag reads N up to 2^53 - 1 (Number.MAX_SAFE_INTEGER), above
  // which a double skips whole numbers: a span whose last build has that N
  // has no next tag.
  if (last >= Number.MAX_SAFE_INTEGER) throw new LayoutError(`${base}-r${last} is the highest build a tag numbers: no later build of the span has a tag`);
  return tierTag(dataset, tier, start, last + 1);
}

// `r-<YYYYMMDDTHHMMSSZ>`: a root, write-once (section 4.6); DOM-020 writes it
// as `r-YYYYMMDDTHHMMSSZ`, lowercased here like every tag.
export function rootTag(at: Date | string): string {
  return checkTag(`r-${stamp(instant(at, "the root time"))}`);
}

// `state-<YYYYMMDD>`: the daily snapshot of the cursors, write-once (DOM-024).
export function stateTag(date: Date | string): string {
  return checkTag(`state-${ymd(day(date, "the state date"))}`);
}

// `state-<YYYYMMDDTHHMMSSZ>`: one state of the package `state`, write-once,
// at its `updated`. `latest` of `state` moves to it under the state guard
// (DOM-024), as `latest` of `root` moves to `r-<created>`.
export function stateRunTag(at: Date | string): string {
  return checkTag(`state-${stamp(instant(at, "the state time"))}`);
}

// `ledger-filter-<YYYYMMDD>`: the provisional filter of the package `state`
// that holds the domains table through the end of that UTC day, write-once
// (docs/format.md section 15, DOM-023). `date` is the day, `YYYY-MM-DD`, its
// start `YYYY-MM-DDT00:00:00Z`, or a Date at that start.
export function ledgerFilterTag(date: Date | string): string {
  return checkTag(`ledger-filter-${ymd(day(date, "the filter date"))}`);
}

// The delta of the provisional filter in the package `state`: the hashes of
// the domains first seen after its filter's as_of. It moves under the state
// guard of DOM-024, like `state` (docs/format.md section 15).
export const LEDGER_DELTA_TAG = "ledger-delta";

// `ledger-delta-<YYYYMMDDTHHMMSSZ>`: one delta of the package `state`,
// write-once, at the time it was built for its move. LEDGER_DELTA_TAG moves to
// it under the state guard (DOM-024).
export function ledgerDeltaRunTag(at: Date | string): string {
  return checkTag(`${LEDGER_DELTA_TAG}-${stamp(instant(at, "the delta time"))}`);
}

// `<kind>-<sha12>`: an object of the `ref` package, sha12 of its bytes.
export function refTag(kind: RefKind, sha256: string): string {
  if (!isOneOf(REF_KINDS, kind)) throw new LayoutError(`${JSON.stringify(kind)} is not a ref kind: ${REF_KINDS.join(", ")}`);
  return checkTag(`${kind}-${sha12(sha256)}`);
}
