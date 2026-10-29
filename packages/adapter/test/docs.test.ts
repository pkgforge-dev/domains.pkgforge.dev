// docs/sources.md against config/source-bits.json and every adapters/*/source.json
// (docs/architecture.md section 5.6: the registry row and the row of
// docs/sources.md are held equal by a test). The parser (docs-table.ts) is then
// tested on synthetic tables, one fault each.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { readBits, readSourceFiles } from "../node/files.ts";
import { BASES, FAMILIES, KINDS, PRECISIONS, type Source } from "../src/types.ts";
import { buildRegistry } from "../src/validate.ts";
import { cells, compareWithDocs, DocsError, parseSourcesDoc } from "./docs-table.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const DOC = parseSourcesDoc(readFileSync(join(ROOT, "docs", "sources.md"), "utf8"));

// Rows of the bit table whose Bit cell is `none`. docs/sources.md says the
// table holds only sources with a bit, so a row listed here is one to move to
// "Inputs without a bit". None is left: dnscoffee-counts moved there.
const NO_BIT_ROWS_TO_MOVE: string[] = [];

test("adapter docs: the ids with a bit in docs/sources.md are the keys of config/source-bits.json, each at its bit", () => {
  const bits = readBits(ROOT);
  const doc = Object.fromEntries(DOC.rows.filter((r) => r.bit !== null).map((r) => [r.id, r.bit]));
  assert.deepEqual(Object.keys(doc).sort(), Object.keys(bits).sort());
  for (const [id, bit] of Object.entries(bits)) assert.equal(doc[id], bit, id);
});

test("adapter docs: the rows of the bit table without a bit are exactly the known rows to move", () => {
  assert.deepEqual(
    DOC.rows.filter((r) => r.bit === null).map((r) => r.id),
    NO_BIT_ROWS_TO_MOVE,
  );
});

test("adapter docs: every label of a row with a bit is a value the registry accepts", () => {
  for (const r of DOC.rows.filter((x) => x.bit !== null)) {
    const l = r.labels!;
    assert.ok((FAMILIES as readonly string[]).includes(l.family), `${r.id}: family ${l.family}`);
    assert.ok((KINDS as readonly string[]).includes(l.kind), `${r.id}: kind ${l.kind}`);
    assert.ok((PRECISIONS as readonly string[]).includes(l.precision), `${r.id}: precision ${l.precision}`);
    for (const b of l.basis) assert.ok((BASES as readonly string[]).includes(b), `${r.id}: basis ${b}`);
  }
});

test("adapter docs: every source of adapters/*/source.json has its row in docs/sources.md, with the same bit and labels", () => {
  const { files, problems } = readSourceFiles(ROOT);
  assert.deepEqual(problems, []);
  const registry = buildRegistry(files, readBits(ROOT));
  assert.deepEqual(compareWithDocs(registry.sources, DOC), []);
});

// Synthetic from here on.
const TABLE = [
  "Intro text.",
  "",
  "| Labels | Source | What | Bit |",
  "| --- | --- | --- | --- |",
  "| F `ct`, K `ct_name`, B `ct-first`, P day | `not-first-cell` | x | 9 |",
  "",
  "| Source | What | Bit | Labels |",
  "| :--- | --- | ---: | --- |",
  "| `feed-a` | a pipe \\| in text, and `a|b` in code | 3 | F `ct`, K `ct_name`, B `ct-first`, P day |",
  "| `feed-b` | x | 4 | F `registry+ct`, K `registered_claim`, B `nrd-ct+rdap` or `zone`, P second, `partial: true` |",
  "| `feed-c` | x | none | not a source of records |",
  "| `feed-e` | x | 6 | F `dns`, K `dns`, B none, P second |",
  "| feed-d | not backticked | 5 | x |",
  "",
  "| Input | What |",
  "| --- | --- |",
  "| plain-input | x |",
].join("\n");

