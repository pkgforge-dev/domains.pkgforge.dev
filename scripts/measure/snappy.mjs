// scripts/measure/snappy.mjs — decode a snappy block, and Kafka's framing of
// snappy (the xerial stream the Java producer writes), with every length checked.
//
// Copied from docs/research/2026-10-27-design-a/scripts/snappy.mjs and hardened:
// a truncated input, a copy that reaches before the start of the output, or an
// output whose length differs from the declared one throws SnappyError, where
// the copy returned short or garbage bytes. It takes and returns Uint8Array and
// uses no Node API, so DOM-005 can port it to a Worker unchanged in substance.
//
// The format (https://github.com/google/snappy/blob/main/format_description.txt):
// a varint of the uncompressed length, then elements. A tag's low two bits name
// the element: 0 a literal, 1 a copy with an 11-bit offset, 2 a copy with a
// 16-bit offset, 3 a copy with a 32-bit offset.
//
// Usage: import { snappyKafka, snappyRaw } from './snappy.mjs'
// It is a module; it has no command line and no exit code.

export class SnappyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SnappyError';
  }
}

// The xerial header: 0x82 'S' 'N' 'A' 'P' 'P' 'Y' 0x00, then a version and a
// compatible version, int32 each. Chunks follow, each an int32 length and a raw block.
const XERIAL_MAGIC = [0x82, 0x53, 0x4e, 0x41, 0x50, 0x50, 0x59, 0x00];
const XERIAL_HEADER = 16;
// A copy of 64 bytes costs 3 input bytes, the best ratio the format allows, so
// a declared length above 22 bytes per input byte cannot be honest.
const MAX_RATIO = 22;

// The uncompressed length of a raw block and where its elements start.
function preamble(src) {
  let len = 0;
  let p = 0;
  for (let shift = 0; ; shift += 7) {
    if (p >= src.length) throw new SnappyError('the length varint runs past the input');
    if (shift > 28) throw new SnappyError('the length varint is longer than 5 bytes');
    const b = src[p++];
    len += (b & 0x7f) * 2 ** shift;
    if ((b & 0x80) === 0) break;
  }
  if (len > 0xffffffff) throw new SnappyError(`the declared length ${len} exceeds 32 bits`);
  if (len > src.length * MAX_RATIO) throw new SnappyError(`the declared length ${len} is more than ${MAX_RATIO} times the ${src.length}-byte input`);
  return { len, p };
}

// Decodes one raw snappy block. Throws SnappyError on any malformed input.
export function snappyRaw(src) {
  const { len, p: start } = preamble(src);
  const out = new Uint8Array(len);
  let p = start;
  let o = 0;
  while (p < src.length) {
    const tag = src[p++];
    const type = tag & 3;
    if (type === 0) {
      let l = tag >> 2;
      if (l >= 60) {
        const nb = l - 59;
        if (p + nb > src.length) throw new SnappyError(`a literal length at input byte ${p - 1} runs past the input`);
        l = 0;
        for (let i = 0; i < nb; i++) l += src[p++] * 2 ** (8 * i);
      }
      l += 1;
      if (p + l > src.length) throw new SnappyError(`a literal of ${l} byte(s) at input byte ${p} runs past the input`);
      if (o + l > len) throw new SnappyError(`a literal of ${l} byte(s) overflows the declared length ${len}`);
      out.set(src.subarray(p, p + l), o);
      p += l;
      o += l;
      continue;
    }
    let l;
    let off;
    if (type === 1) {
      if (p + 1 > src.length) throw new SnappyError('a 1-byte-offset copy runs past the input');
      l = 4 + ((tag >> 2) & 7);
      off = ((tag >> 5) << 8) | src[p++];
    } else if (type === 2) {
      if (p + 2 > src.length) throw new SnappyError('a 2-byte-offset copy runs past the input');
      l = 1 + (tag >> 2);
      off = src[p] | (src[p + 1] << 8);
      p += 2;
    } else {
      if (p + 4 > src.length) throw new SnappyError('a 4-byte-offset copy runs past the input');
      l = 1 + (tag >> 2);
      off = (src[p] | (src[p + 1] << 8) | (src[p + 2] << 16)) + src[p + 3] * 0x1000000;
      p += 4;
    }
    if (off === 0 || off > o) throw new SnappyError(`a copy at output byte ${o} has offset ${off}, outside the ${o} byte(s) written`);
    if (o + l > len) throw new SnappyError(`a copy of ${l} byte(s) overflows the declared length ${len}`);
    // Byte by byte: a copy may overlap its own output (a run).
    for (let i = 0; i < l; i++, o++) out[o] = out[o - off];
  }
  if (o !== len) throw new SnappyError(`the block declares ${len} byte(s) and holds ${o}`);
  return out;
}

// True when the bytes start with the xerial header.
export function isXerial(b) {
  if (b.length < XERIAL_HEADER) return false;
  for (let i = 0; i < XERIAL_MAGIC.length; i++) if (b[i] !== XERIAL_MAGIC[i]) return false;
  return true;
}

// Decodes a Kafka snappy payload: the xerial stream when it carries the header,
// a raw block otherwise (librdkafka writes raw blocks).
export function snappyKafka(b) {
  if (!isXerial(b)) return snappyRaw(b);
  const parts = [];
  let total = 0;
  let p = XERIAL_HEADER;
  while (p < b.length) {
    if (p + 4 > b.length) throw new SnappyError(`${b.length - p} trailing byte(s) after the last xerial chunk`);
    const n = ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    p += 4;
    if (n === 0 || p + n > b.length) throw new SnappyError(`a xerial chunk declares ${n} byte(s) with ${b.length - p} left`);
    const part = snappyRaw(b.subarray(p, p + n));
    parts.push(part);
    total += part.length;
    p += n;
  }
  if (parts.length === 1) return parts[0];
  const out = new Uint8Array(total);
  let o = 0;
  for (const part of parts) {
    out.set(part, o);
    o += part.length;
  }
  return out;
}
