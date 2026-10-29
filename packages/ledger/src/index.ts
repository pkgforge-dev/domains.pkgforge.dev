// @domains/ledger: the `domains` table decides what is new (DOM-021).
//   aggregateToDomains            name records to domain records, in key order
//   firstSeen, lastSeen           one unit for every source: a day counts as its start, or its end
//   exactNew                      the day's domains no earlier tier holds, by a merge-join over the idx
//   BloomFilter, HashDelta,       the hourly provisional filter, its exact delta, and the two as one
//   ProvisionalFilter
//   provisionalNew, reconcile     the hourly verdict and the daily repair of it
//   corpusState                   `warming` for 90 days after corpus_since, then `full`
// It imports nothing from `node:`, so it runs in Node and in workerd alike. The
// records and packs are DOM-017's (@domains/pack); the names are DOM-015's.
export type { AggregateCounts } from "./aggregate.ts";
export { aggregateToDomains, newCounts, releaseKey } from "./aggregate.ts";
export type { LedgerErrorCode } from "./errors.ts";
export { LedgerError } from "./errors.ts";
export type { ExactOptions, ExactStats } from "./exact.ts";
export { exactNew, newExactStats } from "./exact.ts";
export type { FilterOptions, MembershipFilter } from "./filter.ts";
export {
  BloomFilter,
  buildFilter,
  DEFAULT_BITS_PER_KEY,
  DEFAULT_HASHES,
  DELTA_HEADER_BYTES,
  DELTA_MAGIC,
  FILTER_HEADER_BYTES,
  FILTER_MAGIC,
  FORMAT_VERSION,
  HashDelta,
  MAX_HASHES,
  MAX_PARTITION_BITS,
  ProvisionalFilter,
} from "./filter.ts";
export type { Hash64 } from "./hash.ts";
export { compareHash, HASH_ID, hashHex, hashKey, murmur3x86x128 } from "./hash.ts";
export type { Reconciled } from "./reconcile.ts";
export { provisionalNew, reconcile } from "./reconcile.ts";
export type { CorpusState, Moment, Precision, PrecisionOf } from "./time.ts";
export { corpusState, DAY_SECONDS, EPOCH_MS, firstSeen, isoOf, lastSeen, precisionsOf, secondsOf, WARMING_DAYS } from "./time.ts";
