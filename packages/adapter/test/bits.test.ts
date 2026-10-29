// config/source-bits.json, the append-only map from source id to bit. It fails
// when an id is removed, when a bit changes, or when two ids share a bit:
//   - INITIAL is the table of DOM-016's premise, and every pair of it stays;
//   - every committed version of the file in this checkout's git history is
//     held to the same rule, so an id appended later is held once committed;
//   - validateBits refuses a shared bit and an id listed out of bit order.
// ⚠ Never remove or change a line of INITIAL: it is the record the file is held to.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { readBits } from "../node/files.ts";
import { BITS_FORMAT } from "../src/types.ts";
import { bitsAppendOnly, SourceError, validateBits } from "../src/validate.ts";

const ROOT = join(import.meta.dirname, "..", "..", "..");
const BITS_FILE = "config/source-bits.json";

// TODO/foundation.md, DOM-016's premise: bit 18 (vps-ct) is reserved.
const INITIAL = validateBits({
  format: BITS_FORMAT,
  bits: {
    "thc-ct": 0,
    "oi-nrd": 1,
    "oi-nrd-fqdn": 2,
    "oi-nrd-confirmed": 3,
    "oi-cs": 4,
    "ct-le": 5,
    "ct-geomys": 6,
    "ct-ipng": 7,
    "isc-new": 8,
    whoisds: 9,
    "cenk-nrd": 10,
    "hagezi-nrd": 11,
    "oi-zone": 12,
    "sk-nic": 13,
    "oi-zonediff": 14,
    dotgov: 15,
    rdap: 16,
    "ct-godaddy": 17,
    "vps-ct": 18,
    "oi-measure": 19,
    crtsh: 20,
    "zone-walks": 21,
  },
});

test("adapter bits: config/source-bits.json is a valid map, no bit twice, listed in bit order", () => {
  const bits = readBits(ROOT);
  assert.ok(Object.keys(bits).length >= 22);
  assert.equal(new Set(Object.values(bits)).size, Object.keys(bits).length);
});

test("adapter bits: every id of DOM-016's table keeps its bit in config/source-bits.json", () => {
  assert.equal(Object.keys(INITIAL).length, 22);
  assert.deepEqual(bitsAppendOnly(INITIAL, readBits(ROOT)), []);
});

// Each committed version of the file, newest first; null when git cannot answer.
function committed(): { rev: string; text: string }[] | null {
  const git = (args: string[]) => execFileSync("git", ["-C", ROOT, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  try {
    const revs = git(["log", "--format=%H", "--diff-filter=AM", "--", BITS_FILE])
      .split("\n")
      .filter((l) => l !== "");
    return revs.map((rev) => ({ rev, text: git(["show", `${rev}:${BITS_FILE}`]) }));
  } catch {
    // No git, or not a work tree (a tarball): the test says so and skips.
    return null;
  }
}

test("adapter bits: every committed version of config/source-bits.json keeps its ids and bits in the file now", (t) => {
  const versions = committed();
  if (versions === null) return t.skip("git cannot read this checkout's history");
  if (versions.length === 0) return t.skip(`${BITS_FILE} has no commit yet`);
  const now = readBits(ROOT);
  for (const v of versions) assert.deepEqual(bitsAppendOnly(validateBits(JSON.parse(v.text)), now), [], v.rev);
});

test("adapter bits: a removed id, a changed bit and a shared bit each fail against the table", () => {
  const { "vps-ct": _, ...removed } = INITIAL;
  assert.deepEqual(
    bitsAppendOnly(INITIAL, removed).map((p) => [p.at, p.code]),
    [["config/source-bits.json: bits.vps-ct", "missing"]],
  );
  assert.deepEqual(
    bitsAppendOnly(INITIAL, { ...INITIAL, crtsh: 22 }).map((p) => [p.at, p.code]),
    [["config/source-bits.json: bits.crtsh", "bit-mismatch"]],
  );
  assert.throws(
    () => validateBits({ format: BITS_FORMAT, bits: { ...INITIAL, "new-feed": 21 } }),
    (e: unknown) => e instanceof SourceError && e.problems.some((p) => p.code === "bit-taken" && /belongs to zone-walks/.test(p.detail)),
  );
});
