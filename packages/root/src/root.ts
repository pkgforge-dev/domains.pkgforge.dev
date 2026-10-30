// packages/root/src/root.ts — root.json, the machine contract of
// docs/architecture.md section 4.6, and the rules that hold it:
//
//   validateRoot(json)                the schema, the live-set rule, the derived fields; a
//                                     `format` other than domains.root.v1 is refused
//   validateRoot(json, { strict: false })   a reader's form: unknown fields and datasets are ignored
//   checkForward(live, next)          next is above live: root_seq grows; as_of, corpus_since and through never shrink
//   derive(datasets)                  as_of, corpus_since, through, counts and psl_live of the packs
//   carryWithdrawn(list, createdMs)   the withdrawn entries a root created then keeps, sorted
//
// A root (format domains.root.v1) holds:
//   root_seq      a whole number from 1 that only grows
//   as_of         the latest span end of a live pack, or null when the root names none
//   created       when the promotion built it; the dated tag r-<created> names it
//   previous      the manifest digest of the root it replaced; null only for root_seq 1
//   psl           the sha256 of the PSL pinned at promotion (ref:psl-<sha12>)
//   psl_live      the sorted sha256 of every list a live pack was built under (ruling 22)
//   corpus_since  per dataset, the first span start of its packs
//   gaps          per source, the days it is known to lack (YYYY-MM-DD), carried forward
//   through       per source, the latest span end of a live pack that carries it
//   counts        per dataset, its packs and records
//   datasets      per dataset, its live packs, in span order; a pack of feed or
//                 new-name may list `time`, its time copy (docs/format.md
//                 section 14): { idx, parts }, the digests and sizes of its
//                 layers time.idx and time.part.NNN. It is absent when the pack
//                 has none, never null, and no other dataset lists it
//   withdrawn     the manifests a rollback took out of the live set, each with
//                 `at`, the created of the root that withdrew it, sorted by
//                 manifest; [] in the first root. No live pack names one, and
//                 every root drops an entry more than WITHDRAWN_DAYS before
//                 its created
// Every derived field is computed again from the packs and must be equal: a
// value in two places is held equal here, never trusted.
//
// The live-set rule of section 4.5, as this package holds it, per dataset:
//   - a compacted pack (tier h, d, w, m or y) spans exactly its tier unit,
//     aligned (an hour, a day, an ISO week from Monday, a month, a year), and
//     its tag is tierTag(dataset, tier, start), or that tag with -rN, N from
//     2, for a rebuild of the span (ruling 25: a tag is write-once);
//   - two compacted packs never overlap;
//   - two packs that share a source never overlap: a merge that left the packs
//     it replaced in the set is refused here;
//   - in names, domains and rev (SEGMENT_OVERLAP) a segment may overlap another
//     pack whose sources it does not share (the THC day segment beside the
//     hour packs of the live lanes): the one exception to the disjoint spans
//     of section 4.5. feed and new-name have none: no two of their packs overlap;
//   - the union of the spans is one interval from corpus_since: no hole;
//   - the packs are listed by span start, then the higher tier first, then
//     repository and tag, and no manifest digest appears twice in the root.
//
// Runs in Node and in workerd alike: it imports nothing from `node:`.
import { checkTag, LayoutError, MAX_SOURCE_ID, NAMESPACE, PACKAGES, packageOfDataset, parseTierTag, repoOf, SOURCE_ID, TIER_DATASETS, TIERS, type TierDataset, tierTag } from "@domains/ghcr";
import { DATASET_FEED_TIME, DATASET_NEW_NAME_TIME, IDX_HEADER_BYTES, PART_HEADER_BYTES } from "@domains/pack";
import { RootError } from "./errors.ts";

