// packages/state/src/advance.ts — the move of the cursors: the one writer of
// state.json applies the proposals of one run's lanes to the live state
// (DOM-024, docs/architecture.md section 5.4), and settles the packs it owes.
//
//   advance(live, proposals, tagExists, { now, run })  →  { state, accepted, dropped, changed }
//   settle(state, held, now)                           →  { state, settled }
//
// advance, in this order:
//   1. the base is `live`, or the empty state when no state was ever pushed;
//   2. proposals in adapter order; every proposal of an adapter that has more
//      than one is dropped `duplicate` (one run of an adapter a run);
//   3. a proposal whose `before` is not the base's cursor of its adapter
//      (null equals an absent cursor) is dropped `stale-before`: another run
//      moved the cursor since it read it, so it is read again from the live one;
//   4. a proposal naming a ref whose tag is absent is dropped `missing-tag`,
//      one whose tag holds another digest `digest`;
//   5. an accepted proposal moves its adapter's cursor to `after`, records
//      the move in `moved`, merges its days into the history (a day present
//      is replaced, the newest HISTORY_DAYS kept), and owes each segment that
//      is not quarantined (D4 of DOM-024: a quarantined segment joins no root,
//      ruling 23);
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
// the live root names the ref; `covered`: a live feed pack of a higher tier
// spans an owed hour pack; `withdrawn`: the root's `withdrawn` lists its
// digest), and each whose `since` is more than OWED_DAYS days before `now`
// (`expired`). A segment is never covered: a pack of a higher tier built while
// the segment was owed does not hold its records, so a `covered` answer for a
// segment is refused (`usage`), never taken.
import { canonicalJson, jsonEqual } from "@domains/adapter";
import { StateError } from "./errors.ts";
import { type Proposal, proposedRefs, validateProposal } from "./proposal.ts";
import {
  cursorOf,
  DAY_MS,
  DIGEST,
  emptyState,
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
  let owed = base.owed;
  const accepted: Proposal[] = [];
  const dropped: Dropped[] = [];
  for (const adapter of [...byAdapter.keys()].sort()) {
    const list = byAdapter.get(adapter)!;
    if (list.length > 1) {
      const runs = list.map((p) => `run ${p.run} attempt ${p.attempt} at ${p.at}`).join(", ");
      for (let i = 0; i < list.length; i++)
        dropped.push({ adapter, code: "duplicate", detail: `${adapter} has ${list.length} proposals (${runs}); none is applied, and the adapter is read again from its live cursor` });
      continue;
    }
    const p = list[0]!;
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
    for (const s of p.segments) {
      if (!s.quarantined) owed = oweInto(owed, { ref: s.ref, digest: s.digest, dataset: s.dataset, tier: "seg", start: s.start, end: s.end, since: now });
    }
    accepted.push(p);
  }
  const draft: State = { format: STATE_FORMAT, updated: now, cursors, moved, history, owed };
  const changed = !sameState(live, draft);
  const state = validateState(changed ? draft : { ...draft, updated: base.updated });
  return { state, accepted, dropped, changed };
}

const HELD_CODES: readonly string[] = Object.freeze(["held", "covered", "withdrawn"]);

export function settle(state: State, held: Held, now: string): { readonly state: State; readonly settled: readonly Settled[] } {
  if (!isSecond(now)) throw usage(`now ${JSON.stringify(now ?? null)} is not an ISO 8601 UTC time to the second`);
  if (typeof held !== "function") throw usage("held is not a function");
  const live = validateState(state);
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
  return { state: settled.length === 0 ? live : { ...live, updated: now, owed: kept }, settled };
}
