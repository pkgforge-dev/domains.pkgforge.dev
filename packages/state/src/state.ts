// packages/state/src/state.ts — state.json, the one object of the ingest's
// state (format domains.state.v1), pushed as the layer `state.json` of
// `state:latest` (DOM-024):
//
//   { "format": "domains.state.v1", "updated": "2026-10-30T08:30:12Z",
//     "cursors": { "<adapter>": <cursor> },
//     "moved":   { "<adapter>": { "at": "2026-10-30T08:30:12Z", "run": "40000000001" } },
//     "history": { "<source>": [ { "day": "2026-10-29", "count": 32554702, "quarantined": false } ] },
//     "owed":    [ { "ref": "obs:<tag>", "digest": "sha256:...", "dataset": "domains", "tier": "seg",
//                    "start": "...", "end": "...", "since": "..." } ] }
//
//   cursors  one per adapter directory (D3 of DOM-024: one module returns one cursor),
//            opaque JSON of at most 4 KiB (checkCursor of @domains/adapter);
//            the shapes are the adapters' and are never read here
//   moved    the time and the run of the last proposal accepted for each
//            adapter (a backfill keeps its cursor and still sets it):
//            exactly the keys of cursors; a run is a workflow run id or "local"
//   history  the volume history of each day-precision source (D5 of DOM-024): one item a
//            verified day, the names segment's when the day has one, else the
//            domains segment's, sorted by day, no day twice
//            (checkHistory of @domains/adapter), the newest HISTORY_DAYS kept;
//            a source with no day has no key
//   owed     the packs a moved state is past and the live root does not name
//            yet (D4 of DOM-024): every segment that is not quarantined, and
//            every hour pack of `feed`, until settle drops it; sorted by start,
//            then ref
//
// Canonical JSON (canonicalJson of @domains/adapter, keys sorted) and one
// newline, at most STATE_MAX_BYTES. A reader refuses a format it does not
// know, a field it does not know, and a value that breaks its rule
// (StateError, errors.ts). Every time is ISO 8601 UTC to the second. A ref
// names its tag, and the tag must be the one its own fields give (segTag,
// fileTag, parseTierTag of @domains/ghcr): the same fact in two places is
// held to agree.
//
// Pure: no clock, no network, nothing from `node:`; type-checked as Worker
// code, and run by the tests in Node. The helpers below the exports of index.ts are shared with
// proposal.ts and advance.ts.
import { BandError, type BandDay, ContractError, type Cursor, canonicalJson, checkCursor, checkHistory, ID_GRAMMAR, isIsoUtc, jsonEqual, MAX_ID } from "@domains/adapter";
import { checkPackage, checkTag, LayoutError, parseTierTag, segmentTagProblem, WORKFLOW_RUN_ID } from "@domains/ghcr";
import { StateError } from "./errors.ts";

export const STATE_FORMAT = "domains.state.v1";
// The layer of a state object, and its media type (DOM-024).
export const STATE_TITLE = "state.json";
export const STATE_MEDIA_TYPE = "application/json";
export const STATE_MAX_BYTES = 1_048_576;
// The days of a source's history kept: the band reads the last 7 accepted
// days and runs of 3 (packages/adapter/src/band.ts), so 90 is a margin, not a need.
export const HISTORY_DAYS = 90;
// An owed pack the root has not named within this many days is dropped
// (`expired`), so a pack that waits on a hole (scripts/root/promote.mjs
// --partial) or that every promotion refuses is not added again for good.
export const OWED_DAYS = 7;

export type HistoryItem = BandDay;

export interface Moved {
  readonly at: string;
  readonly run: string;
}

export interface OwedItem {
  readonly ref: string;
  readonly digest: string;
  readonly dataset: "names" | "domains" | "feed";
  readonly tier: "seg" | "h";
  readonly start: string;
  readonly end: string;
  readonly since: string;
}

