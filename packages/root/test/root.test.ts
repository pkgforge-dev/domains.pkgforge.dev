// packages/root/src/root.ts: validateRoot, the live-set rule and the derived
// fields. Each refusal plants one fault into a valid root whose derived fields
// are computed again (rederive), so the guard the test names is the only one
// that can catch it; the code and the message the test reads are that
// guard's own. Every pack, digest and source here is synthetic (helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRoot, canonical, derive, type PackEntry, RootError, type RootErrorCode, validateRoot } from "../src/index.ts";
import { digestOf, hours, live, PSL_LIVE, PSL_OLD, pack, plain } from "./helpers.ts";

const NOW = "2026-10-29T08:00:00Z";

// A root of two names day packs and the hours of the next day, and one feed
// day with its time copy.
function sample() {
  const first = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z" });
  return buildRoot({
    live: live(first),
    psl: PSL_LIVE,
    now: NOW,
    add: [
      pack("names", "d", "2026-10-26T00:00:00Z"),
      pack("names", "d", "2026-10-27T00:00:00Z", { psl: PSL_OLD }),
      ...hours("names", "2026-10-28", { sources: ["ct-le", "oi-cs"] }),
      pack("feed", "d", "2026-10-27T00:00:00Z", { sources: ["oi-nrd"] }),
    ],
  });
}

// The derived fields of `json` computed again from its datasets.
function rederive(json: Record<string, unknown>): Record<string, unknown> {
  const d = derive(json.datasets as Record<string, PackEntry[]>);
  return { ...json, as_of: d.as_of, corpus_since: d.corpus_since, through: d.through, counts: d.counts, psl_live: d.psl_live };
}

function refused(json: unknown, code: RootErrorCode, re: RegExp, strict = true): void {
  assert.throws(
    () => validateRoot(json, { strict }),
    (e: unknown) => e instanceof RootError && e.code === code && re.test(e.message),
  );
}

const datasetsOf = (j: Record<string, unknown>) => j.datasets as Record<string, PackEntry[]>;

test("root: a sample root validates, and its derived fields are the packs' own", () => {
  const r = sample();
  assert.equal(validateRoot(plain(r)).root_seq, 2);
  assert.equal(r.as_of, "2026-10-29T00:00:00Z");
  assert.deepEqual(r.corpus_since, { feed: "2026-10-27T00:00:00Z", names: "2026-10-26T00:00:00Z" });
  assert.deepEqual(r.through, { "ct-le": "2026-10-29T00:00:00Z", "oi-cs": "2026-10-29T00:00:00Z", "oi-nrd": "2026-10-28T00:00:00Z", "thc-ct": "2026-10-28T00:00:00Z" });
  assert.deepEqual(r.counts, { feed: { packs: 1, records: 10 }, names: { packs: 26, records: 260 } });
  // psl_live is every list a live pack was built under, sorted; psl is the pin.
  assert.deepEqual(r.psl_live, [PSL_OLD, PSL_LIVE].sort());
  assert.equal(r.psl, PSL_LIVE);
});

test("root: an unknown format is refused before any other field is read", () => {
  refused({ ...plain(sample()), format: "domains.root.v2" }, "format", /domains\.root\.v2.*knows domains\.root\.v1/);
  refused({ format: "domains.root.v2" }, "format", /domains\.root\.v2/);
});

test("root: a writer refuses an unknown field and an unknown dataset, and a reader ignores both", () => {
  const extra = { ...plain(sample()), later: 1 };
  refused(extra, "schema", /unknown field\(s\) later/);
  assert.equal(validateRoot(extra, { strict: false }).root_seq, 2);
  const j = plain(sample());
  const dumps = { ...j, datasets: { ...datasetsOf(j), dumps: [{ month: "2026-09" }] } };
  refused(dumps, "schema", /datasets names "dumps"/);
  // A reader holds the per-dataset fields of what it knows, and skips the rest.
  assert.equal(validateRoot(dumps, { strict: false }).root_seq, 2);
  const unknownPackField = plain(sample());
  (datasetsOf(unknownPackField).feed[0] as unknown as Record<string, unknown>).tidx = { digest: "x" };
  refused(unknownPackField, "schema", /datasets\.feed\[0\] holds the unknown field\(s\) tidx/);
  assert.equal(validateRoot(unknownPackField, { strict: false }).root_seq, 2);
});