export const ROOT_FORMAT = "domains.root.v1";
// The tiers of section 4.5 from the lowest: `seg` is an adapter's segment.
export const ROOT_TIERS = Object.freeze(["seg", ...TIERS] as const);
export type RootTier = (typeof ROOT_TIERS)[number];
// The datasets a root lists packs of: those of section 3.3 that have tiers.
export const DATASETS: readonly TierDataset[] = Object.freeze(Object.keys(TIER_DATASETS) as TierDataset[]);
// The fields of root.json and of a pack entry, in the order they are written.
export const ROOT_FIELDS = Object.freeze(["format", "root_seq", "as_of", "created", "previous", "psl", "psl_live", "corpus_since", "gaps", "through", "counts", "datasets", "withdrawn"] as const);
export const PACK_FIELDS = Object.freeze(["repo", "tag", "tier", "span", "manifest", "pack", "idx", "parts", "count", "key_min", "key_max", "sources", "psl"] as const);
// A pack entry's optional field, written after `parts` when the pack has a time copy.
export const PACK_OPTIONAL_FIELDS = Object.freeze(["time"] as const);
export const TIME_FIELDS = Object.freeze(["idx", "parts"] as const);
// The datasets whose packs may carry a time copy, and the dataset byte its
// index holds (docs/format.md section 14.1: 6 for feed, 7 for new-name).
export const TIME_DATASETS: Readonly<Partial<Record<TierDataset, number>>> = Object.freeze({ feed: DATASET_FEED_TIME, "new-name": DATASET_NEW_NAME_TIME });
// The tiers whose packs of those datasets carry their time copy when they hold
// records: readFeed of packages/feed refuses a page over one that has none
// (its TIME_COPY_TIERS, which a test of packages/feed holds equal to this).
export const TIME_COPY_TIERS: readonly RootTier[] = Object.freeze(["d", "w", "m", "y"] as const);
export const WITHDRAWN_FIELDS = Object.freeze(["manifest", "at"] as const);
// The datasets in which a segment may overlap a pack of other sources (the
// header's live-set rule). feed and new-name are left out: planWindow of
// packages/feed reads a window over disjoint packs, and a source that arrives
// as one day segment (THC) enters them through the day pack.
export const SEGMENT_OVERLAP: readonly TierDataset[] = Object.freeze(["names", "domains", "rev"] as const);
// How long a withdrawn manifest stays listed: GitHub re-runs a workflow run up
// to 30 days after its initial run (READ 2026-10-29T11:19:40Z,
// https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs),
// and one day more is the margin. A re-run of a promotion that added a pack
// a rollback took out is refused while the entry stands (buildRoot).
export const WITHDRAWN_DAYS = 31;
// The most parts a pack has (docs/format.md section 6.1, a u16).
const MAX_PARTS = 0xffff;

export interface Span {
  readonly start: string;
  readonly end: string;
}

export interface Blob {
  readonly digest: string;
  readonly size: number;
}

// The time copy of a feed or new-name pack: its index and its parts, the
// layers time.idx and time.part.NNN of the pack's manifest.
export interface TimeCopy {
  readonly idx: Blob;
  readonly parts: readonly Blob[];
}

export interface PackEntry {
  readonly repo: string;
  readonly tag: string;
  readonly tier: RootTier;
  readonly span: Span;
  // The digest of the pack's OCI manifest.
  readonly manifest: string;
  // The pack's identity: the SHA-256 of its raw blocks (dev.pkgforge.domains.sha256)
  // and the bytes of its parts and index (dev.pkgforge.domains.bytes). The
  // annotations describe the key copy alone, so a time copy is not counted.
  readonly pack: { readonly sha256: string; readonly bytes: number };
  readonly idx: Blob;
  readonly parts: readonly Blob[];
  // The time copy; absent when the pack has none.
  readonly time?: TimeCopy;
  readonly count: number;
  // The first and the last key, from the index head; null for a pack of no record.
  readonly key_min: string | null;
  readonly key_max: string | null;
  // The source ids, sorted.
  readonly sources: readonly string[];
  // The sha256 of the PSL the pack was built under (dev.pkgforge.domains.psl).
  readonly psl: string;
}

export interface DatasetCount {
  readonly packs: number;
  readonly records: number;
}

// A manifest a rollback took out of the live set, and the created of the root that did.
export interface Withdrawn {
  readonly manifest: string;
  readonly at: string;
}

