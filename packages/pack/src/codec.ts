// packages/pack/src/codec.ts — the records of the datasets 1, 2, 3 and 5
// (docs/format.md section 5), of the time copies 6 and 7 (section 14), and the
// interface every dataset implements.
//
// A dataset codec owns the whole record: its key, its bytes and its merge.
// The datasets 1, 2, 3 and 5 start every record with the front-coded key
// prefix of section 5.1 (writeKey and readKey); dataset 4, the reverse IP
// index, has a record of its own and DOM-043 registers its codec. Dataset 5,
// new-name, has the record of dataset 3, feed, at name level. Datasets 6 and 7
// are the time copies of 3 and 5: the same rows, keyed by (first_seen, key).
//
// A codec states the longest key of its dataset (maxKeyBytes). readKey refuses
// a longer key from its two lengths, before it reads a byte of the key, so a
// few bytes of front coding cannot make a reader build a key of 65,535 bytes
// for a dataset whose keys are names of at most 253.
//
// encodeRecord checks every field it writes and refuses with PackError
// "record" (a bad field) or "order" (a key not above the one before it).
// decodeRecord checks the structure of what it reads: a varint, a mask, a
// length, the order of the keys and of the lists. It keeps a value of a known
// field that it does not know, such as a new basis id (docs/format.md section 11).
//
// merge(a, b) folds two records of one key into one. Every field's rule is
// commutative, associative and idempotent (section 5.6), so the order of the
// inputs of a merge never changes its output.
import { type ByteReader, type ByteWriter, checkKey, MAX_BIT, MAX_SAFE } from "./bytes.ts";
import { PackError } from "./errors.ts";
import { DATASET_DOMAINS, DATASET_FEED, DATASET_FEED_TIME, DATASET_LABELS, DATASET_NAMES, DATASET_NEW_NAME, DATASET_NEW_NAME_TIME, NAME_KEY_BYTES } from "./format.ts";

export interface DatasetCodec<R> {
  // The dataset byte of the headers.
  readonly id: number;
  readonly name: string;
  // The longest key of the dataset, 1 to 65,535 bytes. The writer refuses a
  // longer key, and decodeRecord refuses one before it builds it.
  readonly maxKeyBytes: number;
  // The sort key: records of a pack ascend by it, bytewise, with no key twice.
  key(record: R): string;
  // The key the index stores for a block whose first record is `record`. For
  // the datasets 1, 2, 3, 5, 6 and 7 it is the key itself.
  idxKey(record: R): string;
  // Appends `record`; `prev` is the record before it in the block, null for
  // the first record of a block.
  encodeRecord(prev: R | null, record: R, out: ByteWriter): void;
  // Reads one record; `prev` as for encodeRecord.
  decodeRecord(prev: R | null, input: ByteReader): R;
  // Two records of one key as one.
  merge(a: R, b: R): R;
}

// ---- flags

export const FLAG_EXACT = 1;
export const FLAG_WILDCARD = 2;

export const FEED_PROVISIONAL = 1;
export const FEED_SUSPECT = 2;
export const FEED_CORROBORATED = 4;
export const FEED_CENSORED = 8;
// The reasons of `suspect` (docs/format.md section 5.4, ruling 19): an event
// whose certificate is older than 7 days, and an RDAP creation date before
// 2026-01-01. A row is suspect exactly when it holds at least one reason, and
// the writer refuses a row that breaks this.
export const FEED_SUSPECT_CERT = 16;
export const FEED_SUSPECT_RDAP = 32;
export const FEED_SUSPECT_REASONS = FEED_SUSPECT_CERT | FEED_SUSPECT_RDAP;
// Bits 6 and 7 are reserved: the writer writes zero, a reader keeps them.
const FEED_KNOWN = FEED_PROVISIONAL | FEED_SUSPECT | FEED_CORROBORATED | FEED_CENSORED | FEED_SUSPECT_REASONS;