test("root: each derived field that disagrees with the packs is refused by name", () => {
  const j = plain(sample());
  refused({ ...j, as_of: "2026-10-30T00:00:00Z" }, "derived", /^as_of is "2026-10-30T00:00:00Z"/);
  refused({ ...j, psl_live: [PSL_LIVE] }, "derived", /^psl_live is/);
  refused({ ...j, through: { ...(j.through as object), "thc-ct": "2026-10-29T00:00:00Z" } }, "derived", /^through is/);
  refused({ ...j, corpus_since: { names: "2026-10-26T00:00:00Z" } }, "derived", /^corpus_since is/);
  refused({ ...j, counts: { ...(j.counts as object), feed: { packs: 1, records: 11 } } }, "derived", /^counts is/);
});

test("root: psl_live must be sorted hex, and the pin need not be among it", () => {
  const j = plain(sample());
  refused({ ...j, psl_live: [PSL_LIVE, PSL_OLD] }, "psl", /psl_live is not sorted and distinct/);
  refused({ ...j, psl: "1f96bae40adf" }, "psl", /^psl is not 64 lowercase hex digits/);
  // A new pin with no pack built under it yet: psl is outside psl_live (ruling 22).
  const pinned = "f".repeat(64);
  assert.equal(validateRoot({ ...j, psl: pinned }).psl, pinned);
});

test("root: only the first root has no previous", () => {
  const j = plain(sample());
  refused({ ...j, previous: null }, "schema", /root_seq 2 with previous null/);
  const first = plain(buildRoot({ live: null, psl: PSL_LIVE, now: NOW }));
  refused({ ...first, previous: `sha256:${"1".repeat(64)}` }, "schema", /root_seq 1 with previous/);
  refused({ ...first, root_seq: 0 }, "schema", /root_seq is 0/);
});

test("live set: a hole between two packs is refused", () => {
  const j = plain(sample());
  // Drop hour 05 of 2026-10-28; the derived fields follow the packs.
  datasetsOf(j).names = datasetsOf(j).names.filter((p) => p.tag !== "names-h-2026102805");
  refused(rederive(j), "live-set", /a hole from 2026-10-28T05:00:00Z to 2026-10-28T06:00:00Z/);
});

test("live set: two compacted packs that overlap are refused, and so is a pack listed twice", () => {
  const j = plain(sample());
  const names = datasetsOf(j).names;
  // The day 2026-10-28 beside its own hours, with a source of its own.
  const day = pack("names", "d", "2026-10-28T00:00:00Z", { sources: ["isc-new"] }).pack;
  names.splice(
    names.findIndex((p) => p.tag === "names-h-2026102800"),
    0,
    day,
  );
  refused(rederive(j), "live-set", /names-d-20261028 .* and names:names-h-2026102800 .* overlap; two compacted packs never do/);
  const twice = plain(sample());
  const f = datasetsOf(twice).feed;
  f.push({ ...f[0], manifest: `sha256:${"9".repeat(64)}` });
  refused(rederive(twice), "live-set", /feed:feed-d-20261027 .* is listed twice/);
});

test("live set: a segment may overlap a pack of other sources, and never one that shares a source", () => {
  const j = plain(sample());
  // THC's day segment beside the hour packs of the live lanes: no shared source.
  const thc = pack("names", "seg", "2026-10-28T00:00:00Z", { end: "2026-10-29T00:00:00Z", sources: ["thc-ct"] }).pack;
  const names = datasetsOf(j).names;
  names.splice(names.findIndex((p) => p.tag === "names-h-2026102800") + 1, 0, thc);
  assert.equal(validateRoot(rederive(j)).counts.names?.packs, 27);
  // A segment of oi-cs inside hour 08, which oi-cs is merged into already.
  const k = plain(sample());
  const seg = pack("names", "seg", "2026-10-28T08:00:00Z", { sources: ["oi-cs"] }).pack;
  const list = datasetsOf(k).names;
  list.splice(list.findIndex((p) => p.tag === "names-h-2026102808") + 1, 0, seg);
  refused(rederive(k), "live-set", /names-h-2026102808 .* and obs:oi-cs\.20261028t080000z\.20261028t081000z .* overlap and share a source/);
});

