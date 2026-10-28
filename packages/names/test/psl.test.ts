// packages/names/src/psl.ts over the pinned list (fixtures/psl-2026-10-27.dat,
// the list DOM-009's THC day run read): each rule kind, both sections, the IDN
// rules converted to ASCII, the list's algorithm written as sets as an oracle,
// and the lists it refuses.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { domainToASCII } from "node:url";
import { isPublicSuffix, loadPsl, MARKERS, PslError, parseRule, split } from "../src/psl.ts";
import { NameError } from "../src/syntax.ts";

const BYTES = readFileSync(join(import.meta.dirname, "fixtures", "psl-2026-10-27.dat"));
const TEXT = BYTES.toString("utf8");
const psl = await loadPsl(BYTES);

// The hash docs/research/measure/DOM-009/local-2026-10-26.stat.json records for
// the list of that run (psl.sha256), and the counts beside it.
const DOM_009_SHA256 = "0232f4df0831911356e8ee1f4d5c3b6b12c0ed3f6bd66b0f81c8ab5d3d49e9ca";

test("names psl: the pinned list has 6,949 ICANN rules, 3,448 private rules, and the sha256 of its bytes", async () => {
  assert.deepEqual(psl.rules, { icann: 6949, private: 3448 });
  assert.equal(psl.sha256, createHash("sha256").update(BYTES).digest("hex"));
  assert.equal(psl.sha256, DOM_009_SHA256);
  // Text is hashed as its UTF-8 bytes, so the same list gives the same hash.
  assert.equal((await loadPsl(TEXT)).sha256, DOM_009_SHA256);
});

test("names psl: splits names by each rule kind, suffix and reg from the ICANN section, site from both", () => {
  const cases: [string, string, string | null, string | null][] = [
    // name, suffix, reg, site
    ["api.example.com.np", "com.np", "example.com.np", "example.com.np"],
    ["np.com", "com", "np.com", "np.com"],
    ["com.np", "com.np", null, null],
    ["www.example.com", "com", "example.com", "example.com"],
    ["co.uk", "co.uk", null, null],
    ["a.b.co.uk", "co.uk", "b.co.uk", "b.co.uk"],
    ["x.github.io", "io", "github.io", "x.github.io"],
    ["github.io", "io", "github.io", null],
    ["a.b.s3.amazonaws.com", "com", "amazonaws.com", "b.s3.amazonaws.com"],
    ["x.y.compute.amazonaws.com", "com", "amazonaws.com", "x.y.compute.amazonaws.com"],
    ["kawasaki.jp", "jp", "kawasaki.jp", "kawasaki.jp"],
    ["foo.kawasaki.jp", "foo.kawasaki.jp", null, null],
    ["a.foo.kawasaki.jp", "foo.kawasaki.jp", "a.foo.kawasaki.jp", "a.foo.kawasaki.jp"],
    ["city.kawasaki.jp", "kawasaki.jp", "city.kawasaki.jp", "city.kawasaki.jp"],
    ["www.city.kawasaki.jp", "kawasaki.jp", "city.kawasaki.jp", "city.kawasaki.jp"],
    ["www.ck", "ck", "www.ck", "www.ck"],
    ["foo.ck", "foo.ck", null, null],
    ["a.foo.ck", "foo.ck", "a.foo.ck", "a.foo.ck"],
    ["x.workers.dev", "dev", "workers.dev", "x.workers.dev"],
    ["example.unknowntld", "unknowntld", "example.unknowntld", "example.unknowntld"],
    ["unknowntld", "unknowntld", null, null],
  ];
  for (const [name, suffix, reg, site] of cases) {
    assert.deepEqual(split(name, psl), { suffix, reg, site, labels: name.split(".").length }, name);
  }
});

test("names psl: an IDN rule is converted, so a name under 公司.cn or 個人.香港 gets its full registrable domain", () => {
  // Both rules are in the list as Unicode.
  assert.ok(TEXT.includes("\n公司.cn\n") && TEXT.includes("\n個人.香港\n"));
  assert.deepEqual(parseRule("公司.cn"), { kind: "rule", labels: ["xn--55qx5d", "cn"] });
  assert.deepEqual(parseRule("個人.香港"), { kind: "rule", labels: ["xn--gmqw5a", "xn--j6w193g"] });
  // A multi-label rule under an ASCII parent: without the conversion only `cn`
  // matches and reg is `xn--55qx5d.cn`.
  assert.deepEqual(split("x.xn--55qx5d.cn", psl), { suffix: "xn--55qx5d.cn", reg: "x.xn--55qx5d.cn", site: "x.xn--55qx5d.cn", labels: 3 });
  // A rule whose parent is an IDN label too: without the conversion only the
  // implicit `*` matches and reg is `xn--gmqw5a.xn--j6w193g`.
  assert.deepEqual(split("a.xn--gmqw5a.xn--j6w193g", psl), { suffix: "xn--gmqw5a.xn--j6w193g", reg: "a.xn--gmqw5a.xn--j6w193g", site: "a.xn--gmqw5a.xn--j6w193g", labels: 3 });
  assert.equal(isPublicSuffix("xn--gmqw5a.xn--j6w193g", psl), true);
  // A single-label IDN rule splits the same with or without the conversion.
  assert.deepEqual(split("a.xn--j6w193g", psl), { suffix: "xn--j6w193g", reg: "a.xn--j6w193g", site: "a.xn--j6w193g", labels: 2 });
});

