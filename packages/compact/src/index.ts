// @domains/compact: compaction (DOM-023, docs/architecture.md section 4.5).
//   planTier, unitOf                the input packs of one tier unit from a root's live set: ready, wait, present or skip
//   mergeSpan                       the streaming k-way merge of packs into one, in one process
//   checkMerged, checkRange         the second pass: the output holds exactly the inputs' distinct keys, each record their merge;
//                                   checkRange over one range's part, part 0 from the key space's start
//   planRanges, countRange,         the merge cut into key ranges for an Actions matrix: the cuts at index
//   windowOf, writeRange,           page keys, each range's count, each range's window and part, and the
//   assembleRanges, hashParts       index and identity of all parts as one pack
//   mergeRanged                     the ranged layout in one process
//   timeMode, sortTimeCopy,         the time copy of a feed or new-name pack: merged from the inputs'
//   bindFault                       time copies, or sorted, and held to its key copy
//   packManifest, MAX_LAYERS,       the OCI manifest of the result, held to what the promotion accepts
//   ANNOTATION_MAX_CHARS,           and to the layers and the annotation values one push takes, with extra
//   WORKFLOW_RUN_ID                 layers such as summary.json; the grammar of its run annotation
//   tagDecision                     present, or the tag to write (a rebuild takes -rN, ruling 25, unless
//                                   a build holds the sha256 the caller is about to write)
//   planFile, countFile,            the JSON files the jobs of one compaction pass each other, each
//   rangeFile, checkPlanFile        held to its plan by the plan's id
//   rangeCeiling, layersOf          the most key ranges whose pack fits one manifest, and a plan's layers
//   hourOf, planHour, buildHour,    the hour pack of feed from the segments of one hour, under the
//   membershipOf                    provisional filter (the live ledger-filter and ledger-delta)
//   dayOf, basePacks, joinInputs,   the day pack of feed by the exact join, its summary.json, and the
//   buildDay, SummaryCounter,       ledger through the day's end: the live filter and delta checked,
//   checkLedger, rebuildLedger      the filter rebuilt, the delta rebased onto it
//   isQuarantined                   the root's mark of a quarantined pack entry (ruling 23)
// It imports nothing from `node:` and is type-checked as Worker code
// (tsconfig.worker.json); no test runs it in workerd. packages/compact/node
// holds the packs on disk.
export { checkMerged, checkRange, type MergeCheck, type RangeKeys } from "./check.ts";
export type { BuiltDay, Day, DayInput, DaySummary, LedgerCheck, LiveLedger, RebuiltLedger, SuffixCount } from "./daily.ts";
export {
  basePacks,
  buildDay,
  checkLedger,
  DELTA_TITLE,
  dayOf,
  FILTER_TITLE,
  joinInputs,
  rebuildLedger,
  SUMMARY_FORMAT,
  SUMMARY_MEDIA_TYPE,
  SUMMARY_TITLE,
  SummaryCounter,
} from "./daily.ts";
export type { CompactErrorCode } from "./errors.ts";
export { CompactError } from "./errors.ts";
export type { CopyPlan, CountFile, PlanFile, PlanFileInput, RangeFile, RangeFileInput, TimePlan } from "./files.ts";
export { checkPlanFile, codecOf, COUNT_FORMAT, countFile, countsOf, layersOf, PLAN_FORMAT, planFile, RANGE_FORMAT, rangeCeiling, rangeFile, rangesOf, timeCodecFor } from "./files.ts";
export type { BuiltHour, Hour, HourMissing, HourOptions, HourPlan, SegmentInput, Skipped } from "./hour.ts";
export { buildHour, hourOf, membershipOf, planHour } from "./hour.ts";
export type { BuiltManifest, ExtraLayer, ManifestInput } from "./manifest.ts";
export {
  ANNOTATION_MAX_CHARS,
  CREATED_ANNOTATION,
  EMPTY_CONFIG,
  LAYER_MEDIA_TYPE,
  MANIFEST_MEDIA_TYPE,
  MAX_LAYERS,
  packManifest,
  RUN_ANNOTATION,
  SOURCE_ANNOTATION,
  WORKFLOW_RUN_ID,
} from "./manifest.ts";
export type { CompactTier, Excluded, LiveInput, Missing, TierPlan, TierVerdict } from "./plan.ts";
export { COMPACT_TIERS, isQuarantined, NEW_DATASETS, planTier, QUARANTINE_FIELD, SLOT_TIERS, unitOf } from "./plan.ts";
export type { Assembled, BlockDigest, MergeOptions, PackFormat, PartOptions, RangeCount, RangeFacts, RangeOptions, RangeOutput, RangePlan, RangeWindow } from "./range.ts";
export {
  assembleRanges,
  countRange,
  DEFAULT_RANGE_BYTES,
  factsOf,
  hashParts,
  MAX_RANGES,
  mergeRanged,
  mergeSpan,
  planRanges,
  rangeBounds,
  rangeOf,
  WHOLE_WINDOW,
  windowOf,
  writeRange,
} from "./range.ts";
export type { TagDecision, TagOptions } from "./tags.ts";
export { tagDecision } from "./tags.ts";
export type { SortOptions, TimeMode } from "./time.ts";
export { bindFault, DEFAULT_SORT_ROWS, sortTimeCopy, timeMode } from "./time.ts";