export interface RootJson {
  readonly format: typeof ROOT_FORMAT;
  readonly root_seq: number;
  readonly as_of: string | null;
  readonly created: string;
  readonly previous: string | null;
  readonly psl: string;
  readonly psl_live: readonly string[];
  readonly corpus_since: Readonly<Record<string, string>>;
  readonly gaps: Readonly<Record<string, readonly string[]>>;
  readonly through: Readonly<Record<string, string>>;
  readonly counts: Readonly<Record<string, DatasetCount>>;
  readonly datasets: Readonly<Record<string, readonly PackEntry[]>>;
  readonly withdrawn: readonly Withdrawn[];
}

export const HEX64 = /^[0-9a-f]{64}$/;
export const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
// A key of the datasets whose keys are reversed names (docs/format.md section 1).
const NAME_KEY = /^[a-z0-9_.-]{1,253}$/;
const MAX_KEY = 65_535;
const DAY_MS = 86_400_000;

const schema = (message: string): RootError => new RootError("schema", message);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isWhole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

// Milliseconds since the epoch of an ISO 8601 UTC time to the second.
export function msOf(iso: unknown, what: string): number {
  if (typeof iso !== "string" || !ISO_SECOND.test(iso)) throw schema(`${what} is ${JSON.stringify(iso)}, not YYYY-MM-DDTHH:MM:SSZ`);
  const ms = Date.parse(iso);
  // Date.parse rolls 2026-02-30 over to March; a round trip catches it.
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== `${iso.slice(0, 19)}.000Z`) throw schema(`${what} ${iso} is not a calendar time`);
  return ms;
}

export const isoOf = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// The rank of a tier: seg 0, h 1, d 2, w 3, m 4, y 5.
export const rankOf = (tier: RootTier): number => ROOT_TIERS.indexOf(tier);

// The end of the one tier unit that starts at `startMs` (not checked for alignment).
export function tierEnd(tier: Exclude<RootTier, "seg">, startMs: number): number {
  const d = new Date(startMs);
  switch (tier) {
    case "h":
      return startMs + 3_600_000;
    case "d":
      return startMs + DAY_MS;
    case "w":
      return startMs + 7 * DAY_MS;
    case "m":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    case "y":
      return Date.UTC(d.getUTCFullYear() + 1, 0, 1);
  }
}

// Fields of `obj` beyond `known`: refused when strict, ignored otherwise.
function unknownFields(obj: Record<string, unknown>, known: readonly string[], what: string, strict: boolean): void {
  if (!strict) return;
  const extra = Object.keys(obj).filter((k) => !known.includes(k));
  if (extra.length > 0) throw schema(`${what} holds the unknown field(s) ${extra.join(", ")}`);
}

function required(obj: Record<string, unknown>, fields: readonly string[], what: string): void {
  const missing = fields.filter((k) => !Object.hasOwn(obj, k));
  if (missing.length > 0) throw schema(`${what} lacks ${missing.join(", ")}`);
}

function blobOf(v: unknown, what: string, min: number): Blob {
  if (!isObj(v) || typeof v.digest !== "string" || !DIGEST.test(v.digest) || !isWhole(v.size) || v.size < min) {
    throw new RootError("pack", `${what} is not { digest: sha256:<64 hex>, size: a whole number of at least ${min} }`);
  }
  return v as unknown as Blob;
}

// ---------------------------------------------------------------- a pack

