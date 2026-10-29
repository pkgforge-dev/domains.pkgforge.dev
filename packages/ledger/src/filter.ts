// packages/ledger/src/filter.ts — the provisional filter of the hourly job: has
// any source seen this registrable domain before?
//
//   const filter = await buildFilter(domainPacks, { asOf });   // daily, from the exact table
//   const delta = HashDelta.empty(filter);                      // or HashDelta.decode(bytes)
//   const seen = new ProvisionalFilter(filter, delta);          // refuses a delta of another filter
//   if (!seen.has(hashKey(k))) { /* new, provisional */ seen.add(hashKey(k)); }
//   push filter.encode() as `ledger-filter-DATE`, delta.encode() as `ledger-delta` (DOM-024)
//
// MembershipFilter is the seam: has(hash) and add(hash) over the 64-bit hash of
// a reversed registrable domain (hash.ts). Its first implementation is a Bloom
// filter of 10 bits a key and 7 hashes. A Bloom filter has no false negative
// and some false positives: about 0.82% at 10 bits a key and 7 hashes, by
// (1 - e^(-7/10))^7. A false positive judges a new domain old for the hours
// until the daily exact pass (reconcile.ts), and the day pack is built from that
// exact pass, so the filter decides no answer a caller keeps.
//
// The filter is built from the table and does not change until the next build.
// The domains first seen since the build go to the delta: an exact, sorted set
// of their hashes (at most about 0.8 million a day, 8 B each). has() asks both.
// A delta carries the identity of the filter it was built against (`as_of` and
// the CRC-32 of its bits); ProvisionalFilter refuses any other pairing, because
// a delta of an older filter misses the domains between the two builds.
// rebase() moves a delta to a newer filter and keeps only the hashes the newer
// filter lacks: those seen after the newer table's `as_of`.
//
// The Bloom filter is partitioned: hash i sets one bit in partition i, of P bits
// each, at (lo + i * hi) mod P (double hashing, Kirsch and Mitzenmacher). Its
// false-positive rate is that of the classic layout, (1 - e^(-n/P))^k, and P may
// reach 2^32 bits, so k * 2^32 bits bound the filter, not 2^32.
//
// Byte layout of the filter (`ledger-filter-DATE`), little-endian:
//   0  4  magic "DLBF"
//   4  1  version, 1
//   5  1  hash id, 1 (hash.ts HASH_ID)
//   6  1  k, the hashes and the partitions, 1 to 32
//   7  1  reserved, 0
//   8  4  P, the bits of a partition: a multiple of 64, at least 64
//   12 8  keys added, u64 at most 2^53 - 1
//   20 8  as_of: seconds since 2026-01-01T00:00:00Z of the table it was built from
//   28 4  CRC-32 of the bits
//   32 4  CRC-32 of bytes 0 to 31
//   36    the bits: k * P / 8 bytes; bit b of partition i is bit (b & 7) of byte i * P / 8 + (b >>> 3)
// Byte layout of the delta (`ledger-delta`), little-endian:
//   0  4  magic "DLBD"
//   4  1  version, 1
//   5  1  hash id, 1
//   6  2  reserved, 0
//   8  4  n, the hashes
//   12 8  as_of of the filter it pairs with
//   20 4  CRC-32 of that filter's bits
//   24 4  CRC-32 of the hashes
//   28 4  CRC-32 of bytes 0 to 27
//   32    n hashes, u64 each, ascending with none twice
// A reader refuses a length other than the header's, an unknown magic, version
// or hash id, a field out of range, a CRC that does not match, and a delta whose
// hashes do not ascend.
import { crc32, DATASET_DOMAINS, DOMAINS_CODEC, type DomainRecord, hex32, mergePacks, type PackReader } from "@domains/pack";
import { LedgerError } from "./errors.ts";
import { compareHash, HASH_ID, type Hash64, hashKey } from "./hash.ts";

export interface MembershipFilter {
  has(hash: Hash64): boolean;
  add(hash: Hash64): void;
}