export interface State {
  readonly format: typeof STATE_FORMAT;
  readonly updated: string;
  readonly cursors: Readonly<Record<string, Cursor>>;
  readonly moved: Readonly<Record<string, Moved>>;
  readonly history: Readonly<Record<string, readonly HistoryItem[]>>;
  readonly owed: readonly OwedItem[];
}

const STATE_FIELDS = Object.freeze(["cursors", "format", "history", "moved", "owed", "updated"]);
const MOVED_FIELDS = Object.freeze(["at", "run"]);
const HISTORY_FIELDS = Object.freeze(["count", "day", "quarantined"]);
const OWED_FIELDS = Object.freeze(["dataset", "digest", "end", "ref", "since", "start", "tier"]);
const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// A workflow run id (WORKFLOW_RUN_ID of @domains/ghcr, digits), or "local"
// for a run outside Actions.
export const RUN_ID = new RegExp(`^(?:${WORKFLOW_RUN_ID.source.slice(1, -1)}|local)$`);
// A manifest digest as GHCR answers it.
export const DIGEST = /^sha256:[0-9a-f]{64}$/;

type Obj = Readonly<Record<string, unknown>>;
export const isObject = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const show = (v: unknown): string => (v === undefined ? "nothing" : JSON.stringify(v));

// ISO 8601 UTC to the second, `YYYY-MM-DDTHH:MM:SSZ`, naming a real instant
// of the years 1000 to 9999: the years a tag of @domains/ghcr names (its run
// tags and segment tags refuse the others), so a time this takes has a tag.
export function isSecond(t: unknown): t is string {
  return isIsoUtc(t) && t.length === 20 && t >= "1000";
}

// An adapter directory's name or a source id.
export function isId(v: unknown): v is string {
  return typeof v === "string" && ID_GRAMMAR.test(v) && v.length <= MAX_ID;
}

// Why the keys of `o` are not exactly `fields`, or null.
export function keysProblem(o: Obj, fields: readonly string[]): string | null {
  const missing = fields.filter((f) => !Object.hasOwn(o, f));
  if (missing.length > 0) return `${missing.join(", ")} missing`;
  const unknown = Object.keys(o).filter((k) => !fields.includes(k));
  if (unknown.length > 0) return `unknown field${unknown.length > 1 ? "s" : ""} ${unknown.join(", ")}`;
  return null;
}

// A ref `PACKAGE:TAG` read into its parts, or a problem.
export function refParts(ref: unknown): { readonly pkg: string; readonly tag: string } | string {
  if (typeof ref !== "string") return `${show(ref)} is not a ref PACKAGE:TAG`;
  const at = ref.indexOf(":");
  if (at < 1) return `${JSON.stringify(ref)} is not a ref PACKAGE:TAG`;
  try {
    return { pkg: checkPackage(ref.slice(0, at)), tag: checkTag(ref.slice(at + 1)) };
  } catch (e) {
    if (e instanceof LayoutError) return `${JSON.stringify(ref)}: ${e.message}`;
    throw e;
  }
}

// Why `tag` is not the hour pack of `feed` from start to end, or null.
function hourTagProblem(tag: string, start: string, end: string): string | null {
  let parts: ReturnType<typeof parseTierTag>;
  try {
    parts = parseTierTag(tag);
  } catch (e) {
    if (e instanceof LayoutError) return e.message;
    throw e;
  }
  if (parts.dataset !== "feed" || parts.tier !== "h") return `${tag} is a ${parts.dataset} pack of tier ${parts.tier}, not an hour pack of feed`;
  if (parts.start !== start || Date.parse(end) - Date.parse(start) !== HOUR_MS) return `${tag} spans the hour from ${parts.start}, not ${start} to ${end}`;
  return null;
}

// (start, then ref): the order of owed.
export const byStartRef = (a: OwedItem, b: OwedItem): number => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);

