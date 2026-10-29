// packages/ledger/src/hash.ts: the 64-bit key hash is MurmurHash3_x86_128, held
// to SMHasher's verification value, and its first 8 bytes.
import assert from "node:assert/strict";
import { test } from "node:test";
import { compareHash, hashHex, hashKey, LedgerError, murmur3x86x128 } from "../src/index.ts";

// SMHasher's VerificationTest: hash the keys {}, {0}, {0,1}, ... {0..254} with
// the seed 256 - length, concatenate the outputs as the C reference writes them
// (little-endian words), hash that with seed 0, and read its first 4 bytes.
function verification(): number {
  const key = new Uint8Array(256);
  const hashes = new Uint8Array(16 * 256);
  const view = new DataView(hashes.buffer);
  for (let i = 0; i < 256; i += 1) {
    key[i] = i;
    const words = murmur3x86x128(key, 256 - i, i);
    for (let j = 0; j < 4; j += 1) view.setUint32(16 * i + 4 * j, words[j], true);
  }
  return murmur3x86x128(hashes, 0)[0];
}

test("hash: MurmurHash3_x86_128 gives SMHasher's verification value 0xB3ECE62A", () => {
  assert.equal(verification().toString(16), "b3ece62a");
});

test("hash: hashKey is the first 8 bytes of the 128-bit hash of the key's bytes, low word first", () => {
  for (const key of ["com.example", "np.com.x", "a", "uk.co.0000", "x".repeat(300)]) {
    const [w0, w1] = murmur3x86x128(new TextEncoder().encode(key), 0);
    assert.deepEqual(hashKey(key), { hi: w1, lo: w0 }, key.slice(0, 20));
  }
  // A key longer than the reused buffer, then a short one: the buffer grows and
  // the short key hashes its own bytes only.
  assert.deepEqual(hashKey("com.example"), hashKey(`${"com.example"}`));
  assert.equal(hashHex({ hi: 1, lo: 0xff }), "00000001000000ff");
});

test("hash: hashKey refuses an empty key and a code unit above 255", () => {
  assert.throws(
    () => hashKey(""),
    (e: unknown) => e instanceof LedgerError && e.code === "usage",
  );
  assert.throws(
    () => hashKey("com.exāmple"),
    (e: unknown) => e instanceof LedgerError && e.code === "usage" && /code unit 257/.test(e.message),
  );
});

test("hash: compareHash orders 64-bit values by the high half, then the low", () => {
  assert.equal(compareHash({ hi: 1, lo: 0 }, { hi: 0, lo: 0xffff_ffff }), 1);
  assert.equal(compareHash({ hi: 1, lo: 2 }, { hi: 1, lo: 3 }), -1);
  assert.equal(compareHash({ hi: 7, lo: 7 }, { hi: 7, lo: 7 }), 0);
});