// The `time` of a pack entry of `dataset`: a pack of feed or new-name alone
// lists one, and it is { idx, parts }, each a blob no smaller than the header
// of its kind (an index's 64 B, a part's 16 B, docs/format.md sections 3 and
// 6.1), as planWindow of packages/feed reads it. A pack with no time copy
// leaves the field out; null is refused, so one shape says "none".
function timeOf(dataset: TierDataset, v: unknown, at: string, strict: boolean): TimeCopy {
  const fail = (message: string): RootError => new RootError("pack", `${at}: ${message}`);
  if (!Object.hasOwn(TIME_DATASETS, dataset)) throw fail(`a ${dataset} pack lists a time copy; only ${Object.keys(TIME_DATASETS).join(" and ")} packs carry one (docs/format.md section 14)`);
  if (!isObj(v)) throw fail(`time is ${JSON.stringify(v)}, not { idx, parts }; a pack with no time copy leaves the field out`);
  required(v, TIME_FIELDS, `${at} time`);
  unknownFields(v, TIME_FIELDS, `${at} time`, strict);
  blobOf(v.idx, `${at} time.idx`, IDX_HEADER_BYTES);
  if (!Array.isArray(v.parts) || v.parts.length === 0 || v.parts.length > MAX_PARTS) throw fail(`time.parts is not a list of 1 to ${MAX_PARTS} blobs`);
  for (const [i, p] of v.parts.entries()) blobOf(p, `${at} time.parts[${i}]`, PART_HEADER_BYTES);
  return v as unknown as TimeCopy;
}

// A pack entry of `dataset`, checked against its own rules; `at` names it.
export function validatePack(dataset: TierDataset, v: unknown, at: string, strict = true): PackEntry {
  const fail = (message: string): RootError => new RootError("pack", `${at}: ${message}`);
  if (!isObj(v)) throw fail("not an object");
  required(v, PACK_FIELDS, at);
  unknownFields(v, [...PACK_FIELDS, ...PACK_OPTIONAL_FIELDS], at, strict);
  if (!isOneOf(ROOT_TIERS, v.tier)) throw fail(`tier ${JSON.stringify(v.tier)} is not one of ${ROOT_TIERS.join(", ")}`);
  const tier = v.tier;
  if (!isObj(v.span)) throw fail("span is not { start, end }");
  const start = msOf(v.span.start, `${at} span.start`);
  const end = msOf(v.span.end, `${at} span.end`);
  if (!(end > start)) throw fail(`span ${String(v.span.start)} to ${String(v.span.end)} does not end after it starts`);
  if (typeof v.repo !== "string" || !v.repo.startsWith(`${NAMESPACE}/`) || !(PACKAGES as readonly string[]).includes(v.repo.slice(NAMESPACE.length + 1))) {
    throw fail(`repo ${JSON.stringify(v.repo)} is not a package of ${NAMESPACE}`);
  }
  try {
    checkTag(v.tag);
  } catch (e) {
    if (e instanceof LayoutError) throw fail(e.message);
    throw e;
  }
  if (tier === "seg") {
    if (v.repo !== repoOf("obs")) throw fail(`a segment lives in ${repoOf("obs")}, not ${v.repo}`);
  } else {
    if (v.repo !== repoOf(packageOfDataset(dataset))) throw fail(`a ${dataset} pack lives in ${repoOf(packageOfDataset(dataset))}, not ${v.repo}`);
    let tag: string;
    try {
      tag = tierTag(dataset, tier, isoOf(start));
    } catch (e) {
      if (e instanceof LayoutError) throw fail(e.message);
      throw e;
    }
    if (end !== tierEnd(tier, start)) throw fail(`a pack of tier ${tier} spans one unit: ${isoOf(start)} to ${isoOf(tierEnd(tier, start))}, not to ${isoOf(end)}`);
    // The span's tag, or a rebuild of the span: that tag with -rN, N from 2
    // (ruling 25). checkTag above refused a suffix of another form.
    let given: string | null;
    try {
      given = parseTierTag(v.tag).base;
    } catch (e) {
      if (!(e instanceof LayoutError)) throw e;
      given = null;
    }
    if (given !== tag) throw fail(`the tag of a ${dataset} pack of tier ${tier} from ${isoOf(start)} is ${tag}, not ${v.tag}; a rebuild of the span adds -rN to it, N from 2 (ruling 25)`);
  }
  if (typeof v.manifest !== "string" || !DIGEST.test(v.manifest)) throw fail("manifest is not a sha256: digest");
  if (!isObj(v.pack) || typeof v.pack.sha256 !== "string" || !HEX64.test(v.pack.sha256) || !isWhole(v.pack.bytes)) {
    throw fail("pack is not { sha256: <64 hex>, bytes: a whole number }");
  }
  const idx = blobOf(v.idx, `${at} idx`, 1);
  if (!Array.isArray(v.parts) || v.parts.length === 0 || v.parts.length > MAX_PARTS) throw fail(`parts is not a list of 1 to ${MAX_PARTS} blobs`);
  const parts = v.parts.map((p, i) => blobOf(p, `${at} parts[${i}]`, 1));
  const bytes = parts.reduce((a, p) => a + p.size, idx.size);
  if (bytes !== v.pack.bytes) throw fail(`its parts and index hold ${bytes} B, and pack.bytes says ${v.pack.bytes}`);
  if (Object.hasOwn(v, "time")) timeOf(dataset, v.time, at, strict);
  if (!isWhole(v.count)) throw fail("count is not a whole number");
  if (v.count === 0) {
    if (v.key_min !== null || v.key_max !== null) throw fail("a pack of no record has key_min and key_max null");
  } else {
    const keyOk = (k: unknown): k is string => typeof k === "string" && k.length >= 1 && k.length <= MAX_KEY && (dataset === "rev" || NAME_KEY.test(k));
    if (!keyOk(v.key_min) || !keyOk(v.key_max)) throw fail(`key_min and key_max are not keys of ${dataset}`);
    if (v.key_min > v.key_max) throw fail("key_min is above key_max");
  }
  // A writer refuses a pack readFeed would refuse on every page. A reader
  // leaves it to readFeed, which then fails the pages over that pack alone,
  // not the whole root.
  if (strict && Object.hasOwn(TIME_DATASETS, dataset) && TIME_COPY_TIERS.includes(tier) && v.count > 0 && !Object.hasOwn(v, "time")) {
    throw fail(`a ${dataset} pack of tier ${tier} holds ${v.count} records and no time copy; a pack of tier ${TIME_COPY_TIERS.join(", ")} is read through its time copy (docs/format.md section 14)`);
  }
  if (!Array.isArray(v.sources) || v.sources.length === 0) throw fail("sources is not a list of ids");
  for (const [i, id] of v.sources.entries()) {
    if (typeof id !== "string" || !SOURCE_ID.test(id) || id.length > MAX_SOURCE_ID) throw fail(`sources[${i}] ${JSON.stringify(id)} is not a source id`);
    if (i > 0 && !(id > v.sources[i - 1])) throw fail("sources are not sorted and distinct");
  }
  if (typeof v.psl !== "string" || !HEX64.test(v.psl)) throw fail("psl is not 64 lowercase hex digits");
  return v as unknown as PackEntry;
}

