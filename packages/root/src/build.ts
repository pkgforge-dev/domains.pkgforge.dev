// packages/root/src/build.ts — the next root, built from the live one:
//
//   packFromManifest(facts)           a pack entry from its manifest and its index head, and its time copy's when it has one
//   buildRoot({ live, add, replace, psl, now })   the next root.json, checked whole
//   rollbackRoot({ live, target, between, psl, now })   a new root whose datasets are an older root's
//   dropSuperseded(live, add, replace)            the re-run guard: what the live root already holds
//   sourcesLayer({ registry, root, previous })    the sources.json layer: the registry, through, fetched
//   checkSourcesLayer(root, layer)                that layer held equal to the root
//
// buildRoot: root_seq is the live one plus 1, previous is the live manifest
// digest, the replaced packs leave the live set and their replacements join
// it (each replacement spans every pack it replaces and carries each of their
// sources), the added packs join it, and every derived field is computed again. The
// result passes validateRoot, and checkForward against the live root, or
// buildRoot throws RootError: a promotion never writes a root it could not
// read back. With no live root (the first promotion) root_seq is 1, previous
// null, and the datasets are the added packs alone, none at all for an empty
// first root.
//
// withdrawn: buildRoot carries the live list forward (carryWithdrawn: the
// entries more than WITHDRAWN_DAYS before the new created leave it) and
// refuses, RootError withdrawn, an addition or a replacement whose manifest it
// lists. So a re-run of the promotion that first added a pack cannot put it
// back after a rollback took it out. rollbackRoot lists, at its own created,
// each manifest that a root after the target names and the target does not:
// the live root and each root between them (`between`), each of those created
// no more than WITHDRAWN_DAYS before the rollback. It drops each the target names.
//
// Runs in Node and in workerd alike: it imports nothing from `node:`.
import { artifactType, NAMESPACE, type TierDataset } from "@domains/ghcr";
import { DATASET_LABELS, IDX_TITLE, partTitle, splitTimeKey, TIME_IDX_TITLE, TIME_PREFIX_BYTES, timePartTitle, VERIFY_ANNOTATIONS } from "@domains/pack";
import { RootError } from "./errors.ts";
import {
  carryWithdrawn,
  checkForward,
  comparePacks,
  DATASETS,
  DIGEST,
  derive,
  HEX64,
  isoOf,
  msOf,
  type PackEntry,
  type ROOT_FIELDS,
  ROOT_FORMAT,
  ROOT_TIERS,
  type RootJson,
  type RootTier,
  rankOf,
  TIME_DATASETS,
  type TimeCopy,
  validatePack,
  validateRoot,
  WITHDRAWN_DAYS,
  type Withdrawn,
} from "./root.ts";

// The annotation of a pack's tier (docs/architecture.md section 4.2); the
// others are the verifier's (VERIFY_ANNOTATIONS of @domains/pack).
export const TIER_ANNOTATION = "dev.pkgforge.domains.tier";
// The annotation of a quarantined segment (section 5.8): packFromManifest refuses it.
export const QUARANTINE_ANNOTATION = "dev.pkgforge.domains.quarantine";
export const SOURCES_LAYER_FORMAT = "domains.root-sources.v1";
// The coverage table before DOM-035 writes one: its shape, with nothing measured.
export const EMPTY_COVERAGE = Object.freeze({ as_of: null, day: null, pairs: Object.freeze([]), gaps: Object.freeze({}) });

const PACK_TYPE = artifactType("pack");
const SEGMENT_TYPE = artifactType("segment");
const TITLE = "org.opencontainers.image.title";
const WHOLE = /^(?:0|[1-9][0-9]{0,15})$/;
const ISO_SECOND = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const DAY_MS = 86_400_000;
// The epoch of a time key's first_seen: seconds since 2026-01-01T00:00:00Z
// (docs/format.md sections 1 and 14).
const EPOCH_MS = Date.UTC(2026, 0, 1);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isOneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);

export interface LiveRoot {
  readonly root: RootJson;
  // The digest of the live root's manifest: the next root's `previous`.
  readonly digest: string;
}

export interface NewPack {
  readonly dataset: TierDataset;
  readonly pack: PackEntry;
}

export interface Replacement {
  // The manifest digests of the live packs the new one replaces.
  readonly old: readonly string[];
  readonly new: NewPack;
}