test("adapter docs: the parser finds Bit and Labels by header, reads a pipe in code or escaped as text, and keeps plain rows apart", () => {
  const { rows, plain } = parseSourcesDoc(TABLE);
  assert.deepEqual(
    rows.map((r) => [r.id, r.bit, r.line]),
    [
      ["feed-a", 3, 9],
      ["feed-b", 4, 10],
      ["feed-c", null, 11],
      ["feed-e", 6, 12],
    ],
  );
  assert.deepEqual(rows[1]!.labels, { family: "registry+ct", kind: "registered_claim", basis: ["nrd-ct+rdap", "zone"], precision: "second", extra: ["`partial: true`"] });
  assert.equal(rows[2]!.labels, null);
  // `B none`: a source that writes no newness evidence.
  assert.deepEqual(rows[3]!.labels!.basis, []);
  // A row of a table with a Bit column is never a plain row, backticked or not.
  assert.deepEqual(plain, ["plain-input"]);
  assert.deepEqual(cells("| `a|b` | c \\| d |"), ["`a|b`", "c | d"]);
});

test("adapter docs: the parser refuses each table fault it cannot read for certain", () => {
  const head = "| Source | Bit | Labels |\n| --- | --- | --- |\n";
  const cases: [string, string, RegExp][] = [
    ["a backticked id with no Bit column", "| Source | What |\n| --- | --- |\n| `x` | y |\n", /no Bit column/],
    ["a short row", `${head}| \`x\` | 1 |\n`, /2 cells under a header of 3/],
    ["a Bit cell that is not a number", `${head}| \`x\` | one | F \`ct\`, K \`ct_name\`, B \`ct-first\`, P day |\n`, /not a number or none/],
    ["a Labels cell without P", `${head}| \`x\` | 1 | F \`ct\`, K \`ct_name\`, B \`ct-first\` |\n`, /each of F, K, B and P/],
    ["an id twice", `${head}| \`x\` | 1 | F \`ct\`, K \`ct_name\`, B \`ct-first\`, P day |\n| \`x\` | 2 | F \`ct\`, K \`ct_name\`, B \`ct-first\`, P day |\n`, /also on line 3/],
  ];
  for (const [what, md, why] of cases)
    assert.throws(
      () => parseSourcesDoc(md),
      (e: unknown) => e instanceof DocsError && why.test(e.message),
      what,
    );
});

test("adapter docs: a source with no row, or another bit or label than its row, is a disagreement", () => {
  const doc = parseSourcesDoc(TABLE);
  const source = (change: Partial<Source>): Source => ({ id: "feed-a", bit: 3, family: "ct", kind: "ct_name", basis: ["ct-first"], precision: "day", ...change }) as Source;
  assert.deepEqual(compareWithDocs([source({})], doc), []);
  assert.deepEqual(compareWithDocs([source({ id: "feed-z" })], doc), ["feed-z: no row in docs/sources.md"]);
  assert.deepEqual(compareWithDocs([source({ bit: 7 })], doc), ["feed-a: bit 7 in source.json, 3 in docs/sources.md"]);
  assert.deepEqual(compareWithDocs([source({ family: "isc" })], doc), ["feed-a: family isc in source.json, ct in docs/sources.md"]);
  assert.deepEqual(compareWithDocs([source({ kind: "list" })], doc), ["feed-a: kind list in source.json, ct_name in docs/sources.md"]);
  assert.deepEqual(compareWithDocs([source({ precision: "second" })], doc), ["feed-a: precision second in source.json, day in docs/sources.md"]);
  assert.deepEqual(compareWithDocs([source({ basis: ["zone"] })], doc), ["feed-a: basis zone in source.json, ct-first in docs/sources.md"]);
  // A source with no bit has its row in a table with no Bit column.
  assert.deepEqual(compareWithDocs([source({ id: "plain-input", bit: null })], doc), []);
  assert.deepEqual(compareWithDocs([source({ id: "unlisted", bit: null })], doc), ["unlisted: no row in docs/sources.md"]);
  assert.deepEqual(compareWithDocs([source({ bit: null })], doc), ["feed-a: no bit in source.json, bit 3 in docs/sources.md"]);
});
