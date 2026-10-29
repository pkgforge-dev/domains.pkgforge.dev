// packages/ledger/src/reconcile.ts — the hourly verdict and its daily repair.
//
//   const fresh = provisionalNew(hourDomainKeys, new ProvisionalFilter(filter, delta));  // each `provisional: true`
//   const fix = reconcile(provisionalKeysOfTheDay, exactNewKeysOfTheDay);
//
// provisionalNew is the hourly job's answer to "is this domain new?": a key the
// membership does not hold is new, and is added to it at once, so a second
// sighting in the same hour, or in a later hour that reads the pushed delta,
// is not new again. Its verdicts are `provisional` (docs/architecture.md
// section 5.8).
//
// reconcile compares the day's provisional verdicts with the exact join of
// exact.ts. The day pack is built from the exact join (DOM-022), not from the
// hourly rows, so no correction is lost; reconcile names them:
//   confirmed  provisional and exact: the event stays, `provisional: false`.
//   repaired   exact and not provisional: a false positive of the filter judged
//              the domain old, or no hourly job met it (a daily source). It gets
//              its feed event in the day pack, `provisional: false`.
//   retracted  provisional and not exact: the exact table holds an earlier
//              observation (a source the filter had not seen, or an earlier
//              first seen that a later source stated). The day pack leaves it
//              out.
import type { MembershipFilter } from "./filter.ts";
import { hashKey } from "./hash.ts";

// The keys of `keys` the membership does not hold, in their order, each added
// to it before the next key is asked.
export function provisionalNew(keys: Iterable<string>, membership: MembershipFilter): string[] {
  const out: string[] = [];
  for (const key of keys) {
    const h = hashKey(key);
    if (membership.has(h)) continue;
    membership.add(h);
    out.push(key);
  }
  return out;
}

export interface Reconciled {
  readonly confirmed: readonly string[];
  readonly repaired: readonly string[];
  readonly retracted: readonly string[];
}

const sortedUnique = (keys: Iterable<string>): string[] => [...new Set(keys)].sort();

export function reconcile(provisional: Iterable<string>, exact: Iterable<string>): Reconciled {
  const p = sortedUnique(provisional);
  const e = sortedUnique(exact);
  const confirmed: string[] = [];
  const repaired: string[] = [];
  const retracted: string[] = [];
  let i = 0;
  let j = 0;
  while (i < p.length || j < e.length) {
    if (j >= e.length || (i < p.length && p[i] < e[j])) retracted.push(p[i++]);
    else if (i >= p.length || e[j] < p[i]) repaired.push(e[j++]);
    else {
      confirmed.push(p[i]);
      i += 1;
      j += 1;
    }
  }
  return { confirmed, repaired, retracted };
}