// ---------------------------------------------------------------- the live set

// The order of a dataset's list: span start, the higher tier first, repository, tag.
export function comparePacks(a: PackEntry, b: PackEntry): number {
  if (a.span.start !== b.span.start) return a.span.start < b.span.start ? -1 : 1;
  if (a.tier !== b.tier) return rankOf(b.tier) - rankOf(a.tier);
  if (a.repo !== b.repo) return a.repo < b.repo ? -1 : 1;
  if (a.tag !== b.tag) return a.tag < b.tag ? -1 : 1;
  return 0;
}

const shareSource = (a: PackEntry, b: PackEntry): boolean => a.sources.some((s) => b.sources.includes(s));
const label = (p: PackEntry): string => `${p.repo.slice(NAMESPACE.length + 1)}:${p.tag} (${p.tier}, ${p.span.start} to ${p.span.end})`;

// The live-set rule over the packs of one dataset (the header lists it).
export function checkLiveSet(dataset: string, packs: readonly PackEntry[]): void {
  const fail = (message: string): RootError => new RootError("live-set", `datasets.${dataset}: ${message}`);
  const segmentsMayOverlap = (SEGMENT_OVERLAP as readonly string[]).includes(dataset);
  for (let i = 1; i < packs.length; i += 1) {
    const c = comparePacks(packs[i - 1], packs[i]);
    if (c === 0) throw fail(`${label(packs[i])} is listed twice`);
    if (c > 0) throw fail(`${label(packs[i])} is listed after ${label(packs[i - 1])}: the packs are listed by span start, then the higher tier first`);
  }
  let reach = packs.length > 0 ? packs[0].span.end : "";
  for (let i = 0; i < packs.length; i += 1) {
    const a = packs[i];
    if (i > 0) {
      if (a.span.start > reach) throw fail(`a hole from ${reach} to ${a.span.start}: no pack covers it`);
      if (a.span.end > reach) reach = a.span.end;
    }
    for (let j = i + 1; j < packs.length && packs[j].span.start < a.span.end; j += 1) {
      const b = packs[j];
      if (!segmentsMayOverlap)
        throw fail(`${label(a)} and ${label(b)} overlap; no two packs of ${dataset} do: a window is read over disjoint packs, and a day segment joins ${dataset} through its day pack`);
      if (a.tier !== "seg" && b.tier !== "seg") throw fail(`${label(a)} and ${label(b)} overlap; two compacted packs never do`);
      if (shareSource(a, b)) throw fail(`${label(a)} and ${label(b)} overlap and share a source; a merge leaves no pack it replaced`);
    }
  }
}