const schema = (detail: string): StateError => new StateError("schema", `state.json: ${detail}`);

// One owed item, checked whole, as a fresh object.
function owedItem(v: unknown, at: string): OwedItem {
  if (!isObject(v)) throw schema(`${at} is not an object`);
  const keys = keysProblem(v, OWED_FIELDS);
  if (keys !== null) throw schema(`${at}: ${keys}`);
  const { ref, digest, dataset, tier, start, end, since } = v;
  const parts = refParts(ref);
  if (typeof parts === "string") throw schema(`${at}.ref: ${parts}`);
  if (typeof digest !== "string" || !DIGEST.test(digest)) throw schema(`${at}.digest ${show(digest)} is not sha256: and 64 lowercase hex digits`);
  for (const [k, t] of [
    ["start", start],
    ["end", end],
    ["since", since],
  ] as const) {
    if (!isSecond(t)) throw schema(`${at}.${k} ${show(t)} is not an ISO 8601 UTC time to the second`);
  }
  const [s, e] = [start as string, end as string];
  if (!(s < e)) throw schema(`${at}: start ${s} is not before end ${e}`);
  let problem: string | null;
  if (parts.pkg === "obs") {
    if (tier !== "seg" || (dataset !== "names" && dataset !== "domains"))
      throw schema(`${at}: ${ref} is a segment of obs, so tier seg and dataset names or domains; it says tier ${show(tier)} and dataset ${show(dataset)}`);
    problem = segmentTagProblem(parts.tag, dataset, s, e);
  } else if (parts.pkg === "feed") {
    if (tier !== "h" || dataset !== "feed") throw schema(`${at}: ${ref} is an hour pack of feed, so tier h and dataset feed; it says tier ${show(tier)} and dataset ${show(dataset)}`);
    problem = hourTagProblem(parts.tag, s, e);
  } else {
    throw schema(`${at}.ref ${ref} is of the package ${parts.pkg}; an owed pack is a segment of obs or an hour pack of feed`);
  }
  if (problem !== null) throw schema(`${at}.ref: ${problem}`);
  return { ref: ref as string, digest, dataset, tier, start: s, end: e, since: since as string };
}

// One source's history, checked whole, as fresh objects in day order.
function historyList(v: unknown, at: string): HistoryItem[] {
  if (!Array.isArray(v)) throw schema(`${at} is not a list`);
  if (v.length === 0) throw schema(`${at} is empty; a source with no day has no key`);
  if (v.length > HISTORY_DAYS) throw schema(`${at} holds ${v.length} days, over ${HISTORY_DAYS}`);
  v.forEach((item: unknown, i: number) => {
    if (!isObject(item)) throw schema(`${at}[${i}] is not an object`);
    const keys = keysProblem(item, HISTORY_FIELDS);
    if (keys !== null) throw schema(`${at}[${i}]: ${keys}`);
    if (!Number.isSafeInteger(item.count)) throw schema(`${at}[${i}].count ${show(item.count)} is not a whole number`);
  });
  let days: BandDay[];
  try {
    days = checkHistory(v);
  } catch (e) {
    if (e instanceof BandError) throw schema(`${at}: ${e.message}`);
    throw e;
  }
  days.forEach((d, i) => {
    if ((v[i] as Obj).day !== d.day) throw schema(`${at} is not sorted by day: ${String((v[i] as Obj).day)} is at ${i}`);
  });
  return days.map((d) => ({ day: d.day, count: d.count, quarantined: d.quarantined }));
}

