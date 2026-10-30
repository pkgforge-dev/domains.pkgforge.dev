// packages/state/src/proposal.ts — the cursor proposal of one adapter run
// (format domains.proposal.v1), `proposal.<adapter>.json`, which a lane of
// ingest-live.yml writes and uploads and the job `push` reads (DOM-024):
//
//   { "format": "domains.proposal.v1", "adapter": "oi-cs", "lane": "kafka",
//     "run": "40000000001", "attempt": 1, "at": "2026-10-30T08:20:00Z",
//     "before": <cursor or null>, "after": <cursor>,
//     "segments": [ { "ref": "obs:<tag>", "digest": "sha256:...", "source": "oi-cs", "dataset": "domains",
//                     "start": "...", "end": "...", "count": 194303, "quarantined": false } ],
//     "raw":      [ { "ref": "obs:raw-<tag>", "digest": "sha256:...", "source": "oi-cs", "start": "...", "end": "..." } ],
//     "history":  [ { "source": "isc-new", "day": "2026-10-29", "count": 123, "quarantined": false } ] }
//
//   lane      kafka, tiles or feeds, or null for a run outside ingest-live.yml
//   before    the cursor the run read (null: none); after, the one it reached
//   segments  the segments it pushed, sorted by ref; `digest` is what the tag
//             holds in GHCR after the push; each tag is the one its source,
//             dataset and window give (segTag or fileTag, D11 of DOM-024)
//   raw       the raw lane objects it pushed (rawTag of source and window)
//   history   one day for each verified day of a day-precision source whose
//             window is one whole UTC day (D5 of DOM-024), in the band's
//             metric: the names segment's when the day has one, else the
//             domains segment's; its quarantined is that segment's verdict
//             (D18 of DOM-024)
//
// A proposal names at least one segment, or an `after` other than `before`:
// propose refuses an empty one, since it would move nothing. No ref twice
// across segments and raw; no (source, day) twice in history. Canonical JSON
// and one newline, at most PROPOSAL_MAX_BYTES. Every refusal is StateError
// `proposal`, but `format` (another format, bytes that are not UTF-8 JSON)
// and `size`.
import { BandError, ContractError, type Cursor, checkCursor, checkHistory, jsonEqual, MAX_ID } from "@domains/adapter";
import { LayoutError, rawTag, segmentTagProblem } from "@domains/ghcr";
import { StateError } from "./errors.ts";
import { DAY_MS, DIGEST, isId, isObject, isSecond, keysProblem, RUN_ID, readJson, refParts, writeJson } from "./state.ts";

export const PROPOSAL_FORMAT = "domains.proposal.v1";
export const PROPOSAL_MAX_BYTES = 1_048_576;
// The lanes of ingest-live.yml (D13 of DOM-024).
export const LANES = Object.freeze(["kafka", "tiles", "feeds"] as const);
export type Lane = (typeof LANES)[number];

export interface ProposedSegment {
  readonly ref: string;
  readonly digest: string;
  readonly source: string;
  readonly dataset: "names" | "domains";
  readonly start: string;
  readonly end: string;
  readonly count: number;
  readonly quarantined: boolean;
}

export interface ProposedRaw {
  readonly ref: string;
  readonly digest: string;
  readonly source: string;
  readonly start: string;
  readonly end: string;
}

export interface ProposedDay {
  readonly source: string;
  readonly day: string;
  readonly count: number;
  readonly quarantined: boolean;
}

export interface Proposal {
  readonly format: typeof PROPOSAL_FORMAT;
  readonly adapter: string;
  readonly lane: Lane | null;
  readonly run: string;
  readonly attempt: number;
  readonly at: string;
  readonly before: Cursor | null;
  readonly after: Cursor;
  readonly segments: readonly ProposedSegment[];
  readonly raw: readonly ProposedRaw[];
  readonly history: readonly ProposedDay[];
}

export type ProposeInput = Omit<Proposal, "format">;

const PROPOSAL_FIELDS = Object.freeze(["adapter", "after", "at", "attempt", "before", "format", "history", "lane", "raw", "run", "segments"]);
const SEGMENT_FIELDS = Object.freeze(["count", "dataset", "digest", "end", "quarantined", "ref", "source", "start"]);
const RAW_FIELDS = Object.freeze(["digest", "end", "ref", "source", "start"]);
const DAY_FIELDS = Object.freeze(["count", "day", "quarantined", "source"]);

const bad = (detail: string): StateError => new StateError("proposal", `proposal: ${detail}`);
const show = (v: unknown): string => (v === undefined ? "nothing" : JSON.stringify(v));
const byRef = (a: { readonly ref: string }, b: { readonly ref: string }): number => (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0);
const byDay = (a: ProposedDay, b: ProposedDay): number => (a.source < b.source ? -1 : a.source > b.source ? 1 : a.day < b.day ? -1 : a.day > b.day ? 1 : 0);

function cursor(v: unknown, at: string): Cursor {
  try {
    return checkCursor(v, at);
  } catch (e) {
    if (e instanceof ContractError) throw bad(e.message);
    throw e;
  }
}

