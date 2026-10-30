// @domains/ghcr: GHCR for every reader and writer of this project. It runs
// unchanged in Node and in workerd: it imports nothing from `node:`.
//   reader.ts  the anonymous reader: manifests, tag lists, ranges through the signed URL
//   layout.ts  the namespace, the eight packages, the artifact types, the tag builders
//              (the ledger's two tags of state among them), and the tier tag read back
//              with its rebuild suffix (ruling 25)
// The writer is scripts/ghcr/push.mjs, which runs oras on a runner.
//
// The reader's low-level parts (send, ghcr, tokenNew, tokenKept, resetTokens,
// dialer, readCapped) are not exported here: send sends any Authorization to
// any URL, and a caller reads GHCR through ghcrReader, whose checks they skip.
// reader.ts's tests and the scripts' tests import resetTokens from reader.ts.
export type { ArtifactKind, PackageName, RefKind, Tier, TierDataset, TierTagParts } from "./layout.ts";
export {
  ARTIFACT_KINDS,
  artifactType,
  checkPackage,
  checkTag,
  fileTag,
  LATEST,
  LayoutError,
  LEDGER_DELTA_TAG,
  ledgerFilterTag,
  MAX_SOURCE_ID,
  NAMESPACE,
  nextTierTag,
  OWNER,
  PACKAGES,
  packageOfDataset,
  parseTierTag,
  REF_KINDS,
  REGISTRY_HOST,
  rawTag,
  refTag,
  repoOf,
  rootTag,
  SOURCE_ID,
  SOURCE_URL,
  STATE,
  segTag,
  stateTag,
  TAG,
  TIER_DATASETS,
  TIERS,
  tierTag,
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