// ---------------------------------------------------------------- a pack from GHCR

export interface ManifestLayer {
  readonly mediaType: string;
  readonly digest: string;
  readonly size: number;
  readonly annotations?: Readonly<Record<string, string>>;
}

// An index head as read by range: its dataset byte, records, key bounds and
// the bytes of each part its parts table gives.
export interface HeadFacts {
  readonly dataset: number;
  readonly records: number;
  readonly keyMin: string | null;
  readonly keyMax: string | null;
  readonly parts: readonly number[];
}

export interface ManifestFacts {
  readonly repo: string;
  readonly tag: string;
  // The digest of the manifest, as the registry answered it and as its bytes hash.
  readonly digest: string;
  readonly json: { readonly artifactType?: string; readonly layers?: readonly ManifestLayer[]; readonly annotations?: Readonly<Record<string, string>> };
  // The head of the index, the layer idx.
  readonly head: HeadFacts;
  // The head of the time copy's index, the layer time.idx, when the manifest
  // holds one (docs/format.md section 14); absent or null otherwise.
  readonly timeHead?: HeadFacts | null;
}

// The entry the root keeps for a pack, from its manifest and its index head,
// each fact held to the other: the dataset, the count, the parts and their
// sizes, the bytes. A time copy (the layers time.idx and time.part.NNN, both
// or neither) is held to its own head the same way: its dataset byte is the
// one TIME_DATASETS gives the pack's dataset (no other dataset has one), its
// records are the index's, its parts are the sizes its parts table gives, and
// the first_seen of its first and last key lie inside the pack's span: the
// half of the bind (timeBindFault of @domains/pack) that readFeed holds before
// it reads a block of the copy. RootError pack names the first that
// disagrees, and a manifest that carries the quarantine annotation.
export function packFromManifest(facts: ManifestFacts): NewPack {
  const at = `${facts.repo}:${facts.tag}`;
  const fail = (message: string): RootError => new RootError("pack", `${at}: ${message}`);
  const j = facts.json;
  if (j.artifactType !== PACK_TYPE && j.artifactType !== SEGMENT_TYPE) throw fail(`the artifact type is ${JSON.stringify(j.artifactType ?? null)}, not ${PACK_TYPE} or ${SEGMENT_TYPE}`);
  if (typeof facts.digest !== "string" || !DIGEST.test(facts.digest)) throw fail("the manifest digest is not a sha256: digest");
  const a = j.annotations ?? {};
  // A quarantined segment does not feed `new` (docs/architecture.md section
  // 5.8), and the root has no field that would say so: it joins no root.
  if (Object.hasOwn(a, QUARANTINE_ANNOTATION))
    throw fail(`the manifest carries ${QUARANTINE_ANNOTATION}=${JSON.stringify(a[QUARANTINE_ANNOTATION])}: a quarantined pack joins no root until the operator decides (section 5.8)`);
  const A = VERIFY_ANNOTATIONS;
  const get = (key: string): string => {
    const v = a[key];
    if (typeof v !== "string" || v === "") throw fail(`the manifest has no annotation ${key}`);
    return v;
  };
  const whole = (key: string): number => {
    const v = get(key);
    if (!WHOLE.test(v) || !Number.isSafeInteger(Number(v))) throw fail(`the annotation ${key} is ${JSON.stringify(v)}, not a whole number`);
    return Number(v);
  };
  const dataset = get(A.dataset);
  if (!isOneOf(DATASETS, dataset)) throw fail(`the dataset ${JSON.stringify(dataset)} is not one of ${DATASETS.join(", ")}`);
  const tier = get(TIER_ANNOTATION);
  if (!isOneOf(ROOT_TIERS, tier)) throw fail(`the tier ${JSON.stringify(tier)} is not one of ${ROOT_TIERS.join(", ")}`);
  if ((tier === "seg") !== (j.artifactType === SEGMENT_TYPE)) throw fail(`a ${j.artifactType} has the tier ${tier}; a segment is tier seg, and a pack is a higher tier`);
  const count = whole(A.count);
  const bytes = whole(A.bytes);
  const sha256 = get(A.sha256);
  if (!HEX64.test(sha256)) throw fail(`the annotation ${A.sha256} is not 64 lowercase hex digits`);
  const psl = get(A.psl);
  if (!HEX64.test(psl)) throw fail(`the annotation ${A.psl} is not 64 lowercase hex digits`);
  const sources = [
    ...new Set(
      get(A.source)
        .split(",")
        .map((s) => s.trim()),
    ),
  ].sort();
  const h = facts.head;
  if (DATASET_LABELS[h.dataset] !== dataset) throw fail(`the index holds dataset ${h.dataset} (${DATASET_LABELS[h.dataset] ?? "unknown"}), and the annotation says ${dataset}`);
  if (h.records !== count) throw fail(`the index holds ${h.records} records, and the annotation ${A.count} says ${count}`);
  // The parts in part order and one index, and the time copy's alike; other
  // layers (summary.json, raw, txt.gz) are a reader's to ignore
  // (docs/format.md section 2).
  const parts: { digest: string; size: number }[] = [];
  const timeParts: { digest: string; size: number }[] = [];
  let idx: { digest: string; size: number } | null = null;
  let timeIdx: { digest: string; size: number } | null = null;
  for (const l of j.layers ?? []) {
    const title = l.annotations?.[TITLE];
    if (title === IDX_TITLE) {
      if (idx !== null) throw fail("the manifest holds two idx layers");
      idx = { digest: l.digest, size: l.size };
    } else if (title === TIME_IDX_TITLE) {
      if (timeIdx !== null) throw fail("the manifest holds two time.idx layers");
      timeIdx = { digest: l.digest, size: l.size };
    } else if (typeof title === "string" && /^part\.\d{3,}$/.test(title)) {
      if (title !== partTitle(parts.length)) throw fail(`the layer ${title} stands where ${partTitle(parts.length)} belongs`);
      parts.push({ digest: l.digest, size: l.size });
    } else if (typeof title === "string" && /^time\.part\.\d{3,}$/.test(title)) {
      if (title !== timePartTitle(timeParts.length)) throw fail(`the layer ${title} stands where ${timePartTitle(timeParts.length)} belongs`);
      timeParts.push({ digest: l.digest, size: l.size });
    }
  }
  if (idx === null) throw fail("the manifest holds no idx layer");
  if (parts.length !== h.parts.length) throw fail(`the manifest holds ${parts.length} part layer(s), and the index names ${h.parts.length}`);
  for (const [i, p] of parts.entries()) if (p.size !== h.parts[i]) throw fail(`${partTitle(i)} is ${p.size} B in the manifest, and the index gives it ${h.parts[i]} B`);
  const span = { start: get(A.spanStart), end: get(A.spanEnd) };
  const time = timeCopyOf(dataset, timeIdx, timeParts, facts.timeHead ?? null, h.records, span, fail);
  const pack: PackEntry = {
    repo: facts.repo,
    tag: facts.tag,
    tier,
    span,
    manifest: facts.digest,
    pack: { sha256, bytes },
    idx,
    parts,
    ...(time === null ? {} : { time }),
    count,
    key_min: h.keyMin,
    key_max: h.keyMax,
    sources,
    psl,
  };
  return { dataset, pack: validatePack(dataset, pack, at) };
}