// The basis ids of an evidence entry and of the feed's basis bits, with the
// tier each belongs to (docs/architecture.md section 3.3).
export const BASIS = Object.freeze({ zone: 0, rdap: 1, "nrd-list": 2, "nrd-ct+rdap": 3, "ct-first": 4 });
export const BASIS_TIER: readonly number[] = Object.freeze([1, 1, 2, 2, 3]);
const BASIS_KNOWN_BITS = (1 << BASIS_TIER.length) - 1;

// ---- records

// One source's first and last time, in the source's unit.
export interface Seen {
  readonly bit: number;
  readonly first: number;
  readonly last: number;
}

export interface NameRecord {
  readonly key: string;
  readonly flags: number;
  readonly sources: readonly Seen[];
}

export interface Evidence {
  readonly tier: number;
  readonly basis: number;
  readonly source: number;
  readonly at: number;
  readonly confidence: number;
}

export interface DomainRecord extends NameRecord {
  readonly evidence: readonly Evidence[];
}

export interface FeedRecord {
  readonly key: string;
  readonly flags: number;
  // Seconds since 2026-01-01T00:00:00Z.
  readonly firstSeen: number;
  readonly sources: readonly number[];
  readonly basis: number;
  readonly confidence: number;
  readonly feedFlags: number;
}

export type PackRecord = NameRecord | DomainRecord | FeedRecord;

const bad = (message: string): PackError => new PackError("record", message);

const isUint = (value: unknown, max: number): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

// ---- the key prefix (section 5.1)

// The bytes a key shares with the key before it.
function sharedPrefix(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i += 1;
  return i;
}

// `maxKeyBytes` is the codec's: the longest key of its dataset.
export function writeKey(prevKey: string | null, key: string, flags: number, out: ByteWriter, maxKeyBytes: number): void {
  checkKey(key, "a key");
  if (key.length > maxKeyBytes) throw bad(`the key ${JSON.stringify(key.slice(0, 80))} is ${key.length} bytes, above the ${maxKeyBytes} of its dataset`);
  if (!isUint(flags, 3)) throw bad(`the key ${JSON.stringify(key.slice(0, 80))} has flags ${flags}, not 0 to 3`);
  if (prevKey !== null && !(key > prevKey)) throw new PackError("order", `the key ${JSON.stringify(key.slice(0, 80))} is not above the key before it`);
  const shared = prevKey === null ? 0 : sharedPrefix(prevKey, key);
  out.varint(shared);
  out.varint((key.length - shared) * 4 + flags);
  out.latin1(key, shared);
}

export interface KeyPrefix {
  readonly key: string;
  readonly flags: number;
}

// `maxKeyBytes` as for writeKey: a longer key is refused from its lengths,
// before its bytes are read.
export function readKey(prevKey: string | null, input: ByteReader, maxKeyBytes: number): KeyPrefix {
  const shared = input.varint();
  const word = input.varint();
  const suffix = Math.floor(word / 4);
  const flags = word % 4;
  if (prevKey === null && shared !== 0) throw input.fail(`the first record of a block shares ${shared} bytes`);
  if (prevKey !== null && shared > prevKey.length) throw input.fail(`a record shares ${shared} bytes of a key of ${prevKey.length}`);
  if (suffix < 1) throw input.fail("a record adds no byte to the key before it");
  if (shared + suffix > maxKeyBytes) throw input.fail(`a key of ${shared + suffix} bytes, above the ${maxKeyBytes} of its dataset`);
  const tail = input.latin1(suffix);
  if (prevKey !== null && shared < prevKey.length && !(tail.charCodeAt(0) > prevKey.charCodeAt(shared)))
    throw new PackError("order", `${input.label}: a key is not above the key before it, at byte ${input.pos - suffix}`);
  return { key: prevKey === null || shared === 0 ? tail : prevKey.slice(0, shared) + tail, flags };
}

// ---- sources