// ---------------------------------------------------------------- derived fields

export interface Derived {
  readonly as_of: string | null;
  readonly corpus_since: Record<string, string>;
  readonly through: Record<string, string>;
  readonly counts: Record<string, DatasetCount>;
  readonly psl_live: string[];
}

const sortedObject = <V>(entries: [string, V][]): Record<string, V> => Object.fromEntries(entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));

// The fields a root derives from its packs. Datasets are taken in key order.
export function derive(datasets: Readonly<Record<string, readonly PackEntry[]>>): Derived {
  let asOf: string | null = null;
  const since: [string, string][] = [];
  const counts: [string, DatasetCount][] = [];
  const through = new Map<string, string>();
  const psl = new Set<string>();
  for (const [ds, packs] of Object.entries(datasets)) {
    if (packs.length === 0) continue;
    since.push([ds, packs[0].span.start]);
    counts.push([ds, { packs: packs.length, records: packs.reduce((a, p) => a + p.count, 0) }]);
    for (const p of packs) {
      if (asOf === null || p.span.end > asOf) asOf = p.span.end;
      for (const s of p.sources) if ((through.get(s) ?? "") < p.span.end) through.set(s, p.span.end);
      psl.add(p.psl);
    }
  }
  return { as_of: asOf, corpus_since: sortedObject(since), through: sortedObject([...through]), counts: sortedObject(counts), psl_live: [...psl].sort() };
}