// The first_seen of a time key (docs/format.md section 14), or null when the
// bound is absent or too short to hold a row key after its time.
const firstSeenOf = (bound: string | null): number | null => (bound !== null && bound.length > TIME_PREFIX_BYTES ? splitTimeKey(bound).firstSeen : null);

// An ISO 8601 time of a span as seconds since 2026-01-01, a time key's unit.
const epochSecondsOf = (iso: string, what: string): number => (msOf(iso, what) - EPOCH_MS) / 1000;

// The time copy of packFromManifest, or null when the manifest holds none.
function timeCopyOf(
  dataset: TierDataset,
  idx: { digest: string; size: number } | null,
  parts: readonly { digest: string; size: number }[],
  head: HeadFacts | null,
  records: number,
  span: { readonly start: string; readonly end: string },
  fail: (message: string) => RootError,
): TimeCopy | null {
  if (idx === null && parts.length > 0) throw fail(`the manifest holds ${parts.length} time.part layer(s) and no time.idx: a time copy is both or neither`);
  if (idx !== null && parts.length === 0) throw fail("the manifest holds a time.idx layer and no time.part layer: a time copy is both or neither");
  if (idx === null) {
    if (head !== null) throw fail("a time index head was read, and the manifest holds no time copy");
    return null;
  }
  const want = TIME_DATASETS[dataset];
  if (want === undefined) throw fail(`a ${dataset} pack carries a time copy; only ${Object.keys(TIME_DATASETS).join(" and ")} packs have one (docs/format.md section 14)`);
  if (head === null) throw fail("the manifest holds a time copy, and its index head was not read");
  if (head.dataset !== want)
    throw fail(`the time index holds dataset ${head.dataset} (${DATASET_LABELS[head.dataset] ?? "unknown"}); the time copy of ${dataset} is dataset ${want} (${DATASET_LABELS[want]})`);
  if (head.records !== records) throw fail(`the time index holds ${head.records} records, and the index ${records}`);
  if (parts.length !== head.parts.length) throw fail(`the manifest holds ${parts.length} time.part layer(s), and the time index names ${head.parts.length}`);
  for (const [i, p] of parts.entries()) if (p.size !== head.parts[i]) throw fail(`${timePartTitle(i)} is ${p.size} B in the manifest, and the time index gives it ${head.parts[i]} B`);
  // The copy's rows lie inside the pack's span [t0, t1): readFeed refuses
  // every page that touches a pack whose copy does not (FeedError time).
  if (records > 0) {
    const first = firstSeenOf(head.keyMin);
    const last = firstSeenOf(head.keyMax);
    if (first === null || last === null) throw fail(`the time index's key bounds are not time keys: ${TIME_PREFIX_BYTES} bytes of first_seen and a row key each`);
    const t0 = epochSecondsOf(span.start, "span.start");
    const t1 = epochSecondsOf(span.end, "span.end");
    if (first < t0 || last >= t1) throw fail(`the time copy's rows run from first_seen ${first} to ${last}, outside the span [${t0}, ${t1}) of the pack (seconds since 2026-01-01)`);
  }
  return { idx, parts: [...parts] };
}