// The window of an item: two ISO 8601 UTC times to the second, start first.
function windowOf(o: Readonly<Record<string, unknown>>, at: string): [string, string] {
  const { start, end } = o;
  if (!isSecond(start) || !isSecond(end)) throw bad(`${at}: start ${show(start)} and end ${show(end)} are not ISO 8601 UTC times to the second`);
  if (!(start < end)) throw bad(`${at}: start ${start} is not before end ${end}`);
  return [start, end];
}

// The `obs` tag of a ref, or a refusal.
function obsTag(ref: unknown, at: string): string {
  const parts = refParts(ref);
  if (typeof parts === "string") throw bad(`${at}.ref: ${parts}`);
  if (parts.pkg !== "obs") throw bad(`${at}.ref ${String(ref)} is of the package ${parts.pkg}, not obs`);
  return parts.tag;
}

function digestOf(v: unknown, at: string): string {
  if (typeof v !== "string" || !DIGEST.test(v)) throw bad(`${at}.digest ${show(v)} is not sha256: and 64 lowercase hex digits`);
  return v;
}

function sourceOf(v: unknown, at: string): string {
  if (!isId(v)) throw bad(`${at}.source ${show(v)} is not a source id (at most ${MAX_ID} characters)`);
  return v;
}

function segment(v: unknown, at: string): ProposedSegment {
  if (!isObject(v)) throw bad(`${at} is not an object`);
  const keys = keysProblem(v, SEGMENT_FIELDS);
  if (keys !== null) throw bad(`${at}: ${keys}`);
  const tag = obsTag(v.ref, at);
  const digest = digestOf(v.digest, at);
  const source = sourceOf(v.source, at);
  const dataset = v.dataset;
  if (dataset !== "names" && dataset !== "domains") throw bad(`${at}.dataset ${show(dataset)} is not names or domains`);
  const [start, end] = windowOf(v, at);
  if (!Number.isSafeInteger(v.count) || (v.count as number) < 0) throw bad(`${at}.count ${show(v.count)} is not a whole number of at least 0`);
  if (typeof v.quarantined !== "boolean") throw bad(`${at}.quarantined is not true or false`);
  const problem = segmentTagProblem(tag, dataset, start, end, source);
  if (problem !== null) throw bad(`${at}.ref: ${problem}`);
  return { ref: v.ref as string, digest, source, dataset, start, end, count: v.count as number, quarantined: v.quarantined };
}

function raw(v: unknown, at: string): ProposedRaw {
  if (!isObject(v)) throw bad(`${at} is not an object`);
  const keys = keysProblem(v, RAW_FIELDS);
  if (keys !== null) throw bad(`${at}: ${keys}`);
  const tag = obsTag(v.ref, at);
  const digest = digestOf(v.digest, at);
  const source = sourceOf(v.source, at);
  const [start, end] = windowOf(v, at);
  let want: string;
  try {
    want = rawTag(source, start, end);
  } catch (e) {
    if (e instanceof LayoutError) throw bad(`${at}: ${e.message}`);
    throw e;
  }
  if (tag !== want) throw bad(`${at}.ref: ${tag} is not the raw lane object of ${source} from ${start} to ${end}, which is ${want}`);
  return { ref: v.ref as string, digest, source, start, end };
}

function day(v: unknown, at: string): ProposedDay {
  if (!isObject(v)) throw bad(`${at} is not an object`);
  const keys = keysProblem(v, DAY_FIELDS);
  if (keys !== null) throw bad(`${at}: ${keys}`);
  const source = sourceOf(v.source, at);
  if (!Number.isSafeInteger(v.count)) throw bad(`${at}.count ${show(v.count)} is not a whole number`);
  try {
    // The shape of one band day (day, count of at least 0, quarantined).
    checkHistory([{ day: v.day, count: v.count, quarantined: v.quarantined }]);
  } catch (e) {
    if (e instanceof BandError) throw bad(`${at}: ${e.message.replace(/^history\[0\]/, "the day")}`);
    throw e;
  }
  return { source, day: v.day as string, count: v.count as number, quarantined: v.quarantined as boolean };
}

function list<T>(v: unknown, at: string, item: (x: unknown, at: string) => T): T[] {
  if (!Array.isArray(v)) throw bad(`${at} is not a list`);
  return v.map((x: unknown, i: number) => item(x, `${at}[${i}]`));
}

