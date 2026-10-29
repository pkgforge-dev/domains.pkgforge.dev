// @domains/root: the root manifest of docs/architecture.md section 4.6, for
// the promotion job and for every reader of root:latest (the Worker, a
// consumer with no Worker, scripts/root/show.mjs).
//   root.ts    root.json's schema (a pack's time copy among it), validateRoot, the live-set rule, derive, checkForward
//   build.ts   packFromManifest, buildRoot, rollbackRoot, dropSuperseded, the sources layer
// The GHCR side, reading the live root and moving `latest`, is scripts/root/
// (promote.mjs, rollback.mjs, show.mjs). This package reads and writes no
// network: it runs unchanged in Node and in workerd, and imports nothing from
// `node:`.
export type {
  BuildInput,
  Dropped,
  HeadFacts,
  LiveRoot,
  ManifestFacts,
  ManifestLayer,
  NewPack,
  Replacement,
  RollbackInput,
  SourceRow,
  SourcesLayer,
} from "./build.ts";
export {
  buildRoot,
  checkSourcesLayer,
  createdOf,
  dropSuperseded,
  EMPTY_COVERAGE,
  heldBy,
  layerBytes,
  packFromManifest,
  QUARANTINE_ANNOTATION,
  rollbackRoot,
  SOURCES_LAYER_FORMAT,
  sourcesLayer,
  TIER_ANNOTATION,
} from "./build.ts";
export type { RootErrorCode } from "./errors.ts";
export { RootError } from "./errors.ts";
export type { Blob, DatasetCount, Derived, PackEntry, RootJson, RootTier, Span, TimeCopy, ValidateOptions, Withdrawn } from "./root.ts";
export {
  canonical,
  carryWithdrawn,
  checkForward,
  checkLiveSet,
  comparePacks,
  DATASETS,
  derive,
  isoOf,
  msOf,
  PACK_FIELDS,
  PACK_OPTIONAL_FIELDS,
  ROOT_FIELDS,
  ROOT_FORMAT,
  ROOT_TIERS,
  rankOf,
  SEGMENT_OVERLAP,
  TIME_COPY_TIERS,
  TIME_DATASETS,
  TIME_FIELDS,
  tierEnd,
  validatePack,
  validateRoot,
  WITHDRAWN_DAYS,
  WITHDRAWN_FIELDS,
} from "./root.ts";
