// packages/feed/src/plan.ts — which packs a window reads, and which keys.
//
//   const plan = planWindow(root.datasets, { t0, t1, suffix: "com.np" });
//   plan.packs      the live packs whose span overlaps [t0, t1) and whose key bounds meet the range, oldest first
//   plan.range      the key range of `suffix` and `under` (rangeOfDescendants of @domains/names, and the parent itself)
//
// The live set is the root's `datasets` (docs/architecture.md section 4.6,
// RootJson of @domains/root): for each dataset, the list of its live packs
// itself, absent when the dataset has none. A dataset listed as anything but a
// list, such as `{ packs: [...] }`, is refused ("live"), never read as empty.
// Each pack names its `tag`, `tier`, `span` ({ start, end }, ISO 8601 UTC,
// half-open) and `key_min` and `key_max` (null for a pack of no record), and,
// when it carries a time copy (docs/format.md section 14), `time`: { idx:
// { digest, size }, parts: [{ digest, size }] }, the layers time.idx and
// time.part.NNN beside its idx and parts. A `time` that is not that shape is
// refused ("live"); null or absent is a pack with no time copy. The spans of
// one dataset are disjoint (section 4.5), and the reader orders rows across
// packs by their spans, so a live set whose spans overlap is refused ("live").
//
// The key range. Keys are reversed names (section 3.2).
//   under=X    the name X itself and every name below it: the keys from key(X)
//              up to key(X) + "/", where `-` (0x2D) sorts a key such as
//              `com.example-x` inside the bound, so `match` keeps only key(X)
//              and the keys that start with key(X) + ".".
//   suffix=S   rows whose public suffix is S (design B section 7: an exact
//              suffix). The keys below key(S): rangeOfDescendants. A row of the
//              registrable feed is a registrable domain, the suffix plus one
//              label, so its suffix is S exactly when its key has one label
//              more than key(S): `suffix=np` keeps `np.example` and leaves
//              `np.com.example`, whose suffix is `com.np`. A new-name row is
//              any name, and its suffix needs the PSL: for kind `fqdn` the
//              range is every name below S, and DOM-041 holds the rest.
// Both together keep the keys that both keep.
import { secondsOf } from "@domains/ledger";
import { key as keyOf, rangeOfDescendants } from "@domains/names";
import { FeedError } from "./errors.ts";
import { checkWindow, overlaps, type Window } from "./time.ts";

export type FeedKind = "registrable" | "fqdn";
export type FeedDataset = "feed" | "new-name";
export const DATASET_OF_KIND: Readonly<Record<FeedKind, FeedDataset>> = Object.freeze({ registrable: "feed", fqdn: "new-name" });

// A blob of a pack: its digest and its size, as root.json lists it.
export interface BlobRef {
  readonly digest: string;
  readonly size: number;
}

// The time copy of a pack, as root.json lists it beside the pack's idx and parts.
export interface TimeCopyRef {
  readonly idx: BlobRef;
  readonly parts: readonly BlobRef[];
}

export interface LivePack {
  readonly tag: string;
  readonly tier: string;
  readonly span: { readonly start: string; readonly end: string };
  readonly key_min: string | null;
  readonly key_max: string | null;
  // The time copy; absent or null when the pack has none.
  readonly time?: TimeCopyRef | null;
}

// The shape of root.json's `datasets`: per dataset, its live packs.
export type LiveSet<P extends LivePack = LivePack> = Readonly<Record<string, readonly P[] | undefined>>;

export interface KeyRange {
  // The scan bounds [lo, hi); null is open.
  readonly lo: string | null;
  readonly hi: string | null;
  readonly suffixKey: string | null;
  readonly underKey: string | null;
  // The labels a key holds, for `suffix` on the registrable feed; null: any.
  readonly labels: number | null;
}

export interface PlannedPack<P extends LivePack = LivePack> {
  readonly pack: P;
  readonly span: Window;
}

export interface WindowPlan<P extends LivePack = LivePack> {
  readonly kind: FeedKind;
  readonly dataset: FeedDataset;
  readonly window: Window;
  readonly range: KeyRange;
  // Ascending by span.
  readonly packs: readonly PlannedPack<P>[];
}

export interface WindowQuery {
  readonly t0: number;
  readonly t1: number;
  // Names in their forward form: `com.np`, `example.co.uk`.
  readonly suffix?: string | null;
  readonly under?: string | null;
  readonly kind?: FeedKind;
}

const labelsOf = (k: string): number => k.split(".").length;