test("names psl: isPublicSuffix reads the ICANN section and the implicit rule", () => {
  for (const s of ["np", "com", "com.np", "co.uk", "foo.kawasaki.jp", "unknowntld"]) assert.equal(isPublicSuffix(s, psl), true, s);
  for (const s of ["np.com", "github.io", "example.co.uk", "city.kawasaki.jp", "www.ck"]) assert.equal(isPublicSuffix(s, psl), false, s);
});

// The list's algorithm written as sets of rule strings and a scan from the
// longest suffix (design A, docs/research/2026-10-27-design-a/scripts/psl.mjs),
// with the IDN rules converted by node:url, as the oracle of the trie.
function oracle(text: string, icannOnly: boolean): (name: string) => string | null {
  const rules = new Set<string>();
  const wild = new Set<string>();
  const exc = new Set<string>();
  let section = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("// ===BEGIN ICANN")) section = "icann";
    if (line.startsWith("// ===BEGIN PRIVATE")) section = "private";
    if (!line || line.startsWith("//")) continue;
    if (icannOnly && section !== "icann") continue;
    const ascii = (r: string) => domainToASCII(r);
    if (line.startsWith("!")) exc.add(ascii(line.slice(1)));
    else if (line.startsWith("*.")) wild.add(ascii(line.slice(2)));
    else rules.add(ascii(line));
  }
  return (name) => {
    const labels = name.split(".");
    const n = labels.length;
    let best = 1;
    let k: number | null = null;
    for (let i = 0; i < n; i++) {
      const s = labels.slice(i).join(".");
      if (exc.has(s)) {
        k = n - i - 1;
        break;
      }
      if (rules.has(s) && n - i > best) best = n - i;
      if (i + 1 < n && wild.has(labels.slice(i + 1).join(".")) && n - i > best) best = n - i;
    }
    if (k === null) k = best;
    return n > k ? labels.slice(-(k + 1)).join(".") : null;
  };
}

test("names psl: agrees with the list's algorithm written as sets on every name of up to four labels", () => {
  const labels = ["com", "co", "uk", "jp", "kawasaki", "city", "foo", "ck", "www", "io", "github", "s3", "amazonaws", "compute", "np", "xn--55qx5d", "cn", "zz"];
  const names: string[] = [];
  const grow = (prefix: string, depth: number) => {
    for (const l of labels) {
      const name = prefix === "" ? l : `${l}.${prefix}`;
      names.push(name);
      if (depth < 4) grow(name, depth + 1);
    }
  };
  grow("", 1);
  assert.ok(names.length > 100_000);
  const icann = oracle(TEXT, true);
  const all = oracle(TEXT, false);
  for (const name of names) {
    const got = split(name, psl);
    assert.equal(got.reg, icann(name), name);
    assert.equal(got.site, all(name), name);
  }
});

test("names psl: refuses a list without each marker once and in order, and a list cut short", async () => {
  for (const mark of MARKERS) {
    await assert.rejects(loadPsl(TEXT.replace(mark, "")), PslError, mark);
  }
  const cut = (at: string) => TEXT.slice(0, TEXT.indexOf(at));
  await assert.rejects(loadPsl(cut("// ===BEGIN PRIVATE DOMAINS===")), (e: Error) => e instanceof PslError && e.message === "missing marker // ===BEGIN PRIVATE DOMAINS===");
  await assert.rejects(loadPsl(cut("// ===END PRIVATE DOMAINS===")), (e: Error) => e instanceof PslError && e.message === "missing marker // ===END PRIVATE DOMAINS===");
  // The two sections swapped.
  const icann = TEXT.slice(TEXT.indexOf(MARKERS[0]), TEXT.indexOf(MARKERS[1]) + MARKERS[1].length);
  const priv = TEXT.slice(TEXT.indexOf(MARKERS[2]), TEXT.indexOf(MARKERS[3]) + MARKERS[3].length);
  await assert.rejects(loadPsl(`${priv}\n${icann}\n`), /marker out of order/);
  // A marker twice.
  await assert.rejects(loadPsl(`${TEXT}\n${MARKERS[3]}\n`), /marker out of order/);
});