// JSON with every object's keys sorted: two values are equal when this is.
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObj(v)) {
    const keys = Object.keys(v).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

// ---------------------------------------------------------------- the root

function gapsOf(v: unknown): Record<string, readonly string[]> {
  if (!isObj(v)) throw schema("gaps is not an object");
  for (const [id, days] of Object.entries(v)) {
    if (!SOURCE_ID.test(id) || id.length > MAX_SOURCE_ID) throw schema(`gaps names ${JSON.stringify(id)}, which is not a source id`);
    if (!Array.isArray(days) || days.length === 0) throw schema(`gaps.${id} is not a list of days`);
    for (const [i, day] of days.entries()) {
      if (typeof day !== "string" || !ISO_DAY.test(day)) throw schema(`gaps.${id}[${i}] is ${JSON.stringify(day)}, not YYYY-MM-DD`);
      msOf(`${day}T00:00:00Z`, `gaps.${id}[${i}]`);
      if (i > 0 && !(day > days[i - 1])) throw schema(`gaps.${id} is not sorted and distinct`);
    }
  }
  return v as Record<string, readonly string[]>;
}

// The entries of `list` a root created at `createdMs` keeps: those no more than
// WITHDRAWN_DAYS before it, sorted by manifest. A builder writes no other list.
export function carryWithdrawn(list: readonly Withdrawn[], createdMs: number): Withdrawn[] {
  return list
    .filter((w) => createdMs - msOf(w.at, "withdrawn at") <= WITHDRAWN_DAYS * DAY_MS)
    .map((w) => ({ manifest: w.manifest, at: w.at }))
    .sort((a, b) => (a.manifest < b.manifest ? -1 : a.manifest > b.manifest ? 1 : 0));
}

// withdrawn checked against the root's created: a list of { manifest, at },
// sorted by manifest and distinct, each at no later than created and no more
// than WITHDRAWN_DAYS before it. Returns the manifests and their at.
function withdrawnOf(v: unknown, createdMs: number, strict: boolean): Map<string, string> {
  if (!Array.isArray(v)) throw schema("withdrawn is not a list");
  const out = new Map<string, string>();
  let last = "";
  for (const [i, w] of v.entries()) {
    const at = `withdrawn[${i}]`;
    if (!isObj(w)) throw schema(`${at} is not { manifest, at }`);
    required(w, WITHDRAWN_FIELDS, at);
    unknownFields(w, WITHDRAWN_FIELDS, at, strict);
    if (typeof w.manifest !== "string" || !DIGEST.test(w.manifest)) throw schema(`${at}.manifest is not a sha256: digest`);
    const ms = msOf(w.at, `${at}.at`);
    if (ms > createdMs) throw schema(`${at}.at ${String(w.at)} is after the root's created ${isoOf(createdMs)}: a root lists what it or an older root withdrew`);
    if (createdMs - ms > WITHDRAWN_DAYS * DAY_MS) throw schema(`${at}.at ${String(w.at)} is more than ${WITHDRAWN_DAYS} days before the root's created ${isoOf(createdMs)}: every root drops it`);
    if (i > 0 && !(w.manifest > last)) throw schema("withdrawn is not sorted by manifest and distinct");
    last = w.manifest;
    out.set(w.manifest, String(w.at));
  }
  return out;
}

export interface ValidateOptions {
  // A writer (the default) refuses a field or a dataset it does not know, so
  // it never carries forward what it cannot check. A reader passes false and
  // ignores them (docs/architecture.md section 11: changes are additive).
  readonly strict?: boolean;
}

// root.json checked whole, or RootError. Returns it typed.
export function validateRoot(json: unknown, options: ValidateOptions = {}): RootJson {
  const strict = options.strict ?? true;
  if (!isObj(json)) throw schema("root.json is not an object");
  // The format first: a reader refuses a root it does not know (section 11).
  if (json.format !== ROOT_FORMAT) throw new RootError("format", `the format is ${JSON.stringify(json.format ?? null)}; this reader knows ${ROOT_FORMAT}`);
  required(json, ROOT_FIELDS, "root.json");
  unknownFields(json, ROOT_FIELDS, "root.json", strict);
  if (!isWhole(json.root_seq) || json.root_seq < 1) throw schema(`root_seq is ${JSON.stringify(json.root_seq)}, not a whole number of at least 1`);
  const createdMs = msOf(json.created, "created");
  if (json.as_of !== null) msOf(json.as_of, "as_of");
  if (json.previous !== null && (typeof json.previous !== "string" || !DIGEST.test(json.previous))) throw schema("previous is neither null nor a sha256: digest");
  if ((json.root_seq === 1) !== (json.previous === null)) throw schema(`root_seq ${json.root_seq} with previous ${JSON.stringify(json.previous)}: only the first root has no previous`);
  if (typeof json.psl !== "string" || !HEX64.test(json.psl)) throw new RootError("psl", "psl is not 64 lowercase hex digits");
  if (!Array.isArray(json.psl_live)) throw schema("psl_live is not a list");
  for (const [i, h] of json.psl_live.entries()) {
    if (typeof h !== "string" || !HEX64.test(h)) throw new RootError("psl", `psl_live[${i}] is not 64 lowercase hex digits`);
    if (i > 0 && !(h > json.psl_live[i - 1])) throw new RootError("psl", "psl_live is not sorted and distinct");
  }
  gapsOf(json.gaps);
  const withdrawn = withdrawnOf(json.withdrawn, createdMs, strict);
  for (const k of ["corpus_since", "through", "counts"] as const) if (!isObj(json[k])) throw schema(`${k} is not an object`);
  if (!isObj(json.datasets)) throw schema("datasets is not an object");
  const known: Record<string, readonly PackEntry[]> = {};
  const digests = new Map<string, string>();
  let skipped = false;
  for (const [ds, packs] of Object.entries(json.datasets)) {
    if (!isOneOf(DATASETS, ds)) {
      if (strict) throw schema(`datasets names ${JSON.stringify(ds)}; the datasets are ${DATASETS.join(", ")}`);
      skipped = true;
      continue;
    }
    if (!Array.isArray(packs) || packs.length === 0) throw schema(`datasets.${ds} is not a list of packs; a dataset with no pack is not listed`);
    const list = packs.map((p, i) => validatePack(ds, p, `datasets.${ds}[${i}]`, strict));
    for (const [i, p] of list.entries()) {
      const at = `datasets.${ds}[${i}]`;
      const seen = digests.get(p.manifest);
      if (seen !== undefined) throw new RootError("live-set", `${at} names the manifest ${p.manifest}, which ${seen} names too`);
      const out = withdrawn.get(p.manifest);
      if (out !== undefined) throw new RootError("withdrawn", `${at} names the manifest ${p.manifest}, which withdrawn lists (at ${out}): a withdrawn pack is not live`);
      digests.set(p.manifest, at);
    }
    checkLiveSet(ds, list);
    known[ds] = list;
  }
  const d = derive(known);
  const check = (field: string, got: unknown, want: unknown): void => {
    if (canonical(got) !== canonical(want)) throw new RootError("derived", `${field} is ${canonical(got)}; the packs give ${canonical(want)}`);
  };
  if (!skipped) {
    check("as_of", json.as_of, d.as_of);
    check("psl_live", json.psl_live, d.psl_live);
    check("through", json.through, d.through);
  }
  // A reader that skipped a dataset it does not know cannot derive as_of,
  // psl_live or through, whose packs it did not read; it holds the per-dataset
  // fields of the datasets it knows.
  for (const k of ["corpus_since", "counts"] as const) {
    const got = skipped ? Object.fromEntries(Object.entries(json[k] as Record<string, unknown>).filter(([key]) => isOneOf(DATASETS, key))) : json[k];
    check(k, got, d[k]);
  }
  return json as unknown as RootJson;
}

// `next` moves forward from `live`: its root_seq is above, and it was created
// after. Unless it is a rollback, it shrinks nothing either: its as_of is not
// below the live one, no dataset's corpus_since is later or gone, and no
// source's through is earlier or gone. Only a rollback shrinks the root.
// RootError stale or time otherwise.
export function checkForward(live: RootJson, next: RootJson, options: { rollback?: boolean } = {}): void {
  if (!(next.root_seq > live.root_seq)) throw new RootError("stale", `the new root has root_seq ${next.root_seq}, and the live root ${live.root_seq}; root_seq only grows`);
  if (!options.rollback) {
    if (live.as_of !== null && (next.as_of === null || next.as_of < live.as_of)) {
      throw new RootError("stale", `the new root has as_of ${next.as_of}, below the live root's ${live.as_of}; only a rollback lowers as_of`);
    }
    for (const [ds, since] of Object.entries(live.corpus_since)) {
      const now = next.corpus_since[ds];
      if (now === undefined || now > since) throw new RootError("stale", `the new root has corpus_since.${ds} ${now ?? "none"}, and the live root ${since}; only a rollback shrinks a dataset`);
    }
    for (const [id, t] of Object.entries(live.through)) {
      const now = next.through[id];
      if (now === undefined || now < t) throw new RootError("stale", `the new root has through.${id} ${now ?? "none"}, below the live root's ${t}; only a rollback lowers a source's through`);
    }
  }
  if (!(next.created > live.created)) throw new RootError("time", `the new root is created ${next.created}, not after the live root's ${live.created}`);
}
