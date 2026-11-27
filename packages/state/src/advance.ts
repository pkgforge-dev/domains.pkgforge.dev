// packages/state/src/advance.ts — the move of the cursors: the one writer of
// state.json applies the proposals of one run's lanes to the live state
// (DOM-024, docs/architecture.md section 5.4), and settles the packs it owes.
//
//   advance(live, proposals, tagExists, { now, run })  →  { state, accepted, dropped, changed }
//   settle(state, held, now, gapHeld?)                 →  { state, settled, settledGaps }
//
// advance, in this order:
//   1. the base is `live`, or the empty state when no state was ever pushed;
//   2. proposals in adapter order; when an adapter has more than one, every
//      one of them is dropped `duplicate` (one run of an adapter a run),
//      unless every one keeps its cursor (`before` equal to `after`) and no
//      ref, and no (source, day) of history, is in two of them: the legs of
//      one backfill, a window each, all accepted (D13 of DOM-029). A mix of a
//      moving and a keeping proposal of one adapter is still `duplicate`;
//   3. a proposal whose `before` is not the base's cursor of its adapter
//      (null equals an absent cursor) is dropped `stale-before`: another run
//      moved the cursor since it read it, so it is read again from the live one;
//   4. a proposal naming a ref whose tag is absent is dropped `missing-tag`,
//      one whose tag holds another digest `digest`;
//   5. an accepted proposal moves its adapter's cursor to `after`, records
//      the move in `moved`, merges its days into the history (a day present
//      is replaced, the newest HISTORY_DAYS kept), owes each segment,
//      quarantined or not (a quarantined segment joins the root marked, ruling
//      23 and D7 of DOM-029, which lifts D4 of DOM-024), and adds its gaps to
//      the pending gaps (the newest GAP_DAYS a source kept);
//   6. `changed` is whether the next state differs from the live one but for
//      `updated`, which is `now` when it does and the live one when not.
// A dropped adapter is read again from its old cursor by the next run, which
// writes the same segments under the same write-once tags.
//
// `tagExists(ref)` answers the digest the tag holds, or null when it is
// absent; the caller reads every ref first (an anonymous HEAD each), so this
// stays pure. A proposal that does not validate is the caller's fault: the
// CLI drops a file that does not parse as `invalid` (D24 of DOM-024) before it
// calls.
//
// settle drops each owed item for which `held(item)` answers a code (`held`:
// the live root names the ref, or a root on the chain of `previous` named the
// segment and a compaction replaced it; `covered`: a live feed pack of a higher
// tier spans an owed hour pack; `withdrawn`: the root's `withdrawn` lists its
// digest), and each whose `since` is more than OWED_DAYS days before `now`
// (`expired`). A segment is never covered: a pack of a higher tier built while
// the segment was owed and not in the root does not hold its records, so a
// `covered` answer for a segment is refused (`usage`), never taken. Only a
// root that named the segment tells the two apart: the caller's `held` reads
// that (replacedOnChain of scripts/state/lib.mjs, DOM-063), and this package
// reads no root.
//
// settle also drops each pending gap day for which `gapHeld(source, day)`
// answers { code: "held", detail } (D9 of DOM-029): gapHeldBy of
// scripts/state/lib.mjs answers it when the live root's gaps lists the day, or
// a live segment of that source spans the whole day. A pending gap never
// expires: it waits for the promotion that lists it.
import { canonicalJson, jsonEqual } from "@domains/adapter";
import { StateError } from "./errors.ts";
import { type Proposal, proposedRefs, validateProposal } from "./proposal.ts";
import {
  cursorOf,
  DAY_MS,
  DIGEST,
  emptyState,
  GAP_DAYS,
  type HistoryItem,
  HISTORY_DAYS,
  isObject,
  isSecond,
  OWED_DAYS,
  type OwedItem,
  oweInto,
  RUN_ID,
  STATE_FORMAT,
  type State,
  sameState,
  validateState,
  withGaps,
} from "./state.ts";

export type DropCode = "invalid" | "duplicate" | "stale-before" | "missing-tag" | "digest";

export interface Dropped {
  // null when the adapter is not known: a file that does not parse (`invalid`).
  readonly adapter: string | null;
  readonly code: DropCode;
  readonly detail: string;
}

export interface Advanced {
  readonly state: State;
  readonly accepted: readonly Proposal[];
  readonly dropped: readonly Dropped[];
  readonly changed: boolean;
}

export type SettleCode = "held" | "covered" | "withdrawn" | "expired";

