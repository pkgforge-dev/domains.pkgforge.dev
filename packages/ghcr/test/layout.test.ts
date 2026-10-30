// packages/ghcr/src/layout.ts: each builder gives the shape of
// docs/architecture.md section 4.1 and TODO/ingest.md DOM-024 in lowercase, and
// refuses each input that would give another shape or a tag GHCR reads as
// another (a misaligned span, a time off the second, an upper-case or
// overlong tag, a value that is not a string, a package that is not one of
// the eight). A rebuild of a tier pack's span takes -rN, N from 2 to 2^53 - 1,
// on its tier tag alone (ruling 25, section 4.7 rule 2): parseTierTag reads it
// back, nextTierTag names the next free one, and checkTag refuses the suffix
// on every other tag. The source-id grammar is held equal to
// packages/adapter's, its one other copy. A segment tag takes the variant of
// its dataset (-d for domains), and a moving tag of `state` moves to a run tag
// of its own (DOM-024); the constant STATE is gone, since the moving tag of
// `state` is `latest`. All inputs are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_GRAMMAR, MAX_ID } from "@domains/adapter";
import * as ghcr from "../src/index.ts";
import * as layout from "../src/layout.ts";
import {
  ANNOTATION_MAX_CHARS,
  annotationProblem,
  artifactType,
  checkPackage,
  checkTag,
  fileTag,
  LayoutError,
  LATEST,
  LEDGER_DELTA_TAG,
  ledgerDeltaRunTag,
  ledgerFilterTag,
  MAX_SOURCE_ID,
  NAMESPACE,
  nextTierTag,
  PACKAGES,
  packageOfDataset,
  parseTierTag,
  RAW_PREFIX,
  rawTag,
  refTag,
  repoOf,
  rootTag,
  SOURCE_ID,
  segmentTagProblem,
  segTag,
  stateRunTag,
  stateTag,
  TAG,
  tierTag,
} from "../src/layout.ts";

const SHA = "0232f4df0831911356e8ee1f4d5c3b6b12c0ed3f6bd66b0f81c8ab5d3d49e9ca";
const refuses = (fn: () => unknown, re: RegExp) => assert.throws(fn, (e: unknown) => e instanceof LayoutError && re.test(e.message));

test("layout: the namespace is the repository's own name and the eight packages are section 4.1's", () => {
  assert.equal(NAMESPACE, "pkgforge-dev/domains.pkgforge.dev");
  assert.deepEqual([...PACKAGES], ["root", "obs", "names", "feed", "rev", "dumps", "state", "ref"]);
  assert.equal(repoOf("ref"), "pkgforge-dev/domains.pkgforge.dev/ref");
  // A reader may name the measurement package; a writer may not.
  assert.equal(repoOf("probe"), "pkgforge-dev/domains.pkgforge.dev/probe");
  refuses(() => checkPackage("probe"), /not one of the packages/);
  refuses(() => checkPackage("refs"), /not one of the packages/);
  assert.equal(checkPackage("state"), "state");
  refuses(() => repoOf("Ref"), /not a package name/);
  refuses(() => repoOf("ref/x"), /not a package name/);
  refuses(() => repoOf(""), /not a package name/);
});

test("layout: segment and raw-lane tags carry the window as lowercase YYYYMMDDTHHMMSSZ", () => {
  assert.equal(segTag("oi-cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z"), "oi-cs.20261026t080000z.20261026t081000z");
  assert.equal(rawTag("oi-cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z"), "raw-oi-cs.20261026t080000z.20261026t081000z");
  assert.equal(segTag("ct-le", new Date(Date.UTC(2026, 9, 26, 23, 50, 0)), new Date(Date.UTC(2026, 9, 27, 0, 0, 0))), "ct-le.20261026t235000z.20261027t000000z");
  refuses(() => segTag("oi-cs", "2026-10-26T08:10:00Z", "2026-10-26T08:00:00Z"), /not before its end/);
  refuses(() => segTag("oi-cs", "2026-10-26T08:00:00Z", "2026-10-26T08:00:00Z"), /not before its end/);
  refuses(() => segTag("oi-cs", "2026-10-26T08:00:00.500Z", "2026-10-26T08:10:00Z"), /not a time/);
  refuses(() => segTag("oi-cs", new Date(Date.UTC(2026, 9, 26, 8, 0, 0, 500)), "2026-10-26T08:10:00Z"), /not on a whole second/);
  refuses(() => segTag("oi-cs", "2026-02-30T00:00:00Z", "2026-03-03T00:00:00Z"), /not a calendar time/);
  refuses(() => segTag("oi-cs", "2026-10-26 08:00:00", "2026-10-26T08:10:00Z"), /not a time/);
  refuses(() => segTag("OI-cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z"), /not a source id/);
  refuses(() => segTag("oi--cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z"), /not a source id/);
  refuses(() => segTag("oi.cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z"), /not a source id/);
});

