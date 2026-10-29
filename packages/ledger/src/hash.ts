// packages/ledger/src/hash.ts — the 64-bit hash of a registrable-domain key,
// the one value the provisional filter and its delta store.
//
//   hashKey("com.example")  →  { hi, lo }: the first 8 bytes of
//                               MurmurHash3_x86_128(key bytes, seed 0), read as
//                               a little-endian u64 (lo = word 0, hi = word 1)
//
// MurmurHash3_x86_128 is Austin Appleby's public-domain hash of SMHasher. It
// uses 32-bit multiplies only (Math.imul), so it runs in Node and in workerd with
// no BigInt and no `node:` import. It is not a cryptographic hash and needs not
// be: the filter answers "maybe seen", and the daily exact pass decides. The
// SMHasher verification value of this function is 0xB3ECE62A; hash.test.ts
// holds the implementation to it, so a change of one constant fails there.
//
// ⚠ The filter and the delta are persisted, so this function is part of their
// format: HASH_ID names it in their headers, and a reader refuses another id.
// A key is bytes, one code unit of 0 to 255 each (the pack format's keys); a
// code unit above 255 is refused, never truncated.
import { LedgerError } from "./errors.ts";

// The id of this hash in the filter and delta headers (filter.ts).
export const HASH_ID = 1;

// A 64-bit hash as two unsigned 32-bit halves. Its value is hi * 2^32 + lo.
export interface Hash64 {
  readonly hi: number;
  readonly lo: number;
}

const C1 = 0x239b961b;
const C2 = 0xab0e9789;
const C3 = 0x38b34ae5;
const C4 = 0xa1e38b93;

const rotl = (x: number, r: number): number => (x << r) | (x >>> (32 - r));

function fmix(h: number): number {
  let x = h;
  x ^= x >>> 16;
  x = Math.imul(x, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return x >>> 0;
}

const word = (b: Uint8Array, i: number): number => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24);

// MurmurHash3_x86_128 of bytes [0, length) of `data`, as its four 32-bit output
// words in order (the C reference writes them little-endian).
export function murmur3x86x128(data: Uint8Array, seed = 0, length = data.length): [number, number, number, number] {
  if (!Number.isInteger(length) || length < 0 || length > data.length) throw new LedgerError("usage", `murmur3: length ${length} is outside the ${data.length} bytes given`);
  let h1 = seed | 0;
  let h2 = seed | 0;
  let h3 = seed | 0;
  let h4 = seed | 0;
  const blocks = length - (length % 16);
  for (let i = 0; i < blocks; i += 16) {
    let k1 = word(data, i);
    let k2 = word(data, i + 4);
    let k3 = word(data, i + 8);
    let k4 = word(data, i + 12);
    k1 = Math.imul(rotl(Math.imul(k1, C1), 15), C2);
    h1 ^= k1;
    h1 = (Math.imul(rotl(h1, 19) + h2, 5) + 0x561ccd1b) | 0;
    k2 = Math.imul(rotl(Math.imul(k2, C2), 16), C3);
    h2 ^= k2;
    h2 = (Math.imul(rotl(h2, 17) + h3, 5) + 0x0bcaa747) | 0;
    k3 = Math.imul(rotl(Math.imul(k3, C3), 17), C4);
    h3 ^= k3;
    h3 = (Math.imul(rotl(h3, 15) + h4, 5) + 0x96cd1c35) | 0;
    k4 = Math.imul(rotl(Math.imul(k4, C4), 18), C1);
    h4 ^= k4;
    h4 = (Math.imul(rotl(h4, 13) + h1, 5) + 0x32ac3b17) | 0;
  }
  // The tail: the C reference's switch falls through from the highest byte
  // down, so each lane takes the bytes of its own 4-byte slot that exist. The
  // reference mixes only the lanes that took a byte; a lane with none is 0,
  // and 0 mixes to 0, so mixing all four gives the same hash.
  const rest = length - blocks;
  let k1 = 0;
  let k2 = 0;
  let k3 = 0;
  let k4 = 0;
  for (let j = rest - 1; j >= 0; j -= 1) {
    const b = data[blocks + j] << (8 * (j % 4));
    if (j >= 12) k4 ^= b;
    else if (j >= 8) k3 ^= b;
    else if (j >= 4) k2 ^= b;
    else k1 ^= b;
  }
  h4 ^= Math.imul(rotl(Math.imul(k4, C4), 18), C1);
  h3 ^= Math.imul(rotl(Math.imul(k3, C3), 17), C4);
  h2 ^= Math.imul(rotl(Math.imul(k2, C2), 16), C3);
  h1 ^= Math.imul(rotl(Math.imul(k1, C1), 15), C2);
  h1 ^= length;
  h2 ^= length;
  h3 ^= length;
  h4 ^= length;
  h1 = (h1 + h2 + h3 + h4) | 0;
  h2 = (h2 + h1) | 0;
  h3 = (h3 + h1) | 0;
  h4 = (h4 + h1) | 0;
  h1 = fmix(h1);
  h2 = fmix(h2);
  h3 = fmix(h3);
  h4 = fmix(h4);
  h1 = (h1 + h2 + h3 + h4) | 0;
  h2 = (h2 + h1) | 0;
  h3 = (h3 + h1) | 0;
  h4 = (h4 + h1) | 0;
  return [h1 >>> 0, h2 >>> 0, h3 >>> 0, h4 >>> 0];
}

// The bytes of the key being hashed. hashKey is synchronous and copies the key
// in before it reads, so one buffer serves every call; it grows to the longest
// key met (a key is at most 65,535 bytes, the pack format's limit).
let scratch = new Uint8Array(256);

export function hashKey(key: string): Hash64 {
  if (typeof key !== "string" || key.length === 0) throw new LedgerError("usage", "hashKey: a key is a non-empty string");
  if (key.length > scratch.length) scratch = new Uint8Array(Math.max(key.length, scratch.length * 2));
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    if (c > 255) throw new LedgerError("usage", `hashKey: the key holds the code unit ${c} at ${i}; a key is bytes`);
    scratch[i] = c;
  }
  const [w0, w1] = murmur3x86x128(scratch, 0, key.length);
  return { hi: w1, lo: w0 };
}

// The hash as 16 lowercase hex digits, high half first: the u64's value.
export const hashHex = (h: Hash64): string => h.hi.toString(16).padStart(8, "0") + h.lo.toString(16).padStart(8, "0");

// -1, 0 or 1 as a is below, equal to or above b, as u64 values.
export const compareHash = (a: Hash64, b: Hash64): number => (a.hi !== b.hi ? (a.hi < b.hi ? -1 : 1) : a.lo !== b.lo ? (a.lo < b.lo ? -1 : 1) : 0);
