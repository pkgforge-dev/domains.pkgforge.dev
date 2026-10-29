// packages/pack/src/bytes.ts — the integers, varints, masks and keys of
// docs/format.md section 1, written by ByteWriter and read by ByteReader.
//
// Every fixed-width integer is little-endian. A varint is unsigned LEB128 of at
// most 8 bytes and a value of at most 2^53 - 1, and has one encoding per value:
// a varint of more than one byte never ends with 0x00. A mask is the LEB128 of a
// 64-bit set of source bits, built from the bit numbers, so no BigInt is needed.
// A key is a byte string: a JavaScript string whose code units are 0 to 255, one
// per byte, so `<` on two keys is their byte order.
//
// ByteReader throws PackError with the code it was made with ("record" inside a
// block, "head" or "page" inside the index), so a read past the end is refused
// by the check that owns the bytes.
import { PackError, type PackErrorCode } from "./errors.ts";

export const MAX_SAFE = Number.MAX_SAFE_INTEGER;
export const MAX_KEY_BYTES = 65_535;
export const MAX_VARINT_BYTES = 8;
export const MAX_MASK_BYTES = 10;
export const MAX_BIT = 63;
const TWO_32 = 2 ** 32;
// String.fromCharCode takes its bytes as arguments; this many stays far below
// every engine's argument limit.
const CHARS_AT_ONCE = 8192;

// The bytes [start, end) as a key: one code unit per byte. A short run is
// built char by char, which V8 runs several times faster than a spread of
// the array; a long one goes through apply, which takes a typed array as an
// array-like of numbers.
export function latin1(bytes: Uint8Array, start = 0, end = bytes.length): string {
  let out = "";
  if (end - start <= 64) {
    for (let i = start; i < end; i += 1) out += String.fromCharCode(bytes[i]);
    return out;
  }
  for (let at = start; at < end; at += CHARS_AT_ONCE) out += String.fromCharCode.apply(null, bytes.subarray(at, Math.min(end, at + CHARS_AT_ONCE)) as unknown as number[]);
  return out;
}

// The bytes of a key. A code unit above 255 is no byte, so it is refused.
export function keyBytes(key: string): Uint8Array {
  const out = new Uint8Array(key.length);
  for (let i = 0; i < key.length; i += 1) {
    const c = key.charCodeAt(i);
    if (c > 255) throw new PackError("record", `a key holds the code unit ${c} at ${i}: a key is bytes, one code unit of 0 to 255 each`);
    out[i] = c;
  }
  return out;
}

