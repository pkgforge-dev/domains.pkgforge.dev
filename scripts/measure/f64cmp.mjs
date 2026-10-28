// scripts/measure/f64cmp.mjs — the hash files of the THC day measurement
// (DOM-009) and the comparison of two of them, after design A's f64cmp.mjs
// (docs/research/2026-10-27-design-a/scripts/f64cmp.mjs).
//
// A hash file is a sorted, duplicate-free run of little-endian IEEE 754 doubles,
// each an integer below 2^53: the h53 hash of one key. It has no header, so a
// file is described by the stat file written beside it (thc-day.mjs), which
// names the hash, the sample and the count; thc-union.mjs checks the count and
// the order before it trusts a file. This is the format design A's union4.mjs
// read.
//
// h53 is design A's two-lane hash (FNV-1a in one lane, a multiply-xorshift in
// the other) with a murmur3 finaliser on each lane, so that its top bits are as
// well mixed as its bottom ones: a sample keeps the hashes whose top
// `sampleBits` bits are zero. The finaliser is a bijection on each lane, so two
// keys collide exactly when they collide in design A's hash.
//
// Usage:
//   import { h53, sampleLimit, createF64, sortUnique, readF64, writeF64, compareF64 } from './f64cmp.mjs'
//   node scripts/measure/f64cmp.mjs A.f64 B.f64   prints {A, B, both, pctOfA, pctOfB} as JSON
// Exit codes: 0 compared, 1 a file is not sorted and duplicate-free, 2 could not run.
import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';

export class F64Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'F64Error';
  }
}

const TWO32 = 4294967296;

function fmix32(input) {
  let h = input;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

// An integer in [0, 2^53) for a string of code units below 256.
export function h53(s) {
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995);
    b ^= b >>> 15;
  }
  return fmix32(a) + (fmix32(b) & 0x1fffff) * TWO32;
}

// The exclusive upper bound of a sample of 1 in 2^bits hashes.
export function sampleLimit(bits) {
  if (!Number.isInteger(bits) || bits < 0 || bits > 20) throw new F64Error(`sample bits must be an integer from 0 to 20, got ${bits}`);
  return 2 ** (53 - bits);
}

// A growable Float64Array. push(x); array() returns the filled part.
export function createF64(capacity = 1 << 16) {
  let data = new Float64Array(Math.max(16, capacity));
  let size = 0;
  return {
    push(x) {
      if (size === data.length) {
        const next = new Float64Array(data.length * 2);
        next.set(data);
        data = next;
      }
      data[size++] = x;
    },
    get size() {
      return size;
    },
    array() {
      return data.subarray(0, size);
    },
  };
}

// Sorts in place and returns a new array of the distinct values.
export function sortUnique(values) {
  values.sort();
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    if (i === 0 || values[i] !== values[i - 1]) values[n++] = values[i];
  }
  return values.slice(0, n);
}

// Throws an F64Error unless every value is an integer in [0, limit) and each is
// above the one before.
export function checkSortedUnique(values, limit = 2 ** 53, what = 'values') {
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isInteger(v) || v < 0 || v >= limit) throw new F64Error(`${what}: value ${i} is not an integer in [0, ${limit})`);
    if (i > 0 && v <= values[i - 1]) throw new F64Error(`${what}: value ${i} is not above value ${i - 1}`);
  }
}

export function writeF64(path, values) {
  writeFileSync(path, Buffer.from(values.buffer, values.byteOffset, values.byteLength));
}

// Reads a hash file. A length that is not a multiple of 8 is refused.
export function readF64(path) {
  const bytes = readFileSync(path);
  if (bytes.length % 8 !== 0) throw new F64Error(`${path}: ${bytes.length} B is not a multiple of 8`);
  if (bytes.byteOffset % 8 === 0) return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.length / 8);
  const copy = new Float64Array(bytes.length / 8);
  new Uint8Array(copy.buffer).set(bytes);
  return copy;
}

// The sizes of two sorted duplicate-free arrays and of their intersection.
export function compareF64(A, B) {
  let i = 0;
  let j = 0;
  let both = 0;
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) {
      both += 1;
      i += 1;
      j += 1;
    } else if (A[i] < B[j]) i += 1;
    else j += 1;
  }
  const pct = (n, d) => (d === 0 ? 0 : +((100 * n) / d).toFixed(2));
  return { A: A.length, B: B.length, both, pctOfA: pct(both, A.length), pctOfB: pct(both, B.length) };
}

function main(argv) {
  if (argv.length !== 2) {
    console.error('usage: node scripts/measure/f64cmp.mjs A.f64 B.f64');
    return 2;
  }
  const arrays = [];
  for (const path of argv) {
    let values;
    try {
      values = readF64(path);
    } catch (err) {
      console.error(`f64cmp: ${err.message}`);
      return err instanceof F64Error ? 1 : 2;
    }
    try {
      checkSortedUnique(values, 2 ** 53, path);
    } catch (err) {
      console.error(`f64cmp: ${err.message}`);
      return 1;
    }
    arrays.push(values);
  }
  console.log(JSON.stringify({ a: basename(argv[0]), b: basename(argv[1]), ...compareF64(arrays[0], arrays[1]) }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