// `value` as a State, or StateError: `format` for another format, `schema`
// for every other rule of the header. The result is a fresh object; the
// cursors are kept as given.
export function validateState(value: unknown): State {
  if (!isObject(value)) throw schema("not an object");
  // The format first: a reader refuses a state it does not know.
  if (value.format !== STATE_FORMAT) throw new StateError("format", `state.json: the format is ${show(value.format)}; this reader knows ${STATE_FORMAT}`);
  const keys = keysProblem(value, STATE_FIELDS);
  if (keys !== null) throw schema(keys);
  if (!isSecond(value.updated)) throw schema(`updated ${show(value.updated)} is not an ISO 8601 UTC time to the second`);
  const { cursors, moved, history, owed } = value;
  if (!isObject(cursors)) throw schema("cursors is not an object");
  const nextCursors: Record<string, Cursor> = {};
  for (const [adapter, cursor] of Object.entries(cursors)) {
    if (!isId(adapter)) throw schema(`cursors names ${JSON.stringify(adapter)}, which is not an adapter id (at most ${MAX_ID} characters)`);
    try {
      nextCursors[adapter] = checkCursor(cursor, `cursors.${adapter}`);
    } catch (e) {
      if (e instanceof ContractError) throw schema(e.message);
      throw e;
    }
  }
  if (!isObject(moved)) throw schema("moved is not an object");
  const want = Object.keys(nextCursors).sort();
  const got = Object.keys(moved).sort();
  if (!jsonEqual(want, got)) throw schema(`moved names ${got.join(", ") || "no adapter"}, and cursors ${want.join(", ") || "no adapter"}: each cursor has one moved, and each moved one cursor`);
  const nextMoved: Record<string, Moved> = {};
  for (const [adapter, m] of Object.entries(moved)) {
    if (!isObject(m)) throw schema(`moved.${adapter} is not an object`);
    const k = keysProblem(m, MOVED_FIELDS);
    if (k !== null) throw schema(`moved.${adapter}: ${k}`);
    if (!isSecond(m.at)) throw schema(`moved.${adapter}.at ${show(m.at)} is not an ISO 8601 UTC time to the second`);
    if (typeof m.run !== "string" || !RUN_ID.test(m.run)) throw schema(`moved.${adapter}.run ${show(m.run)} is not a workflow run id nor "local"`);
    nextMoved[adapter] = { at: m.at, run: m.run };
  }
  if (!isObject(history)) throw schema("history is not an object");
  const nextHistory: Record<string, HistoryItem[]> = {};
  for (const [source, list] of Object.entries(history)) {
    if (!isId(source)) throw schema(`history names ${JSON.stringify(source)}, which is not a source id (at most ${MAX_ID} characters)`);
    nextHistory[source] = historyList(list, `history.${source}`);
  }
  if (!Array.isArray(owed)) throw schema("owed is not a list");
  const nextOwed = owed.map((item: unknown, i: number) => owedItem(item, `owed[${i}]`));
  const refs = new Set<string>();
  nextOwed.forEach((item, i) => {
    if (refs.has(item.ref)) throw schema(`owed lists ${item.ref} twice`);
    refs.add(item.ref);
    if (i > 0 && byStartRef(nextOwed[i - 1]!, item) >= 0)
      throw schema(`owed is not sorted by start, then ref: ${item.ref} from ${item.start} is after ${nextOwed[i - 1]!.ref} from ${nextOwed[i - 1]!.start}`);
  });
  return { format: STATE_FORMAT, updated: value.updated, cursors: nextCursors, moved: nextMoved, history: nextHistory, owed: nextOwed };
}

const encoder = new TextEncoder();

