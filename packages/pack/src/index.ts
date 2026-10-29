// @domains/pack: the pack format DPK1 (docs/format.md), its one writer and its
// one reader.
//   PackWriter, writePack         records in key order to parts and an index
//   PackReader                    get, scan and blockOf by range; readBlock and decodeBlock checked
//   PackIndex, readIdx            the index read by range, or whole
//   mergeRecords, mergePacks      the k-way merge by key
//   NAMES_CODEC, DOMAINS_CODEC, FEED_CODEC, NEW_NAME_CODEC   the records of the datasets 1, 2, 3 and 5
//   FEED_TIME_CODEC, NEW_NAME_TIME_CODEC, timeBindFault, RowSum   the time copies 6 and 7 of 3 and 5, and their bind
//   crc32, Sha256                 the block CRC and the decoded digest
//   verifyPack, expectFromAnnotations   the verifier of a pack before it counts (DOM-018)
// It imports nothing from `node:`, so the reader runs in Node and in workerd.
// The compressor of the writer is the caller's: packages/pack/node gives
// node:zlib at level 9, outside src/, where no Worker imports it.
export type { ByteSource, RangeSource } from "./source.ts";
export { bytesSource, partsSource, readExact, readPart } from "./source.ts";
export { ByteReader, ByteWriter, checkKey, fromHex, keyBytes, latin1, MAX_KEY_BYTES, toHex } from "./bytes.ts";
export type { DatasetCodec, DomainRecord, Evidence, FeedRecord, KeyPrefix, NameRecord, PackRecord, Seen } from "./codec.ts";
export {
  BASIS,
  BASIS_TIER,
  BUILTIN_CODECS,
  DOMAINS_CODEC,
  FEED_CODEC,
  FEED_CENSORED,
  FEED_CORROBORATED,
  FEED_PROVISIONAL,
  FEED_SUSPECT,
  FEED_SUSPECT_CERT,
  FEED_SUSPECT_RDAP,
  FEED_SUSPECT_REASONS,
  FEED_TIME_CODEC,
  feedFlagsFault,
  FLAG_EXACT,
  FLAG_WILDCARD,
  MAX_TIME_FIRST_SEEN,
  mergeBits,
  mergeEvidence,
  mergeSeen,
  NAMES_CODEC,
  NEW_NAME_CODEC,
  NEW_NAME_TIME_CODEC,
  readKey,
  splitTimeKey,
  strongerConfidence,
  TIME_KEY_BYTES,
  TIME_PREFIX_BYTES,
  timeCodecOf,
  timeKey,
  writeKey,
} from "./codec.ts";
export { crc32, hex32 } from "./crc32.ts";
export type { PackErrorCode } from "./errors.ts";
export { PackError } from "./errors.ts";
export type { PartHeader } from "./format.ts";
export {
  ANNOTATIONS,
  CODEC_DEFLATE_RAW,
  CODEC_FORMATS,
  CODEC_GZIP,
  DATASET_DOMAINS,
  DATASET_FEED,
  DATASET_FEED_TIME,
  DATASET_LABELS,
  DATASET_NAMES,
  DATASET_NEW_NAME,
  DATASET_NEW_NAME_TIME,
  DATASET_REV,
  DEFAULT_CODEC,
  DEFAULT_PAGE_ENTRIES,
  DEFAULT_PART_LIMIT,
  DEFAULT_RECORDS_PER_BLOCK,
  encodePartHeader,
  IDX_MAGIC,
  IDX_TITLE,
  MAX_BLOCK_KEY_BYTES,
  MAX_PARTS,
  MAX_RAW_BLOCK_BYTES,
  MAX_RECORDS_PER_BLOCK,
  NAME_KEY_BYTES,
  PART_HEADER_BYTES,
  PART_MAGIC,
  packedLimit,
  partTitle,
  readPartHeader,
  TIME_IDX_TITLE,
  timePartTitle,
  VERSION,
} from "./format.ts";
export type { BlockEntry, Idx, IdxContent, IdxHead, IdxHeader, IndexOptions, PageRef, PartEntry } from "./idx.ts";
export { checkPartSizes, checkTiling, DEFAULT_HEAD_READ, encodeIdx, headCrc, IDX_HEADER_BYTES, PackIndex, parseHead, parsePage, readIdx } from "./idx.ts";
export { mergePacks, mergeRecords } from "./merge.ts";
export { inflate, PackReader } from "./reader.ts";
export { Sha256, sha256Hex } from "./sha256.ts";
export type { TimeSpan } from "./time.ts";
export { RowSum, timeBindFault } from "./time.ts";
export type {
  CheckName,
  CheckOutcome,
  Expect,
  PartSource,
  Precision,
  SourceRow,
  VerifyFailure,
  VerifyOptions,
  VerifyResult,
  VerifyStats,
  VolumeCheck,
  VolumeVerdict,
} from "./verify.ts";
export { CHECKS, DEFAULT_MAX_FAILURES, DEFAULT_REFIND, DEFAULT_SEED, expectFromAnnotations, KEY_SHOWN, quoteKey, VERIFY_ANNOTATIONS, verifyPack } from "./verify.ts";
export type { Compress, PackSink, PackSummary, WriterOptions } from "./writer.ts";
export { MemorySink, PackWriter, packAnnotations, writePack } from "./writer.ts";
