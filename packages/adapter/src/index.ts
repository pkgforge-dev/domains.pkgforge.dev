// @domains/adapter: the source registry and the adapter contract (DOM-016).
//   types         Source, Segment, Cursor, RunResult, AdapterModule, SegmentWriter
//   validate      validateBits, validateSource(File), buildRegistry, validateRegistry,
//                 checkCursor, validateSegment
//   band          checkBand: the volume verdict of one day, with the step change;
//                 checkHistory: a source's volume history held to its shape
//   writer        memoryWriter: the in-memory SegmentWriter of the tests
//   harness       runAdapter: an adapter against recorded answers, three runs;
//                 checkResult, checkSources: one run's result held to the contract
//   live          liveFetch: the ctx.fetch of a production run
// It imports nothing from `node:`, so it runs in Node and in workerd alike. The
// file readers (recordings, config/, adapters/) are Node-only, in
// `@domains/adapter/node` (packages/adapter/node/index.ts).
export type { BandDay, BandOptions, BandReason, BandResult, Verdict } from "./band.ts";
export { BandError, BASELINE_DAYS, checkBand, checkHistory, median, RESET_AFTER } from "./band.ts";
export type { HarnessOptions, HarnessResult, HarnessRun, Recording, Replay, RequestLog } from "./harness.ts";
export { checkResult, checkSources, HARNESS_USER_AGENT, parseRecording, RECORDING_FORMAT, replayFetch, runAdapter } from "./harness.ts";
export { canonicalJson, JsonError, jsonEqual, sha256Hex } from "./json.ts";
export { liveFetch } from "./live.ts";
export type {
  AdapterContext,
  AdapterFault,
  AdapterModule,
  Band,
  Basis,
  Cursor,
  Dataset,
  Family,
  Fetch,
  Json,
  Kind,
  Metric,
  Precision,
  RawInput,
  RawRef,
  Registry,
  RegistryRow,
  RunResult,
  Segment,
  SegmentDraft,
  SegmentRecord,
  SegmentWriter,
  Source,
  SourceBits,
  SourceFile,
  Window,
} from "./types.ts";
export { BASES, BITS_FORMAT, DATASETS, FAMILIES, KINDS, MASKED_DATASETS, METRICS, PRECISIONS, REGISTRY_FORMAT, SOURCE_FORMAT } from "./types.ts";
export type { ContractCheck, Problem, ProblemCode, SourceFileText } from "./validate.ts";
export {
  bandProblems,
  bitsAppendOnly,
  buildRegistry,
  CONTRACT_CHECKS,
  ContractError,
  checkCursor,
  checkWindow,
  ID_GRAMMAR,
  isIsoUtc,
  MAX_BIT,
  MAX_CURSOR_BYTES,
  MAX_ID,
  MAX_URLS_CHARS,
  PROBLEM_CODES,
  parseDuration,
  RAW_ID_PREFIX,
  REGISTRY_COMMENT,
  RETENTION_WORDS,
  RUNTIME_FIELDS,
  renderRegistry,
  SOURCE_FIELDS,
  SourceError,
  URL_SCHEMES,
  validateBits,
  validateRegistry,
  validateSegment,
  validateSource,
  validateSourceFile,
} from "./validate.ts";
export type { MemoryWriter, Written } from "./writer.ts";
export { memoryWriter } from "./writer.ts";
