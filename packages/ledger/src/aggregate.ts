// packages/ledger/src/aggregate.ts — name records to domain records.
//
//   for await (const d of aggregateToDomains(namesPack.scan(), psl)) writer.add(d);
//
// Each name record becomes part of the record of its registrable domain
// (docs/architecture.md section 2, `reg`), keyed by the reversed registrable
// domain: per source bit, the minimum first and the maximum last (mergeSeen of
// the pack format, the one rule every merge uses). The wildcard flag is
// dropped: it says how a name was seen, not the domain. The exact flag is kept
// when the registrable domain itself was seen as an exact name. A record made
// here carries no evidence entry: `ct-first` is the basis of a CT source and the
// registry states it; an entry would repeat the source's first time. Evidence
// comes from the domain-level adapters, which emit domain records directly.
//
// A name that is itself an ICANN public suffix under the list given has no
// registrable domain. normalise refuses such a name at ingest, so here it is a
// name stored under an older list that the new one made a suffix (a PSL update,
// docs/architecture.md section 5.4): it is skipped and counted in `suffixes`.
//
// Streaming. The names arrive in key order and the domains leave in key order,
// holding only the domains whose names may still arrive. Every name of a
// registrable domain R has the key R or a key that starts with R + ".", so none
// arrives once the input passes R + "/". Domains do not leave in the order
// their first names arrive, though: `com.my-site` arrives before `com.my.www`,
// because `-` sorts below `.`, and the domain of `com.my.www`, `com.my`, sorts
// below `com.my-site`. A later name can make a domain below R only through a
// prefix of R cut just before a `-` or a `.` that is itself a registrable
// domain (`com.my` of `com.my-site`; `com.zone` of `com.zone.deep.a` where
// `deep.zone.com` is a suffix and `zone.com` is not). So R leaves once the input
// passes the shortest such cut plus "/" (releaseKey). The domains held are
// those between R and that bound: `com.my-*` while `com.my` is open. A check
// refuses an output key that does not ascend, so a fault of this rule fails
// loudly instead of writing a pack out of order.
import { fromKey, type Psl, split } from "@domains/names";
import { type DomainRecord, FLAG_EXACT, mergeSeen, type NameRecord, type Seen } from "@domains/pack";
import { LedgerError } from "./errors.ts";

const DOT = 46;
const HYPHEN = 45;

export interface AggregateCounts {
  // Name records read.
  names: number;
  // Domain records written.
  domains: number;
  // Names skipped because the list makes them a public suffix.
  suffixes: number;
  // The most domains held at once.
  held: number;
}

export const newCounts = (): AggregateCounts => ({ names: 0, domains: 0, suffixes: 0, held: 0 });

// The first n labels of a key.
function firstLabels(key: string, n: number): string {
  let at = -1;
  for (let i = 0; i < n; i += 1) {
    at = key.indexOf(".", at + 1);
    if (at === -1) return key;
  }
  return key.slice(0, at);
}

// True when the key's name is its own registrable domain under the list.
function isRegistrable(k: string, psl: Psl): boolean {
  const name = fromKey(k);
  return split(name, psl).reg === name;
}

// The key the input must pass before the domain regKey can leave: past it, no
// name of that domain and no name of a domain sorting below it can arrive. It
// is the shortest prefix of regKey cut just before a `.` or a `-` that is itself
// registrable, plus "/", else regKey plus "/". A cut needs two labels and a
// non-empty last label, or it names nothing.
export function releaseKey(regKey: string, psl: Psl): string {
  const firstDot = regKey.indexOf(".");
  for (let i = firstDot + 1; i < regKey.length; i += 1) {
    const c = regKey.charCodeAt(i);
    if ((c === DOT || c === HYPHEN) && regKey.charCodeAt(i - 1) !== DOT) {
      const cut = regKey.slice(0, i);
      if (isRegistrable(cut, psl)) return `${cut}/`;
    }
  }
  return `${regKey}/`;
}

interface Held {
  readonly key: string;
  readonly release: string;
  flags: number;
  sources: Seen[];
}

// A min-heap of held domains by key.
class Heap {
  readonly items: Held[] = [];

  push(item: Held): void {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!(a[i].key < a[parent].key)) break;
      [a[i], a[parent]] = [a[parent], a[i]];
      i = parent;
    }
  }

  pop(): Held | undefined {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length > 0 && last !== undefined) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].key < a[m].key) m = l;
        if (r < a.length && a[r].key < a[m].key) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }

  peek(): Held | undefined {
    return this.items[0];
  }
}

export async function* aggregateToDomains(names: Iterable<NameRecord> | AsyncIterable<NameRecord>, psl: Psl, counts: AggregateCounts = newCounts()): AsyncGenerator<DomainRecord> {
  const held = new Map<string, Held>();
  const heap = new Heap();
  let prevName: string | null = null;
  let prevOut: string | null = null;
  const release = (item: Held): DomainRecord => {
    held.delete(item.key);
    if (prevOut !== null && !(item.key > prevOut))
      throw new LedgerError("order", `aggregate: the domain ${JSON.stringify(item.key.slice(0, 80))} would leave after ${JSON.stringify(prevOut.slice(0, 80))}`);
    prevOut = item.key;
    counts.domains += 1;
    return { key: item.key, flags: item.flags, sources: item.sources, evidence: [] };
  };
  for await (const record of names) {
    const k = record.key;
    if (typeof k !== "string" || k.length === 0) throw new LedgerError("usage", "aggregate: a name record has no key");
    if (prevName !== null && !(k > prevName)) throw new LedgerError("order", `aggregate: the name ${JSON.stringify(k.slice(0, 80))} is not above the name before it`);
    prevName = k;
    counts.names += 1;
    for (let top = heap.peek(); top !== undefined && top.release <= k; top = heap.peek()) {
      heap.pop();
      yield release(top);
    }
    const name = fromKey(k);
    const reg = split(name, psl).reg;
    if (reg === null) {
      counts.suffixes += 1;
      continue;
    }
    let labels = 1;
    for (let i = 0; i < reg.length; i += 1) if (reg.charCodeAt(i) === DOT) labels += 1;
    const regKey = firstLabels(k, labels);
    const exact = regKey === k ? record.flags & FLAG_EXACT : 0;
    const item = held.get(regKey);
    if (item === undefined) {
      const fresh: Held = { key: regKey, release: releaseKey(regKey, psl), flags: exact, sources: [...record.sources] };
      held.set(regKey, fresh);
      heap.push(fresh);
      if (held.size > counts.held) counts.held = held.size;
    } else {
      item.flags |= exact;
      item.sources = mergeSeen(item.sources, record.sources);
    }
  }
  for (let top = heap.pop(); top !== undefined; top = heap.pop()) yield release(top);
}
