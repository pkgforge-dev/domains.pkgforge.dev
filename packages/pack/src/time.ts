// packages/pack/src/time.ts — the bind of a time copy to its key copy
// (docs/format.md section 14.4).
//
//   timeBindFault(keyHead, timeHead, span)   why a time copy is not the copy of its key copy, read from the two index heads; null when it binds
//   new RowSum()                              an order-free sum of rows: the same rows, read in any order, give the same sum
//
// A reader holds both index heads before it reads a block, so it checks the
// half of the bind the heads hold: the time copy is the time dataset of its
// key copy (6 for 3, 7 for 5), it holds the same number of records, and its
// first and last first_seen lie inside the span of the pack (readFeed of
// packages/feed). That the time copy holds exactly the rows of its key copy
// needs every row of both: the `time` check of verifyPack sums the rows of each
// copy with RowSum and compares the two sums.
import { type FeedRecord, splitTimeKey, TIME_PREFIX_BYTES, timeCodecOf } from "./codec.ts";
import type { IdxHead } from "./idx.ts";
import { Sha256 } from "./sha256.ts";

// Seconds since 2026-01-01T00:00:00Z; the span is [t0, t1).
export interface TimeSpan {
  readonly t0: number;
  readonly t1: number;
}

// The first_seen of a bound of the time copy's head, or null when the bound
// is too short to be a time key.
const firstSeenOf = (bound: string): number | null => (bound.length > TIME_PREFIX_BYTES ? splitTimeKey(bound).firstSeen : null);

export function timeBindFault(key: IdxHead, time: IdxHead, span: TimeSpan | null = null): string | null {
  const want = timeCodecOf(key.header.dataset);
  if (want === null) return `the key copy is dataset ${key.header.dataset}, which has no time copy`;
  if (time.header.dataset !== want.id) return `the time copy is dataset ${time.header.dataset}; the time copy of dataset ${key.header.dataset} is dataset ${want.id}`;
  if (time.header.records !== key.header.records) return `the time copy holds ${time.header.records} records and its key copy ${key.header.records}`;
  if (time.keyMin === null || time.keyMax === null) return null;
  const first = firstSeenOf(time.keyMin);
  const last = firstSeenOf(time.keyMax);
  if (first === null || last === null) return "the time copy's key bounds are not time keys: 4 bytes of first_seen and a row key";
  if (span !== null && (first < span.t0 || last >= span.t1)) return `the time copy's rows run from first_seen ${first} to ${last}, outside the span [${span.t0}, ${span.t1}) of the pack`;
  return null;
}

const encoder = new TextEncoder();

// The rows of one copy as a sum: the SHA-256 of each row's fields, as JSON,
// added in eight 32-bit lanes modulo 2^32, and the count of rows. Addition is
// commutative, so the key copy read in key order and the time copy read in
// time order give one sum when they hold the same rows. The sum finds a copy
// written from other rows; it is no defence against rows forged to collide.
export class RowSum {
  readonly #lanes = new Uint32Array(8);
  #count = 0;

  add(row: FeedRecord): void {
    const text = JSON.stringify([row.key, row.flags, row.firstSeen, row.sources, row.basis, row.confidence, row.feedFlags]);
    const d = new Sha256().update(encoder.encode(text)).digest();
    for (let i = 0; i < 8; i += 1) this.#lanes[i] += d[4 * i] * 2 ** 24 + d[4 * i + 1] * 2 ** 16 + d[4 * i + 2] * 2 ** 8 + d[4 * i + 3];
    this.#count += 1;
  }

  get count(): number {
    return this.#count;
  }

  hex(): string {
    let out = "";
    for (const lane of this.#lanes) out += lane.toString(16).padStart(8, "0");
    return out;
  }
}