export const FORMAT_VERSION = 1;
export const FILTER_MAGIC = "DLBF";
export const DELTA_MAGIC = "DLBD";
export const FILTER_HEADER_BYTES = 36;
export const DELTA_HEADER_BYTES = 32;
export const DEFAULT_BITS_PER_KEY = 10;
export const DEFAULT_HASHES = 7;
export const MAX_HASHES = 32;
// A partition's bit offsets are u32: the largest multiple of 64 below 2^32.
export const MAX_PARTITION_BITS = 2 ** 32 - 64;
const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const TWO_32 = 2 ** 32;

const bad = (message: string): LedgerError => new LedgerError("format", message);

function whole(value: unknown, min: number, max: number, what: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) throw new LedgerError("usage", `${what} must be a whole number of ${min} to ${max}, not ${String(value)}`);
  return value;
}

function magicAt(bytes: Uint8Array, magic: string): boolean {
  for (let i = 0; i < 4; i += 1) if (bytes[i] !== magic.charCodeAt(i)) return false;
  return true;
}

const u64 = (view: DataView, at: number): number => view.getUint32(at, true) + view.getUint32(at + 4, true) * TWO_32;

function setU64(view: DataView, at: number, value: number): void {
  view.setUint32(at, value % TWO_32, true);
  view.setUint32(at + 4, Math.floor(value / TWO_32), true);
}

export interface FilterOptions {
  // Seconds since 2026-01-01T00:00:00Z: the time through which the table the
  // filter is built from is complete.
  readonly asOf: number;
  readonly bitsPerKey?: number;
  readonly hashes?: number;
}

export class BloomFilter implements MembershipFilter {
  readonly hashes: number;
  readonly partitionBits: number;
  readonly asOf: number;
  readonly #bits: Uint8Array<ArrayBuffer>;
  readonly #partitionBytes: number;
  #keys: number;
  // The CRC-32 of the bits, kept until the next add.
  #crc: number | null = null;

  private constructor(hashes: number, partitionBits: number, asOf: number, bits: Uint8Array<ArrayBuffer>, keys: number) {
    this.hashes = hashes;
    this.partitionBits = partitionBits;
    this.asOf = asOf;
    this.#bits = bits;
    this.#partitionBytes = partitionBits / 8;
    this.#keys = keys;
  }

  // An empty filter sized for `expected` keys at `bitsPerKey` bits a key.
  static forKeys(expected: number, options: FilterOptions): BloomFilter {
    whole(expected, 0, MAX_SAFE, "the expected keys");
    const hashes = whole(options.hashes ?? DEFAULT_HASHES, 1, MAX_HASHES, "the hashes");
    const bitsPerKey = whole(options.bitsPerKey ?? DEFAULT_BITS_PER_KEY, 1, 64, "the bits a key");
    whole(options.asOf, 0, MAX_SAFE, "as_of");
    const partition = Math.max(64, Math.ceil((expected * bitsPerKey) / hashes / 64) * 64);
    if (partition > MAX_PARTITION_BITS) throw new LedgerError("usage", `a filter of ${expected} keys at ${bitsPerKey} bits a key needs partitions of ${partition} bits, above ${MAX_PARTITION_BITS}`);
    return new BloomFilter(hashes, partition, options.asOf, new Uint8Array((hashes * partition) / 8), 0);
  }

  // The number of add calls.
  get keys(): number {
    return this.#keys;
  }

  // The bytes of the bits, without the header.
  get bitBytes(): number {
    return this.#bits.length;
  }

