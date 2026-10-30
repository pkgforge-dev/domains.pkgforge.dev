// @domains/feed: the new-domain feed (DOM-022).
//   confidenceOf, classOf          registered-confirmed, corroborated or single, the suspect flag and its reasons, and why
//   feedRowOf, buildFeedDay,       the rows of a day pack (the exact join) and of an hour pack (the
//   buildFeedHour, writeFeedPack   provisional filter), and the pack with its time copy
//   CARRIED_FLAGS, newCarryStats   the bits a day row takes from its hour row, and what that carry did
//   planWindow, keyRangeOf         the live packs a window reads, and the key range of suffix and under
//   readFeed, keyCopyFirst         one page of rows in first_seen order, from the time copy or the key
//                                  copy and a sort, with a cursor and a block budget
//   checkFilter, rowMatches,       the filters of GET /v1/new, and a stored row by name
//   describeRow
//   sourceTable                    id, family, kind and precision of each source bit
// It imports nothing from `node:`, so it runs in Node and in workerd alike. The
// records and packs are DOM-017's (@domains/pack), the time copy's codec and
// bind among them (docs/format.md section 14), the join and the filter
// DOM-021's (@domains/ledger), the keys DOM-015's (@domains/names).
export type { BuildContext, CarryStats, DayContext, DomainEvent, FeedPack, FeedPackOptions, TimeCopyOptions } from "./build.ts";
export { buildFeedDay, buildFeedHour, CARRIED_FLAGS, feedRowOf, newCarryStats, writeFeedPack } from "./build.ts";
export type { CertAge, Confidence, ConfidenceContext, ConfidenceLevel, EventFacts, RdapCreated, Why } from "./confidence.ts";
export { CORROBORATION_SECONDS, classOf, confidenceOf, RDAP_EVIDENCE_FROM, REGISTERED_MAX_LEVEL, SUSPECT_CERT_AGE_SECONDS } from "./confidence.ts";
export type { FeedErrorCode } from "./errors.ts";
export { FeedError } from "./errors.ts";
export type { BasisFilter, FeedFilter, ProvisionalFilter, RowDescription, SuspectFilter, SuspectReason } from "./filter.ts";
export { BASIS_FILTERS, checkFilter, describeRow, PROVISIONAL_FILTERS, rowMatches, SUSPECT_FILTERS } from "./filter.ts";
export type { BlobRef, FeedDataset, FeedKind, KeyRange, LivePack, LiveSet, PlannedPack, TimeCopyRef, WindowPlan, WindowQuery } from "./plan.ts";
export { DATASET_OF_KIND, inRange, keyRangeOf, planWindow } from "./plan.ts";
export type { CopyChoice, FeedCopy, FeedCursor, FeedOrder, FeedPage, FeedStats, OpenedPack, ReadOptions } from "./read.ts";
export { COPY_CHOICES, compareRows, DEFAULT_LIMIT, DEFAULT_MAX_BLOCKS, FEED_ORDERS, keyCopyFirst, MAX_LIMIT, readFeed, TIME_COPY_TIERS } from "./read.ts";
export type { SourceRowLike, SourceTable } from "./sources.ts";
export { sourceTable } from "./sources.ts";
export type { RowPrecision, Timed, Window } from "./time.ts";
export { checkWindow, dayStart, HOUR_SECONDS, inWindow, overlaps, rowPrecision, rowSpan } from "./time.ts";