// `value` as a Proposal, or StateError (`format` for another format, else
// `proposal`). The result is a fresh object; the cursors are kept as given.
export function validateProposal(value: unknown): Proposal {
  if (!isObject(value)) throw bad("not an object");
  if (value.format !== PROPOSAL_FORMAT) throw new StateError("format", `proposal: the format is ${show(value.format)}; this reader knows ${PROPOSAL_FORMAT}`);
  const keys = keysProblem(value, PROPOSAL_FIELDS);
  if (keys !== null) throw bad(keys);
  const { adapter, lane, run, attempt, at } = value;
  if (!isId(adapter)) throw bad(`adapter ${show(adapter)} is not an adapter id (at most ${MAX_ID} characters)`);
  if (lane !== null && !(LANES as readonly unknown[]).includes(lane)) throw bad(`lane ${show(lane)} is not one of ${LANES.join(", ")}, nor null`);
  if (typeof run !== "string" || !RUN_ID.test(run)) throw bad(`run ${show(run)} is not a workflow run id nor "local"`);
  if (!Number.isSafeInteger(attempt) || (attempt as number) < 1) throw bad(`attempt ${show(attempt)} is not a whole number of at least 1`);
  if (!isSecond(at)) throw bad(`at ${show(at)} is not an ISO 8601 UTC time to the second`);
  const before = value.before === null ? null : cursor(value.before, "before");
  const after = cursor(value.after, "after");
  const segments = list(value.segments, "segments", segment);
  segments.forEach((s, i) => {
    if (i > 0 && byRef(segments[i - 1]!, s) >= 0) throw bad(`segments is not sorted by ref, one each: ${s.ref} follows ${segments[i - 1]!.ref}`);
  });
  const raws = list(value.raw, "raw", raw);
  const refs = new Set<string>(segments.map((s) => s.ref));
  for (const r of raws) {
    if (refs.has(r.ref)) throw bad(`${r.ref} is named twice`);
    refs.add(r.ref);
  }
  const history = list(value.history, "history", day);
  const days = new Set<string>();
  for (const h of history) {
    const key = `${h.source} ${h.day}`;
    if (days.has(key)) throw bad(`history lists ${h.source} on ${h.day} twice`);
    days.add(key);
    const start = `${h.day}T00:00:00Z`;
    const end = new Date(Date.parse(start) + DAY_MS).toISOString().replace(".000Z", "Z");
    const spans = segments.filter((s) => s.source === h.source && s.start === start && s.end === end);
    if (spans.length === 0) {
      throw bad(`history lists ${h.source} on ${h.day}, and no segment of ${h.source} spans that day from ${start} to ${end}: a day of history is a verified one-day segment's`);
    }
    // The day is its segment's verdict (D18 of DOM-024): the names segment's
    // when the day has one, else the domains segment's.
    const names = spans.filter((s) => s.dataset === "names");
    const own = names.length > 0 ? names : spans;
    if (own.some((s) => s.quarantined !== h.quarantined)) {
      throw bad(
        `history lists ${h.source} on ${h.day} with quarantined ${h.quarantined}, and its ${own[0]!.dataset} segment of that day has quarantined ${!h.quarantined}: a day of history carries that segment's verdict`,
      );
    }
  }
  if (segments.length === 0 && jsonEqual(before, after)) throw bad(`${adapter} names no segment and keeps its cursor ${JSON.stringify(after)}: an empty proposal moves nothing`);
  return {
    format: PROPOSAL_FORMAT,
    adapter,
    lane: lane as Lane | null,
    run,
    attempt: attempt as number,
    at,
    before,
    after,
    segments,
    raw: raws,
    history,
  };
}

// The proposal of `input`, checked whole, with segments and raw sorted by ref
// and history by source and day, so that one run gives one text whatever the
// order the run met them in. StateError `proposal` for any refusal.
export function propose(input: ProposeInput): Proposal {
  if (!isObject(input)) throw bad("the input is not an object");
  // A list sorts when it is a list of objects; anything else is left for
  // validateProposal to refuse, and an absent field stays absent.
  const value: Record<string, unknown> = { ...input, format: PROPOSAL_FORMAT };
  const sort = <T>(key: string, by: (a: T, b: T) => number): void => {
    const v = value[key];
    if (Array.isArray(v) && v.every(isObject)) value[key] = [...(v as T[])].sort(by);
  };
  sort("segments", byRef);
  sort("raw", byRef);
  sort("history", byDay);
  // `format` is set here, so validateProposal's one other code cannot occur.
  return validateProposal(value);
}

export function parseProposal(bytes: Uint8Array | string): Proposal {
  return validateProposal(readJson(bytes, PROPOSAL_MAX_BYTES, "proposal"));
}

export function encodeProposal(p: Proposal): Uint8Array {
  return writeJson(validateProposal(p), PROPOSAL_MAX_BYTES, "proposal");
}

// `proposal.<adapter>.json`: the file of one adapter's proposal in a lane's
// artifact proposals-<lane>, so two adapters of a lane never share a name.
export function proposalFile(adapter: string): string {
  if (!isId(adapter)) throw new StateError("usage", `${show(adapter)} is not an adapter id (at most ${MAX_ID} characters)`);
  return `proposal.${adapter}.json`;
}

// Every ref a proposal names with the digest it says the tag holds: its
// segments, then its raw objects.
export function proposedRefs(p: Proposal): readonly { readonly ref: string; readonly digest: string }[] {
  return [...p.segments, ...p.raw].map((x) => ({ ref: x.ref, digest: x.digest }));
}
