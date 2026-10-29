// packages/ghcr/src/layout.ts: each builder gives the shape of
// docs/architecture.md section 4.1 and TODO/ingest.md DOM-024 in lowercase, and
// refuses each input that would give another shape or a tag GHCR reads as
// another (a misaligned span, a time off the second, an upper-case or
// overlong tag, a package that is not one of the eight). The source-id grammar
// is held equal to packages/adapter's, its one other copy. All inputs are
// synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { ID_GRAMMAR, MAX_ID } from "@domains/adapter";
import {
  artifactType,
  checkPackage,
  checkTag,
  fileTag,
  LayoutError,
  MAX_SOURCE_ID,
  NAMESPACE,
  PACKAGES,
  packageOfDataset,
  rawTag,
  refTag,
  repoOf,
  rootTag,
  SOURCE_ID,
  segTag,
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

test("layout: root, state and ref tags", () => {
  assert.equal(rootTag("2026-10-29T05:13:00Z"), "r-20261029t051300z");
  assert.equal(stateTag("2026-10-29"), "state-20261029");
  refuses(() => stateTag("2026-10-29T05:13:00Z"), /not 00:00:00Z of a day/);
  assert.equal(refTag("psl", SHA), "psl-0232f4df0831");
  assert.equal(refTag("ctlogs", `sha256:${SHA}`), "ctlogs-0232f4df0831");
  assert.equal(refTag("sources", SHA), "sources-0232f4df0831");
  refuses(() => refTag("pslx" as "psl", SHA), /not a ref kind/);
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
});

test("layout: artifact types follow application/vnd.pkgforge.domains.<kind>.v1, and an unknown kind is refused", () => {
  assert.equal(artifactType("pack"), "application/vnd.pkgforge.domains.pack.v1");
  assert.equal(artifactType("ref"), "application/vnd.pkgforge.domains.ref.v1");
  refuses(() => artifactType("probe" as "ref"), /not an artifact kind/);
});
