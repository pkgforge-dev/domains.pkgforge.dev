// packages/ledger/src/exact.ts — which domains of a day no earlier tier holds.
//
//   for await (const d of exactNew(dayDomains, [yearPack, monthPack, ...weekAndDayPacks])) ...
//
// docs/architecture.md section 2: a registrable domain is `new` when its global
// first_seen falls inside the window, and the corpus shows no earlier
// observation from any source. exactNew merge-joins the day's domain records,
// in key order, with the `domains` packs of the earlier tiers: a day record
// whose key no earlier pack holds is yielded. With `since` (the window start)
// a record whose own first seen is earlier is not new either: one of its
// sources (an RDAP registration date, ISC's first-seen date) states an earlier
// observation.
//
// The join reads each earlier pack through its index (DOM-017): for a day key it
// finds the one block that may hold it, reads and checks that block once, and
// walks it forward while the day keys stay inside it. A block no day key falls
// in is never read, and no block is read twice, because the day keys ascend. A
// key outside a pack's key bounds costs no read. `stats` counts the blocks read.
//
// It runs in the daily compaction on a runner (DOM-023): the table of earlier
// tiers is read from local files there. It holds one block of each earlier pack.
import { type BlockEntry, DATASET_DOMAINS, type DomainRecord, type PackReader } from "@domains/pack";
import { LedgerError } from "./errors.ts";
import { firstSeen, type PrecisionOf } from "./time.ts";

export interface ExactOptions {
  // The start of the window, in seconds since 2026-01-01T00:00:00Z: a record
  // whose first seen is earlier is not new. Needs `precision`.
  readonly since?: number;
  readonly precision?: PrecisionOf;
  // Filled as the join runs.
  readonly stats?: ExactStats;
}

export interface ExactStats {
  // Day records read.
  day: number;
  // Day records yielded as new.
  new: number;
  // Day records absent from every earlier pack but first seen before `since`.
  early: number;
  // Blocks of the earlier packs read, over all of them.
  blocksRead: number;
}

export const newExactStats = (): ExactStats => ({ day: 0, new: 0, early: 0, blocksRead: 0 });

// One earlier pack, walked forward by ascending keys.
class Cursor {
  readonly reader: PackReader<DomainRecord>;
  readonly #stats: ExactStats;
  #entry: BlockEntry | null = null;
  // The index key of the block after #entry; null when #entry is the last.
  #next: string | null = null;
  #keys: string[] = [];
  #at = 0;

  constructor(reader: PackReader<DomainRecord>, stats: ExactStats) {
    this.reader = reader;
    this.#stats = stats;
  }

  async has(key: string): Promise<boolean> {
    const { keyMin, keyMax } = this.reader.index.head;
    if (keyMin === null || keyMax === null || key < keyMin || key > keyMax) return false;
    // The block held answers every key below the next block's index key. A key
    // at or past it is in a later block, so a block is never read twice.
    if (this.#entry === null || (this.#next !== null && key >= this.#next)) {
      const found = await this.reader.index.locateEntry(key);
      if (found === null) return false;
      await this.#load(found);
    }
    const keys = this.#keys;
    while (this.#at < keys.length && keys[this.#at] < key) this.#at += 1;
    return this.#at < keys.length && keys[this.#at] === key;
  }

  async #load(entry: BlockEntry): Promise<void> {
    const records = await this.reader.records(entry);
    this.#stats.blocksRead += 1;
    const blocks = this.reader.index.header.blocks;
    this.#entry = entry;
    this.#next = entry.index + 1 < blocks ? (await this.reader.index.entry(entry.index + 1)).key : null;
    this.#keys = records.map((r) => this.reader.codec.key(r));
    this.#at = 0;
  }
}

export async function* exactNew(day: Iterable<DomainRecord> | AsyncIterable<DomainRecord>, base: readonly PackReader<DomainRecord>[], options: ExactOptions = {}): AsyncGenerator<DomainRecord> {
  const stats = options.stats ?? newExactStats();
  const since = options.since;
  if (since !== undefined) {
    if (!Number.isSafeInteger(since) || since < 0) throw new LedgerError("usage", `exactNew: since must be whole seconds since 2026-01-01, not ${since}`);
    if (options.precision === undefined) throw new LedgerError("usage", "exactNew: since needs the precision of each source");
  }
  const cursors = base.map((reader, i) => {
    if (reader.index.header.dataset !== DATASET_DOMAINS) throw new LedgerError("usage", `exactNew: earlier pack ${i} is dataset ${reader.index.header.dataset}, not ${DATASET_DOMAINS} (domains)`);
    return new Cursor(reader, stats);
  });
  let prev: string | null = null;
  for await (const record of day) {
    const key = record.key;
    if (prev !== null && !(key > prev)) throw new LedgerError("order", `exactNew: the day key ${JSON.stringify(key.slice(0, 80))} is not above the key before it`);
    prev = key;
    stats.day += 1;
    let seen = false;
    // Every cursor must see every day key it is asked about in ascending order;
    // skipping a cursor for one key is safe, since the next key is larger.
    for (const cursor of cursors) {
      if (await cursor.has(key)) {
        seen = true;
        break;
      }
    }
    if (seen) continue;
    if (since !== undefined && options.precision !== undefined && firstSeen(record, options.precision).at < since) {
      stats.early += 1;
      continue;
    }
    stats.new += 1;
    yield record;
  }
}