function checkSeen(sources: readonly Seen[], key: string): void {
  if (!Array.isArray(sources) || sources.length === 0) throw bad(`the record ${JSON.stringify(key.slice(0, 80))} has no source`);
  let before = -1;
  for (const s of sources) {
    if (!isUint(s.bit, MAX_BIT) || s.bit <= before) throw bad(`the record ${JSON.stringify(key.slice(0, 80))}: source bits must ascend from 0 to 63 with none twice`);
    if (!isUint(s.first, MAX_SAFE) || !isUint(s.last, MAX_SAFE) || s.last < s.first)
      throw bad(`the record ${JSON.stringify(key.slice(0, 80))}: source ${s.bit} has first ${s.first} and last ${s.last}`);
    before = s.bit;
  }
}

function writeSeen(sources: readonly Seen[], out: ByteWriter): void {
  out.mask(sources.map((s) => s.bit));
  for (const s of sources) {
    out.varint(s.first);
    out.varint(s.last - s.first);
  }
}

function readSeen(input: ByteReader): Seen[] {
  return input.mask().map((bit) => {
    const first = input.varint();
    const last = first + input.varint();
    if (last > MAX_SAFE) throw input.fail(`source ${bit} has a last time above 2^53 - 1`);
    return { bit, first, last };
  });
}

// The union of two source lists: for a bit both hold, the earliest first and
// the latest last.
export function mergeSeen(a: readonly Seen[], b: readonly Seen[]): Seen[] {
  const out: Seen[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (y === undefined || (x !== undefined && x.bit < y.bit)) {
      out.push(x);
      i += 1;
    } else if (x === undefined || y.bit < x.bit) {
      out.push(y);
      j += 1;
    } else {
      out.push({ bit: x.bit, first: Math.min(x.first, y.first), last: Math.max(x.last, y.last) });
      i += 1;
      j += 1;
    }
  }
  return out;
}

function checkBits(bits: readonly number[], key: string): void {
  if (!Array.isArray(bits) || bits.length === 0) throw bad(`the record ${JSON.stringify(key.slice(0, 80))} has no source`);
  let before = -1;
  for (const bit of bits) {
    if (!isUint(bit, MAX_BIT) || bit <= before) throw bad(`the record ${JSON.stringify(key.slice(0, 80))}: source bits must ascend from 0 to 63 with none twice`);
    before = bit;
  }
}

export function mergeBits(a: readonly number[], b: readonly number[]): number[] {
  return [...new Set([...a, ...b])].sort((x, y) => x - y);
}

function sameKey(a: { key: string }, b: { key: string }): void {
  if (a.key !== b.key) throw new PackError("usage", "merge: the two records have different keys");
}

// ---- dataset 1, names

export const NAMES_CODEC: DatasetCodec<NameRecord> = Object.freeze({
  id: DATASET_NAMES,
  name: DATASET_LABELS[DATASET_NAMES],
  maxKeyBytes: NAME_KEY_BYTES,
  key: (r: NameRecord) => r.key,
  idxKey: (r: NameRecord) => r.key,
  encodeRecord(prev: NameRecord | null, r: NameRecord, out: ByteWriter): void {
    checkKey(r.key, "a key");
    if (r.flags === 0) throw bad(`the name ${JSON.stringify(r.key.slice(0, 80))} has flags 0: a name is exact, wildcard or both`);
    checkSeen(r.sources, r.key);
    writeKey(prev === null ? null : prev.key, r.key, r.flags, out, NAME_KEY_BYTES);
    writeSeen(r.sources, out);
  },
  decodeRecord(prev: NameRecord | null, input: ByteReader): NameRecord {
    const { key, flags } = readKey(prev === null ? null : prev.key, input, NAME_KEY_BYTES);
    if (flags === 0) throw input.fail("a name record has flags 0");
    return { key, flags, sources: readSeen(input) };
  },
  merge(a: NameRecord, b: NameRecord): NameRecord {
    sameKey(a, b);
    return { key: a.key, flags: a.flags | b.flags, sources: mergeSeen(a.sources, b.sources) };
  },
});

