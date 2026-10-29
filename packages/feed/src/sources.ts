// packages/feed/src/sources.ts — what the feed needs to know of each source
// bit: its id, its family, its kind and its precision (docs/architecture.md
// section 3.5).
//
//   const table = sourceTable(registry.sources);   // config/sources.json, or the root's sources.json
//   table.family(8)      "isc"
//   table.precision(8)   "day"   (precisionsOf of @domains/ledger, the one precision table)
//
// A row with no bit feeds no masked dataset and is skipped, as precisionsOf
// skips it. A bit given twice with two families or two kinds is refused, and so
// is a later question about a bit the rows did not name: a guess would make a
// feed row corroborated, or not, by a family nobody stated.
import { type PrecisionOf, precisionsOf } from "@domains/ledger";
import { FeedError } from "./errors.ts";

export interface SourceRowLike {
  readonly id: string;
  readonly bit: number | null;
  readonly family: string;
  readonly precision: string;
  readonly kind: string;
}

export interface SourceTable {
  readonly precision: PrecisionOf;
  id(bit: number): string;
  family(bit: number): string;
  kind(bit: number): string;
}

interface Known {
  readonly id: string;
  readonly family: string;
  readonly kind: string;
}

const isText = (v: unknown): v is string => typeof v === "string" && v.length > 0;

export function sourceTable(rows: readonly SourceRowLike[]): SourceTable {
  const precision = precisionsOf(rows);
  const known = new Map<number, Known>();
  for (const row of rows) {
    if (row.bit === null) continue;
    if (!isText(row.id) || !isText(row.family) || !isText(row.kind)) throw new FeedError("usage", `source bit ${row.bit} needs an id, a family and a kind`);
    const before = known.get(row.bit);
    if (before !== undefined && (before.id !== row.id || before.family !== row.family || before.kind !== row.kind))
      throw new FeedError("usage", `source bit ${row.bit} is given twice: ${before.id} (${before.family}, ${before.kind}) and ${row.id} (${row.family}, ${row.kind})`);
    known.set(row.bit, { id: row.id, family: row.family, kind: row.kind });
  }
  const get = (bit: number): Known => {
    const k = known.get(bit);
    if (k === undefined) throw new FeedError("usage", `source bit ${bit} is not in the source table`);
    return k;
  };
  return {
    // The bit is asked of this table first, so an unknown bit is a FeedError
    // here as it is for id, family and kind.
    precision: (bit) => {
      get(bit);
      return precision(bit);
    },
    id: (bit) => get(bit).id,
    family: (bit) => get(bit).family,
    kind: (bit) => get(bit).kind,
  };
}
