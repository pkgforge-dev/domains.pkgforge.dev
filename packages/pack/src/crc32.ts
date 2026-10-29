// packages/pack/src/crc32.ts — the CRC-32 of zlib and gzip (docs/format.md
// section 1): polynomial 0xEDB88320 reflected, initial value and final XOR
// 0xFFFFFFFF. crc32(bytes, previous) continues a CRC as zlib's crc32(data,
// value) does. The CRC-32 of the ASCII bytes "123456789" is 0xcbf43926.
//
// It runs in Node and in workerd alike; checksums.test.ts holds it equal to
// node:zlib crc32. Slicing by four bytes keeps one 64 KB block in tens of
// microseconds.

const TABLES = (() => {
  const t = new Uint32Array(256 * 4);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  for (let n = 0; n < 256; n += 1) {
    t[256 + n] = (t[t[n] & 0xff] ^ (t[n] >>> 8)) >>> 0;
    t[512 + n] = (t[t[256 + n] & 0xff] ^ (t[256 + n] >>> 8)) >>> 0;
    t[768 + n] = (t[t[512 + n] & 0xff] ^ (t[512 + n] >>> 8)) >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, previous = 0): number {
  const t = TABLES;
  let c = ~previous >>> 0;
  let i = 0;
  const fours = bytes.length - (bytes.length % 4);
  for (; i < fours; i += 4) {
    c ^= bytes[i] | (bytes[i + 1] << 8) | (bytes[i + 2] << 16) | (bytes[i + 3] << 24);
    c = t[768 + (c & 0xff)] ^ t[512 + ((c >>> 8) & 0xff)] ^ t[256 + ((c >>> 16) & 0xff)] ^ t[c >>> 24];
  }
  for (; i < bytes.length; i += 1) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
}

export const hex32 = (value: number): string => (value >>> 0).toString(16).padStart(8, "0");
