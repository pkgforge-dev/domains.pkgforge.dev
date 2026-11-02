// packages/root/src/chain.ts: the entry a root names under a repository and
// a tag, and the pack of a higher tier that spans a segment and carries its
// source, which replacedOnChain of scripts/state/lib.mjs asks of each root on
// the chain (DOM-063). Every
// pack, digest and source here is synthetic (helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { repoOf } from "@domains/ghcr";
import { buildRoot, packNamed, packSpanning, type RootJson } from "../src/index.ts";
import { live, PSL_LIVE, pack } from "./helpers.ts";

const seg = (start: string, source = "oi-cs") => pack("names", "seg", start, { sources: [source] });
const d28 = pack("names", "d", "2026-10-28T00:00:00Z", { sources: ["oi-cs", "thc-ct"] });
const y = seg("2026-10-29T00:00:00Z");
const x = seg("2026-10-29T00:10:00Z");
const feedDay = pack("feed", "d", "2026-10-28T00:00:00Z", { sources: ["oi-cs"] });

// root_seq 1 names d28, y and x; root_seq 2 replaces y and x with the day pack d29.
function chain(): { one: RootJson; two: RootJson } {
  const one = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-30T06:00:00Z", add: [d28, y, x, feedDay] });
  const d29 = pack("names", "d", "2026-10-29T00:00:00Z", { sources: ["oi-cs"] });
  const two = buildRoot({ live: live(one), psl: PSL_LIVE, now: "2026-10-30T07:00:00Z", replace: [{ old: [y.pack.manifest, x.pack.manifest], new: d29 }] });
  return { one, two };
}

test("chain: packNamed finds an entry by its repository and tag in any dataset, and nothing under another repository", () => {
  const { one, two } = chain();
  assert.deepEqual(packNamed(one, repoOf("obs"), x.pack.tag), { dataset: "names", pack: x.pack });
  assert.equal(packNamed(two, repoOf("obs"), x.pack.tag), null, "the replaced segment is named no more");
  assert.equal(packNamed(one, repoOf("feed"), feedDay.pack.tag)?.dataset, "feed");
  // The same tag in another repository is another pack.
  assert.equal(packNamed(one, repoOf("names"), x.pack.tag), null);
  assert.equal(packNamed(one, repoOf("obs"), "constructor"), null);
});

test("chain: packSpanning finds the pack of a tier above seg that spans the span and carries the source, in the dataset asked", () => {
  const { one, two } = chain();
  const span = x.pack.span;
  assert.equal(packSpanning(two, "names", span, "oi-cs")?.tag, "names-d-20261029");
  // Before the replacement no compacted pack spans the segment; the segment itself is tier seg.
  assert.equal(packSpanning(one, "names", span, "oi-cs"), null);
  // A pack that does not carry the source, of another dataset, or of no dataset the root lists.
  assert.equal(packSpanning(two, "names", span, "thc-ct"), null);
  assert.equal(packSpanning(two, "domains", span, "oi-cs"), null);
  assert.equal(packSpanning(two, "constructor", span, "oi-cs"), null);
  // The edges of the day: its first and its last ten minutes, and nothing past its end.
  assert.equal(packSpanning(two, "names", { start: "2026-10-29T00:00:00Z", end: "2026-10-29T00:10:00Z" }, "oi-cs")?.tag, "names-d-20261029");
  assert.equal(packSpanning(two, "names", { start: "2026-10-29T23:50:00Z", end: "2026-10-30T00:00:00Z" }, "oi-cs")?.tag, "names-d-20261029");
  assert.equal(packSpanning(two, "names", { start: "2026-10-29T23:50:00Z", end: "2026-10-30T00:10:00Z" }, "oi-cs"), null);
  // A span across two day packs: neither spans it alone.
  assert.equal(packSpanning(two, "names", { start: "2026-10-28T23:50:00Z", end: "2026-10-29T00:10:00Z" }, "oi-cs"), null);
  // The older day pack carries both sources.
  assert.equal(packSpanning(two, "names", { start: "2026-10-28T13:00:00Z", end: "2026-10-28T14:00:00Z" }, "thc-ct")?.tag, "names-d-20261028");
});