// ---- dataset 2, domains

const tripleBelow = (x: Evidence, y: Evidence): boolean => x.tier < y.tier || (x.tier === y.tier && (x.basis < y.basis || (x.basis === y.basis && x.source < y.source)));

function checkEvidence(list: readonly Evidence[], key: string): void {
  if (!Array.isArray(list)) throw bad(`the domain ${JSON.stringify(key.slice(0, 80))} has no evidence list`);
  list.forEach((e, i) => {
    const label = `the domain ${JSON.stringify(key.slice(0, 80))} evidence ${i}`;
    if (!isUint(e.basis, BASIS_TIER.length - 1)) throw bad(`${label} has basis ${e.basis}, not one of 0 to ${BASIS_TIER.length - 1}`);
    if (e.tier !== BASIS_TIER[e.basis]) throw bad(`${label} has tier ${e.tier}; basis ${e.basis} is tier ${BASIS_TIER[e.basis]}`);
    if (!isUint(e.source, MAX_BIT)) throw bad(`${label} has source ${e.source}, not 0 to 63`);
    if (!isUint(e.at, MAX_SAFE)) throw bad(`${label} has the time ${e.at}`);
    if (!isUint(e.confidence, 255)) throw bad(`${label} has confidence ${e.confidence}, not 0 to 255`);
    if (i > 0 && !tripleBelow(list[i - 1], e)) throw bad(`${label}: entries must ascend by (tier, basis, source) with no triple twice`);
  });
}

function readEvidence(input: ByteReader): Evidence[] {
  const count = input.varint();
  // An entry is at least 5 bytes: a count above that is refused before any
  // array is made for it.
  if (count * 5 > input.remaining) throw input.fail(`an evidence list of ${count} entries does not fit in the ${input.remaining} bytes left`);
  const out: Evidence[] = [];
  for (let i = 0; i < count; i += 1) {
    const e = { tier: input.u8(), basis: input.u8(), source: input.u8(), at: input.varint(), confidence: input.u8() };
    if (e.source > MAX_BIT) throw input.fail(`evidence ${i} names source ${e.source}, above ${MAX_BIT}`);
    if (i > 0 && !tripleBelow(out[i - 1], e)) throw input.fail(`evidence ${i} is not above the entry before it by (tier, basis, source)`);
    out.push(e);
  }
  return out;
}

// The stronger of two confidences. OpenINTEL's level 1 is the closest to the
// RDAP date and level 10 the furthest (docs/format.md section 5.6), and 0 is a
// source that states none, so the lowest level that is not 0 wins.
export function strongerConfidence(a: number, b: number): number {
  if (a === 0) return b;
  if (b === 0) return a;
  return Math.min(a, b);
}

// The union by (tier, basis, source): for a triple both hold, the earliest
// time and the stronger confidence.
export function mergeEvidence(a: readonly Evidence[], b: readonly Evidence[]): Evidence[] {
  const out: Evidence[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    const x = a[i];
    const y = b[j];
    if (y === undefined || (x !== undefined && tripleBelow(x, y))) {
      out.push(x);
      i += 1;
    } else if (x === undefined || tripleBelow(y, x)) {
      out.push(y);
      j += 1;
    } else {
      out.push({ tier: x.tier, basis: x.basis, source: x.source, at: Math.min(x.at, y.at), confidence: strongerConfidence(x.confidence, y.confidence) });
      i += 1;
      j += 1;
    }
  }
  return out;
}

