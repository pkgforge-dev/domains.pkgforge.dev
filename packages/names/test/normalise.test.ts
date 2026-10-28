// packages/names/src/normalise.ts: the steps of docs/architecture.md section
// 3.1 over the pinned list (fixtures/psl-2026-10-27.dat). Each refusal is
// planted on its own, and the IDN conversion is held equal to node:url
// domainToASCII, the conversion DOM-009 measured with.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { domainToASCII } from "node:url";
import { normalise, REFUSALS } from "../src/normalise.ts";
import { loadPsl } from "../src/psl.ts";
import { toAscii } from "../src/syntax.ts";

const psl = await loadPsl(readFileSync(join(import.meta.dirname, "fixtures", "psl-2026-10-27.dat")));
const ok = (name: string, wild = false) => ({ name, wild });
const no = (refused: string) => ({ refused });

test("names normalise: toAscii converts as domainToASCII does, and never hands the URL parser an ASCII delimiter", () => {
  for (const text of ["bücher.example", "x.公司.cn", "a.個人.香港", "ＡＢＣ.com", "ü..com"]) assert.equal(toAscii(text), domainToASCII(text), text);
  // Each of these has a host the URL parser answers without an error.
  for (const text of ["ü@evil.example", "evil.example/ü", "ü.example:443", "ü.example?x", "ü.example#x", "ü\\evil.example", "ü.example\t", ""]) {
    assert.equal(toAscii(text), null, JSON.stringify(text));
  }
  for (const text of ["‍.com", "a／b.com", "ü.123"]) assert.equal(toAscii(text), null, JSON.stringify(text));
});

test("names normalise: lowercases ASCII, removes one trailing dot, and turns a leading *. into wild", () => {
  assert.deepEqual(normalise("api.example.com", psl), ok("api.example.com"));
  assert.deepEqual(normalise("API.Example.COM", psl), ok("api.example.com"));
  // Zonestream sends names with a trailing dot (design A section 3.1).
  assert.deepEqual(normalise("creatorwide.com.", psl), ok("creatorwide.com"));
  assert.deepEqual(normalise("*.example.com", psl), ok("example.com", true));
  assert.deepEqual(normalise("*.API.Example.COM.", psl), ok("api.example.com", true));
  // One trailing dot only, and one leading `*.` only.
  assert.deepEqual(normalise("example.com..", psl), no("label-empty"));
  assert.deepEqual(normalise("*.*.example.com", psl), no("charset"));
  assert.deepEqual(normalise("www.*.example.com", psl), no("charset"));
  assert.deepEqual(normalise("_dmarc.example.com", psl), ok("_dmarc.example.com"));
  assert.deepEqual(normalise("-x_.example.com", psl), ok("-x_.example.com"));
  // A star is wild only as a whole first label: `*abc.` and `**.` are not.
  assert.deepEqual(normalise("*abc.example.com", psl), no("charset"));
  assert.deepEqual(normalise("**.example.com", psl), no("charset"));
  // Every upper-case letter lowers, Z included.
  assert.deepEqual(normalise("a.Z.com", psl), ok("a.z.com"));
  // `_` beside an IDN label: the ASCII label keeps it, the other converts.
  assert.deepEqual(normalise("_dmarc.bücher.example", psl), ok("_dmarc.xn--bcher-kva.example"));
});

test("names normalise: an IDN label becomes its xn-- form, as node:url domainToASCII gives it", () => {
  assert.deepEqual(normalise("bücher.example", psl), ok("xn--bcher-kva.example"));
  assert.deepEqual(normalise("MÜNCHEN.de", psl), ok("xn--mnchen-3ya.de"));
  assert.deepEqual(normalise("*.ü.com.", psl), ok("xn--tda.com", true));
  assert.deepEqual(normalise("x.公司.cn", psl), ok("x.xn--55qx5d.cn"));
  assert.deepEqual(normalise("a.個人.香港", psl), ok("a.xn--gmqw5a.xn--j6w193g"));
  // UTS #46 maps full-width letters and the ideographic full stop.
  assert.deepEqual(normalise("ＡＢＣ.com", psl), ok("abc.com"));
  assert.deepEqual(normalise("ex。example", psl), ok("ex.example"));
  // A label already in its xn-- form takes the ASCII path unchanged.
  assert.deepEqual(normalise("xn--tda.com", psl), ok("xn--tda.com"));
});

// Synthetic, not recorded: lines in the shape of cenk's NRD lists (design B
// section 13), Unicode names one per line beside ASCII ones.
const CENK_STYLE = ["bücher-shop.de", "straße.de", "café.fr", "пример.рф", "例え.jp", "مثال.com", "ελληνικά.gr", "plain-ascii.com", "ÖL.at", "日本語.中国"];

test("names normalise: a synthetic cenk-style list of Unicode names gives what domainToASCII gives, line by line", () => {
  for (const line of CENK_STYLE) {
    const want = domainToASCII(line);
    assert.notEqual(want, "", line);
    assert.deepEqual(normalise(line, psl), ok(want), line);
  }
});