test("live set: in feed and new-name no two packs overlap, a segment of other sources neither; in names, domains and rev the same shape is the segment exception", () => {
  const first = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z" });
  // An isc-new hour 00:00 to 01:00 and an oi-nrd segment 00:10 to 00:20 inside it: no source shared, one a segment.
  const shape = (ds: "feed" | "new-name" | "names" | "domains" | "rev") => [
    pack(ds, "h", "2026-10-28T00:00:00Z", { sources: ["isc-new"] }),
    pack(ds, "seg", "2026-10-28T00:10:00Z", { end: "2026-10-28T00:20:00Z", sources: ["oi-nrd"] }),
  ];
  for (const ds of ["feed", "new-name"] as const) {
    assert.throws(
      () => buildRoot({ live: live(first), psl: PSL_LIVE, now: NOW, add: shape(ds) }),
      (e: unknown) =>
        e instanceof RootError &&
        e.code === "live-set" &&
        new RegExp(
          `^datasets\\.${ds}: feed:${ds}-h-2026102800 \\(h, .*\\) and obs:oi-nrd\\.20261028t001000z\\.20261028t002000z \\(seg, .*\\) overlap; no two packs of ${ds} do: a window is read over disjoint packs`,
        ).test(e.message),
      ds,
    );
  }
  for (const ds of ["names", "domains", "rev"] as const) {
    assert.equal(buildRoot({ live: live(first), psl: PSL_LIVE, now: NOW, add: shape(ds) }).counts[ds]?.packs, 2, ds);
  }
  // A feed segment beside an hour it does not overlap is a live pack like any other.
  const beside = buildRoot({
    live: live(first),
    psl: PSL_LIVE,
    now: NOW,
    add: [pack("feed", "h", "2026-10-28T00:00:00Z", { sources: ["isc-new"] }), pack("feed", "seg", "2026-10-28T01:00:00Z", { sources: ["oi-nrd"] })],
  });
  assert.equal(beside.counts.feed?.packs, 2);
});

