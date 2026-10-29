// packages/pack/src/crc32.ts and src/sha256.ts against node:zlib and
// node:crypto, on the standard check values and on seeded random bytes cut at
// the lengths where a hash's padding changes (55, 56, 63, 64 and 65 bytes) and
// fed in random pieces.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { crc32 as zlibCrc32 } from "node:zlib";
import { crc32, hex32 } from "../src/crc32.ts";
import { Sha256, sha256Hex } from "../src/sha256.ts";
import { rng } from "./helpers.ts";

const ascii = (text: string): Uint8Array => new TextEncoder().encode(text);

function randomBytes(n: number, seed: number): Uint8Array {
  const next = rng(seed);
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 1) out[i] = Math.floor(next() * 256);
  return out;
}

test("pack checksums: the CRC-32 of 123456789 is cbf43926 and equals zlib's on random bytes and continued", () => {
  assert.equal(hex32(crc32(ascii("123456789"))), "cbf43926");
  assert.equal(crc32(new Uint8Array(0)), 0);
  for (const n of [1, 3, 4, 5, 7, 8, 1000, 65_537]) {
    const bytes = randomBytes(n, n);
    assert.equal(crc32(bytes), zlibCrc32(bytes), `length ${n}`);
    const cut = Math.floor(n / 3);
    assert.equal(crc32(bytes.subarray(cut), crc32(bytes.subarray(0, cut))), zlibCrc32(bytes), `continued at ${cut}`);
  }
});

test("pack checksums: SHA-256 equals node:crypto for the empty input, abc, and every padding edge, fed whole and in pieces", () => {
  assert.equal(sha256Hex(new Uint8Array(0)), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  assert.equal(sha256Hex(ascii("abc")), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const next = rng(17);
  for (const n of [1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100_003]) {
    const bytes = randomBytes(n, 1000 + n);
    const want = createHash("sha256").update(bytes).digest("hex");
    assert.equal(sha256Hex(bytes), want, `whole, length ${n}`);
    const h = new Sha256();
    for (let at = 0; at < n; ) {
      const step = 1 + Math.floor(next() * 130);
      h.update(bytes.subarray(at, at + step));
      at += step;
    }
    assert.equal(h.hex(), want, `in pieces, length ${n}`);
  }
});

test("pack checksums: a SHA-256 refuses an update or a digest after its digest", () => {
  const h = new Sha256().update(ascii("x"));
  h.digest();
  assert.throws(() => h.update(ascii("y")), /after digest/);
  assert.throws(() => h.digest(), /digest twice/);
});