test("names normalise: a label of 63 passes and 64 is refused; a name of 253 passes and 254 is refused", () => {
  const l63 = "a".repeat(63);
  assert.deepEqual(normalise(`${l63}.com`, psl), ok(`${l63}.com`));
  assert.deepEqual(normalise(`${"a".repeat(64)}.com`, psl), no("label-long"));
  const n253 = `${l63}.${l63}.${l63}.${"b".repeat(57)}.com`;
  assert.equal(n253.length, 253);
  assert.deepEqual(normalise(n253, psl), ok(n253));
  // The trailing dot is not counted: 253 characters and a dot pass.
  assert.deepEqual(normalise(`${n253}.`, psl), ok(n253));
  const n254 = `${l63}.${l63}.${l63}.${"b".repeat(58)}.com`;
  assert.equal(n254.length, 254);
  assert.deepEqual(normalise(n254, psl), no("name-long"));
  // After the conversion: `ü` 57 times is a 63-character xn-- label, 58 times
  // a 64-character one. The limit applies to the ASCII form.
  assert.equal(domainToASCII(`${"ü".repeat(57)}.com`).split(".")[0]!.length, 63);
  assert.equal(domainToASCII(`${"ü".repeat(58)}.com`).split(".")[0]!.length, 64);
  assert.ok("name" in normalise(`${"ü".repeat(57)}.com`, psl));
  assert.deepEqual(normalise(`${"ü".repeat(58)}.com`, psl), no("label-long"));
});

test("names normalise: empty text, an empty label and a name with no dot are refused", () => {
  assert.deepEqual(normalise("", psl), no("empty"));
  assert.deepEqual(normalise(".", psl), no("empty"));
  assert.deepEqual(normalise("*.", psl), no("charset"));
  assert.deepEqual(normalise("a..com", psl), no("label-empty"));
  assert.deepEqual(normalise(".a.com", psl), no("label-empty"));
  assert.deepEqual(normalise("localhost", psl), no("no-dot"));
  assert.deepEqual(normalise("*.com", psl), no("no-dot"));
  assert.deepEqual(normalise("ü..com", psl), no("label-empty"));
});

test("names normalise: a character outside the charset is refused, and an ASCII one never reaches the URL parser", () => {
  for (const bad of ["a b.com", "a.com\r", "a/b.com", "a@b.com", "a:80.com", "a%41.com", "a\\b.com", "a\tb.com", "a.com\n"]) {
    assert.deepEqual(normalise(bad, psl), no("charset"), JSON.stringify(bad));
  }
  // The URL parser would answer the host after `@`, or before `/`, without an
  // error; a high character beside them must not send the text there.
  assert.equal(new URL("http://ü@evil.example").hostname, "evil.example");
  assert.deepEqual(normalise("ü@evil.example", psl), no("charset"));
  assert.deepEqual(normalise("evil.example/ü", psl), no("charset"));
  assert.deepEqual(normalise("ü.example:443", psl), no("charset"));
  // Their full-width forms map to the same characters inside the host, where
  // the parser refuses them.
  for (const bad of ["a／b.com", "a＠b.com", "a：b.com", "a　b.com", "‍.com", "\ud800.com", "xn--ü.com"]) {
    assert.deepEqual(normalise(bad, psl), no("idn"), JSON.stringify(bad));
  }
});

test("names normalise: a name that is itself an ICANN public suffix is refused; github.io, a private suffix, passes", () => {
  for (const suffix of ["co.uk", "com.np", "foo.kawasaki.jp", "foo.ck", "*.co.uk", "CO.UK.", "xn--55qx5d.cn", "公司.cn"]) {
    assert.deepEqual(normalise(suffix, psl), no("public-suffix"), suffix);
  }
  assert.deepEqual(normalise("np.com", psl), ok("np.com"));
  assert.deepEqual(normalise("city.kawasaki.jp", psl), ok("city.kawasaki.jp"));
  assert.deepEqual(normalise("www.ck", psl), ok("www.ck"));
  assert.deepEqual(normalise("github.io", psl), ok("github.io"));
  assert.deepEqual(normalise("x.github.io", psl), ok("x.github.io"));
  assert.deepEqual(normalise("example.unknowntld", psl), ok("example.unknowntld"));
});

test("names normalise: an address literal, a name whose top-level label is all digits, is refused as numeric-tld", () => {
  for (const literal of ["192.0.2.1", "*.198.51.100.7", "10.0.0.1.", "1.2.3.4.5", "host.123", "a.0", "１.２.３.４"]) {
    assert.deepEqual(normalise(literal, psl), no("numeric-tld"), literal);
  }
  // Digits elsewhere, or beside a letter in the last label, pass.
  for (const name of ["1.com", "123.example.com", "a.b0", "a.0x1", "192.0.2.1.example.com", "a.xn--p1ai"]) {
    assert.deepEqual(normalise(name, psl), ok(name), name);
  }
});

test("names normalise: every refusal it names is reachable, and none is left out", () => {
  const seen = new Set<string>();
  for (const input of ["", "a b.com", "x.ü/", "\ud800.com", "a..com", `${"a".repeat(64)}.com`, `${"a.".repeat(127)}com`, "localhost", "192.0.2.1", "co.uk"]) {
    const r = normalise(input, psl);
    assert.ok("refused" in r, JSON.stringify(input));
    seen.add(r.refused);
  }
  assert.deepEqual([...seen].sort(), [...REFUSALS].sort());
});