test("layout: a segment tag takes its dataset's variant, -d for domains, as a file tag does, and refuses one off the grammar or read as a rebuild", () => {
  const [start, end] = ["2026-10-30T08:00:00Z", "2026-10-30T08:10:00Z"];
  assert.equal(segTag("oi-cs", start, end, "d"), "oi-cs.20261030t080000z.20261030t081000z-d");
  // No variant is the names segment's tag, the tag of every segment before DOM-024.
  assert.equal(segTag("oi-cs", start, end), "oi-cs.20261030t080000z.20261030t081000z");
  assert.equal(segTag("oi-cs", start, end, undefined), segTag("oi-cs", start, end));
  assert.equal(segTag("oi-cs", start, end, "abcdefg8"), "oi-cs.20261030t080000z.20261030t081000z-abcdefg8");
  for (const bad of ["D", "", "abcdefghi", "d-x", "d.x", 1 as unknown as string, null as unknown as string]) {
    refuses(() => segTag("oi-cs", start, end, bad), /^the variant .* is not 1 to 8 lowercase letters or digits$/);
  }
  refuses(() => segTag("oi-cs", start, end, "r2"), /carries the rebuild suffix -r2, which only a tier tag takes/);
  // The window is still checked.
  refuses(() => segTag("oi-cs", end, start, "d"), /not before its end/);
  // The longest source id with the variant stays inside GHCR's 128 characters.
  const id = `a${"-b".repeat(31)}`;
  assert.equal(segTag(id, start, end, "d").length, 63 + 36);
});

test("layout: a moving tag of state moves to a run tag of its own time, state-<stamp> and ledger-delta-<stamp>, which no tier tag reads", () => {
  assert.equal(stateRunTag("2026-10-30T08:30:12Z"), "state-20261030t083012z");
  assert.equal(stateRunTag(new Date(Date.UTC(2026, 9, 30, 8, 30, 12))), "state-20261030t083012z");
  assert.equal(ledgerDeltaRunTag("2026-10-30T09:00:41Z"), "ledger-delta-20261030t090041z");
  assert.equal(ledgerDeltaRunTag(new Date(Date.UTC(2026, 11, 31, 23, 59, 59))), "ledger-delta-20261231t235959z");
  // A run tag is never the daily snapshot's tag, nor the moving tag's.
  assert.notEqual(stateRunTag("2026-10-30T00:00:00Z"), stateTag("2026-10-30"));
  assert.notEqual(ledgerDeltaRunTag("2026-10-30T00:00:00Z"), LEDGER_DELTA_TAG);
  // Off a whole second, as rootTag refuses it; and not a time at all.
  refuses(() => stateRunTag(new Date(Date.UTC(2026, 9, 30, 8, 30, 12, 500))), /^the state time 2026-10-30T08:30:12\.500Z is not on a whole second/);
  refuses(() => ledgerDeltaRunTag(new Date(Date.UTC(2026, 9, 30, 9, 0, 41, 1))), /^the delta time 2026-10-30T09:00:41\.001Z is not on a whole second/);
  refuses(() => stateRunTag("2026-10-30T08:30:12.500Z"), /^the state time .* is not a time/);
  refuses(() => ledgerDeltaRunTag("2026-10-30"), /^the delta time "2026-10-30" is not a time/);
  refuses(() => stateRunTag("2026-02-30T00:00:00Z"), /not a calendar time/);
  refuses(() => stateRunTag(new Date(Number.NaN)), /^the state time is an invalid Date$/);
  // Neither reads as a tier tag, so neither reads as a rebuild (ruling 25).
  refuses(() => parseTierTag(stateRunTag("2026-10-30T08:30:12Z")), /is not a tier tag/);
  refuses(() => parseTierTag(ledgerDeltaRunTag("2026-10-30T09:00:41Z")), /is not a tier tag/);
  assert.equal(checkTag(stateRunTag("2026-10-30T08:30:12Z")), "state-20261030t083012z");
  // Both are exported from the package, beside the tags they move.
  assert.equal(ghcr.stateRunTag, stateRunTag);
  assert.equal(ghcr.ledgerDeltaRunTag, ledgerDeltaRunTag);
});

