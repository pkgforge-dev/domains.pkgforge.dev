// @domains/adapter: the source registry and the adapter contract (DOM-016).
//   types         Source, Segment, Cursor, RunResult, AdapterModule, SegmentWriter
//   validate      validateBits, validateSource(File), buildRegistry, validateRegistry,
//                 checkCursor, validateSegment, checkDraftUrl, checkGaps
//   band          checkBand: the volume verdict of one day, with the step change;
//                 checkHistory: a source's volume history held to its shape
//   writer        memoryWriter: the in-memory SegmentWriter of the tests
//   facts         facts.json (domains.facts.v1): encodeFacts, parseFacts, mergeFacts,
//                 factsOfRows, factsRef: the certificate facts of a pack's keys
//   harness       runAdapter: an adapter against recorded answers, three runs;
//                 checkResult, checkSources: one run's result held to the contract
//   connect       the TCP recording (NAME.tcp.json), replayConnect: its replay as
//                 ctx.connect; tapConnect, encodeTcpRecording: a conversation recorded
//   live          liveFetch: the ctx.fetch of a production run
// It imports nothing from `node:`, so it runs in Node and in workerd alike. The
// file readers (recordings, config/, adapters/), liveConnect and runSandboxed
// are Node-only, in `@domains/adapter/node` (packages/adapter/node/index.ts).
export type { BandDay, BandOptions, BandReason, BandResult, Verdict } from "./band.ts";
export { BandError, BASELINE_DAYS, checkBand, checkHistory, median, RESET_AFTER } from "./band.ts";
export type { ConnectionLog, ConnectMiss, ConnectReplay, Tap, TappedExchange, TcpExchange, TcpRecording, TcpRecordingInput, TcpRequestLog } from "./connect.ts";
export { encodeTcpRecording, parseTcpRecording, REPLAY_IDLE_MS, replayConnect, TCP_RECORDING_FORMAT, TCP_RECORDING_SUFFIX, tapConnect } from "./connect.ts";
export type { Facts, FactsErrorCode, FactsTable } from "./facts.ts";
export { encodeFacts, FACTS_ERRORS, FACTS_FORMAT, FACTS_MAX_BYTES, FACTS_MEDIA_TYPE, FACTS_TITLE, FactsError, factsOfRows, factsRef, mergeFacts, parseFacts } from "./facts.ts";
export type { HarnessOptions, HarnessResult, HarnessRun, Recording, Replay, RequestLog } from "./harness.ts";
export { checkResult, checkSources, HARNESS_USER_AGENT, parseRecording, RECORDING_FORMAT, replayFetch, runAdapter } from "./harness.ts";
export { base64Of, bytesOfBase64, canonicalJson, JsonError, jsonEqual, sha256Hex } from "./json.ts";
export { liveFetch } from "./live.ts";
export type {
  AdapterContext,
  AdapterFault,
  AdapterModule,
  AdapterSocket,
  Band,
  Basis,
  Connect,
  Cursor,
  Dataset,
  FactRow,
  FactsRef,
  Family,
  Fetch,
  Gap,
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
  SocketAddress,
  SocketOptions,
  Source,
  SourceBits,
  SourceFile,
  Window,
} from "./types.ts";
export { BASES, BITS_FORMAT, DATASETS, FAMILIES, KINDS, MASKED_DATASETS, METRICS, PRECISIONS, REGISTRY_FORMAT, SOURCE_FORMAT } from "./types.ts";
export type { ContractCheck, FactKeysWalk, Problem, ProblemCode, SourceFileText } from "./validate.ts";
export {
  bandProblems,
  bitsAppendOnly,
  buildRegistry,
  CONTRACT_CHECKS,
  ContractError,
  checkCursor,
  checkDraftUrl,
  checkGaps,
  checkRawMember,
  checkRawMemberBytes,
  checkWindow,
  factKeysWalk,
  factsProblem,
  ID_GRAMMAR,
  isIsoUtc,
  MAX_BIT,
  MAX_CURSOR_BYTES,
  MAX_GAPS,
  MAX_ID,
  MAX_RAW_MEMBER_BYTES,
  MAX_URLS_CHARS,
  PROBLEM_CODES,
  parseDuration,
  RAW_ID_PREFIX,
  RAW_MEMBER_OWN,
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
export type { MemoryWriter, MemoryWriterOptions, Written } from "./writer.ts";
export { memoryWriter } from "./writer.ts";