export const DOMAINS_CODEC: DatasetCodec<DomainRecord> = Object.freeze({
  id: DATASET_DOMAINS,
  name: DATASET_LABELS[DATASET_DOMAINS],
  maxKeyBytes: NAME_KEY_BYTES,
  key: (r: DomainRecord) => r.key,
  idxKey: (r: DomainRecord) => r.key,
  encodeRecord(prev: DomainRecord | null, r: DomainRecord, out: ByteWriter): void {
    checkKey(r.key, "a key");
    checkSeen(r.sources, r.key);
    checkEvidence(r.evidence, r.key);
    writeKey(prev === null ? null : prev.key, r.key, r.flags, out, NAME_KEY_BYTES);
    writeSeen(r.sources, out);
    out.varint(r.evidence.length);
    for (const e of r.evidence) {
      out.u8(e.tier);
      out.u8(e.basis);
      out.u8(e.source);
      out.varint(e.at);
      out.u8(e.confidence);
    }
  },
  decodeRecord(prev: DomainRecord | null, input: ByteReader): DomainRecord {
    const { key, flags } = readKey(prev === null ? null : prev.key, input, NAME_KEY_BYTES);
    const sources = readSeen(input);
    return { key, flags, sources, evidence: readEvidence(input) };
  },
  merge(a: DomainRecord, b: DomainRecord): DomainRecord {
    sameKey(a, b);
    return { key: a.key, flags: a.flags | b.flags, sources: mergeSeen(a.sources, b.sources), evidence: mergeEvidence(a.evidence, b.evidence) };
  },
});

// ---- dataset 3, feed, and dataset 5, new-name: one record, keyed by a
// reversed registrable domain (feed) or a reversed name (new-name)

// Why a feed_flags value breaks the rule of docs/format.md section 5.4, or null:
// a bit above bit 5 (6 and 7 are reserved and written zero), or a suspect bit
// that is not set exactly when a reason bit is. The writer (encodeRecord) and
// the verifier (verifyPack's `record` check) hold it; decodeRecord keeps what
// it reads.
export function feedFlagsFault(feedFlags: number): string | null {
  if (!isUint(feedFlags, FEED_KNOWN)) return `feed flags ${feedFlags}; the known bits are 0 to 5`;
  const reasoned = (feedFlags & FEED_SUSPECT_REASONS) !== 0;
  const suspect = (feedFlags & FEED_SUSPECT) !== 0;
  if (reasoned !== suspect) return `feed flags ${feedFlags}: suspect (bit 1) is set exactly when a reason is (bit 4 suspect-cert, bit 5 suspect-rdap)`;
  return null;
}

// The fields of a feed row after its key, checked: first_seen (up to
// `maxFirstSeen`), the sources, the basis bits, the confidence and feed_flags
// (feedFlagsFault).
function checkFeedFields(r: FeedRecord, label: string, maxFirstSeen: number): void {
  if (!isUint(r.firstSeen, maxFirstSeen)) throw bad(`${label} has first_seen ${r.firstSeen}${maxFirstSeen < MAX_SAFE ? `, not 0 to ${maxFirstSeen}` : ""}`);
  checkBits(r.sources, r.key);
  if (!isUint(r.basis, BASIS_KNOWN_BITS)) throw bad(`${label} has basis bits ${r.basis}; the known bits are 0 to ${BASIS_TIER.length - 1}`);
  if (!isUint(r.confidence, 255)) throw bad(`${label} has confidence ${r.confidence}, not 0 to 255`);
  const flags = feedFlagsFault(r.feedFlags);
  if (flags !== null) throw bad(`${label} has ${flags}`);
}

// The fields of a feed row after its first_seen.
function writeFeedTail(r: FeedRecord, out: ByteWriter): void {
  out.mask(r.sources);
  out.varint(r.basis);
  out.u8(r.confidence);
  out.u8(r.feedFlags);
}

function readFeedTail(input: ByteReader): Pick<FeedRecord, "sources" | "basis" | "confidence" | "feedFlags"> {
  const sources = input.mask();
  const basis = input.varint();
  if (basis > 0xffff_ffff) throw input.fail(`basis bits ${basis} above 32 bits`);
  return { sources, basis, confidence: input.u8(), feedFlags: input.u8() };
}