function nameKey(name: string, what: string): string {
  try {
    return keyOf(name);
  } catch (error) {
    throw new FeedError("range", `${what} ${JSON.stringify(String(name).slice(0, 80))} is not a valid lowercase name: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function keyRangeOf(query: { readonly suffix?: string | null; readonly under?: string | null; readonly kind?: FeedKind }): KeyRange {
  const kind = query.kind ?? "registrable";
  const bounds: [string, string][] = [];
  let suffixKey: string | null = null;
  let underKey: string | null = null;
  let labels: number | null = null;
  if (query.suffix !== undefined && query.suffix !== null) {
    suffixKey = nameKey(query.suffix, "the suffix");
    bounds.push([...rangeOfDescendants(suffixKey)]);
    if (kind === "registrable") labels = labelsOf(suffixKey) + 1;
  }
  if (query.under !== undefined && query.under !== null) {
    underKey = nameKey(query.under, "the parent");
    bounds.push([underKey, rangeOfDescendants(underKey)[1]]);
  }
  // The intersection: the highest start and the lowest end.
  // biome-ignore lint/complexity/useMathMinMax: the values are strings; Math.max and Math.min would read them as NaN
  const lo = bounds.length === 0 ? null : bounds.map((b) => b[0]).reduce((a, b) => (b > a ? b : a));
  // biome-ignore lint/complexity/useMathMinMax: the values are strings; Math.max and Math.min would read them as NaN
  const hi = bounds.length === 0 ? null : bounds.map((b) => b[1]).reduce((a, b) => (b < a ? b : a));
  return { lo, hi, suffixKey, underKey, labels };
}

export function inRange(range: KeyRange, key: string): boolean {
  if (range.lo !== null && key < range.lo) return false;
  if (range.hi !== null && key >= range.hi) return false;
  if (range.underKey !== null && key !== range.underKey && !key.startsWith(`${range.underKey}.`)) return false;
  if (range.suffixKey !== null && !key.startsWith(`${range.suffixKey}.`)) return false;
  if (range.labels !== null && labelsOf(key) !== range.labels) return false;
  return true;
}

function spanOf(pack: LivePack, i: number): Window {
  const what = `live pack ${i} (${JSON.stringify(pack?.tag)})`;
  if (pack === null || typeof pack !== "object" || typeof pack.tag !== "string" || pack.span === null || typeof pack.span !== "object") throw new FeedError("live", `${what} has no tag or no span`);
  let t0: number;
  let t1: number;
  try {
    t0 = secondsOf(pack.span.start);
    t1 = secondsOf(pack.span.end);
  } catch (error) {
    throw new FeedError("live", `${what}: its span does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!(t0 < t1)) throw new FeedError("live", `${what}: its span starts at ${pack.span.start}, not before its end ${pack.span.end}`);
  const bounds = [pack.key_min, pack.key_max];
  if (!bounds.every((b) => b === null || (typeof b === "string" && b.length > 0)) || (pack.key_min === null) !== (pack.key_max === null))
    throw new FeedError("live", `${what}: key_min and key_max are both keys or both null`);
  if (pack.time !== undefined && pack.time !== null) checkTimeRef(pack.time, what);
  return { t0, t1 };
}

const DIGEST = /^sha256:[0-9a-f]{64}$/;
// The smallest index is its 64-byte header; the smallest part its 16-byte header.
const isBlob = (b: unknown, least: number): boolean => {
  const r = b as BlobRef | null;
  return r !== null && typeof r === "object" && typeof r.digest === "string" && DIGEST.test(r.digest) && Number.isSafeInteger(r.size) && r.size >= least;
};

function checkTimeRef(time: TimeCopyRef, what: string): void {
  if (typeof time !== "object" || !isBlob(time.idx, 64) || !Array.isArray(time.parts) || time.parts.length === 0 || !time.parts.every((p) => isBlob(p, 16)))
    throw new FeedError("live", `${what}: its time copy is not { idx: { digest, size }, parts: [{ digest, size }, ...] }`);
}

// The pack holds no key of the range: its bounds lie wholly outside [lo, hi).
function outsideRange(pack: LivePack, range: KeyRange): boolean {
  if (pack.key_min === null || pack.key_max === null) return true;
  if (range.lo !== null && pack.key_max < range.lo) return true;
  if (range.hi !== null && pack.key_min >= range.hi) return true;
  return false;
}

export function planWindow<P extends LivePack>(live: LiveSet<P>, query: WindowQuery): WindowPlan<P> {
  const kind = query.kind ?? "registrable";
  if (!Object.hasOwn(DATASET_OF_KIND, kind)) throw new FeedError("usage", `the kind ${JSON.stringify(kind)} is not registrable or fqdn`);
  const dataset = DATASET_OF_KIND[kind];
  const window = checkWindow({ t0: query.t0, t1: query.t1 });
  const range = keyRangeOf({ suffix: query.suffix, under: query.under, kind });
  if (live === null || typeof live !== "object" || Array.isArray(live)) throw new FeedError("live", "the live set is not the root's datasets: an object of lists of packs");
  const listed = Object.hasOwn(live, dataset) ? live[dataset] : undefined;
  if (listed !== undefined && !Array.isArray(listed)) throw new FeedError("live", `datasets.${dataset} of the live set is not a list of packs`);
  const all = (listed ?? []).map((pack, i) => ({ pack, span: spanOf(pack, i) })).sort((a, b) => a.span.t0 - b.span.t0);
  for (let i = 1; i < all.length; i += 1) {
    if (all[i].span.t0 < all[i - 1].span.t1) throw new FeedError("live", `the live packs ${all[i - 1].pack.tag} and ${all[i].pack.tag} of ${dataset} overlap: the spans of a live set are disjoint`);
  }
  const packs = all.filter((p) => overlaps(p.span, window) && !outsideRange(p.pack, range));
  return { kind, dataset, window, range, packs };
}