export interface Settled {
  readonly item: OwedItem;
  readonly code: SettleCode;
  readonly detail: string;
}

export type Held = (item: OwedItem) => { readonly code: Exclude<SettleCode, "expired">; readonly detail: string } | null;

// A pending gap day settle dropped, and why.
export interface SettledGap {
  readonly source: string;
  readonly day: string;
  readonly detail: string;
}

export type GapHeld = (source: string, day: string) => { readonly code: "held"; readonly detail: string } | null;

const usage = (detail: string): StateError => new StateError("usage", detail);
const cursorText = (c: unknown): string => (c === null ? "none" : canonicalJson(c));

// `days` with `item` in it, replacing its day when present, in day order, the
// newest HISTORY_DAYS kept.
function mergeDay(days: readonly HistoryItem[], item: HistoryItem): HistoryItem[] {
  const next = days.filter((d) => d.day !== item.day);
  next.push({ day: item.day, count: item.count, quarantined: item.quarantined });
  next.sort((a, b) => (a.day < b.day ? -1 : 1));
  return next.slice(-HISTORY_DAYS);
}

// Why the proposals of one adapter cannot all apply, or null (rule 2): one of
// them moves its cursor, or two name one ref or one (source, day) of history.
// The cursor check comes first: two runs of an adapter that move it are two
// runs too many, whatever they name.
function keepingClash(list: readonly Proposal[]): string | null {
  const moving = list.find((p) => !jsonEqual(p.before, p.after));
  if (moving !== undefined) return `run ${moving.run} moves the cursor from ${cursorText(moving.before)} to ${cursorText(moving.after)}`;
  const refs = new Set<string>();
  const days = new Set<string>();
  for (const p of list) {
    for (const { ref } of proposedRefs(p)) {
      if (refs.has(ref)) return `${ref} is in two of them`;
      refs.add(ref);
    }
    for (const d of p.history) {
      const key = `${d.source} ${d.day}`;
      if (days.has(key)) return `the history day ${key} is in two of them`;
      days.add(key);
    }
  }
  return null;
}

// Why a proposal's refs do not stand in GHCR as it says, or null.
function refProblem(p: Proposal, tagExists: (ref: string) => string | null): Dropped | null {
  for (const { ref, digest } of proposedRefs(p)) {
    const found = tagExists(ref);
    if (found !== null && (typeof found !== "string" || !DIGEST.test(found))) throw usage(`tagExists answered ${JSON.stringify(found)} for ${ref}, neither a sha256: digest nor null`);
    if (found === null)
      return { adapter: p.adapter, code: "missing-tag", detail: `${p.adapter} names ${ref}, which GHCR does not hold; the adapter is read again from its cursor ${cursorText(p.before)}` };
    if (found !== digest)
      return { adapter: p.adapter, code: "digest", detail: `${p.adapter} names ${ref} at ${digest}, and the tag holds ${found}; the adapter is read again from its cursor ${cursorText(p.before)}` };
  }
  return null;
}

