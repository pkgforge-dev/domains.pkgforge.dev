// packages/ghcr/src/layout.ts — where everything of this project lives in GHCR
// (docs/architecture.md sections 4.1 and 4.2): the namespace, the eight
// packages, the artifact types, and the one builder of each tag shape.
//
//   repoOf("ref")                                          "pkgforge-dev/domains.pkgforge.dev/ref"
//   segTag("oi-cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z")
//                                                          "oi-cs.20261026t080000z.20261026t081000z"
//   rawTag("oi-cs", same window)                           "raw-oi-cs.20261026t080000z.20261026t081000z"
//   fileTag("thc-ct", "2026-10-26", SHA256)                "thc-ct.20261026.0232f4df0831"
//   fileTag("thc-ct", "2026-10-26", SHA256, "d")           "thc-ct.20261026.0232f4df0831-d"
//   tierTag("names", "w", "2026-10-26T00:00:00Z")          "names-w-2026w44"
//   rootTag("2026-10-29T05:13:00Z")                        "r-20261029t051300z"
//   stateTag("2026-10-29")                                 "state-20261029"
//   refTag("psl", SHA256)                                  "psl-0232f4df0831"
//
// Every builder returns a lowercase tag that matches TAG and throws LayoutError
// otherwise: GHCR resolves tags without regard to case, so two spellings of
// one tag are one tag, and every tag here is lowercase (section 4.1). A time is
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

// The two tags that move (section 4.7): every other tag is write-once.
export const LATEST = "latest";
export const STATE = "state";

const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

// `tag` when it is a tag of this project, else LayoutError.
export function checkTag(tag: unknown): string {
  if (typeof tag !== "string" || !TAG.test(tag)) throw new LayoutError(`${JSON.stringify(tag)} is not a tag: lowercase letters, digits, _ . and -, at most 128 characters, not starting with . or -`);
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

// `<source>.<window start>.<window end>`: a segment of a windowed source (`obs`).
export function segTag(source: string, start: Date | string, end: Date | string): string {
  const [s, e] = windowOf(start, end);
  return checkTag(`${sourceId(source)}.${s}.${e}`);
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
  if (variant !== undefined && (typeof variant !== "string" || !/^[a-z0-9]{1,8}$/.test(variant)))
    throw new LayoutError(`the variant ${JSON.stringify(variant)} is not 1 to 8 lowercase letters or digits`);
  return checkTag(`${sourceId(source)}.${ymd(day(date, "the file date"))}.${sha12(sha256)}${variant === undefined ? "" : `-${variant}`}`);
}

// ISO 8601 week-year and week of a Monday: the week holding its Thursday.
function isoWeek(monday: Date): [number, number] {
  const thursday = new Date(monday.getTime() + 3 * 86_400_000);
  const year = thursday.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  return [year, Math.floor((thursday.getTime() - jan1) / 86_400_000 / 7) + 1];
}

// `<dataset>-<tier>-<span>` (sections 4.1 and 4.5): `names-h-2026102608`,
// `names-d-20261026`, `names-w-2026w44`, `rev-m-202609`, `names-y-2026`. `start`
// is the first second of the span.
export function tierTag(dataset: TierDataset, tier: Tier, start: Date | string): string {
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
  return checkTag(`${dataset}-${tier}-${span}`);
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

// `<kind>-<sha12>`: an object of the `ref` package, sha12 of its bytes.
export function refTag(kind: RefKind, sha256: string): string {
  if (!isOneOf(REF_KINDS, kind)) throw new LayoutError(`${JSON.stringify(kind)} is not a ref kind: ${REF_KINDS.join(", ")}`);
  return checkTag(`${kind}-${sha12(sha256)}`);
}