function mergeFeed(a: FeedRecord, b: FeedRecord): FeedRecord {
  const provisional = a.feedFlags & b.feedFlags & FEED_PROVISIONAL;
  return {
    key: a.key,
    flags: a.flags | b.flags,
    firstSeen: Math.min(a.firstSeen, b.firstSeen),
    sources: mergeBits(a.sources, b.sources),
    basis: (a.basis | b.basis) >>> 0,
    confidence: strongerConfidence(a.confidence, b.confidence),
    feedFlags: ((a.feedFlags | b.feedFlags) & ~FEED_PROVISIONAL) | provisional,
  };
}

const feedShaped = (id: number): DatasetCodec<FeedRecord> =>
  Object.freeze({
    id,
    name: DATASET_LABELS[id],
    maxKeyBytes: NAME_KEY_BYTES,
    key: (r: FeedRecord) => r.key,
    idxKey: (r: FeedRecord) => r.key,
    encodeRecord(prev: FeedRecord | null, r: FeedRecord, out: ByteWriter): void {
      checkKey(r.key, "a key");
      checkFeedFields(r, `the ${DATASET_LABELS[id]} row ${JSON.stringify(r.key.slice(0, 80))}`, MAX_SAFE);
      writeKey(prev === null ? null : prev.key, r.key, r.flags, out, NAME_KEY_BYTES);
      out.varint(r.firstSeen);
      writeFeedTail(r, out);
    },
    decodeRecord(prev: FeedRecord | null, input: ByteReader): FeedRecord {
      const { key, flags } = readKey(prev === null ? null : prev.key, input, NAME_KEY_BYTES);
      const firstSeen = input.varint();
      return { key, flags, firstSeen, ...readFeedTail(input) };
    },
    merge(a: FeedRecord, b: FeedRecord): FeedRecord {
      sameKey(a, b);
      return mergeFeed(a, b);
    },
  });

export const FEED_CODEC: DatasetCodec<FeedRecord> = feedShaped(DATASET_FEED);
export const NEW_NAME_CODEC: DatasetCodec<FeedRecord> = feedShaped(DATASET_NEW_NAME);

// ---- dataset 6, the time copy of feed, and dataset 7, of new-name
// (docs/format.md section 14): the rows of a key copy in (first_seen, key)
// order. The key of a record is the row's time key: first_seen as 4 big-endian
// bytes, then the row's own key, so the bytewise order of time keys is the
// order by (first_seen, key). The record is the key prefix of section 5.1 over
// the time key, then the fields of section 5.4 after first_seen, which the key
// holds. A record decodes to the row of the key copy: its own key, and its
// first_seen read from the time key.

// The largest first_seen a time key holds: 2^32 - 1 seconds, in the year 2162.
export const MAX_TIME_FIRST_SEEN = 0xffff_ffff;
export const TIME_PREFIX_BYTES = 4;
// The longest time key: 4 bytes of time and a reversed name of 253.
export const TIME_KEY_BYTES = TIME_PREFIX_BYTES + NAME_KEY_BYTES;

// The time key of a row. A first_seen that 4 bytes do not hold is refused, so
// no time key wraps around. The key "" gives the lowest time key of a second,
// which a reader takes as a bound.
export function timeKey(firstSeen: number, key: string): string {
  if (!isUint(firstSeen, MAX_TIME_FIRST_SEEN)) throw bad(`first_seen ${firstSeen} is not 0 to ${MAX_TIME_FIRST_SEEN}, which a time key holds`);
  return String.fromCharCode(Math.floor(firstSeen / 2 ** 24), (firstSeen >>> 16) & 0xff, (firstSeen >>> 8) & 0xff, firstSeen & 0xff) + key;
}

