// @domains/ghcr: GHCR for every reader and writer of this project. It runs
// unchanged in Node and in workerd: it imports nothing from `node:`.
//   reader.ts  the anonymous reader: manifests, tag lists, ranges through the signed URL
//   layout.ts  the namespace, the eight packages, the artifact types, the tag builders
//              (the ledger's tags of state and the run tags a moving tag of state
//              moves to among them), the tier tag read back with its rebuild
//              suffix (ruling 25), a segment's tag held to its facts
//              (segmentTagProblem), and the one rule of an annotation value
//              the push tool takes (annotationProblem)
// The writer is scripts/ghcr/push.mjs, which runs oras on a runner.
//
// The reader's low-level parts (send, ghcr, tokenNew, tokenKept, resetTokens,
// dialer, readCapped) are not exported here: send sends any Authorization to
// any URL, and a caller reads GHCR through ghcrReader, whose checks they skip.
// reader.ts's tests and the scripts' tests import resetTokens from reader.ts.
export type { ArtifactKind, PackageName, RefKind, Tier, TierDataset, TierTagParts } from "./layout.ts";
export {
  ANNOTATION_MAX_CHARS,
  ARTIFACT_KINDS,
  annotationProblem,
  artifactType,
  checkPackage,
  checkTag,
  fileTag,
  LATEST,
  LayoutError,
  LEDGER_DELTA_TAG,
  ledgerDeltaRunTag,
  ledgerFilterTag,
  MAX_SOURCE_ID,
  NAMESPACE,
  nextTierTag,
  OWNER,
  PACKAGES,
  packageOfDataset,
  parseTierTag,
  RAW_PREFIX,
  REF_KINDS,
  REGISTRY_HOST,
  rawTag,
  refTag,
  repoOf,
  rootTag,
  SOURCE_ID,
  SOURCE_URL,
  segmentTagProblem,
  segTag,
  stateRunTag,
  stateTag,
  TAG,
  TIER_DATASETS,
  TIERS,
  tierTag,
  WORKFLOW_RUN_ID,
} from "./layout.ts";
export type { Descriptor, Dialer, Fetcher, GhcrCache, GhcrErrorCode, GhcrReader, Manifest, ManifestHead, ManifestJson, RangeRead, ReaderOptions, TagList } from "./reader.ts";
export {
  BLOB_HOST_SUFFIX,
  bearerRealm,
  checkRef,
  DIGEST,
  DUMMY,
  GhcrError,
  ghcrReader,
  MANIFEST_ACCEPT,
  MANIFEST_LIMIT_BYTES,
  MANIFEST_MAX_BYTES,
  MANIFEST_TTL_S,
  memoryCache,
  nextTagPage,
  parseManifest,
  RANGE_MAX_BYTES,
  REGISTRY,
  REQUEST_TIMEOUT_MS,
  SIGNED_MARGIN_S,
  SIGNED_MAX_S,
  sha256Digest,
  signedExpiry,
  TAG_PAGE,
  TAG_PAGES_MAX,
  TITLE,
  TOKEN_TTL_S,
} from "./reader.ts";