export function advance(live: State | null, proposals: readonly Proposal[], tagExists: (ref: string) => string | null, options: { readonly now: string; readonly run: string }): Advanced {
  if (!isObject(options)) throw usage("advance takes the options { now, run }");
  const { now, run } = options;
  if (!isSecond(now)) throw usage(`now ${JSON.stringify(now ?? null)} is not an ISO 8601 UTC time to the second`);
  if (typeof run !== "string" || !RUN_ID.test(run)) throw usage(`run ${JSON.stringify(run ?? null)} is not a workflow run id nor "local"`);
  if (typeof tagExists !== "function") throw usage("tagExists is not a function");
  if (!Array.isArray(proposals)) throw usage("the proposals are not a list");
  const base = live === null ? emptyState(now) : validateState(live);
  const byAdapter = new Map<string, Proposal[]>();
  for (const p of proposals.map((x) => validateProposal(x))) {
    const list = byAdapter.get(p.adapter);
    if (list === undefined) byAdapter.set(p.adapter, [p]);
    else list.push(p);
  }
  const cursors = { ...base.cursors };
  const moved = { ...base.moved };
  const history: Record<string, readonly HistoryItem[]> = { ...base.history };
  const gaps: Record<string, readonly string[]> = { ...base.gaps };
  let owed = base.owed;
  const accepted: Proposal[] = [];
  const dropped: Dropped[] = [];
  for (const adapter of [...byAdapter.keys()].sort()) {
    const list = byAdapter.get(adapter)!;
    if (list.length > 1) {
      const clash = keepingClash(list);
      if (clash !== null) {
        const runs = list.map((p) => `run ${p.run} attempt ${p.attempt} at ${p.at}`).join(", ");
        for (let i = 0; i < list.length; i++)
          dropped.push({ adapter, code: "duplicate", detail: `${adapter} has ${list.length} proposals (${runs}), and ${clash}; none is applied, and the adapter is read again from its live cursor` });
        continue;
      }
    }
    for (const p of list) {
      const current = cursorOf(base, adapter);
      if (!jsonEqual(p.before, current)) {
        dropped.push({
          adapter,
          code: "stale-before",
          detail: `${adapter} proposes from the cursor ${cursorText(p.before)}, and the live cursor is ${cursorText(current)}: another run moved it; the adapter is read again from the live one`,
        });
        continue;
      }
      const missing = refProblem(p, tagExists);
      if (missing !== null) {
        dropped.push(missing);
        continue;
      }
      cursors[adapter] = p.after;
      moved[adapter] = { at: now, run };
      // Object.hasOwn: a source id such as `constructor` is no key of Object.prototype here.
      for (const d of p.history) history[d.source] = mergeDay(Object.hasOwn(history, d.source) ? history[d.source]! : [], d);
      for (const s of p.segments) owed = oweInto(owed, { ref: s.ref, digest: s.digest, dataset: s.dataset, tier: "seg", start: s.start, end: s.end, since: now });
      for (const g of p.gaps ?? []) gaps[g.source] = [...new Set([...(Object.hasOwn(gaps, g.source) ? gaps[g.source]! : []), g.day])].sort().slice(-GAP_DAYS);
      accepted.push(p);
    }
  }
  const draft: State = withGaps({ format: STATE_FORMAT, updated: now, cursors, moved, history, owed }, gaps);
  const changed = !sameState(live, draft);
  const state = validateState(changed ? draft : { ...draft, updated: base.updated });
  return { state, accepted, dropped, changed };
}

const HELD_CODES: readonly string[] = Object.freeze(["held", "covered", "withdrawn"]);

export function settle(
  state: State,
  held: Held,
  now: string,
  gapHeld: GapHeld = () => null,
): { readonly state: State; readonly settled: readonly Settled[]; readonly settledGaps: readonly SettledGap[] } {
  if (!isSecond(now)) throw usage(`now ${JSON.stringify(now ?? null)} is not an ISO 8601 UTC time to the second`);
  if (typeof held !== "function") throw usage("held is not a function");
  if (typeof gapHeld !== "function") throw usage("gapHeld is not a function");
  const live = validateState(state);
  const settledGaps: SettledGap[] = [];
  const pending: Record<string, string[]> = {};
  for (const [source, days] of Object.entries(live.gaps ?? {})) {
    pending[source] = [];
    for (const day of days) {
      const answer: unknown = gapHeld(source, day);
      if (answer === null) {
        pending[source].push(day);
        continue;
      }
      if (!isObject(answer) || answer.code !== "held" || typeof answer.detail !== "string") {
        throw usage(`gapHeld answered ${JSON.stringify(answer ?? null)} for ${source} ${day}; it answers null or { code: held, detail }`);
      }
      settledGaps.push({ source, day, detail: answer.detail });
    }
  }
  const kept: OwedItem[] = [];
  const settled: Settled[] = [];
  for (const item of live.owed) {
    const answer: unknown = held(item);
    if (answer !== null) {
      if (!isObject(answer) || !HELD_CODES.includes(answer.code as string) || typeof answer.detail !== "string") {
        throw usage(`held answered ${JSON.stringify(answer ?? null)} for ${item.ref}; it answers null or { code: held, covered or withdrawn, detail }`);
      }
      const code = answer.code as Exclude<SettleCode, "expired">;
      if (code === "covered" && item.tier !== "h") {
        throw usage(`held answered covered for ${item.ref}, a segment: a pack of a higher tier built while it was owed does not hold its records, so only an hour pack is covered`);
      }
      settled.push({ item, code, detail: answer.detail });
      continue;
    }
    const age = Date.parse(now) - Date.parse(item.since);
    if (age > OWED_DAYS * DAY_MS) {
      settled.push({ item, code: "expired", detail: `${item.ref} is owed since ${item.since}, more than ${OWED_DAYS} days before ${now}, and no root names it` });
      continue;
    }
    kept.push(item);
  }
  if (settled.length === 0 && settledGaps.length === 0) return { state: live, settled, settledGaps };
  return { state: withGaps({ ...live, updated: now, owed: kept }, pending), settled, settledGaps };
}
