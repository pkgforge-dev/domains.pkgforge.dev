// packages/pack/src/bytes.ts: the varint, the mask and the key of
// docs/format.md section 1. Each encoding is written and read back, and each
// refusal is a byte string only its own check refuses: an overlong varint, a
// mask with a bit above 63, a mask with no bit, a key with a code unit above 255.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ByteReader, ByteWriter, checkKey, fromHex, keyBytes, latin1, toHex } from "../src/bytes.ts";
import { PackError } from "../src/errors.ts";

const written = (fn: (w: ByteWriter) => void): string => {
  const w = new ByteWriter(16);
  fn(w);
  return toHex(w.take());
};
const reader = (hex: string) => new ByteReader(fromHex(hex), "record", "test");
const refused = (fn: () => unknown, code: string, pattern: RegExp) =>
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof PackError, String(e));
    assert.equal(e.code, code);
    assert.match(e.message, pattern);
    return true;
  });

test("pack bytes: varints are unsigned LEB128, low group first, and read back", () => {
  const cases: [number, string][] = [
    [0, "00"],
    [1, "01"],
    [127, "7f"],
    [128, "8001"],
    [298, "aa02"],
    // 25,747,200 = 0 + 62 * 128 + 35 * 128^2 + 12 * 128^3, worked by hand.
    [25_747_200, "80bea30c"],
    [2 ** 32, "8080808010"],
    [Number.MAX_SAFE_INTEGER, "ffffffffffffff0f"],
  ];
  for (const [value, hex] of cases) {
    assert.equal(
      written((w) => w.varint(value)),
      hex,
      String(value),
    );
    const r = reader(hex);
    assert.equal(r.varint(), value);
    assert.equal(r.remaining, 0);
  }
});

test("pack bytes: a varint with a trailing zero group, over 8 bytes, above 2^53 - 1 or cut short is refused", () => {
  refused(() => reader("8000").varint(), "record", /ends with a zero byte/);
  refused(() => reader("ffffffffffffffff01").varint(), "record", /longer than 8 bytes/);
  refused(() => reader("ffffffffffffff7f").varint(), "record", /above 2\^53 - 1/);
  refused(() => reader("80").varint(), "record", /runs past the end/);
  assert.throws(() => new ByteWriter().varint(-1), PackError);
  assert.throws(() => new ByteWriter().varint(2 ** 53), PackError);
  assert.throws(() => new ByteWriter().varint(1.5), PackError);
});

test("pack bytes: a mask is the LEB128 of the 64-bit set of its bits", () => {
  const cases: [number[], string][] = [
    [[0], "01"],
    [[5], "20"],
    [[0, 9], "8104"],
    [[7], "8001"],
    [[63], "80808080808080808001"],
    [[0, 1, 2, 3, 4, 5, 6], "7f"],
  ];
  for (const [bits, hex] of cases) {
    assert.equal(
      written((w) => w.mask(bits)),
      hex,
      bits.join(","),
    );
    assert.deepEqual(reader(hex).mask(), bits);
  }
  // Every bit at once.
  const all = Array.from({ length: 64 }, (_, i) => i);
  assert.deepEqual(reader(written((w) => w.mask(all))).mask(), all);
});

test("pack bytes: a mask with no bit, a trailing zero group, a bit above 63 or 11 bytes is refused", () => {
  refused(() => reader("00").mask(), "record", /holds no bit/);
  refused(() => reader("8100").mask(), "record", /ends with a zero byte/);
  // The tenth byte may hold bit 63 alone: 0x02 there is bit 64.
  refused(() => reader("80808080808080808002").mask(), "record", /above 63/);
  refused(() => reader("8080808080808080808101").mask(), "record", /above 63|longer than 10 bytes/);
  refused(() => reader("8080808080808080808001").mask(), "record", /longer than 10 bytes/);
  assert.throws(() => new ByteWriter().mask([]), PackError);
  assert.throws(() => new ByteWriter().mask([64]), PackError);
});

test("pack bytes: fixed-width integers are little-endian; a u64 above 2^53 - 1 is refused", () => {
  assert.equal(
    written((w) => {
      w.u16(0x1234);
      w.u32(0xdeadbeef);
      w.u64(2 ** 40 + 5);
    }),
    "3412efbeadde0500000000010000",
  );
  const r = reader("3412efbeadde0500000000010000");
  assert.equal(r.u16(), 0x1234);
  assert.equal(r.u32(), 0xdeadbeef);
  assert.equal(r.u64(), 2 ** 40 + 5);
  refused(() => reader("0000000000002000").u64(), "record", /above 2\^53 - 1/);
  assert.equal(reader("ffffffffffff1f00").u64(), Number.MAX_SAFE_INTEGER);
});

test("pack bytes: a key is one byte per code unit; empty, too long or above 255 is refused", () => {
  const key = "aÿ\u0000z";
  assert.deepEqual([...keyBytes(key)], [0x61, 0xff, 0x00, 0x7a]);
  assert.equal(latin1(keyBytes(key)), key);
  // Byte order is string order for code units of 0 to 255.
  assert.equal("np.com-x" < "np.com.a", true);
  assert.equal("ÿ" > "z", true);
  refused(() => checkKey("", "k"), "record", /empty/);
  refused(() => checkKey("x".repeat(65_536), "k"), "record", /above 65535/);
  refused(() => checkKey("aĀ", "k"), "record", /code unit 256/);
  refused(() => keyBytes("€"), "record", /code unit 8364/);
  checkKey("x".repeat(65_535), "k");
  // A long key crosses the chunking of latin1.
  const long = Array.from({ length: 20_000 }, (_, i) => String.fromCharCode(i % 256)).join("");
  assert.equal(latin1(keyBytes(long)), long);
});