test("names psl: refuses a rule outside a section, a rule it cannot read, a one-label exception, and bytes that are not UTF-8", async () => {
  const head = TEXT.indexOf(MARKERS[0]);
  await assert.rejects(loadPsl(`com\n${TEXT}`), /rule outside a section: "com"/);
  await assert.rejects(loadPsl(`${TEXT}\nexample\n`), /rule outside a section/);
  await assert.rejects(loadPsl(TEXT.replace("\ngithub.io\n", "\ngit*hub.io\n")), /rule cannot be read: "git\*hub.io"/);
  await assert.rejects(loadPsl(TEXT.replace("\ngithub.io\n", "\ngithub..io\n")), /rule cannot be read/);
  await assert.rejects(loadPsl(TEXT.replace("\ngithub.io\n", "\n!io\n")), /exception of one label/);
  // An IDN rule with an ASCII delimiter: the URL parser would read the host
  // after `@` as the rule, `evil.example`, without an error.
  assert.throws(() => parseRule("ü@evil.example"), /rule cannot be read: "ü@evil.example"/);
  await assert.rejects(loadPsl(TEXT.replace("\ngithub.io\n", "\nü@evil.example\n")), /rule cannot be read/);
  await assert.rejects(loadPsl(TEXT.replace("\ngithub.io\n", "\nü.example/x\n")), /rule cannot be read/);
  const bad = Buffer.concat([BYTES.subarray(0, head), Buffer.from([0xff, 0x0a]), BYTES.subarray(head)]);
  await assert.rejects(loadPsl(bad), /not UTF-8/);
});

test("names psl: a rule is read up to its first whitespace, and upper case in a rule is lowercased", async () => {
  const list = `${MARKERS[0]}\ncom\nFOO.com trailing words\n${MARKERS[1]}\n${MARKERS[2]}\nbar.com\twith a tab\n${MARKERS[3]}\n`;
  const small = await loadPsl(list);
  assert.deepEqual(small.rules, { icann: 2, private: 1 });
  assert.deepEqual(split("x.foo.com", small), { suffix: "foo.com", reg: "x.foo.com", site: "x.foo.com", labels: 3 });
  assert.deepEqual(split("x.bar.com", small), { suffix: "com", reg: "bar.com", site: "x.bar.com", labels: 3 });
});

test("names psl: one node holds a rule and a wildcard, or flags of both sections, and an exception counts in its own section", async () => {
  // Synthetic: a.com, *.a.com and !x.a.com in the ICANN section; the same
  // shapes under b.com in the private section; c.com an ICANN rule whose node
  // also holds the private *.c.com.
  const list = [MARKERS[0], "com", "a.com", "*.a.com", "!x.a.com", "c.com", MARKERS[1], MARKERS[2], "b.com", "*.b.com", "!x.b.com", "*.c.com", MARKERS[3], ""].join("\n");
  const small = await loadPsl(list);
  assert.deepEqual(small.rules, { icann: 5, private: 4 });
  // a.com keeps its rule beside the wildcard inserted after it.
  assert.equal(isPublicSuffix("a.com", small), true);
  assert.deepEqual(split("y.q.a.com", small), { suffix: "q.a.com", reg: "y.q.a.com", site: "y.q.a.com", labels: 4 });
  assert.deepEqual(split("z.x.a.com", small), { suffix: "a.com", reg: "x.a.com", site: "x.a.com", labels: 4 });
  // A private exception moves the site only; reg is the ICANN section's.
  assert.deepEqual(split("z.x.b.com", small), { suffix: "com", reg: "b.com", site: "x.b.com", labels: 4 });
  assert.deepEqual(split("y.q.b.com", small), { suffix: "com", reg: "b.com", site: "y.q.b.com", labels: 4 });
  // c.com's node holds the ICANN rule and the private wildcard.
  assert.deepEqual(split("y.q.c.com", small), { suffix: "c.com", reg: "q.c.com", site: "y.q.c.com", labels: 4 });
});

test("names psl: split and isPublicSuffix refuse a name that is not lowercase labels, instead of answering the implicit rule", () => {
  for (const [name, reason] of [
    ["Example.com", "upper"],
    ["ü.com", "high"],
    ["a..com", "label-empty"],
    ["a.com.", "label-empty"],
    ["a b.com", "charset"],
  ] as const) {
    assert.throws(
      () => split(name, psl),
      (e: Error) => e instanceof NameError && e.reason === reason,
      name,
    );
    assert.throws(() => isPublicSuffix(name, psl), NameError, name);
  }
});