// Refuses what is not a key: not a string, empty, longer than MAX_KEY_BYTES, or
// holding a code unit above 255.
export function checkKey(key: unknown, what: string): asserts key is string {
  if (typeof key !== "string") throw new PackError("record", `${what} is not a string`);
  if (key.length === 0) throw new PackError("record", `${what} is empty`);
  if (key.length > MAX_KEY_BYTES) throw new PackError("record", `${what} is ${key.length} bytes, above ${MAX_KEY_BYTES}`);
  for (let i = 0; i < key.length; i += 1) if (key.charCodeAt(i) > 255) throw new PackError("record", `${what} holds the code unit ${key.charCodeAt(i)} at ${i}`);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(text: string): Uint8Array<ArrayBuffer> {
  if (!/^(?:[0-9a-f]{2})*$/.test(text)) throw new PackError("usage", "hex must be pairs of 0-9 and a-f");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(text.slice(2 * i, 2 * i + 2), 16);
  return out;
}

const checkUint = (value: number, max: number, what: string): void => {
  if (!Number.isInteger(value) || value < 0 || value > max) throw new PackError("record", `${what} ${value} is not a whole number of 0 to ${max}`);
};

// A growable byte buffer. The writer of every record, block and index.
export class ByteWriter {
  #buf: Uint8Array<ArrayBuffer>;
  #len = 0;

  constructor(initial = 4096) {
    this.#buf = new Uint8Array(Math.max(16, initial));
  }

  get length(): number {
    return this.#len;
  }

  #room(n: number): void {
    if (this.#len + n <= this.#buf.length) return;
    let size = this.#buf.length * 2;
    while (size < this.#len + n) size *= 2;
    const next = new Uint8Array(size);
    next.set(this.#buf.subarray(0, this.#len));
    this.#buf = next;
  }

  u8(value: number): void {
    checkUint(value, 0xff, "a u8");
    this.#room(1);
    this.#buf[this.#len++] = value;
  }

  u16(value: number): void {
    checkUint(value, 0xffff, "a u16");
    this.#room(2);
    this.#buf[this.#len++] = value & 0xff;
    this.#buf[this.#len++] = value >>> 8;
  }

  u32(value: number): void {
    checkUint(value, 0xffff_ffff, "a u32");
    this.#room(4);
    for (let i = 0; i < 4; i += 1) this.#buf[this.#len++] = (value >>> (8 * i)) & 0xff;
  }

  // A u64 of at most 2^53 - 1, as two u32: the low half first.
  u64(value: number): void {
    checkUint(value, MAX_SAFE, "a u64");
    this.u32(value % TWO_32);
    this.u32(Math.floor(value / TWO_32));
  }

  varint(value: number): void {
    checkUint(value, MAX_SAFE, "a varint");
    let rest = value;
    while (rest >= 128) {
      this.u8((rest % 128) | 0x80);
      rest = Math.floor(rest / 128);
    }
    this.u8(rest);
  }

  // The mask of a set of source bits. `bits` ascends, holds no bit twice, and
  // holds at least one bit of 0 to 63; the codecs check that before they call.
  mask(bits: readonly number[]): void {
    if (bits.length === 0) throw new PackError("record", "a mask holds no bit");
    const top = bits[bits.length - 1];
    checkUint(top, MAX_BIT, "a source bit");
    const groups = new Array<number>(Math.floor(top / 7) + 1).fill(0);
    for (const bit of bits) groups[Math.floor(bit / 7)] |= 1 << (bit % 7);
    for (let g = 0; g < groups.length; g += 1) this.u8(g < groups.length - 1 ? groups[g] | 0x80 : groups[g]);
  }

  bytes(bytes: Uint8Array): void {
    this.#room(bytes.length);
    this.#buf.set(bytes, this.#len);
    this.#len += bytes.length;
  }

  // The code units of key[from, end) as bytes. The caller checked the key.
  latin1(key: string, from = 0): void {
    this.#room(key.length - from);
    for (let i = from; i < key.length; i += 1) this.#buf[this.#len++] = key.charCodeAt(i);
  }

  // A key with its u16 length before it, as the index stores keys.
  key16(key: string): void {
    checkKey(key, "an index key");
    this.u16(key.length);
    this.latin1(key);
  }

  // Overwrites a u32 already written at `at`.
  patchU32(at: number, value: number): void {
    checkUint(value, 0xffff_ffff, "a u32");
    if (at < 0 || at + 4 > this.#len) throw new PackError("usage", `no u32 written at ${at}`);
    for (let i = 0; i < 4; i += 1) this.#buf[at + i] = (value >>> (8 * i)) & 0xff;
  }

  // A copy of the bytes written. The writer keeps its buffer.
  take(): Uint8Array<ArrayBuffer> {
    return this.#buf.slice(0, this.#len);
  }

  reset(): void {
    this.#len = 0;
  }
}

// Reads the bytes [pos, end) of an array. Every read past `end` is a PackError
// with the reader's code.
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly end: number;
  readonly code: PackErrorCode;
  readonly label: string;
  pos: number;

  constructor(bytes: Uint8Array, code: PackErrorCode, label: string, pos = 0, end = bytes.length) {
    this.bytes = bytes;
    this.code = code;
    this.label = label;
    this.pos = pos;
    this.end = end;
  }

  get remaining(): number {
    return this.end - this.pos;
  }

  fail(message: string): PackError {
    return new PackError(this.code, `${this.label}: ${message}`);
  }

  #need(n: number, what: string): void {
    if (this.pos + n > this.end) throw this.fail(`${what} runs past the end, at byte ${this.pos}`);
  }

  u8(): number {
    this.#need(1, "a u8");
    return this.bytes[this.pos++];
  }

  u16(): number {
    this.#need(2, "a u16");
    const value = this.bytes[this.pos] | (this.bytes[this.pos + 1] << 8);
    this.pos += 2;
    return value;
  }

  u32(): number {
    this.#need(4, "a u32");
    const b = this.bytes;
    const p = this.pos;
    this.pos += 4;
    return (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0;
  }

  u64(): number {
    this.#need(8, "a u64");
    const low = this.u32();
    const high = this.u32();
    if (high >= 2 ** 21) throw this.fail(`a u64 above 2^53 - 1 ends at byte ${this.pos}`);
    return high * TWO_32 + low;
  }

  varint(): number {
    let value = 0;
    let scale = 1;
    for (let i = 0; i < MAX_VARINT_BYTES; i += 1) {
      if (this.pos >= this.end) throw this.fail(`a varint runs past the end, at byte ${this.pos}`);
      const byte = this.bytes[this.pos++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) {
        if (byte === 0 && i > 0) throw this.fail(`a varint ends with a zero byte at byte ${this.pos - 1}: it has a shorter encoding`);
        if (value > MAX_SAFE) throw this.fail(`a varint above 2^53 - 1 ends at byte ${this.pos - 1}`);
        return value;
      }
      scale *= 128;
    }
    throw this.fail(`a varint is longer than ${MAX_VARINT_BYTES} bytes, at byte ${this.pos}`);
  }

  // The source bits of a mask, ascending.
  mask(): number[] {
    const bits: number[] = [];
    for (let g = 0; g < MAX_MASK_BYTES; g += 1) {
      if (this.pos >= this.end) throw this.fail(`a mask runs past the end, at byte ${this.pos}`);
      const byte = this.bytes[this.pos++];
      const low = byte & 0x7f;
      if (g === MAX_MASK_BYTES - 1 && low > 1) throw this.fail(`a mask holds a bit above ${MAX_BIT}, at byte ${this.pos - 1}`);
      for (let k = 0; k < 7; k += 1) if (low & (1 << k)) bits.push(g * 7 + k);
      if (byte < 0x80) {
        if (low === 0) throw this.fail(g === 0 ? `a mask holds no bit, at byte ${this.pos - 1}` : `a mask ends with a zero byte at byte ${this.pos - 1}`);
        return bits;
      }
    }
    throw this.fail(`a mask is longer than ${MAX_MASK_BYTES} bytes, at byte ${this.pos}`);
  }

  // n bytes as a key string.
  latin1(n: number): string {
    this.#need(n, `a run of ${n} bytes`);
    const text = latin1(this.bytes, this.pos, this.pos + n);
    this.pos += n;
    return text;
  }

  // A key with its u16 length before it. An empty key is refused unless
  // `allowEmpty`, which the key bounds of an empty pack use.
  key16(what: string, allowEmpty = false): string {
    const n = this.u16();
    if (n === 0 && !allowEmpty) throw this.fail(`${what} is empty`);
    return this.latin1(n);
  }
}