test("root: withdrawn is a list of { manifest, at } sorted by manifest, each at no later than created and at most 31 days before it", () => {
  const j = plain(sample());
  const [a, b] = [digestOf("withdrawn a"), digestOf("withdrawn b")].sort();
  const ok = [
    { manifest: a, at: "2026-09-28T08:00:00Z" },
    { manifest: b, at: NOW },
  ];
  // 2026-09-28T08:00:00Z is 31 days before created, NOW.
  // A writer (strict) and a reader (strict false, the Worker's) refuse each alike.
  const { withdrawn: _gone, ...without } = j;
  for (const strict of [true, false]) {
    assert.deepEqual(validateRoot({ ...j, withdrawn: ok }, { strict }).withdrawn, ok);
    refused({ ...j, withdrawn: {} }, "schema", /^withdrawn is not a list/, strict);
    refused({ ...j, withdrawn: [a] }, "schema", /^withdrawn\[0\] is not \{ manifest, at \}/, strict);
    refused({ ...j, withdrawn: [{ manifest: a }] }, "schema", /^withdrawn\[0\] lacks at/, strict);
    refused({ ...j, withdrawn: [{ manifest: "sha256:abc", at: NOW }] }, "schema", /^withdrawn\[0\]\.manifest is not a sha256: digest/, strict);
    refused({ ...j, withdrawn: [{ manifest: a, at: "2026-10-29" }] }, "schema", /^withdrawn\[0\]\.at is "2026-10-29", not YYYY-MM-DDTHH:MM:SSZ/, strict);
    refused({ ...j, withdrawn: [{ manifest: a, at: "2026-10-29T08:00:01Z" }] }, "schema", /^withdrawn\[0\]\.at 2026-10-29T08:00:01Z is after the root's created 2026-10-29T08:00:00Z/, strict);
    refused(
      { ...j, withdrawn: [{ manifest: a, at: "2026-09-28T07:59:59Z" }] },
      "schema",
      /^withdrawn\[0\]\.at 2026-09-28T07:59:59Z is more than 31 days before the root's created 2026-10-29T08:00:00Z: every root drops it/,
      strict,
    );
    refused({ ...j, withdrawn: [ok[1], ok[0]] }, "schema", /^withdrawn is not sorted by manifest and distinct/, strict);
    refused({ ...j, withdrawn: [ok[0], ok[0]] }, "schema", /^withdrawn is not sorted by manifest and distinct/, strict);
    refused(without, "schema", /^root\.json lacks withdrawn/, strict);
  }
  // A writer refuses an entry field it does not know; a reader ignores it.
  const extra = { ...j, withdrawn: [{ ...ok[0], why: "bad" }] };
  refused(extra, "schema", /^withdrawn\[0\] holds the unknown field\(s\) why/);
  assert.equal(validateRoot(extra, { strict: false }).withdrawn.length, 1);
});

test("root: a live pack whose manifest withdrawn lists is refused, by a writer and a reader alike", () => {
  const j = plain(sample());
  const named = datasetsOf(j).names[1] as PackEntry;
  for (const strict of [true, false]) {
    refused(
      { ...j, withdrawn: [{ manifest: named.manifest, at: NOW }] },
      "withdrawn",
      /^datasets\.names\[1\] names the manifest sha256:[0-9a-f]{64}, which withdrawn lists \(at 2026-10-29T08:00:00Z\): a withdrawn pack is not live/,
      strict,
    );
  }
});

test("live set: packs out of span order are refused", () => {
  const j = plain(sample());
  const names = datasetsOf(j).names;
  [names[0], names[1]] = [names[1] as PackEntry, names[0] as PackEntry];
  refused(rederive(j), "live-set", /names-d-20261026 .* is listed after names:names-d-20261027/);
});

test("live set: at an equal start the higher tier is listed first, whatever the repositories (rev sorts after obs)", () => {
  const first = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z" });
  const r = buildRoot({ live: live(first), psl: PSL_LIVE, now: NOW, add: [pack("rev", "seg", "2026-10-28T05:00:00Z", { sources: ["oi-cs"] }), pack("rev", "h", "2026-10-28T05:00:00Z")] });
  assert.deepEqual(
    r.datasets.rev?.map((p) => [p.repo.split("/").at(-1), p.tier]),
    [
      ["rev", "h"],
      ["obs", "seg"],
    ],
  );
  // The repository order alone would list the segment first: refused.
  const j = plain(r);
  datasetsOf(j).rev.reverse();
  refused(j, "live-set", /rev:\S+ \(h, 2026-10-28T05:00:00Z .* is listed after obs:oi-cs\.20261028t050000z\.20261028t051000z .*: the packs are listed by span start, then the higher tier first/);
});

test("live set: a long segment reaches past the hole between two shorter packs, and a later overlap of one source is found past a pack between", () => {
  const first = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z" });
  // THC's day segment covers hours 01 to 04 and 06 to 08, which no hour pack of oi-cs does.
  const reach = buildRoot({
    live: live(first),
    psl: PSL_LIVE,
    now: NOW,
    add: [
      pack("names", "d", "2026-10-27T00:00:00Z"),
      pack("names", "h", "2026-10-28T00:00:00Z", { sources: ["oi-cs"] }),
      pack("names", "seg", "2026-10-28T00:00:00Z", { end: "2026-10-29T00:00:00Z", sources: ["thc-ct"] }),
      pack("names", "h", "2026-10-28T05:00:00Z", { sources: ["oi-cs"] }),
      pack("names", "h", "2026-10-28T09:00:00Z", { sources: ["oi-cs"] }),
    ],
  });
  assert.equal(validateRoot(plain(reach)).counts.names?.packs, 5);
  // A second thc-ct segment at 12:00 overlaps the day segment, with an oi-cs hour listed between them.
  const k = plain(reach);
  datasetsOf(k).names = datasetsOf(k).names.filter((p) => p.span.start < "2026-10-28T05:00:00Z");
  datasetsOf(k).names.push(pack("names", "h", "2026-10-28T01:00:00Z", { sources: ["oi-cs"] }).pack, pack("names", "seg", "2026-10-28T12:00:00Z", { sources: ["thc-ct"] }).pack);
  refused(rederive(k), "live-set", /obs:thc-ct\.20261028t000000z\.20261029t000000z .* and obs:thc-ct\.20261028t120000z\.20261028t121000z .* overlap and share a source/);
});

test("live set: one manifest named by two packs is refused across datasets", () => {
  const j = plain(sample());
  datasetsOf(j).feed[0] = { ...datasetsOf(j).feed[0], manifest: datasetsOf(j).names[0].manifest } as PackEntry;
  // feed comes first in key order, so the names pack is the second to name it.
  refused(rederive(j), "live-set", /^datasets\.names\[0\] names the manifest sha256:[0-9a-f]{64}, which datasets\.feed\[0\] names too/);
});

test("pack: a compacted pack spans its whole tier unit, aligned, under its own tag", () => {
  const short = plain(sample());
  const f = datasetsOf(short).feed[0] as PackEntry;
  datasetsOf(short).feed[0] = { ...f, span: { start: f.span.start, end: "2026-10-27T12:00:00Z" } };
  refused(rederive(short), "pack", /a pack of tier d spans one unit: 2026-10-27T00:00:00Z to 2026-10-28T00:00:00Z, not to 2026-10-27T12:00:00Z/);
  const tagged = plain(sample());
  datasetsOf(tagged).feed[0] = { ...(datasetsOf(tagged).feed[0] as PackEntry), tag: "feed-d-20261028" };
  refused(rederive(tagged), "pack", /the tag of a feed pack of tier d from 2026-10-27T00:00:00Z is feed-d-20261027, not feed-d-20261028/);
  const misaligned = plain(sample());
  const g = datasetsOf(misaligned).feed[0] as PackEntry;
  datasetsOf(misaligned).feed[0] = { ...g, span: { start: "2026-10-27T01:00:00Z", end: "2026-10-28T01:00:00Z" } };
  refused(rederive(misaligned), "pack", /is not the start of a day/);
  const repo = plain(sample());
  datasetsOf(repo).feed[0] = { ...(datasetsOf(repo).feed[0] as PackEntry), repo: "pkgforge-dev/domains.pkgforge.dev/names" };
  refused(rederive(repo), "pack", /a feed pack lives in pkgforge-dev\/domains\.pkgforge\.dev\/feed/);
});

test("pack: a compacted pack's tag is its span's tag, or a rebuild of it with -rN, N from 2; every other tag is refused", () => {
  // Feed's day 2026-10-27 of the sample, under `tag`.
  const plant = (tag: string) => {
    const j = plain(sample());
    datasetsOf(j).feed[0] = { ...(datasetsOf(j).feed[0] as PackEntry), tag };
    return rederive(j);
  };
  // A writer and a reader (the Worker's) accept each build of the span alike.
  for (const strict of [true, false]) {
    for (const tag of ["feed-d-20261027", "feed-d-20261027-r2", "feed-d-20261027-r3", "feed-d-20261027-r10"]) {
      assert.equal(validateRoot(plant(tag), { strict }).datasets.feed?.[0]?.tag, tag);
    }
  }
  // The rebuild of another span, tier or dataset, and a tag that is no tier tag.
  for (const tag of ["feed-d-20261028-r2", "feed-h-2026102700-r2", "new-name-d-20261027-r2", "names-d-20261027-r2", "feed-d-20261027x", "latest"]) {
    for (const strict of [true, false]) {
      refused(
        plant(tag),
        "pack",
        new RegExp(`the tag of a feed pack of tier d from 2026-10-27T00:00:00Z is feed-d-20261027, not ${tag}; a rebuild of the span adds -rN to it, N from 2 \\(ruling 25\\)$`),
        strict,
      );
    }
  }
  // A suffix of another form: checkTag refuses it before the span is read.
  refused(plant("feed-d-20261027-r1"), "pack", /feed-d-20261027-r1 carries -r1: a rebuild of a span is -r2, -r3 and up, with no leading zero, and the first build carries no suffix/);
  refused(plant("feed-d-20261027-r02"), "pack", /feed-d-20261027-r02 carries -r02: a rebuild of a span is -r2/);
  refused(plant("feed-d-20261027-r0"), "pack", /feed-d-20261027-r0 carries -r0: a rebuild of a span is -r2/);
  refused(plant("feed-d-20261027-r2-r3"), "pack", /carries the rebuild suffix -r3, which only a tier tag takes/);
  // A segment keeps its own form: a rebuild suffix on its tag is refused.
  const j = plain(sample());
  const seg = pack("names", "seg", "2026-10-28T05:00:00Z", { sources: ["thc-ct"] }).pack;
  const names = datasetsOf(j).names;
  names.splice(names.findIndex((p) => p.tag === "names-h-2026102805") + 1, 0, { ...seg, tag: `${seg.tag}-r2` });
  refused(rederive(j), "pack", /thc-ct\.20261028t050000z\.20261028t051000z-r2 carries the rebuild suffix -r2, which only a tier tag takes/);
});

test("pack: a week, a month and a year span their calendar unit, written here as literals, never computed", () => {
  // One pack of `tier` from `start` to `end`, alone in a first root.
  const one = (tier: "w" | "m" | "y", start: string, end: string) => {
    const p = pack("names", tier, start).pack;
    return buildRoot({ live: null, psl: PSL_LIVE, now: NOW, add: [{ dataset: "names", pack: { ...p, span: { start, end } } }] });
  };
  // The ISO week of 2026-10-26 ends in November; October has 31 days; 2026 has 365.
  assert.equal(one("w", "2026-10-26T00:00:00Z", "2026-11-02T00:00:00Z").as_of, "2026-11-02T00:00:00Z");
  assert.equal(one("m", "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z").as_of, "2026-11-01T00:00:00Z");
  assert.equal(one("y", "2026-01-01T00:00:00Z", "2027-01-01T00:00:00Z").as_of, "2027-01-01T00:00:00Z");
  for (const [tier, start, end] of [
    ["w", "2026-10-26T00:00:00Z", "2026-11-01T00:00:00Z"],
    ["m", "2026-10-01T00:00:00Z", "2026-11-02T00:00:00Z"],
    ["y", "2026-01-01T00:00:00Z", "2027-01-02T00:00:00Z"],
  ] as const) {
    assert.throws(
      () => one(tier, start, end),
      (e: unknown) => e instanceof RootError && e.code === "pack" && new RegExp(`a pack of tier ${tier} spans one unit: .* not to ${end}`).test(e.message),
      `${tier} ${start} to ${end}`,
    );
  }
});

test("pack: a segment lives in the obs package, and its span ends after it starts", () => {
  const plant = (change: Partial<PackEntry>) => {
    const j = plain(sample());
    const s = { ...pack("names", "seg", "2026-10-28T05:00:00Z", { sources: ["thc-ct"] }).pack, ...change };
    const names = datasetsOf(j).names;
    names.splice(names.findIndex((p) => p.tag === "names-h-2026102805") + 1, 0, s);
    return rederive(j);
  };
  assert.equal(validateRoot(plant({})).counts.names?.packs, 27);
  refused(plant({ repo: "pkgforge-dev/domains.pkgforge.dev/names" }), "pack", /a segment lives in pkgforge-dev\/domains\.pkgforge\.dev\/obs, not pkgforge-dev\/domains\.pkgforge\.dev\/names/);
  refused(plant({ span: { start: "2026-10-28T05:00:00Z", end: "2026-10-28T05:00:00Z" } }), "pack", /span 2026-10-28T05:00:00Z to 2026-10-28T05:00:00Z does not end after it starts/);
});

test("pack: a tag that is not a string is refused, a segment's as a compacted pack's, by a writer and a reader alike", () => {
  // A segment's tag meets checkTag alone: no tier tag is compared with it.
  const segment = (tag: unknown) => {
    const j = plain(sample());
    const s = { ...pack("names", "seg", "2026-10-28T05:00:00Z", { sources: ["thc-ct"] }).pack, tag };
    const names = datasetsOf(j).names;
    names.splice(names.findIndex((p) => p.tag === "names-h-2026102805") + 1, 0, s as PackEntry);
    return rederive(j);
  };
  const day = (tag: unknown) => {
    const j = plain(sample());
    datasetsOf(j).feed[0] = { ...(datasetsOf(j).feed[0] as PackEntry), tag } as PackEntry;
    return rederive(j);
  };
  const seg = "thc-ct.20261028t050000z.20261028t051000z";
  // A RegExp would read each of these as a string that matches the tag
  // grammar: "null", "12", "true", and the one tag the list holds.
  for (const strict of [true, false]) {
    assert.equal(validateRoot(segment(seg), { strict }).counts.names?.packs, 27);
    refused(segment(null), "pack", /^datasets\.names\[\d+\]: null is not a tag/, strict);
    refused(segment(12), "pack", /^datasets\.names\[\d+\]: 12 is not a tag/, strict);
    refused(segment(true), "pack", /^datasets\.names\[\d+\]: true is not a tag/, strict);
    refused(segment([seg]), "pack", /^datasets\.names\[\d+\]: \["thc-ct\.20261028t050000z\.20261028t051000z"\] is not a tag/, strict);
    refused(day(null), "pack", /^datasets\.feed\[0\]: null is not a tag/, strict);
    refused(day(["feed-d-20261027"]), "pack", /^datasets\.feed\[0\]: \["feed-d-20261027"\] is not a tag/, strict);
  }
});

test("pack: its bytes, its key bounds and its sources are held to their rules", () => {
  const plant = (change: Partial<PackEntry>) => {
    const j = plain(sample());
    datasetsOf(j).feed[0] = { ...(datasetsOf(j).feed[0] as PackEntry), ...change };
    return rederive(j);
  };
  refused(plant({ pack: { sha256: "1".repeat(64), bytes: 1201 } }), "pack", /its parts and index hold 1200 B, and pack\.bytes says 1201/);
  refused(plant({ count: 0 }), "pack", /a pack of no record has key_min and key_max null/);
  refused(plant({ key_min: "com.z", key_max: "com.a" }), "pack", /key_min is above key_max/);
  refused(plant({ key_min: "COM.example" }), "pack", /key_min and key_max are not keys of feed/);
  refused(plant({ sources: ["oi-nrd", "isc-new"] }), "pack", /sources are not sorted and distinct/);
  refused(plant({ parts: [] }), "pack", /parts is not a list of 1 to 65535 blobs/);
  refused(plant({ manifest: "sha256:abc" }), "pack", /manifest is not a sha256: digest/);
  // A pack of no record, its bounds null, is a valid entry (a source's empty day).
  assert.equal(validateRoot(plant({ count: 0, key_min: null, key_max: null })).counts.feed?.records, 0);
});

test("pack: a feed or new-name pack may list its time copy as { idx, parts }; another dataset, null, or another shape is refused", () => {
  const timed = pack("feed", "d", "2026-10-27T00:00:00Z", { sources: ["oi-nrd"], time: true }).pack;
  const plant = (time: unknown, at: "feed" | "names" = "feed") => {
    const j = plain(sample());
    const list = datasetsOf(j)[at];
    list[0] = { ...(list[0] as PackEntry), time } as PackEntry;
    return rederive(j);
  };
  assert.deepEqual(validateRoot(plant(timed.time)).datasets.feed?.[0].time, timed.time);
  // new-name too, and a pack with no time copy leaves the field out.
  const nn = plain(sample());
  datasetsOf(nn)["new-name"] = [pack("new-name", "d", "2026-10-27T00:00:00Z", { sources: ["oi-nrd"], time: true }).pack];
  assert.equal(validateRoot(rederive(nn)).datasets["new-name"]?.[0].time?.parts.length, 1);
  // A day pack that holds records lists its time copy: a writer refuses one
  // that lists none, and a reader leaves that to readFeed. A pack of no
  // record has none to list.
  const untimed = (at: "feed" | "new-name", count = 10) => {
    const j = plain(sample());
    datasetsOf(j)[at] = [pack(at, "d", "2026-10-27T00:00:00Z", { sources: ["oi-nrd"], time: false, count }).pack];
    return rederive(j);
  };
  for (const at of ["feed", "new-name"] as const) {
    refused(untimed(at), "pack", new RegExp(`datasets\\.${at}\\[0\\]: a ${at} pack of tier d holds 10 records and no time copy; a pack of tier d, w, m, y is read through its time copy`));
    assert.equal(Object.hasOwn(validateRoot(untimed(at), { strict: false }).datasets[at]?.[0] ?? {}, "time"), false);
    assert.equal(Object.hasOwn(validateRoot(untimed(at, 0)).datasets[at]?.[0] ?? {}, "time"), false);
  }
  // An hour pack and a segment may have none: they are read from the key copy and sorted.
  const hour = plain(sample());
  datasetsOf(hour)["new-name"] = [pack("new-name", "h", "2026-10-27T00:00:00Z", { sources: ["oi-nrd"] }).pack];
  assert.equal(Object.hasOwn(validateRoot(rederive(hour)).datasets["new-name"]?.[0] ?? {}, "time"), false);
  refused(plant(timed.time, "names"), "pack", /datasets\.names\[0\]: a names pack lists a time copy; only feed and new-name packs carry one/);
  refused(plant(null), "pack", /datasets\.feed\[0\]: time is null, not \{ idx, parts \}; a pack with no time copy leaves the field out/);
  // A reader refuses both as well: the field is known, and its rules are not unknown fields.
  refused(plant(timed.time, "names"), "pack", /a names pack lists a time copy/, false);
  refused(plant(null), "pack", /time is null/, false);
  refused(plant({ idx: timed.time?.idx }), "schema", /datasets\.feed\[0\] time lacks parts/);
  const idx = timed.time?.idx;
  const part = timed.time?.parts[0];
  refused(plant({ idx: { ...idx, size: 63 }, parts: [part] }), "pack", /time\.idx is not \{ digest: sha256:<64 hex>, size: a whole number of at least 64 \}/);
  refused(plant({ idx, parts: [] }), "pack", /time\.parts is not a list of 1 to 65535 blobs/);
  refused(plant({ idx, parts: [{ ...part, size: 15 }] }), "pack", /time\.parts\[0\] is not \{ digest: sha256:<64 hex>, size: a whole number of at least 16 \}/);
  refused(plant({ idx, parts: [{ ...part, digest: "sha256:abc" }] }), "pack", /time\.parts\[0\] is not \{ digest/);
  // A writer refuses a field of time it does not know; a reader ignores it.
  refused(plant({ idx, parts: [part], rows: 10 }), "schema", /datasets\.feed\[0\] time holds the unknown field\(s\) rows/);
  assert.equal(validateRoot(plant({ idx, parts: [part], rows: 10 }), { strict: false }).root_seq, 2);
});

test("root: the gaps are sorted days of source ids", () => {
  const j = plain(sample());
  assert.deepEqual(validateRoot({ ...j, gaps: { "thc-ct": ["2026-10-04", "2026-10-09"] } }).gaps, { "thc-ct": ["2026-10-04", "2026-10-09"] });
  refused({ ...j, gaps: { "thc-ct": ["2026-10-09", "2026-10-04"] } }, "schema", /gaps\.thc-ct is not sorted and distinct/);
  refused({ ...j, gaps: { "thc-ct": ["2026-02-30"] } }, "schema", /is not a calendar time/);
  refused({ ...j, gaps: { THC: ["2026-10-04"] } }, "schema", /gaps names "THC"/);
});

test("root: canonical JSON orders keys, so field order never decides equality", () => {
  assert.equal(canonical({ b: 1, a: [{ d: 2, c: 3 }] }), canonical({ a: [{ c: 3, d: 2 }], b: 1 }));
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});
