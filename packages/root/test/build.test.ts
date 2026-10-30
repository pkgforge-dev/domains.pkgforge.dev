// packages/root/src/build.ts: the first root, the next root, replacement,
// a rebuild of a span under -rN (ruling 25), rollback, the forward-only check,
// the re-run guard, a pack from its manifest, and the sources layer. Each
// refusal plants one fault that only the guard it names can catch. Every
// pack, digest, annotation and registry row here is synthetic (helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { artifactType, nextTierTag, repoOf, tierTag } from "@domains/ghcr";
import { timeKey } from "@domains/pack";
import {
  buildRoot,
  checkForward,
  checkSourcesLayer,
  createdOf,
  dropSuperseded,
  type HeadFacts,
  layerBytes,
  type ManifestFacts,
  packFromManifest,
  RootError,
  type RootErrorCode,
  rollbackRoot,
  SOURCES_LAYER_FORMAT,
  sourcesLayer,
  validateRoot,
} from "../src/index.ts";
import { digestOf, hex, hours, live, PSL_LIVE, PSL_OLD, pack } from "./helpers.ts";

const refusal = (fn: () => unknown, code: RootErrorCode, re: RegExp) =>
  assert.throws(fn, (e: unknown) => e instanceof RootError && e.code === code && re.test(e.message), `expected RootError ${code} ${re}`);

const first = () => buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z" });

test("build: the first root is root_seq 1 with no previous, no pack and no as_of, and names the pinned PSL", () => {
  const r = first();
  assert.deepEqual(
    { seq: r.root_seq, previous: r.previous, as_of: r.as_of, datasets: r.datasets, psl: r.psl, psl_live: r.psl_live, counts: r.counts, withdrawn: r.withdrawn },
    { seq: 1, previous: null, as_of: null, datasets: {}, psl: PSL_LIVE, psl_live: [], counts: {}, withdrawn: [] },
  );
  assert.deepEqual(Object.keys(r), ["format", "root_seq", "as_of", "created", "previous", "psl", "psl_live", "corpus_since", "gaps", "through", "counts", "datasets", "withdrawn"]);
  // The first root may also carry packs.
  const withPacks = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z")] });
  assert.equal(withPacks.as_of, "2026-10-27T00:00:00Z");
  assert.equal(withPacks.previous, null);
});

test("build: the next root is root_seq plus 1, previous is the live digest, and the gaps carry forward", () => {
  const one = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z", gaps: { "thc-ct": ["2026-10-04"] } });
  const l = live(one, "the live root");
  const two = buildRoot({ live: l, psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z")] });
  assert.equal(two.root_seq, 2);
  assert.equal(two.previous, l.digest);
  assert.deepEqual(two.gaps, { "thc-ct": ["2026-10-04"] });
  assert.deepEqual(
    two.datasets.names?.map((p) => p.tag),
    ["names-d-20261026"],
  );
});

test("build: 24 hour packs replaced by their day keep as_of, and the count follows the packs", () => {
  const base = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z"), ...hours("names", "2026-10-27")] });
  assert.equal(base.counts.names?.packs, 25);
  const day = pack("names", "d", "2026-10-27T00:00:00Z", { count: 99 });
  const next = buildRoot({
    live: live(base),
    psl: PSL_LIVE,
    now: "2026-10-28T02:00:00Z",
    replace: [{ old: (base.datasets.names ?? []).filter((p) => p.tier === "h").map((p) => p.manifest), new: day }],
  });
  assert.equal(next.as_of, base.as_of);
  assert.deepEqual(next.counts.names, { packs: 2, records: 109 });
  assert.deepEqual(
    next.datasets.names?.map((p) => p.tag),
    ["names-d-20261026", "names-d-20261027"],
  );
});

test("build: a replacement that names a pack the live root does not hold is refused", () => {
  const base = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: hours("names", "2026-10-27") });
  const day = pack("names", "d", "2026-10-27T00:00:00Z");
  refusal(
    () => buildRoot({ live: live(base), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [{ old: [digestOf("never pushed")], new: day }] }),
    "replace",
    /names sha256:[0-9a-f]{64}, which is not a live names pack/,
  );
});

test("build: a replacement that does not span what it replaces, or drops a source of it, is refused; nothing else would catch the last two", () => {
  // The review's case: two feed days of isc and oi-nrd, 1,000 records each, and
  // day 26 "replaced" by its hour 23 of isc alone, 3 records. Without the rule
  // corpus_since would rise by 23 hours and oi-nrd would leave day 26.
  const days = [pack("feed", "d", "2026-10-26T00:00:00Z", { sources: ["isc", "oi-nrd"], count: 1000 }), pack("feed", "d", "2026-10-27T00:00:00Z", { sources: ["isc", "oi-nrd"], count: 1000 })];
  const feed = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: days });
  const h23 = pack("feed", "h", "2026-10-26T23:00:00Z", { sources: ["isc"], count: 3 });
  refusal(
    () => buildRoot({ live: live(feed), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [{ old: [days[0].pack.manifest], new: h23 }] }),
    "replace",
    /the replacement by feed-h-2026102623 spans 2026-10-26T23:00:00Z to 2026-10-27T00:00:00Z, and the packs it replaces reach 2026-10-26T00:00:00Z to 2026-10-27T00:00:00Z; a replacement covers what it replaces/,
  );
  // The same span with a source fewer: through, corpus_since and as_of stay, so only this rule sees it.
  const fewer = pack("feed", "d", "2026-10-26T00:00:00Z", { sources: ["isc"], salt: "rebuilt" });
  refusal(
    () => buildRoot({ live: live(feed), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [{ old: [days[0].pack.manifest], new: fewer }] }),
    "replace",
    /the replacement by feed-d-20261026 does not carry oi-nrd, which the packs it replaces carry/,
  );
  // THC's day segment replaced by a 10 minute one: day 26 of oi-cs still covers the day, so only this rule sees it.
  const thcDay = pack("names", "seg", "2026-10-26T00:00:00Z", { end: "2026-10-27T00:00:00Z", sources: ["thc-ct"] });
  const names = buildRoot({
    live: live(first()),
    psl: PSL_LIVE,
    now: "2026-10-28T01:00:00Z",
    add: [pack("names", "d", "2026-10-26T00:00:00Z", { sources: ["oi-cs"] }), thcDay, pack("names", "d", "2026-10-27T00:00:00Z", { sources: ["oi-cs", "thc-ct"] })],
  });
  const short = pack("names", "seg", "2026-10-26T00:00:00Z", { sources: ["thc-ct"] });
  refusal(
    () => buildRoot({ live: live(names), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [{ old: [thcDay.pack.manifest], new: short }] }),
    "replace",
    /spans 2026-10-26T00:00:00Z to 2026-10-26T00:10:00Z, and the packs it replaces reach 2026-10-26T00:00:00Z to 2026-10-27T00:00:00Z/,
  );
  // A replacement that names no pack is refused by buildRoot itself, not only by the CLI.
  refusal(
    () => buildRoot({ live: live(feed), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [{ old: [], new: fewer }] }),
    "replace",
    /the replacement by feed-d-20261026 names no pack it replaces/,
  );
});