  // The CRC-32 of the bits: with as_of, the identity a delta pairs with.
  get crc(): number {
    if (this.#crc === null) this.#crc = crc32(this.#bits);
    return this.#crc;
  }

  #probe(hash: Hash64, set: boolean): boolean {
    const p = this.partitionBits;
    const bits = this.#bits;
    let pos = hash.lo % p;
    const step = hash.hi % p;
    let base = 0;
    let all = true;
    for (let i = 0; i < this.hashes; i += 1) {
      const byte = base + (pos >>> 3);
      const mask = 1 << (pos & 7);
      if ((bits[byte] & mask) === 0) {
        if (!set) return false;
        bits[byte] |= mask;
        all = false;
      }
      pos += step;
      if (pos >= p) pos -= p;
      base += this.#partitionBytes;
    }
    return all;
  }

  has(hash: Hash64): boolean {
    return this.#probe(hash, false);
  }

  add(hash: Hash64): void {
    if (this.#keys >= MAX_SAFE) throw new LedgerError("usage", "the filter holds 2^53 - 1 keys");
    this.#probe(hash, true);
    this.#keys += 1;
    this.#crc = null;
  }

  encode(): Uint8Array<ArrayBuffer> {
    const out = new Uint8Array(FILTER_HEADER_BYTES + this.#bits.length);
    const view = new DataView(out.buffer);
    for (let i = 0; i < 4; i += 1) out[i] = FILTER_MAGIC.charCodeAt(i);
    out[4] = FORMAT_VERSION;
    out[5] = HASH_ID;
    out[6] = this.hashes;
    out[7] = 0;
    view.setUint32(8, this.partitionBits, true);
    setU64(view, 12, this.#keys);
    setU64(view, 20, this.asOf);
    view.setUint32(28, this.crc, true);
    view.setUint32(32, crc32(out.subarray(0, 32)), true);
    out.set(this.#bits, FILTER_HEADER_BYTES);
    return out;
  }

  // The filter of `bytes`, every header field and both CRCs checked. The bits
  // are copied, so the filter owns them.
  static decode(bytes: Uint8Array): BloomFilter {
    if (bytes.length < FILTER_HEADER_BYTES) throw bad(`a filter is at least ${FILTER_HEADER_BYTES} B, these are ${bytes.length} B`);
    if (!magicAt(bytes, FILTER_MAGIC)) throw bad(`the bytes do not start with ${FILTER_MAGIC}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headCrc = crc32(bytes.subarray(0, 32));
    if (headCrc !== view.getUint32(32, true)) throw new LedgerError("crc", `the filter header has CRC-32 ${hex32(headCrc)}, it says ${hex32(view.getUint32(32, true))}`);
    if (bytes[4] !== FORMAT_VERSION) throw bad(`the filter is version ${bytes[4]}; this reader reads ${FORMAT_VERSION}`);
    if (bytes[5] !== HASH_ID) throw bad(`the filter uses hash ${bytes[5]}; this reader knows ${HASH_ID}`);
    const hashes = bytes[6];
    if (hashes < 1 || hashes > MAX_HASHES) throw bad(`the filter has ${hashes} hashes, not 1 to ${MAX_HASHES}`);
    if (bytes[7] !== 0) throw bad(`the filter's reserved byte is ${bytes[7]}, not 0`);
    const partition = view.getUint32(8, true);
    if (partition < 64 || partition % 64 !== 0) throw bad(`the filter's partitions are ${partition} bits, not a multiple of 64 of at least 64`);
    const keys = u64(view, 12);
    const asOf = u64(view, 20);
    if (keys > MAX_SAFE || asOf > MAX_SAFE) throw bad("the filter's key count or as_of is above 2^53 - 1");
    const size = FILTER_HEADER_BYTES + (hashes * partition) / 8;
    if (bytes.length !== size) throw bad(`the filter header says ${size} B, the bytes are ${bytes.length} B`);
    const bits = new Uint8Array(bytes.subarray(FILTER_HEADER_BYTES));
    const crc = crc32(bits);
    if (crc !== view.getUint32(28, true)) throw new LedgerError("crc", `the filter bits have CRC-32 ${hex32(crc)}, the header says ${hex32(view.getUint32(28, true))}`);
    const filter = new BloomFilter(hashes, partition, asOf, bits, keys);
    filter.#crc = crc;
    return filter;
  }
}

const bigOf = (h: Hash64): bigint => (BigInt(h.hi) << 32n) | BigInt(h.lo);
const hashOf = (b: bigint): Hash64 => ({ hi: Number(b >> 32n), lo: Number(b & 0xffff_ffffn) });

export class HashDelta implements MembershipFilter {
  readonly filterAsOf: number;
  readonly filterCrc: number;
  // The hashes read from bytes, ascending, as parallel halves.
  readonly #hi: Uint32Array;
  readonly #lo: Uint32Array;
  // The hashes added since, none of them in #hi and #lo.
  readonly #added = new Set<bigint>();

  private constructor(filterAsOf: number, filterCrc: number, hi: Uint32Array, lo: Uint32Array) {
    this.filterAsOf = filterAsOf;
    this.filterCrc = filterCrc;
    this.#hi = hi;
    this.#lo = lo;
  }

  // An empty delta paired with `filter`.
  static empty(filter: BloomFilter): HashDelta {
    return new HashDelta(filter.asOf, filter.crc, new Uint32Array(0), new Uint32Array(0));
  }

  get size(): number {
    return this.#hi.length + this.#added.size;
  }

  #inSorted(h: Hash64): boolean {
    let lo = 0;
    let hi = this.#hi.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const c = compareHash({ hi: this.#hi[mid], lo: this.#lo[mid] }, h);
      if (c === 0) return true;
      if (c < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  has(hash: Hash64): boolean {
    return this.#inSorted(hash) || this.#added.has(bigOf(hash));
  }

  add(hash: Hash64): void {
    if (!this.#inSorted(hash)) this.#added.add(bigOf(hash));
  }

  // Every hash, ascending.
  *hashes(): Generator<Hash64> {
    const added = [...this.#added].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).map(hashOf);
    let i = 0;
    let j = 0;
    while (i < this.#hi.length || j < added.length) {
      const x = i < this.#hi.length ? { hi: this.#hi[i], lo: this.#lo[i] } : null;
      const y = j < added.length ? added[j] : null;
      if (y === null || (x !== null && compareHash(x, y) < 0)) {
        yield x as Hash64;
        i += 1;
      } else {
        yield y;
        j += 1;
      }
    }
  }

  // The hashes the newer filter lacks, in a delta paired with it. Those it has
  // were in its table, or are its false positives, which has() answers anyway.
  rebase(filter: BloomFilter): HashDelta {
    const kept = [...this.hashes()].filter((h) => !filter.has(h));
    return new HashDelta(
      filter.asOf,
      filter.crc,
      Uint32Array.from(kept, (h) => h.hi),
      Uint32Array.from(kept, (h) => h.lo),
    );
  }

  encode(): Uint8Array<ArrayBuffer> {
    const n = this.size;
    if (n > 0xffff_ffff) throw new LedgerError("usage", `a delta of ${n} hashes is above the u32 count of its header`);
    const out = new Uint8Array(DELTA_HEADER_BYTES + 8 * n);
    const view = new DataView(out.buffer);
    let at = DELTA_HEADER_BYTES;
    for (const h of this.hashes()) {
      view.setUint32(at, h.lo, true);
      view.setUint32(at + 4, h.hi, true);
      at += 8;
    }
    for (let i = 0; i < 4; i += 1) out[i] = DELTA_MAGIC.charCodeAt(i);
    out[4] = FORMAT_VERSION;
    out[5] = HASH_ID;
    view.setUint32(8, n, true);
    setU64(view, 12, this.filterAsOf);
    view.setUint32(20, this.filterCrc, true);
    view.setUint32(24, crc32(out.subarray(DELTA_HEADER_BYTES)), true);
    view.setUint32(28, crc32(out.subarray(0, 28)), true);
    return out;
  }

  static decode(bytes: Uint8Array): HashDelta {
    if (bytes.length < DELTA_HEADER_BYTES) throw bad(`a delta is at least ${DELTA_HEADER_BYTES} B, these are ${bytes.length} B`);
    if (!magicAt(bytes, DELTA_MAGIC)) throw bad(`the bytes do not start with ${DELTA_MAGIC}`);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const headCrc = crc32(bytes.subarray(0, 28));
    if (headCrc !== view.getUint32(28, true)) throw new LedgerError("crc", `the delta header has CRC-32 ${hex32(headCrc)}, it says ${hex32(view.getUint32(28, true))}`);
    if (bytes[4] !== FORMAT_VERSION) throw bad(`the delta is version ${bytes[4]}; this reader reads ${FORMAT_VERSION}`);
    if (bytes[5] !== HASH_ID) throw bad(`the delta uses hash ${bytes[5]}; this reader knows ${HASH_ID}`);
    if (bytes[6] !== 0 || bytes[7] !== 0) throw bad("the delta's reserved bytes are not 0");
    const n = view.getUint32(8, true);
    const asOf = u64(view, 12);
    if (asOf > MAX_SAFE) throw bad("the delta's filter as_of is above 2^53 - 1");
    if (bytes.length !== DELTA_HEADER_BYTES + 8 * n) throw bad(`the delta header says ${n} hashes, ${DELTA_HEADER_BYTES + 8 * n} B; the bytes are ${bytes.length} B`);
    const crc = crc32(bytes.subarray(DELTA_HEADER_BYTES));
    if (crc !== view.getUint32(24, true)) throw new LedgerError("crc", `the delta hashes have CRC-32 ${hex32(crc)}, the header says ${hex32(view.getUint32(24, true))}`);
    const hi = new Uint32Array(n);
    const lo = new Uint32Array(n);
    for (let i = 0; i < n; i += 1) {
      const at = DELTA_HEADER_BYTES + 8 * i;
      lo[i] = view.getUint32(at, true);
      hi[i] = view.getUint32(at + 4, true);
      if (i > 0 && compareHash({ hi: hi[i - 1], lo: lo[i - 1] }, { hi: hi[i], lo: lo[i] }) >= 0) throw bad(`delta hash ${i} is not above the hash before it`);
    }
    return new HashDelta(asOf, view.getUint32(20, true), hi, lo);
  }
}

// The filter and its delta as one membership: has() asks both, add() goes to
// the delta, because the filter changes only at its daily build.
export class ProvisionalFilter implements MembershipFilter {
  readonly filter: BloomFilter;
  readonly delta: HashDelta;

  constructor(filter: BloomFilter, delta: HashDelta) {
    if (delta.filterAsOf !== filter.asOf || delta.filterCrc !== filter.crc)
      throw new LedgerError(
        "pair",
        `the delta pairs with the filter of as_of ${delta.filterAsOf} and CRC-32 ${hex32(delta.filterCrc)}, not this one (as_of ${filter.asOf}, CRC-32 ${hex32(filter.crc)}); rebase it`,
      );
    this.filter = filter;
    this.delta = delta;
  }

  has(hash: Hash64): boolean {
    return this.filter.has(hash) || this.delta.has(hash);
  }

  add(hash: Hash64): void {
    this.delta.add(hash);
  }
}

// The filter of the registrable domains of `packs` (the `domains` packs of the
// live set), sized for the sum of their records. A key in two packs is added
// once: the packs are merged by key.
export async function buildFilter(packs: readonly PackReader<DomainRecord>[], options: FilterOptions): Promise<BloomFilter> {
  let expected = 0;
  for (const [i, reader] of packs.entries()) {
    if (reader.index.header.dataset !== DATASET_DOMAINS) throw new LedgerError("usage", `buildFilter: pack ${i} is dataset ${reader.index.header.dataset}, not ${DATASET_DOMAINS} (domains)`);
    expected += reader.index.header.records;
  }
  const filter = BloomFilter.forKeys(expected, options);
  for await (const record of mergePacks(packs, DOMAINS_CODEC)) filter.add(hashKey(record.key));
  return filter;
}