test("layout: the moving tag of state is latest, as root's is: STATE is exported from neither the layout nor the package", () => {
  assert.equal(LATEST, "latest");
  assert.ok(!Object.hasOwn(layout, "STATE"), "layout.ts exports STATE");
  assert.ok(!Object.hasOwn(ghcr, "STATE"), "@domains/ghcr exports STATE");
});

test("layout: the longest source id gives a raw-lane tag inside GHCR's 128 characters, and the id grammar is the adapter's", () => {
  assert.equal(String(SOURCE_ID), String(ID_GRAMMAR));
  assert.equal(MAX_SOURCE_ID, MAX_ID);
  const id = `a${"-b".repeat(31)}`;
  assert.equal(id.length, 63);
  const t = rawTag(id, "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z");
  assert.equal(t.length, 63 + 38);
  assert.ok(TAG.test(t));
  refuses(() => rawTag(`${id}x`, "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z"), /not a source id/);
});

test("layout: no source id starts raw-, so a segment of one source never takes the raw lane tag of another", () => {
  const [start, end] = ["2026-10-30T08:00:00Z", "2026-10-30T08:10:00Z"];
  assert.equal(RAW_PREFIX, "raw-");
  assert.equal(rawTag("oi-cs", start, end), "raw-oi-cs.20261030t080000z.20261030t081000z");
  for (const build of [() => segTag("raw-oi-cs", start, end), () => segTag("raw-oi-cs", start, end, "d"), () => rawTag("raw-oi-cs", start, end), () => fileTag("raw-oi-cs", "2026-10-30", SHA)]) {
    refuses(build, /^"raw-oi-cs" is not a source id: raw- begins the raw lane's tags/);
  }
  // A source whose id holds raw elsewhere is a source.
  assert.equal(segTag("oi-raw", start, end), "oi-raw.20261030t080000z.20261030t081000z");
  assert.equal(segTag("rawx-cs", start, end), "rawx-cs.20261030t080000z.20261030t081000z");
});

test("layout: annotationProblem is the push tool's one rule of a value: a string of 1 to 1024 characters with no control character", () => {
  assert.equal(ANNOTATION_MAX_CHARS, 1024);
  assert.equal(annotationProblem("x".repeat(1024)), null);
  assert.equal(annotationProblem('{"offset":7}'), null);
  assert.equal(annotationProblem("é"), null);
  assert.equal(annotationProblem("x".repeat(1025)), "is 1025 characters, over 1024");
  assert.equal(annotationProblem(""), "is empty");
  for (const bad of ["a\u007fb", "a\tb", "a\nb", "\u0000", "a\u001f"]) assert.equal(annotationProblem(bad), "holds a control character", JSON.stringify(bad));
  assert.equal(annotationProblem(7), "is number, not a string");
  assert.equal(annotationProblem(null), "is null, not a string");
  assert.equal(annotationProblem(undefined), "is undefined, not a string");
});

test("layout: segmentTagProblem holds a segment's tag to its source, window and dataset, for a window and for a file", () => {
  const [start, end] = ["2026-10-30T08:00:00Z", "2026-10-30T08:10:00Z"];
  const names = "oi-cs.20261030t080000z.20261030t081000z";
  assert.equal(segmentTagProblem(names, "names", start, end), null);
  assert.equal(segmentTagProblem(names, "names", start, end, "oi-cs"), null);
  assert.equal(segmentTagProblem(`${names}-d`, "domains", start, end, "oi-cs"), null);
  const file = fileTag("isc-new", "2026-10-29", SHA);
  assert.equal(segmentTagProblem(file, "names", "2026-10-29T00:00:00Z", "2026-10-30T00:00:00Z", "isc-new"), null);
  assert.equal(segmentTagProblem(`${file}-d`, "domains", "2026-10-29T00:00:00Z", "2026-10-30T00:00:00Z"), null);
  const cases: [string, string, string, string, string | undefined, RegExp][] = [
    [names, "domains", start, end, "oi-cs", /which is oi-cs\.20261030t080000z\.20261030t081000z-d$/],
    [`${names}-d`, "names", start, end, "oi-cs", /is not the tag of a names segment/],
    [names, "names", start, "2026-10-30T08:20:00Z", "oi-cs", /which is oi-cs\.20261030t080000z\.20261030t082000z$/],
    [names, "names", start, end, "other-src", /which is other-src\.20261030t080000z\.20261030t081000z$/],
    ["x", "names", start, end, "oi-cs", /^x is not the tag of a names segment of oi-cs/],
    ["X", "names", start, end, undefined, /^X is not <source>\.<start>\.<end>/],
    [names, "feed", start, end, "oi-cs", /a segment holds names or domains, not "feed"/],
    [file, "names", "2026-10-28T00:00:00Z", "2026-10-29T00:00:00Z", "isc-new", /which is isc-new\.20261028\.0232f4df0831$/],
    [names, "names", "2026-10-30T08:00:00.5Z", end, "oi-cs", /has no tag: the window start/],
    ["raw-oi-cs.20261030t080000z.20261030t081000z", "names", start, end, undefined, /has no tag: "raw-oi-cs" is not a source id/],
  ];
  for (const [tag, dataset, s, e, source, re] of cases) assert.match(segmentTagProblem(tag, dataset, s, e, source) ?? "null", re, `${tag} ${dataset}`);
});

test("layout: a run tag of state and of ledger-delta takes a year from 1000 to 9999 alone", () => {
  for (const at of [new Date(Date.UTC(12000, 0, 1)), "0999-12-31T23:59:59Z", new Date(Date.UTC(999, 0, 1))]) {
    refuses(() => stateRunTag(at), /outside the years 1000 to 9999/);
    refuses(() => ledgerDeltaRunTag(at), /outside the years 1000 to 9999/);
  }
  assert.equal(stateRunTag("1000-01-01T00:00:00Z"), "state-10000101t000000z");
  assert.equal(stateRunTag("9999-12-31T23:59:59Z"), "state-99991231t235959z");
});

test("layout: a file tag is source, day and the first 12 hex of the file's sha256, with an optional variant", () => {
  assert.equal(fileTag("thc-ct", "2026-10-26", SHA), "thc-ct.20261026.0232f4df0831");
  assert.equal(fileTag("thc-ct", `2026-10-26T00:00:00Z`, `sha256:${SHA}`), "thc-ct.20261026.0232f4df0831");
  assert.equal(fileTag("isc-new", new Date(Date.UTC(2026, 9, 26)), SHA.slice(0, 12)), "isc-new.20261026.0232f4df0831");
  assert.equal(fileTag("thc-ct", "2026-10-26", SHA, "d"), "thc-ct.20261026.0232f4df0831-d");
  refuses(() => fileTag("thc-ct", "2026-10-26T08:00:00Z", SHA), /not 00:00:00Z of a day/);
  refuses(() => fileTag("thc-ct", "2026-10-26", SHA.toUpperCase()), /not a sha256/);
  refuses(() => fileTag("thc-ct", "2026-10-26", SHA.slice(0, 20)), /not a sha256/);
  refuses(() => fileTag("thc-ct", "2026-10-26", SHA, "D"), /variant/);
  refuses(() => fileTag("thc-ct", "2026-10-26", SHA, ""), /variant/);
});

test("layout: tier tags name their span by the tier, and a span that does not start on its boundary is refused", () => {
  assert.equal(tierTag("feed", "h", "2026-10-26T08:00:00Z"), "feed-h-2026102608");
  assert.equal(tierTag("names", "d", "2026-10-26T00:00:00Z"), "names-d-20261026");
  assert.equal(tierTag("feed", "d", "2026-10-26T00:00:00Z"), "feed-d-20261026");
  // 2026-10-26 is a Monday in ISO week 44; 2024-12-30 is the Monday of 2025's week 1; 2027-01-04 of 2027's.
  assert.equal(tierTag("names", "w", "2026-10-26T00:00:00Z"), "names-w-2026w44");
  assert.equal(tierTag("names", "w", "2024-12-30T00:00:00Z"), "names-w-2025w01");
  assert.equal(tierTag("names", "w", "2027-01-04T00:00:00Z"), "names-w-2027w01");
  assert.equal(tierTag("names", "w", "2026-12-28T00:00:00Z"), "names-w-2026w53");
  assert.equal(tierTag("rev", "m", "2026-09-01T00:00:00Z"), "rev-m-202609");
  assert.equal(tierTag("names", "y", "2026-01-01T00:00:00Z"), "names-y-2026");
  assert.equal(tierTag("new-name", "d", "2026-10-26T00:00:00Z"), "new-name-d-20261026");
  refuses(() => tierTag("names", "h", "2026-10-26T08:30:00Z"), /start of an hour/);
  refuses(() => tierTag("names", "d", "2026-10-26T08:00:00Z"), /start of a day/);
  refuses(() => tierTag("names", "w", "2026-10-27T00:00:00Z"), /Monday/);
  refuses(() => tierTag("names", "m", "2026-09-02T00:00:00Z"), /start of a month/);
  refuses(() => tierTag("names", "y", "2026-02-01T00:00:00Z"), /start of a year/);
  refuses(() => tierTag("names", "seg" as "d", "2026-10-26T00:00:00Z"), /not a tier/);
  refuses(() => tierTag("dumps" as "names", "d", "2026-10-26T00:00:00Z"), /not a dataset with tiers/);
  assert.equal(packageOfDataset("domains"), "names");
  assert.equal(packageOfDataset("new-name"), "feed");
  assert.equal(packageOfDataset("rev"), "rev");
});

test("layout: a rebuild of a tier pack's span takes its tag with -rN, N from 2, and the first build carries none", () => {
  const day = "2026-10-26T00:00:00Z";
  assert.equal(tierTag("names", "d", day), "names-d-20261026");
  // 1 is the first build: the same tag as none, so parseTierTag's rebuild gives the tag back.
  assert.equal(tierTag("names", "d", day, 1), "names-d-20261026");
  assert.equal(tierTag("names", "d", day, 2), "names-d-20261026-r2");
  assert.equal(tierTag("names", "d", day, 3), "names-d-20261026-r3");
  assert.equal(tierTag("names", "d", day, 10), "names-d-20261026-r10");
  assert.equal(tierTag("feed", "h", "2026-10-26T08:00:00Z", 2), "feed-h-2026102608-r2");
  assert.equal(tierTag("new-name", "d", day, 2), "new-name-d-20261026-r2");
  assert.equal(tierTag("names", "w", day, 2), "names-w-2026w44-r2");
  assert.equal(tierTag("rev", "m", "2026-09-01T00:00:00Z", 4), "rev-m-202609-r4");
  assert.equal(tierTag("domains", "y", "2026-01-01T00:00:00Z", 2), "domains-y-2026-r2");
  const notRebuild = /the rebuild .* is not a whole number from 2: the first build of a span carries no suffix/;
  for (const bad of [0, -2, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, "2" as unknown as number, null as unknown as number]) {
    refuses(() => tierTag("names", "d", day, bad), notRebuild);
  }
  // The span is still checked first.
  refuses(() => tierTag("names", "d", "2026-10-26T08:00:00Z", 2), /start of a day/);
});

test("layout: parseTierTag reads a tier tag back to its span's tag, dataset, tier, start and build", () => {
  assert.deepEqual(parseTierTag("names-d-20261026"), { base: "names-d-20261026", dataset: "names", tier: "d", start: "2026-10-26T00:00:00Z", rebuild: 1 });
  assert.deepEqual(parseTierTag("names-d-20261026-r2"), { base: "names-d-20261026", dataset: "names", tier: "d", start: "2026-10-26T00:00:00Z", rebuild: 2 });
  assert.deepEqual(parseTierTag("new-name-h-2026102623-r12"), { base: "new-name-h-2026102623", dataset: "new-name", tier: "h", start: "2026-10-26T23:00:00Z", rebuild: 12 });
  // ISO weeks across a year end, and week 53 of a year that has one.
  assert.equal(parseTierTag("names-w-2025w01").start, "2024-12-30T00:00:00Z");
  assert.equal(parseTierTag("names-w-2026w53-r2").start, "2026-12-28T00:00:00Z");
  assert.equal(parseTierTag("names-w-2027w01").start, "2027-01-04T00:00:00Z");
  assert.equal(parseTierTag("rev-m-202609").start, "2026-09-01T00:00:00Z");
  assert.equal(parseTierTag("feed-y-2026-r3").start, "2026-01-01T00:00:00Z");
  // Every tag tierTag gives reads back to its arguments.
  for (const [dataset, tier, start] of [
    ["feed", "h", "2026-10-26T08:00:00Z"],
    ["names", "d", "2026-10-26T00:00:00Z"],
    ["domains", "w", "2026-10-26T00:00:00Z"],
    ["rev", "m", "2026-09-01T00:00:00Z"],
    ["new-name", "y", "2026-01-01T00:00:00Z"],
  ] as const) {
    for (const rebuild of [1, 2, 7]) {
      const p = parseTierTag(tierTag(dataset, tier, start, rebuild));
      assert.deepEqual([p.dataset, p.tier, p.start, p.rebuild], [dataset, tier, start, rebuild]);
      assert.equal(tierTag(p.dataset, p.tier, p.start, p.rebuild), tierTag(dataset, tier, start, rebuild));
    }
  }
});

test("layout: parseTierTag refuses a suffix other than -r2 and up, and a base that is not the tag of a span", () => {
  // The first build carries no suffix, and one rebuild has one spelling.
  // 10^17 - 1 rounds to 10^17, which prints as other digits. 2^53 reads back
  // to its own digits through Number and String, and is not a safe integer.
  for (const t of ["names-d-20261026-r1", "names-d-20261026-r0", "names-d-20261026-r02", "names-d-20261026-r00", "names-d-20261026-r99999999999999999", "names-d-20261026-r9007199254740992"]) {
    refuses(() => parseTierTag(t), /a rebuild of a span is -r2, -r3 and up, with no leading zero, and the first build carries no suffix/);
    refuses(() => checkTag(t), /a rebuild of a span is -r2, -r3 and up, with no leading zero, and the first build carries no suffix/);
  }
  // 2^53 - 1, the highest safe integer, is a build.
  assert.equal(parseTierTag("names-d-20261026-r9007199254740991").rebuild, Number.MAX_SAFE_INTEGER);
  // Not <dataset>-<tier>-<span>.
  refuses(() => parseTierTag("names-d-20261026-r2-r3"), /carries the rebuild suffix -r3, which only a tier tag takes.*names-d-20261026-r2 is not <dataset>-<tier>-<span>/);
  refuses(() => parseTierTag("latest"), /latest is not a tier tag/);
  refuses(() => parseTierTag("dumps-d-20261026-r2"), /carries the rebuild suffix -r2.*"dumps" is not a dataset with tiers/);
  refuses(() => parseTierTag("names-x-20261026"), /"x" is not a tier/);
  // The span in another tier's form.
  refuses(() => parseTierTag("names-d-2026102608"), /2026102608 is not the span of a pack of tier d/);
  refuses(() => parseTierTag("names-w-202644"), /202644 is not the span of a pack of tier w/);
  // Off the calendar: 30 February, hour 24, month 13, week 0, and week 53 of 2027, which has 52.
  refuses(() => parseTierTag("names-d-20260230"), /not a calendar time/);
  refuses(() => parseTierTag("feed-h-2026102624-r2"), /carries the rebuild suffix -r2.*not a calendar time/);
  refuses(() => parseTierTag("rev-m-202613"), /not a calendar time/);
  refuses(() => parseTierTag("names-w-2026w00"), /the span 2026w00 is not a span of tier w: its start 2025-12-22T00:00:00Z gives names-w-2025w52/);
  refuses(() => parseTierTag("names-w-2027w53"), /the span 2027w53 is not a span of tier w: its start 2028-01-03T00:00:00Z gives names-w-2028w01/);
  // Not a tag at all.
  refuses(() => parseTierTag("Names-d-20261026"), /is not a tag/);
  refuses(() => parseTierTag(20261026), /is not a tag/);
  // A list of one tag reads as that tag to a RegExp, which coerces it to a string.
  refuses(() => parseTierTag(["names-d-20261026-r2"]), /\["names-d-20261026-r2"\] is not a tag/);
});

test("layout: checkTag accepts the rebuild suffix on a tier tag alone; segment, raw-lane, file, root, state and ref tags keep their forms", () => {
  for (const t of ["names-d-20261026-r2", "feed-h-2026102608-r3", "names-w-2026w44-r2", "rev-m-202609-r10", "new-name-y-2026-r2", "names-d-20261026"]) assert.equal(checkTag(t), t);
  const onlyTier = /carries the rebuild suffix -r2, which only a tier tag takes/;
  for (const t of [
    `${segTag("oi-cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z")}-r2`,
    `${rawTag("oi-cs", "2026-10-26T08:00:00Z", "2026-10-26T08:10:00Z")}-r2`,
    `${fileTag("thc-ct", "2026-10-26", SHA)}-r2`,
    `${rootTag("2026-10-29T05:13:00Z")}-r2`,
    `${stateTag("2026-10-29")}-r2`,
    `${refTag("psl", SHA)}-r2`,
    "latest-r2",
    "state-r2",
  ]) {
    refuses(() => checkTag(t), onlyTier);
  }
  // A file variant that reads as a rebuild is refused; one that does not stays.
  refuses(() => fileTag("thc-ct", "2026-10-26", SHA, "r2"), onlyTier);
  assert.equal(fileTag("thc-ct", "2026-10-26", SHA, "r"), "thc-ct.20261026.0232f4df0831-r");
  assert.equal(fileTag("thc-ct", "2026-10-26", SHA, "r2x"), "thc-ct.20261026.0232f4df0831-r2x");
  // A tier tag's suffix is held to its own form here too.
  refuses(() => checkTag("names-d-20261026-r1"), /carries -r1: a rebuild of a span is -r2/);
  refuses(() => checkTag("names-d-20261026-r02"), /carries -r02: a rebuild of a span is -r2/);
  refuses(() => checkTag("names-d-20261399-r2"), /carries the rebuild suffix -r2.*not a calendar time/);
});

test("layout: nextTierTag names the span's tag when no build is listed, else -rN one above the highest build listed", () => {
  const day = "2026-10-26T00:00:00Z";
  const next = (existing: Iterable<string>) => nextTierTag("names", "d", day, existing);
  assert.equal(next([]), "names-d-20261026");
  assert.equal(next(["names-d-20261026"]), "names-d-20261026-r2");
  assert.equal(next(["names-d-20261026", "names-d-20261026-r2"]), "names-d-20261026-r3");
  // A gap is never filled: the builds of a span keep the order of their numbers.
  assert.equal(next(["names-d-20261026", "names-d-20261026-r3"]), "names-d-20261026-r4");
  assert.equal(next(["names-d-20261026-r2"]), "names-d-20261026-r3");
  assert.equal(next(new Set(["names-d-20261026-r10", "names-d-20261026-r9"])), "names-d-20261026-r11");
  // Tags of other spans, tiers and datasets, and of other forms, are not builds of the span.
  assert.equal(
    next(["names-d-20261027-r5", "names-h-2026102600-r4", "domains-d-20261026-r6", "feed-d-20261026-r7", "thc-ct.20261026.0232f4df0831", "latest", "names-d-20261026x", "names-d-202610260-r2"]),
    "names-d-20261026",
  );
  // A stray tag of the span's prefix that no build takes is passed over: no tag nextTierTag gives equals it.
  assert.equal(next(["names-d-20261026", "names-d-20261026-r1", "names-d-20261026-r02", "names-d-20261026-rx", "names-d-20261026-r2-r9"]), "names-d-20261026-r2");
  // GHCR resolves tags without regard to case: an upper-case build is a build.
  assert.equal(next(["NAMES-D-20261026", "Names-D-20261026-R2"]), "names-d-20261026-r3");
  // Other datasets and tiers.
  assert.equal(nextTierTag("feed", "h", "2026-10-26T08:00:00Z", ["feed-h-2026102608"]), "feed-h-2026102608-r2");
  assert.equal(nextTierTag("names", "w", day, ["names-w-2026w44", "names-w-2026w44-r2"]), "names-w-2026w44-r3");
  // The span is checked, and the list is a list of strings.
  refuses(() => nextTierTag("names", "d", "2026-10-26T08:00:00Z", []), /start of a day/);
  refuses(() => nextTierTag("names", "d", day, "names-d-20261026" as unknown as string[]), /the existing tags are not a list of tags/);
  refuses(() => nextTierTag("names", "d", day, null as unknown as string[]), /the existing tags are not a list of tags/);
  // An object that is not iterable: a LayoutError, not the TypeError of for-of.
  refuses(() => nextTierTag("names", "d", day, {} as unknown as string[]), /the existing tags are not a list of tags/);
  refuses(() => nextTierTag("names", "d", day, { [Symbol.iterator]: 1 } as unknown as string[]), /the existing tags are not a list of tags/);
  refuses(() => nextTierTag("names", "d", day, ["names-d-20261026", 7 as unknown as string]), /the existing tags hold a number, which is not a tag/);
});

test("layout: nextTierTag never names a build past 2^53 - 1, where a number stops being exact", () => {
  const day = "2026-10-26T00:00:00Z";
  // -r2^53 is no build of the span (parseTierTag refuses it), so it is passed over.
  assert.equal(nextTierTag("names", "d", day, ["names-d-20261026", "names-d-20261026-r9007199254740992"]), "names-d-20261026-r2");
  assert.equal(nextTierTag("names", "d", day, ["names-d-20261026-r9007199254740990"]), "names-d-20261026-r9007199254740991");
  // The highest build listed is 2^53 - 1: its next number, 2^53, is past the last exact one.
  refuses(
    () => nextTierTag("names", "d", day, ["names-d-20261026", "names-d-20261026-r9007199254740991"]),
    /^names-d-20261026-r9007199254740991 is the highest build a tag numbers: no later build of the span has a tag$/,
  );
});

test("layout: root, state and ref tags", () => {
  assert.equal(rootTag("2026-10-29T05:13:00Z"), "r-20261029t051300z");
  assert.equal(stateTag("2026-10-29"), "state-20261029");
  refuses(() => stateTag("2026-10-29T05:13:00Z"), /not 00:00:00Z of a day/);
  assert.equal(refTag("psl", SHA), "psl-0232f4df0831");
  assert.equal(refTag("ctlogs", `sha256:${SHA}`), "ctlogs-0232f4df0831");
  assert.equal(refTag("sources", SHA), "sources-0232f4df0831");
  refuses(() => refTag("pslx" as "psl", SHA), /not a ref kind/);
});

test("layout: the ledger's tags of state: ledger-filter-YYYYMMDD of a UTC day's start, and ledger-delta; an instant that is not a day's start is refused", () => {
  for (const day of ["2026-10-27", "2026-10-27T00:00:00Z", new Date("2026-10-27T00:00:00Z")]) assert.equal(ledgerFilterTag(day), "ledger-filter-20261027");
  assert.equal(ledgerFilterTag("2026-12-31"), "ledger-filter-20261231");
  refuses(() => ledgerFilterTag("2026-10-27T05:00:00Z"), /^the filter date 2026-10-27T05:00:00\.000Z is not 00:00:00Z of a day$/);
  refuses(() => ledgerFilterTag(new Date("2026-10-27T00:00:00.500Z")), /^the filter date 2026-10-27T00:00:00\.500Z is not on a whole second/);
  refuses(() => ledgerFilterTag("2026-02-30"), /^the filter date "2026-02-30T00:00:00Z" is not a calendar time$/);
  refuses(() => ledgerFilterTag(new Date(Number.NaN)), /^the filter date is an invalid Date$/);
  refuses(() => ledgerFilterTag("20261027"), /^the filter date "20261027" is not a time/);
  refuses(() => ledgerFilterTag(20261027 as unknown as string), /^the filter date 20261027 is not a time/);
  assert.equal(LEDGER_DELTA_TAG, "ledger-delta");
  assert.equal(checkTag(LEDGER_DELTA_TAG), "ledger-delta");
  // Neither reads as a rebuild of a tier pack (ruling 25).
  refuses(() => parseTierTag(ledgerFilterTag("2026-10-27")), /is not a tier tag/);
  refuses(() => parseTierTag(LEDGER_DELTA_TAG), /is not a tier tag/);
});

test("layout: checkTag takes lowercase tags of at most 128 characters and refuses the rest", () => {
  assert.equal(checkTag("a".repeat(128)), "a".repeat(128));
  assert.equal(checkTag("_x"), "_x");
  refuses(() => checkTag("a".repeat(129)), /not a tag/);
  refuses(() => checkTag("Latest"), /not a tag/);
  refuses(() => checkTag(".x"), /not a tag/);
  refuses(() => checkTag("-x"), /not a tag/);
  refuses(() => checkTag("a:b"), /not a tag/);
  refuses(() => checkTag(""), /not a tag/);
  // A value that is not a string, though a RegExp coerces each of these to a
  // string that matches TAG: "null", "undefined", "12", "true", "abc".
  for (const v of [null, undefined, 12, true, ["abc"]]) refuses(() => checkTag(v), /^(null|undefined|12|true|\["abc"\]) is not a tag/);
});

test("layout: artifact types follow application/vnd.pkgforge.domains.<kind>.v1, and an unknown kind is refused", () => {
  assert.equal(artifactType("pack"), "application/vnd.pkgforge.domains.pack.v1");
  assert.equal(artifactType("ref"), "application/vnd.pkgforge.domains.ref.v1");
  refuses(() => artifactType("probe" as "ref"), /not an artifact kind/);
});