test("build: an addition that leaves a hole in the spans is refused by the live-set rule", () => {
  const base = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-25T00:00:00Z")] });
  refusal(
    () => buildRoot({ live: live(base), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", add: [pack("names", "d", "2026-10-27T00:00:00Z")] }),
    "live-set",
    /a hole from 2026-10-26T00:00:00Z to 2026-10-27T00:00:00Z/,
  );
});

test("build: a root whose root_seq is not above the live one, or whose as_of falls, or created earlier, is refused as stale", () => {
  const base = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z"), pack("names", "d", "2026-10-27T00:00:00Z")] });
  const next = buildRoot({ live: live(base), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z" });
  checkForward(base, next);
  refusal(() => checkForward(next, base), "stale", /root_seq 2, and the live root 3; root_seq only grows/);
  refusal(() => checkForward(base, { ...next, root_seq: base.root_seq }), "stale", /root_seq only grows/);
  // as_of falls: the same root_seq order, one day fewer.
  const fewer = { ...next, as_of: "2026-10-27T00:00:00Z" };
  refusal(() => checkForward(base, fewer), "stale", /as_of 2026-10-27T00:00:00Z, below the live root's 2026-10-28T00:00:00Z; only a rollback lowers as_of/);
  checkForward(base, fewer, { rollback: true });
  refusal(() => checkForward(base, { ...next, created: base.created }), "time", /not after the live root's/);
  // buildRoot runs the check: a clock behind the live root's created is refused.
  refusal(() => buildRoot({ live: live(base), psl: PSL_LIVE, now: "2026-10-28T00:30:00Z" }), "time", /created 2026-10-28T00:30:00Z, not after/);
});

test("build: outside a rollback a root that raises corpus_since, drops a dataset, or lowers or drops a source's through is refused as stale", () => {
  const base = buildRoot({
    live: live(first()),
    psl: PSL_LIVE,
    now: "2026-10-28T01:00:00Z",
    add: [pack("names", "d", "2026-10-26T00:00:00Z"), pack("names", "d", "2026-10-27T00:00:00Z"), pack("feed", "d", "2026-10-27T00:00:00Z", { sources: ["oi-nrd"] })],
  });
  const next = buildRoot({ live: live(base), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z" });
  checkForward(base, next);
  // Each plant keeps root_seq, as_of and created, so the clause named is the only one left to refuse.
  for (const [planted, re] of [
    [
      { ...next, corpus_since: { ...next.corpus_since, names: "2026-10-27T00:00:00Z" } },
      /corpus_since\.names 2026-10-27T00:00:00Z, and the live root 2026-10-26T00:00:00Z; only a rollback shrinks a dataset/,
    ],
    [{ ...next, corpus_since: { names: "2026-10-26T00:00:00Z" } }, /corpus_since\.feed none, and the live root 2026-10-27T00:00:00Z/],
    [
      { ...next, through: { ...next.through, "thc-ct": "2026-10-27T00:00:00Z" } },
      /through\.thc-ct 2026-10-27T00:00:00Z, below the live root's 2026-10-28T00:00:00Z; only a rollback lowers a source's through/,
    ],
    [{ ...next, through: { "thc-ct": "2026-10-28T00:00:00Z" } }, /through\.oi-nrd none, below the live root's 2026-10-28T00:00:00Z/],
  ] as const) {
    refusal(() => checkForward(base, planted), "stale", re);
    checkForward(base, planted, { rollback: true });
  }
  // An earlier corpus_since and a later through are growth, not shrinkage.
  checkForward(base, { ...next, corpus_since: { ...next.corpus_since, names: "2026-10-25T00:00:00Z" }, through: { ...next.through, "thc-ct": "2026-10-29T00:00:00Z" } });
});

test("rollback: a new root with a higher root_seq takes the older root's datasets, and never goes to a newer one", () => {
  const one = first();
  const two = buildRoot({ live: live(one), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z")] });
  const three = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", add: [pack("names", "d", "2026-10-27T00:00:00Z")] });
  const l = live(three, "three");
  const back = rollbackRoot({ live: l, target: two, between: [], psl: PSL_LIVE, now: "2026-10-28T03:00:00Z" });
  assert.equal(back.root_seq, 4);
  assert.equal(back.previous, l.digest);
  assert.deepEqual(back.datasets, two.datasets);
  assert.equal(back.as_of, "2026-10-27T00:00:00Z");
  validateRoot(back);
  refusal(
    () => rollbackRoot({ live: l, target: three, between: [], psl: PSL_LIVE, now: "2026-10-28T03:00:00Z" }),
    "stale",
    /a rollback goes to an older root: the target has root_seq 3, and the live root 3/,
  );
});

test("rollback: the new root takes the gaps of the target, not the live root's, and the pin it is given", () => {
  const one = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z", gaps: { "thc-ct": ["2026-10-04"] } });
  const two = buildRoot({ live: live(one), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z")] });
  const three = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", gaps: { "thc-ct": ["2026-10-04", "2026-10-09"] } });
  const back = rollbackRoot({ live: live(three), target: two, between: [], psl: PSL_OLD, now: "2026-10-28T03:00:00Z" });
  assert.deepEqual(back.gaps, { "thc-ct": ["2026-10-04"] });
  assert.equal(back.psl, PSL_OLD);
});

// Roots 1 to 4 of the withdrawn tests: day 26 and the hours of day 27 (2), the
// hours replaced by their day pack (3), and a rollback to 2 at 03:00 (4).
function withdrawnChain() {
  const day26 = pack("names", "d", "2026-10-26T00:00:00Z");
  const hrs = hours("names", "2026-10-27");
  const day27 = pack("names", "d", "2026-10-27T00:00:00Z");
  const two = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [day26, ...hrs] });
  const merge = { old: hrs.map((h) => h.pack.manifest), new: day27 };
  const three = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [merge] });
  const four = rollbackRoot({ live: live(three), target: two, between: [], psl: PSL_LIVE, now: "2026-10-28T03:00:00Z" });
  return { day27, hrs, merge, two, three, four };
}

test("withdrawn: a rollback lists each manifest the live root names and the target does not, at its own created; a later root carries it, and a rollback that names it again takes it off", () => {
  const { day27, two, three, four } = withdrawnChain();
  assert.deepEqual(two.withdrawn, []);
  assert.deepEqual(four.withdrawn, [{ manifest: day27.pack.manifest, at: "2026-10-28T03:00:00Z" }]);
  // The hours of day 27 came back with root 2's datasets: none of them is listed.
  assert.deepEqual(four.datasets, two.datasets);
  const five = buildRoot({ live: live(four), psl: PSL_LIVE, now: "2026-10-28T04:00:00Z", gaps: { "thc-ct": ["2026-10-04"] } });
  assert.deepEqual(five.withdrawn, four.withdrawn);
  // Back to root 3, which names day 27: off the list, and the hours that root 5 named and root 3 does not go on it.
  const six = rollbackRoot({ live: live(five), target: three, between: [four], psl: PSL_LIVE, now: "2026-10-28T05:00:00Z" });
  assert.equal(
    six.withdrawn.some((w) => w.manifest === day27.pack.manifest),
    false,
  );
  assert.deepEqual(
    six.withdrawn.map((w) => w.at),
    Array(24).fill("2026-10-28T05:00:00Z"),
  );
  assert.deepEqual(
    six.withdrawn.map((w) => w.manifest),
    (two.datasets.names ?? [])
      .filter((p) => p.tier === "h")
      .map((p) => p.manifest)
      .sort(),
  );
});

test("withdrawn: a re-run's addition or replacement of a withdrawn manifest is refused, with the ways back that work; buildRoot does not refuse another digest of the span", () => {
  const { day27, merge, four } = withdrawnChain();
  // The re-run of root 3's promotion: the replacement of the hours by day 27.
  refusal(
    () => buildRoot({ live: live(four), psl: PSL_LIVE, now: "2026-10-28T04:00:00Z", replace: [merge] }),
    "withdrawn",
    new RegExp(
      `^the replacement names:names-d-20261027 \\(${day27.pack.manifest}\\) was withdrawn by the rollback of 2026-10-28T03:00:00Z: a re-run cannot put it back\\. It comes back by a rollback to a root that names it, or after 2026-11-28T03:00:00Z, when every root drops the entry$`,
    ),
  );
  // The same pack named as an addition.
  refusal(
    () => buildRoot({ live: live(four), psl: PSL_LIVE, now: "2026-10-28T04:00:00Z", add: [day27] }),
    "withdrawn",
    /^the addition names:names-d-20261027 \(sha256:[0-9a-f]{64}\) was withdrawn by the rollback of 2026-10-28T03:00:00Z/,
  );
  // Another manifest digest of the same span is not this guard's to refuse: it
  // joins, and the old one stays listed. The span's tag is the withdrawn
  // pack's, write-once, so the rebuild takes it with -r2 (docs/architecture.md
  // section 4.7 rule 2, ruling 25).
  const rebuilt = pack("names", "d", "2026-10-27T00:00:00Z", { rebuild: 2 });
  const five = buildRoot({ live: live(four), psl: PSL_LIVE, now: "2026-10-28T04:00:00Z", replace: [{ old: merge.old, new: rebuilt }] });
  assert.deepEqual(
    five.datasets.names?.map((p) => p.manifest),
    [four.datasets.names?.[0]?.manifest, rebuilt.pack.manifest],
  );
  assert.deepEqual(five.withdrawn, four.withdrawn);
});

test("rebuild: a pack replaced by its rebuild, the same span and dataset under -rN and another manifest, passes, and so does a rebuild of the rebuild", () => {
  const day26 = pack("names", "d", "2026-10-26T00:00:00Z");
  const base = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [day26, pack("names", "d", "2026-10-27T00:00:00Z")] });
  const r2 = pack("names", "d", "2026-10-26T00:00:00Z", { rebuild: 2 });
  assert.equal(r2.pack.tag, "names-d-20261026-r2");
  assert.notEqual(r2.pack.manifest, day26.pack.manifest);
  const two = buildRoot({ live: live(base), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [{ old: [day26.pack.manifest], new: r2 }] });
  assert.deepEqual(
    two.datasets.names?.map((p) => p.tag),
    ["names-d-20261026-r2", "names-d-20261027"],
  );
  assert.equal(two.as_of, base.as_of);
  assert.deepEqual(two.corpus_since, base.corpus_since);
  // A replacement withdraws nothing: only a rollback lists a manifest.
  assert.deepEqual(two.withdrawn, []);
  const r3 = pack("names", "d", "2026-10-26T00:00:00Z", { rebuild: 3 });
  const three = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-10-28T03:00:00Z", replace: [{ old: [r2.pack.manifest], new: r3 }] });
  assert.deepEqual(
    three.datasets.names?.map((p) => p.tag),
    ["names-d-20261026-r3", "names-d-20261027"],
  );
  // A re-run of root 2's promotion: the re-run guard drops the replacement the live root names.
  assert.deepEqual(
    dropSuperseded(two, [], [{ old: [day26.pack.manifest], new: r2 }]).dropped.map((d) => [d.tag, d.why]),
    [["names-d-20261026-r2", "the live root names it (datasets.names)"]],
  );
  // The rebuild added beside the build it rebuilds, not in its place, is refused: two compacted packs of one span never overlap.
  refusal(
    () => buildRoot({ live: live(base), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", add: [r2] }),
    "live-set",
    /names:names-d-20261026 \(d, .*\) and names:names-d-20261026-r2 \(d, .*\) overlap; two compacted packs never do/,
  );
});

test("rebuild: after a rollback withdrew names-d-20261026, a promotion that replaces nothing adds names-d-20261026-r2 for the same span, and the withdrawn manifest stays refused", () => {
  const day25 = pack("names", "d", "2026-10-25T00:00:00Z");
  const day26 = pack("names", "d", "2026-10-26T00:00:00Z");
  const two = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [day25] });
  const three = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", add: [day26] });
  // Root 3's day 26 is found bad: the rollback to root 2 withdraws it.
  const four = rollbackRoot({ live: live(three), target: two, between: [], psl: PSL_LIVE, now: "2026-10-28T03:00:00Z" });
  assert.deepEqual(four.withdrawn, [{ manifest: day26.pack.manifest, at: "2026-10-28T03:00:00Z" }]);
  assert.deepEqual(
    four.datasets.names?.map((p) => p.tag),
    ["names-d-20261025"],
  );
  // GHCR keeps names-d-20261026, write-once: the rebuild takes the next free tag of the span.
  const tag = nextTierTag("names", "d", "2026-10-26T00:00:00Z", ["names-d-20261025", "names-d-20261026"]);
  assert.equal(tag, "names-d-20261026-r2");
  const r2 = pack("names", "d", "2026-10-26T00:00:00Z", { rebuild: 2 });
  assert.equal(r2.pack.tag, tag);
  const five = buildRoot({ live: live(four), psl: PSL_LIVE, now: "2026-10-28T04:00:00Z", add: [r2] });
  assert.deepEqual(
    five.datasets.names?.map((p) => [p.tag, p.manifest]),
    [
      ["names-d-20261025", day25.pack.manifest],
      ["names-d-20261026-r2", r2.pack.manifest],
    ],
  );
  assert.equal(five.as_of, "2026-10-27T00:00:00Z");
  // The withdrawn entry stays, and the root reads back whole.
  assert.deepEqual(five.withdrawn, four.withdrawn);
  assert.equal(validateRoot(JSON.parse(JSON.stringify(five))).root_seq, 5);
  // A re-run of root 3's promotion still cannot put the withdrawn day 26 back.
  refusal(
    () => buildRoot({ live: live(five), psl: PSL_LIVE, now: "2026-10-28T05:00:00Z", add: [day26] }),
    "withdrawn",
    new RegExp(`^the addition names:names-d-20261026 \\(${day26.pack.manifest}\\) was withdrawn by the rollback of 2026-10-28T03:00:00Z: a re-run cannot put it back`),
  );
});

test("withdrawn: every root drops an entry more than 31 days before its created, and the pack it named may then join again", () => {
  const { merge, four } = withdrawnChain();
  // 31 days after 2026-10-28T03:00:00Z the entry stays; one second later it is gone.
  assert.equal(buildRoot({ live: live(four), psl: PSL_LIVE, now: "2026-11-28T03:00:00Z" }).withdrawn.length, 1);
  const later = buildRoot({ live: live(four), psl: PSL_LIVE, now: "2026-11-28T03:00:01Z", replace: [merge] });
  assert.deepEqual(later.withdrawn, []);
  assert.deepEqual(
    later.datasets.names?.map((p) => p.tag),
    ["names-d-20261026", "names-d-20261027"],
  );
});

const manifests = (list: readonly { pack: { manifest: string } }[]) => list.map((np) => np.pack.manifest);
const sorted = (list: readonly string[]) => [...list].sort();

test("withdrawn: a rollback also lists each manifest a root between the target and the live root names and the target does not, so a compaction since the target hides no pack from it", () => {
  // The review's case: root 1 (the target) holds day 26, root 2 adds the hours
  // of day 27, root 3 replaces them by their day pack. The live root names the
  // day pack alone, and root 2 alone names the hours.
  const day26 = pack("names", "d", "2026-10-26T00:00:00Z");
  const hrs = hours("names", "2026-10-27");
  const day27 = pack("names", "d", "2026-10-27T00:00:00Z");
  const one = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z", add: [day26] });
  const two = buildRoot({ live: live(one), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: hrs });
  const three = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [{ old: manifests(hrs), new: day27 }] });
  const back = rollbackRoot({ live: live(three), target: one, between: [two], psl: PSL_LIVE, now: "2026-10-28T03:00:00Z" });
  assert.deepEqual(
    back.withdrawn,
    sorted(manifests([day27, ...hrs])).map((manifest) => ({ manifest, at: "2026-10-28T03:00:00Z" })),
  );
  // The re-run of root 2's promotion, in order after the rollback: its 24 additions are refused.
  refusal(() => buildRoot({ live: live(back), psl: PSL_LIVE, now: "2026-10-28T04:00:00Z", add: hrs }), "withdrawn", /^the addition names:names-h-2026102700 \(sha256:[0-9a-f]{64}\) was withdrawn/);

  // A rebuilt day pack: root 3 replaces the hours by day V1, root 4 replaces V1
  // by V2. A rollback to root 2 lists V1, which root 3 alone names, and V2.
  const v1 = pack("names", "d", "2026-10-27T00:00:00Z", { salt: "v1" });
  const v2 = pack("names", "d", "2026-10-27T00:00:00Z", { salt: "v2" });
  const threeV = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", replace: [{ old: manifests(hrs), new: v1 }] });
  const fourV = buildRoot({ live: live(threeV), psl: PSL_LIVE, now: "2026-10-28T03:00:00Z", replace: [{ old: [v1.pack.manifest], new: v2 }] });
  const backV = rollbackRoot({ live: live(fourV), target: two, between: [threeV], psl: PSL_LIVE, now: "2026-10-28T04:00:00Z" });
  assert.deepEqual(
    backV.withdrawn.map((w) => w.manifest),
    sorted(manifests([v1, v2])),
  );
  // The re-run of root 3's promotion, the hours replaced by V1, is refused.
  refusal(
    () => buildRoot({ live: live(backV), psl: PSL_LIVE, now: "2026-10-28T05:00:00Z", replace: [{ old: manifests(hrs), new: v1 }] }),
    "withdrawn",
    new RegExp(`^the replacement names:names-d-20261027 \\(${v1.pack.manifest}\\) was withdrawn by the rollback of 2026-10-28T04:00:00Z`),
  );
});

test("withdrawn: a root created more than 31 days before the rollback adds nothing to it; one created 31 days before does", () => {
  // Root 2 adds the hours of day 27 on 2026-09-01; root 3, the live root, replaces them by the day pack.
  const day26 = pack("names", "d", "2026-10-26T00:00:00Z");
  const hrs = hours("names", "2026-10-27");
  const day27 = pack("names", "d", "2026-10-27T00:00:00Z");
  const one = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-09-01T00:00:00Z", add: [day26] });
  const two = buildRoot({ live: live(one), psl: PSL_LIVE, now: "2026-09-01T01:00:00Z", add: hrs });
  const three = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-09-20T00:00:00Z", replace: [{ old: manifests(hrs), new: day27 }] });
  const at = (now: string) => rollbackRoot({ live: live(three), target: one, between: [two], psl: PSL_LIVE, now }).withdrawn.map((w) => w.manifest);
  // 31 days after root 2's created: its hours are listed.
  assert.deepEqual(at("2026-10-02T01:00:00Z"), sorted(manifests([day27, ...hrs])));
  // One second later: root 2's run can no longer be re-run, and the live root's day pack alone is listed.
  assert.deepEqual(at("2026-10-02T01:00:01Z"), [day27.pack.manifest]);
});

test("withdrawn: a second rollback keeps the live root's entries, each with its own at", () => {
  // The review's case: root 4 rolls back to root 2 and withdraws B, root 5
  // changes a gap, root 6 rolls back to root 2 again.
  const a = pack("names", "d", "2026-10-26T00:00:00Z");
  const b = pack("names", "d", "2026-10-27T00:00:00Z");
  const two = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [a] });
  const three = buildRoot({ live: live(two), psl: PSL_LIVE, now: "2026-10-28T02:00:00Z", add: [b] });
  const four = rollbackRoot({ live: live(three), target: two, between: [], psl: PSL_LIVE, now: "2026-10-28T03:00:00Z" });
  assert.deepEqual(four.withdrawn, [{ manifest: b.pack.manifest, at: "2026-10-28T03:00:00Z" }]);
  const five = buildRoot({ live: live(four), psl: PSL_LIVE, now: "2026-10-28T04:00:00Z", gaps: { "thc-ct": ["2026-10-04"] } });
  const six = rollbackRoot({ live: live(five), target: two, between: [four, three], psl: PSL_LIVE, now: "2026-10-28T05:00:00Z" });
  assert.deepEqual(six.withdrawn, [{ manifest: b.pack.manifest, at: "2026-10-28T03:00:00Z" }]);
  // The re-run of root 3's promotion after root 6 is refused.
  refusal(
    () => buildRoot({ live: live(six), psl: PSL_LIVE, now: "2026-10-28T06:00:00Z", add: [b] }),
    "withdrawn",
    /^the addition names:names-d-20261027 \(sha256:[0-9a-f]{64}\) was withdrawn by the rollback of 2026-10-28T03:00:00Z/,
  );
});

test("re-run guard: an addition the live root names, one it supersedes, and a replacement already made are dropped with their reason", () => {
  const day26 = pack("names", "d", "2026-10-26T00:00:00Z");
  const base = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [day26, pack("names", "d", "2026-10-27T00:00:00Z")] });
  const hour = pack("names", "h", "2026-10-27T05:00:00Z");
  const seg = pack("names", "seg", "2026-10-27T05:00:00Z", { sources: ["thc-ct"] });
  const otherSource = pack("names", "seg", "2026-10-27T05:00:00Z", { sources: ["oi-cs"] });
  const fresh = pack("names", "d", "2026-10-28T00:00:00Z");
  const { add, replace, dropped } = dropSuperseded(base, [day26, hour, seg, otherSource, fresh], [{ old: [digestOf("x")], new: pack("names", "d", "2026-10-27T00:00:00Z") }]);
  assert.deepEqual(
    add.map((p) => p.pack.tag),
    ["oi-cs.20261027t050000z.20261027t051000z", "names-d-20261028"],
  );
  assert.deepEqual(replace, []);
  assert.deepEqual(
    dropped.map((d) => [d.tag, d.why.replace(/ \(.*$/, "")]),
    [
      ["names-d-20261026", "the live root names it"],
      ["names-h-2026102705", "the live root supersedes it with names-d-20261027"],
      ["thc-ct.20261027t050000z.20261027t051000z", "the live root supersedes it with names-d-20261027"],
      ["names-d-20261027", "the live root names it"],
    ],
  );
  // With no live root nothing is dropped.
  assert.equal(dropSuperseded(null, [day26], []).dropped.length, 0);
});

test("re-run guard: a pack is superseded only by a higher tier of its own dataset whose span covers it from its start and that carries every source of it", () => {
  const base = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z"), pack("names", "d", "2026-10-27T00:00:00Z")] });
  const only27 = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-27T00:00:00Z")] });
  for (const [what, liveRoot, np] of [
    // Another manifest of the live pack's own tier and span: buildRoot refuses the overlap loudly.
    ["the same tier", base, pack("names", "d", "2026-10-27T00:00:00Z", { salt: "rebuilt" })],
    // Hour 23 of day 26 ends inside day 27's span and starts before it.
    ["a start before the day", only27, pack("names", "h", "2026-10-26T23:00:00Z")],
    // oi-cs is a source day 27 does not carry.
    ["a source the day lacks", base, pack("names", "h", "2026-10-27T05:00:00Z", { sources: ["oi-cs", "thc-ct"] })],
    // A names day supersedes no feed pack.
    ["another dataset", base, pack("feed", "h", "2026-10-27T05:00:00Z")],
  ] as const) {
    const r = dropSuperseded(liveRoot, [np], []);
    assert.deepEqual(r.dropped, [], what);
    assert.deepEqual(
      r.add.map((p) => p.pack.manifest),
      [np.pack.manifest],
      what,
    );
  }
});

// The manifest and index head of a synthetic names day pack, as GHCR and the
// index give them, with `change` planted into the annotations.
function facts(change: Record<string, string | undefined> = {}, head: Partial<ManifestFacts["head"]> = {}, layers?: ManifestFacts["json"]["layers"]): ManifestFacts {
  const annotations: Record<string, string> = {
    "dev.pkgforge.domains.dataset": "names",
    "dev.pkgforge.domains.tier": "d",
    "dev.pkgforge.domains.span.start": "2026-10-26T00:00:00Z",
    "dev.pkgforge.domains.span.end": "2026-10-27T00:00:00Z",
    "dev.pkgforge.domains.count": "3",
    "dev.pkgforge.domains.bytes": "1300",
    "dev.pkgforge.domains.sha256": hex("raw"),
    "dev.pkgforge.domains.psl": PSL_LIVE,
    "dev.pkgforge.domains.source": "thc-ct,ct-le",
  };
  for (const [k, v] of Object.entries(change)) {
    if (v === undefined) delete annotations[k];
    else annotations[k] = v;
  }
  const t = (title: string) => ({ "org.opencontainers.image.title": title });
  return {
    repo: repoOf("names"),
    tag: "names-d-20261026",
    digest: digestOf("manifest"),
    json: {
      artifactType: artifactType("pack"),
      annotations,
      layers: layers ?? [
        { mediaType: "application/octet-stream", digest: digestOf("p0"), size: 600, annotations: t("part.000") },
        { mediaType: "application/octet-stream", digest: digestOf("p1"), size: 500, annotations: t("part.001") },
        { mediaType: "application/octet-stream", digest: digestOf("i"), size: 200, annotations: t("idx") },
        { mediaType: "application/json", digest: digestOf("s"), size: 50, annotations: t("summary.json") },
      ],
    },
    head: { dataset: 1, records: 3, keyMin: "com.a", keyMax: "com.c", parts: [600, 500], ...head },
  };
}

test("pack from manifest: the entry holds the annotations, the layers and the index head, the sources sorted", () => {
  const { dataset, pack: p } = packFromManifest(facts());
  assert.equal(dataset, "names");
  assert.deepEqual(p, {
    repo: repoOf("names"),
    tag: "names-d-20261026",
    tier: "d",
    span: { start: "2026-10-26T00:00:00Z", end: "2026-10-27T00:00:00Z" },
    manifest: digestOf("manifest"),
    pack: { sha256: hex("raw"), bytes: 1300 },
    idx: { digest: digestOf("i"), size: 200 },
    parts: [
      { digest: digestOf("p0"), size: 600 },
      { digest: digestOf("p1"), size: 500 },
    ],
    count: 3,
    key_min: "com.a",
    key_max: "com.c",
    sources: ["ct-le", "thc-ct"],
    psl: PSL_LIVE,
  });
});

test("pack from manifest: each fact that disagrees with another is refused by name", () => {
  refusal(() => packFromManifest(facts({ "dev.pkgforge.domains.count": "4" })), "pack", /the index holds 3 records, and the annotation dev\.pkgforge\.domains\.count says 4/);
  refusal(() => packFromManifest(facts({}, { dataset: 3 })), "pack", /the index holds dataset 3 \(feed\), and the annotation says names/);
  refusal(() => packFromManifest(facts({}, { parts: [600, 501] })), "pack", /part\.001 is 500 B in the manifest, and the index gives it 501 B/);
  refusal(() => packFromManifest(facts({}, { parts: [600] })), "pack", /holds 2 part layer\(s\), and the index names 1/);
  refusal(() => packFromManifest(facts({ "dev.pkgforge.domains.psl": undefined })), "pack", /has no annotation dev\.pkgforge\.domains\.psl/);
  refusal(() => packFromManifest(facts({ "dev.pkgforge.domains.tier": "seg" })), "pack", /has the tier seg; a segment is tier seg/);
  refusal(() => packFromManifest(facts({ "dev.pkgforge.domains.bytes": "1301" })), "pack", /its parts and index hold 1300 B, and pack\.bytes says 1301/);
  const t = (title: string) => ({ "org.opencontainers.image.title": title });
  refusal(
    () =>
      packFromManifest(
        facts({}, {}, [
          { mediaType: "application/octet-stream", digest: digestOf("p1"), size: 500, annotations: t("part.001") },
          { mediaType: "application/octet-stream", digest: digestOf("i"), size: 200, annotations: t("idx") },
        ]),
      ),
    "pack",
    /the layer part\.001 stands where part\.000 belongs/,
  );
  refusal(() => packFromManifest(facts({}, {}, [{ mediaType: "application/octet-stream", digest: digestOf("p0"), size: 600, annotations: t("part.000") }])), "pack", /holds no idx layer/);
  refusal(
    () => packFromManifest(facts({}, {}, [...(facts().json.layers ?? []), { mediaType: "application/octet-stream", digest: digestOf("i2"), size: 200, annotations: t("idx") }])),
    "pack",
    /the manifest holds two idx layers/,
  );
  // A quarantined segment (section 5.8) joins no root.
  refusal(() => packFromManifest(facts({ "dev.pkgforge.domains.quarantine": "1" })), "pack", /carries dev\.pkgforge\.domains\.quarantine="1": a quarantined pack joins no root/);
  refusal(() => packFromManifest({ ...facts(), json: { ...facts().json, artifactType: artifactType("ref") } }), "pack", /the artifact type is "application\/vnd\.pkgforge\.domains\.ref\.v1"/);
});

// The facts of a synthetic feed day pack that carries a time copy: the key
// copy's two parts and idx, the time copy's two parts and time.idx, and both
// heads, with `layers` and `timeHead` planted over them.
function timedFacts(o: { dataset?: "feed" | "new-name" | "names"; layers?: ManifestFacts["json"]["layers"]; timeHead?: Partial<HeadFacts> | null } = {}): ManifestFacts {
  const dataset = o.dataset ?? "feed";
  const base = facts({ "dev.pkgforge.domains.dataset": dataset, "dev.pkgforge.domains.source": "oi-nrd" }, { dataset: { feed: 3, "new-name": 5, names: 1 }[dataset] });
  const t = (title: string) => ({ "org.opencontainers.image.title": title });
  const layer = (title: string, size: number) => ({ mediaType: "application/octet-stream", digest: digestOf(title), size, annotations: t(title) });
  const timeLayers = [layer("time.part.000", 650), layer("time.part.001", 520), layer("time.idx", 210)];
  return {
    ...base,
    repo: repoOf(dataset === "names" ? "names" : "feed"),
    tag: tierTag(dataset, "d", "2026-10-26T00:00:00Z"),
    json: { ...base.json, layers: o.layers ?? [...(base.json.layers ?? []), ...timeLayers] },
    timeHead:
      o.timeHead === null
        ? null
        : { dataset: dataset === "new-name" ? 7 : 6, records: 3, keyMin: timeKey(298 * 86_400, "com.b"), keyMax: timeKey(298 * 86_400 + 60, "com.a"), parts: [650, 520], ...o.timeHead },
  };
}

test("pack from manifest: a feed or new-name pack's time copy is listed by its layers, held to its own index head", () => {
  const { dataset, pack: p } = packFromManifest(timedFacts());
  assert.equal(dataset, "feed");
  assert.deepEqual(p.time, {
    idx: { digest: digestOf("time.idx"), size: 210 },
    parts: [
      { digest: digestOf("time.part.000"), size: 650 },
      { digest: digestOf("time.part.001"), size: 520 },
    ],
  });
  // The time copy is not counted in pack.bytes, which the annotations give for the key copy.
  assert.equal(p.pack.bytes, 1300);
  assert.equal(packFromManifest(timedFacts({ dataset: "new-name" })).pack.time?.idx.size, 210);
  // A pack with no time copy has no `time` field, not a null one.
  assert.equal(Object.hasOwn(packFromManifest(facts()).pack, "time"), false);
  // The time layers may come before the key copy's; each kind keeps its own numbering.
  const layers = timedFacts().json.layers ?? [];
  const timeFirst = [
    ...layers.filter((l) => l.annotations?.["org.opencontainers.image.title"]?.startsWith("time.")),
    ...layers.filter((l) => !l.annotations?.["org.opencontainers.image.title"]?.startsWith("time.")),
  ];
  assert.deepEqual(packFromManifest(timedFacts({ layers: timeFirst })).pack, p);
});

test("pack from manifest: each fault of a time copy is refused by name", () => {
  const all = timedFacts().json.layers ?? [];
  const without = (title: string) => all.filter((l) => l.annotations?.["org.opencontainers.image.title"] !== title);
  const t = (title: string) => ({ "org.opencontainers.image.title": title });
  // Both or neither: the parts with no time.idx, and a time.idx with no part.
  refusal(() => packFromManifest(timedFacts({ layers: without("time.idx") })), "pack", /holds 2 time\.part layer\(s\) and no time\.idx: a time copy is both or neither/);
  refusal(
    () => packFromManifest(timedFacts({ layers: without("time.part.000").filter((l) => l.annotations?.["org.opencontainers.image.title"] !== "time.part.001") })),
    "pack",
    /holds a time\.idx layer and no time\.part layer: a time copy is both or neither/,
  );
  refusal(
    () => packFromManifest(timedFacts({ layers: [...all, { mediaType: "application/octet-stream", digest: digestOf("i3"), size: 210, annotations: t("time.idx") }] })),
    "pack",
    /the manifest holds two time\.idx layers/,
  );
  refusal(() => packFromManifest(timedFacts({ layers: without("time.part.000") })), "pack", /the layer time\.part\.001 stands where time\.part\.000 belongs/);
  // A dataset with no time copy: names.
  refusal(() => packFromManifest(timedFacts({ dataset: "names" })), "pack", /a names pack carries a time copy; only feed and new-name packs have one/);
  // The head the caller read, or did not.
  refusal(() => packFromManifest(timedFacts({ timeHead: null })), "pack", /the manifest holds a time copy, and its index head was not read/);
  refusal(() => packFromManifest({ ...facts(), timeHead: timedFacts().timeHead }), "pack", /a time index head was read, and the manifest holds no time copy/);
  // The head held to the key copy and to the layers.
  refusal(() => packFromManifest(timedFacts({ timeHead: { dataset: 3 } })), "pack", /the time index holds dataset 3 \(feed\); the time copy of feed is dataset 6 \(feed-time\)/);
  refusal(
    () => packFromManifest(timedFacts({ dataset: "new-name", timeHead: { dataset: 6 } })),
    "pack",
    /the time index holds dataset 6 \(feed-time\); the time copy of new-name is dataset 7 \(new-name-time\)/,
  );
  refusal(() => packFromManifest(timedFacts({ timeHead: { records: 4 } })), "pack", /the time index holds 4 records, and the index 3/);
  refusal(() => packFromManifest(timedFacts({ timeHead: { parts: [650] } })), "pack", /holds 2 time\.part layer\(s\), and the time index names 1/);
  refusal(() => packFromManifest(timedFacts({ timeHead: { parts: [650, 521] } })), "pack", /time\.part\.001 is 520 B in the manifest, and the time index gives it 521 B/);
});

test("pack from manifest: the first and the last first_seen of a time copy lie inside the pack's span, as readFeed holds them", () => {
  // The span of timedFacts is 2026-10-26 to 2026-10-27: [25747200, 25833600) in seconds since 2026-01-01.
  const t0 = 298 * 86_400;
  const t1 = 299 * 86_400;
  // Its first second and its last are inside.
  assert.ok(packFromManifest(timedFacts({ timeHead: { keyMin: timeKey(t0, "com.b"), keyMax: timeKey(t1 - 1, "com.a") } })).pack.time);
  // A second before the start, and the end itself, each alone.
  const outside = /the time copy's rows run from first_seen \d+ to \d+, outside the span \[25747200, 25833600\) of the pack/;
  refusal(() => packFromManifest(timedFacts({ timeHead: { keyMin: timeKey(t0 - 1, "com.b") } })), "pack", outside);
  refusal(() => packFromManifest(timedFacts({ timeHead: { keyMax: timeKey(t1, "com.a") } })), "pack", outside);
  // Bounds that are not time keys: absent with records, or the 4 bytes of time alone.
  const notKeys = /the time index's key bounds are not time keys: 4 bytes of first_seen and a row key each/;
  refusal(() => packFromManifest(timedFacts({ timeHead: { keyMax: null } })), "pack", notKeys);
  refusal(() => packFromManifest(timedFacts({ timeHead: { keyMin: timeKey(t0, "com.b").slice(0, 4) } })), "pack", notKeys);
});

test("psl_live: a root names every list its packs were built under, and keeps the pin apart", () => {
  const r = buildRoot({
    live: live(first()),
    psl: "e".repeat(64),
    now: "2026-10-28T01:00:00Z",
    add: [pack("names", "d", "2026-10-26T00:00:00Z", { psl: PSL_OLD }), pack("names", "d", "2026-10-27T00:00:00Z")],
  });
  assert.deepEqual(r.psl_live, [PSL_OLD, PSL_LIVE].sort());
  assert.equal(r.psl, "e".repeat(64));
  refusal(() => buildRoot({ live: null, psl: "1f96bae40adf", now: "2026-10-28T00:00:00Z" }), "psl", /the pinned PSL "1f96bae40adf" is not 64 lowercase hex digits/);
});

const REGISTRY = [
  { id: "thc-ct", bit: 0, precision: "day" },
  { id: "ct-le", bit: 5, precision: "second" },
];

test("sources layer: each registry row with the root's through, and fetched given or carried", () => {
  const r = buildRoot({ live: live(first()), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z")] });
  const one = sourcesLayer({ registry: REGISTRY, root: r, fetched: { "thc-ct": "2026-10-27T00:20:00Z" } });
  assert.equal(one.format, SOURCES_LAYER_FORMAT);
  assert.deepEqual(
    one.sources.map((s) => [s.id, s.through, s.fetched]),
    [
      ["thc-ct", "2026-10-27T00:00:00Z", "2026-10-27T00:20:00Z"],
      ["ct-le", null, null],
    ],
  );
  const two = sourcesLayer({ registry: REGISTRY, root: r, previous: one });
  assert.equal(two.sources[0]?.fetched, "2026-10-27T00:20:00Z");
  assert.deepEqual(checkSourcesLayer(r, JSON.parse(JSON.stringify(two))), two);
  refusal(() => sourcesLayer({ registry: [{ id: "ct-le" }], root: r }), "sources", /a live pack carries thc-ct, which the registry does not hold/);
  refusal(() => sourcesLayer({ registry: [...REGISTRY, { id: "thc-ct" }], root: r }), "sources", /the registry holds thc-ct twice/);
  refusal(
    () => checkSourcesLayer(r, { ...two, sources: [{ ...two.sources[0], through: "2026-10-28T00:00:00Z" }, two.sources[1]] }),
    "sources",
    /thc-ct is through "2026-10-28T00:00:00Z", and the root says "2026-10-27T00:00:00Z"/,
  );
  refusal(() => checkSourcesLayer(r, { ...two, sources: [two.sources[1]] }), "sources", /holds no row for thc-ct/);
});

test("build: layerBytes writes compact JSON with one final newline", () => {
  assert.equal(new TextDecoder().decode(layerBytes({ a: [1, { b: "c" }], d: null })), '{"a":[1,{"b":"c"}],"d":null}\n');
  const r = first();
  assert.deepEqual(JSON.parse(new TextDecoder().decode(layerBytes(r))), JSON.parse(JSON.stringify(r)));
});

test("build: createdOf cuts a time to its second, as a dated tag needs", () => {
  assert.equal(createdOf(Date.parse("2026-10-29T07:27:31.999Z")), "2026-10-29T07:27:31Z");
  assert.equal(createdOf(new Date("2026-10-29T07:27:31Z")), "2026-10-29T07:27:31Z");
});