// UTF-8 JSON of at most `max` bytes, parsed; StateError `size` before any
// parsing, `format` for bytes that are not UTF-8 or text that is not JSON.
export function readJson(bytes: Uint8Array | string, max: number, what: string): unknown {
  let text: string;
  if (typeof bytes === "string") {
    // A string of n UTF-16 units encodes to at least n bytes: a longer one is
    // over the limit without encoding it.
    const n = bytes.length > max ? bytes.length : encoder.encode(bytes).byteLength;
    if (n > max) throw new StateError("size", `${what} is ${n} bytes or more, over ${max}`);
    text = bytes;
  } else if (bytes instanceof Uint8Array) {
    if (bytes.byteLength > max) throw new StateError("size", `${what} is ${bytes.byteLength} bytes, over ${max}`);
    try {
      // ignoreBOM: true keeps a byte order mark, which JSON.parse then
      // refuses, as packages/ghcr/src/reader.ts reads a manifest: bytes and
      // the same text as a string read alike.
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch (e) {
      if (e instanceof TypeError) throw new StateError("format", `${what} is not UTF-8`);
      throw e;
    }
  } else {
    throw new StateError("usage", `${what} is neither bytes nor text`);
  }
  try {
    return JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) throw new StateError("format", `${what} is not JSON: ${e.message}`);
    throw e;
  }
}

// Canonical JSON of `value` and one newline, at most `max` bytes.
export function writeJson(value: unknown, max: number, what: string): Uint8Array {
  const bytes = encoder.encode(`${canonicalJson(value)}\n`);
  if (bytes.byteLength > max) throw new StateError("size", `${what} is ${bytes.byteLength} bytes, over ${max}`);
  return bytes;
}

// The state with no cursor, no history and nothing owed, updated `now`.
export function emptyState(now: string): State {
  if (!isSecond(now)) throw new StateError("usage", `now ${show(now)} is not an ISO 8601 UTC time to the second`);
  return { format: STATE_FORMAT, updated: now, cursors: {}, moved: {}, history: {}, owed: [] };
}

export function parseState(bytes: Uint8Array | string): State {
  return validateState(readJson(bytes, STATE_MAX_BYTES, "state.json"));
}

export function encodeState(state: State): Uint8Array {
  return writeJson(validateState(state), STATE_MAX_BYTES, "state.json");
}

// What a move changes: everything but `updated` and `format`. null is the
// state no run has pushed, which holds nothing.
const body = (s: State | null): unknown => (s === null ? { cursors: {}, history: {}, moved: {}, owed: [] } : { cursors: s.cursors, history: s.history, moved: s.moved, owed: s.owed });

// Equal but for `updated`; null equals a state with no cursor, history or owed item.
export function sameState(a: State | null, b: State | null): boolean {
  return jsonEqual(body(a), body(b));
}

// The adapter's cursor, or null when the state holds none.
export function cursorOf(state: State | null, adapter: string): Cursor | null {
  return state !== null && Object.hasOwn(state.cursors, adapter) ? (state.cursors[adapter] as Cursor) : null;
}

// The source's volume history, in day order; empty when the state holds none.
export function historyOf(state: State | null, source: string): readonly HistoryItem[] {
  return state !== null && Object.hasOwn(state.history, source) ? (state.history[source] as readonly HistoryItem[]) : [];
}

// `owed` with `item` in its order, unless its ref is owed already. The same
// ref owed with another digest, dataset, tier or span is a fault: a tag is
// written once, so its ref names one pack.
export function oweInto(owed: readonly OwedItem[], item: OwedItem): readonly OwedItem[] {
  const live = owed.find((o) => o.ref === item.ref);
  if (live === undefined) return [...owed, item].sort(byStartRef);
  const pack = (o: OwedItem): string => canonicalJson({ ref: o.ref, digest: o.digest, dataset: o.dataset, tier: o.tier, start: o.start, end: o.end });
  if (pack(live) !== pack(item)) throw schema(`${item.ref} is owed as ${pack(live)}, and this item says ${pack(item)}`);
  return owed;
}

// The state with `item` owed, `updated` set to `now`; the state itself when
// the ref is owed already.
export function owe(state: State, item: OwedItem, now: string): State {
  if (!isSecond(now)) throw new StateError("usage", `now ${show(now)} is not an ISO 8601 UTC time to the second`);
  const checked = owedItem(item, "the owed item");
  const owed = oweInto(state.owed, checked);
  return owed === state.owed ? state : { ...state, updated: now, owed };
}