// ---------------------------------------------------------------- the next root

export interface BuildInput {
  // null for the first promotion: no root:latest exists.
  readonly live: LiveRoot | null;
  readonly add?: readonly NewPack[];
  readonly replace?: readonly Replacement[];
  // The sha256 of the PSL pinned at promotion (the ref package's psl-<sha12>).
  readonly psl: string;
  // The time of the promotion, YYYY-MM-DDTHH:MM:SSZ: the root's `created`.
  readonly now: string;
  // The days each source lacks; the live root's when absent.
  readonly gaps?: Readonly<Record<string, readonly string[]>>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

// The time of a promotion in milliseconds, or RootError usage.
function nowMs(now: unknown): number {
  if (typeof now !== "string" || !ISO_SECOND.test(now)) throw new RootError("usage", `now ${JSON.stringify(now)} is not YYYY-MM-DDTHH:MM:SSZ`);
  return msOf(now, "now");
}

// root.json in the order of ROOT_FIELDS, its derived fields computed, the
// withdrawn list carried to `now` (carryWithdrawn), checked.
function assemble(
  seq: number,
  previous: string | null,
  psl: string,
  now: string,
  gaps: Readonly<Record<string, readonly string[]>>,
  lists: Map<string, PackEntry[]>,
  withdrawn: readonly Withdrawn[],
): RootJson {
  if (typeof psl !== "string" || !HEX64.test(psl)) throw new RootError("psl", `the pinned PSL ${JSON.stringify(psl)} is not 64 lowercase hex digits`);
  const ms = nowMs(now);
  const datasets: Record<string, PackEntry[]> = {};
  for (const ds of [...lists.keys()].sort()) {
    const list = lists.get(ds) ?? [];
    if (list.length > 0) datasets[ds] = [...list].sort(comparePacks);
  }
  const d = derive(datasets);
  const root: Record<(typeof ROOT_FIELDS)[number], unknown> = {
    format: ROOT_FORMAT,
    root_seq: seq,
    as_of: d.as_of,
    created: now,
    previous,
    psl,
    psl_live: d.psl_live,
    corpus_since: d.corpus_since,
    gaps: clone(gaps),
    through: d.through,
    counts: d.counts,
    datasets,
    withdrawn: carryWithdrawn(withdrawn, ms),
  };
  return validateRoot(root);
}

// A replacement holds what it replaces: its span covers every replaced span,
// and it carries every source they carried. Only a rollback shrinks the root.
function checkCovers(p: PackEntry, gone: readonly PackEntry[]): void {
  // biome-ignore lint/complexity/useMathMinMax: the values are strings; Math.max and Math.min would read them as NaN
  const start = gone.reduce((a, o) => (o.span.start < a ? o.span.start : a), p.span.start);
  // biome-ignore lint/complexity/useMathMinMax: the values are strings; Math.max and Math.min would read them as NaN
  const end = gone.reduce((a, o) => (o.span.end > a ? o.span.end : a), p.span.end);
  if (start !== p.span.start || end !== p.span.end) {
    throw new RootError("replace", `the replacement by ${p.tag} spans ${p.span.start} to ${p.span.end}, and the packs it replaces reach ${start} to ${end}; a replacement covers what it replaces`);
  }
  const lost = [...new Set(gone.flatMap((o) => o.sources))].filter((s) => !p.sources.includes(s)).sort();
  if (lost.length > 0) throw new RootError("replace", `the replacement by ${p.tag} does not carry ${lost.join(", ")}, which the packs it replaces carry`);
}

function listsOf(root: RootJson | null): Map<string, PackEntry[]> {
  const lists = new Map<string, PackEntry[]>();
  if (root !== null) for (const [ds, packs] of Object.entries(root.datasets)) lists.set(ds, clone([...packs]));
  return lists;
}

const pkgTag = (p: PackEntry): string => `${p.repo.slice(NAMESPACE.length + 1)}:${p.tag}`;

export function buildRoot(input: BuildInput): RootJson {
  const live = input.live;
  if (live !== null && (typeof live.digest !== "string" || !DIGEST.test(live.digest))) throw new RootError("usage", "the live root's digest is not a sha256: digest");
  // A manifest a rollback took out comes back through a rollback to a root
  // that names it, or once its entry leaves the list; a re-run of an older
  // promotion that names it is refused here. A pack of the same span under
  // another manifest digest is not refused here: a rebuilt tier pack takes the
  // span's tag with -rN, N from 2 (docs/architecture.md section 4.7 rule 2,
  // ruling 25), and joins as an addition or a replacement like any pack.
  const withdrawn = new Map(carryWithdrawn(live?.root.withdrawn ?? [], nowMs(input.now)).map((w) => [w.manifest, w.at]));
  for (const [what, np] of [...(input.add ?? []).map((np) => ["addition", np] as const), ...(input.replace ?? []).map((r) => ["replacement", r.new] as const)]) {
    const at = withdrawn.get(np.pack.manifest);
    if (at !== undefined) {
      throw new RootError(
        "withdrawn",
        `the ${what} ${pkgTag(np.pack)} (${np.pack.manifest}) was withdrawn by the rollback of ${at}: a re-run cannot put it back. It comes back by a rollback to a root that names it, or after ${isoOf(msOf(at, "withdrawn at") + WITHDRAWN_DAYS * DAY_MS)}, when every root drops the entry`,
      );
    }
  }
  const lists = listsOf(live?.root ?? null);
  const put = (np: NewPack): void => {
    const list = lists.get(np.dataset) ?? [];
    list.push(np.pack);
    lists.set(np.dataset, list);
  };
  for (const r of input.replace ?? []) {
    if (r.old.length === 0) throw new RootError("replace", `the replacement by ${r.new.pack.tag} names no pack it replaces`);
    if (new Set(r.old).size !== r.old.length) throw new RootError("replace", `the replacement by ${r.new.pack.tag} names a pack twice`);
    const list = lists.get(r.new.dataset) ?? [];
    const gone: PackEntry[] = [];
    for (const old of r.old) {
      const i = list.findIndex((p) => p.manifest === old);
      if (i === -1) throw new RootError("replace", `the replacement by ${r.new.pack.tag} names ${old}, which is not a live ${r.new.dataset} pack`);
      gone.push(...list.splice(i, 1));
    }
    checkCovers(r.new.pack, gone);
    lists.set(r.new.dataset, list);
    put(r.new);
  }
  for (const np of input.add ?? []) put(np);
  const root = assemble(live === null ? 1 : live.root.root_seq + 1, live?.digest ?? null, input.psl, input.now, input.gaps ?? live?.root.gaps ?? {}, lists, live?.root.withdrawn ?? []);
  if (live !== null) checkForward(live.root, root);
  return root;
}

export interface RollbackInput {
  readonly live: LiveRoot;
  // The older root whose datasets the new one takes.
  readonly target: RootJson;
  // The roots on the chain of `previous` between the live root and the
  // target, both left out: each was live once (scripts/root/rollback.mjs
  // reads them). [] when the target is the live root's previous.
  readonly between: readonly RootJson[];
  readonly psl: string;
  readonly now: string;
}

const manifestsOf = (root: RootJson): string[] => Object.values(root.datasets).flatMap((packs) => packs.map((p) => p.manifest));

// A rollback is a new root: root_seq the live one plus 1, previous the live
// digest, and the datasets and gaps of the target, an older root. It never
// lowers root_seq and never deletes; as_of may fall to the target's. Its
// withdrawn is the live root's, plus each manifest that the live root or a
// root of `between` names and the target does not (at: this root's created;
// an entry already listed keeps its own), minus each the target names. A pack
// that a compaction replaced after the target was live is named by a root of
// `between` alone, and a re-run of the promotion that added it would put it
// back. A root created more than WITHDRAWN_DAYS before the rollback adds
// nothing: the run that first added a pack it names started before it, and
// GitHub re-runs a run for 30 days (root.ts); a newer root that names the
// pack adds it.
export function rollbackRoot(input: RollbackInput): RootJson {
  const { live, target } = input;
  if (typeof live?.digest !== "string" || !DIGEST.test(live.digest)) throw new RootError("usage", "the live root's digest is not a sha256: digest");
  if (!(target.root_seq < live.root.root_seq)) throw new RootError("stale", `a rollback goes to an older root: the target has root_seq ${target.root_seq}, and the live root ${live.root.root_seq}`);
  const ms = nowMs(input.now);
  const back = new Set(manifestsOf(target));
  const withdrawn = new Map(live.root.withdrawn.map((w) => [w.manifest, w.at]));
  for (const r of [live.root, ...input.between]) {
    if (ms - msOf(r.created, "created") > WITHDRAWN_DAYS * DAY_MS) continue;
    for (const m of manifestsOf(r)) if (!back.has(m) && !withdrawn.has(m)) withdrawn.set(m, input.now);
  }
  for (const m of back) withdrawn.delete(m);
  const root = assemble(
    live.root.root_seq + 1,
    live.digest,
    input.psl,
    input.now,
    target.gaps,
    listsOf(target),
    [...withdrawn].map(([manifest, at]) => ({ manifest, at })),
  );
  checkForward(live.root, root, { rollback: true });
  return root;
}

// ---------------------------------------------------------------- the re-run guard

export interface Dropped {
  readonly tag: string;
  readonly manifest: string;
  readonly why: string;
}

const covers = (outer: PackEntry, inner: PackEntry): boolean => outer.span.start <= inner.span.start && outer.span.end >= inner.span.end;

// Why the live root already holds `np`, or null: it names the same manifest,
// or a pack of a higher tier spans it and carries every source it carries.
export function heldBy(live: RootJson, np: NewPack): string | null {
  for (const [ds, packs] of Object.entries(live.datasets)) {
    const same = packs.find((p) => p.manifest === np.pack.manifest);
    if (same !== undefined) return `the live root names it (datasets.${ds})`;
  }
  const rank = rankOf(np.pack.tier as RootTier);
  const over = (live.datasets[np.dataset] ?? []).find((p) => rankOf(p.tier) > rank && covers(p, np.pack) && np.pack.sources.every((s) => p.sources.includes(s)));
  return over === undefined ? null : `the live root supersedes it with ${over.tag} (${over.tier}, ${over.span.start} to ${over.span.end})`;
}

// The re-run guard of docs/architecture.md section 4.7 rule 4: every addition
// and replacement the live root already names or supersedes is dropped, with
// its reason. A re-run of an older run then writes nothing the live root holds.
export function dropSuperseded(live: RootJson | null, add: readonly NewPack[], replace: readonly Replacement[]): { add: NewPack[]; replace: Replacement[]; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const keep = (np: NewPack): boolean => {
    const why = live === null ? null : heldBy(live, np);
    if (why !== null) dropped.push({ tag: np.pack.tag, manifest: np.pack.manifest, why });
    return why === null;
  };
  return { add: add.filter(keep), replace: replace.filter((r) => keep(r.new)), dropped };
}

// ---------------------------------------------------------------- the sources layer

export interface SourceRow {
  readonly id: string;
  readonly [field: string]: unknown;
}

export interface SourcesLayer {
  readonly format: typeof SOURCES_LAYER_FORMAT;
  readonly sources: readonly (SourceRow & { readonly through: string | null; readonly fetched: string | null })[];
}

// The sources.json layer of a root: each row of the registry (config/sources.json,
// validated by the caller) with `through` from the root and `fetched` given, or
// carried from the previous layer, or null. A source a live pack carries that
// the registry does not hold is refused: the layer would not describe it.
export function sourcesLayer(input: {
  readonly registry: readonly SourceRow[];
  readonly root: RootJson;
  readonly previous?: SourcesLayer | null;
  readonly fetched?: Readonly<Record<string, string>>;
}): SourcesLayer {
  const ids = new Set<string>();
  for (const row of input.registry) {
    if (!isObj(row) || typeof row.id !== "string" || row.id === "") throw new RootError("sources", "a registry row has no id");
    if (ids.has(row.id)) throw new RootError("sources", `the registry holds ${row.id} twice`);
    if (Object.hasOwn(row, "through") || Object.hasOwn(row, "fetched")) throw new RootError("sources", `the registry row ${row.id} holds through or fetched, which the promotion writes`);
    ids.add(row.id);
  }
  for (const id of Object.keys(input.root.through)) if (!ids.has(id)) throw new RootError("sources", `a live pack carries ${id}, which the registry does not hold`);
  for (const [id, t] of Object.entries(input.fetched ?? {})) {
    if (!ids.has(id)) throw new RootError("sources", `fetched names ${id}, which the registry does not hold`);
    msOf(t, `fetched.${id}`);
  }
  const before = new Map((input.previous?.sources ?? []).map((r) => [r.id, r.fetched]));
  const sources = input.registry.map((row) => ({ ...row, through: input.root.through[row.id] ?? null, fetched: input.fetched?.[row.id] ?? before.get(row.id) ?? null }));
  return { format: SOURCES_LAYER_FORMAT, sources };
}

// The sources.json layer held to its root: its format, one row per id, each
// row's `through` the root's, and a row for every source the root's packs carry.
export function checkSourcesLayer(root: RootJson, layer: unknown): SourcesLayer {
  const fail = (message: string): RootError => new RootError("sources", `sources.json: ${message}`);
  if (!isObj(layer) || layer.format !== SOURCES_LAYER_FORMAT || !Array.isArray(layer.sources)) throw fail(`is not { format: ${SOURCES_LAYER_FORMAT}, sources: [...] }`);
  const ids = new Set<string>();
  for (const row of layer.sources as unknown[]) {
    if (!isObj(row) || typeof row.id !== "string") throw fail("a row has no id");
    if (ids.has(row.id)) throw fail(`holds ${row.id} twice`);
    ids.add(row.id);
    if ((row.through ?? null) !== (root.through[row.id] ?? null))
      throw fail(`${row.id} is through ${JSON.stringify(row.through ?? null)}, and the root says ${JSON.stringify(root.through[row.id] ?? null)}`);
    if (row.fetched !== null && row.fetched !== undefined) msOf(row.fetched, `sources.json ${row.id} fetched`);
  }
  for (const id of Object.keys(root.through)) if (!ids.has(id)) throw fail(`holds no row for ${id}, which a live pack carries`);
  return layer as unknown as SourcesLayer;
}

// The bytes of a layer: compact JSON (no indentation), one final newline.
// root.json is read by machines, which parse it whatever its spacing.
export const layerBytes = (value: unknown): Uint8Array => new TextEncoder().encode(`${JSON.stringify(value)}\n`);

// The time `now` as a root's `created`: a Date or milliseconds, cut to the second.
export const createdOf = (now: Date | number): string => isoOf(Math.floor((typeof now === "number" ? now : now.getTime()) / 1000) * 1000);