// The first_seen and the row key of a time key.
export function splitTimeKey(key: string): { readonly firstSeen: number; readonly key: string } {
  if (key.length < TIME_PREFIX_BYTES) throw bad(`a time key of ${key.length} bytes is shorter than its ${TIME_PREFIX_BYTES} bytes of time`);
  const c = (i: number): number => key.charCodeAt(i);
  return { firstSeen: c(0) * 2 ** 24 + c(1) * 2 ** 16 + c(2) * 2 ** 8 + c(3), key: key.slice(TIME_PREFIX_BYTES) };
}

const timeShaped = (id: number, rows: DatasetCodec<FeedRecord>): DatasetCodec<FeedRecord> =>
  Object.freeze({
    id,
    name: DATASET_LABELS[id],
    maxKeyBytes: TIME_KEY_BYTES,
    key: (r: FeedRecord) => timeKey(r.firstSeen, r.key),
    idxKey: (r: FeedRecord) => timeKey(r.firstSeen, r.key),
    encodeRecord(prev: FeedRecord | null, r: FeedRecord, out: ByteWriter): void {
      checkKey(r.key, "a key");
      const label = `the ${DATASET_LABELS[id]} row ${JSON.stringify(r.key.slice(0, 80))}`;
      if (r.key.length > NAME_KEY_BYTES) throw bad(`${label}: its key is ${r.key.length} bytes, above the ${NAME_KEY_BYTES} of ${rows.name}`);
      checkFeedFields(r, label, MAX_TIME_FIRST_SEEN);
      writeKey(prev === null ? null : timeKey(prev.firstSeen, prev.key), timeKey(r.firstSeen, r.key), r.flags, out, TIME_KEY_BYTES);
      writeFeedTail(r, out);
    },
    decodeRecord(prev: FeedRecord | null, input: ByteReader): FeedRecord {
      const { key, flags } = readKey(prev === null ? null : timeKey(prev.firstSeen, prev.key), input, TIME_KEY_BYTES);
      if (key.length <= TIME_PREFIX_BYTES) throw input.fail(`a time key of ${key.length} bytes holds no row key after its ${TIME_PREFIX_BYTES} bytes of time`);
      const split = splitTimeKey(key);
      return { key: split.key, flags, firstSeen: split.firstSeen, ...readFeedTail(input) };
    },
    merge(a: FeedRecord, b: FeedRecord): FeedRecord {
      if (a.key !== b.key || a.firstSeen !== b.firstSeen) throw new PackError("usage", "merge: the two records have different time keys");
      return mergeFeed(a, b);
    },
  });

export const FEED_TIME_CODEC: DatasetCodec<FeedRecord> = timeShaped(DATASET_FEED_TIME, FEED_CODEC);
export const NEW_NAME_TIME_CODEC: DatasetCodec<FeedRecord> = timeShaped(DATASET_NEW_NAME_TIME, NEW_NAME_CODEC);

// The codecs this package ships, by dataset byte. DOM-043 passes the codec of
// dataset 4 to the reader itself.
export const BUILTIN_CODECS: ReadonlyMap<number, DatasetCodec<NameRecord> | DatasetCodec<DomainRecord> | DatasetCodec<FeedRecord>> = new Map<
  number,
  DatasetCodec<NameRecord> | DatasetCodec<DomainRecord> | DatasetCodec<FeedRecord>
>([
  [DATASET_NAMES, NAMES_CODEC],
  [DATASET_DOMAINS, DOMAINS_CODEC],
  [DATASET_FEED, FEED_CODEC],
  [DATASET_NEW_NAME, NEW_NAME_CODEC],
  [DATASET_FEED_TIME, FEED_TIME_CODEC],
  [DATASET_NEW_NAME_TIME, NEW_NAME_TIME_CODEC],
]);

// The codec of the time copy of a dataset: 6 for 3 (feed), 7 for 5
// (new-name); null for a dataset that has no time copy.
export function timeCodecOf(dataset: number): DatasetCodec<FeedRecord> | null {
  return dataset === DATASET_FEED ? FEED_TIME_CODEC : dataset === DATASET_NEW_NAME ? NEW_NAME_TIME_CODEC : null;
}
