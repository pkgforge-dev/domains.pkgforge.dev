// packages/feed/src/plan.ts: the packs a window reads and the key range of
// suffix and under. The live sets are synthetic: tags, spans and key bounds, no
// pack bytes; except the root test, which plans over the datasets of a root
// that @domains/root builds from the manifests of two real feed packs written
// to memory, whose manifest digests, writer and PSL hash are synthetic.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { artifactType, packageOfDataset, repoOf, tierTag } from "@domains/ghcr";
import { type FeedRecord, IDX_TITLE, packAnnotations, parseHead, partTitle, TIME_IDX_TITLE, timePartTitle, VERIFY_ANNOTATIONS } from "@domains/pack";
import { buildRoot, type ManifestFacts, packFromManifest, TIER_ANNOTATION, TIME_COPY_TIERS as ROOT_TIME_COPY_TIERS } from "@domains/root";
import { compareRows, FeedError, inRange, inWindow, keyRangeOf, type LivePack, planWindow, readFeed, TIME_COPY_TIERS } from "../src/index.ts";
import { BIT, D, DAY, HOUR, iso, type MemFeed, memoryOpen, row, table, writeFeed } from "./helpers.ts";

const isFeed = (code: string) => (e: unknown) => e instanceof FeedError && e.code === code;
const pack = (tag: string, tier: string, t0: number, t1: number, keyMin: string | null = "com.a", keyMax: string | null = "uk.co.z"): LivePack => ({
  tag,
  tier,
  span: { start: iso(t0), end: iso(t1) },
  key_min: keyMin,
  key_max: keyMax,
});

// 2026-10-25 and 2026-10-26 as day packs, the hours 00 to 11 of 2026-10-27 as
// hour packs, and six 10-minute segments from 12:00 to 13:00.
const D27 = 299 * DAY;
const NOW = D27 + 13 * HOUR;
const days = [297, 298].map((d) => pack(`feed-d-202610${d - 272}`, "d", d * DAY, (d + 1) * DAY));
const hours = Array.from({ length: 12 }, (_, h) => pack(`feed-h-20261027${String(h).padStart(2, "0")}`, "h", D27 + h * HOUR, D27 + (h + 1) * HOUR));
const segments = Array.from({ length: 6 }, (_, s) => pack(`seg-${s}`, "seg", D27 + 12 * HOUR + s * 600, D27 + 12 * HOUR + (s + 1) * 600));
// The root lists them in no particular order.
const live = { feed: [...segments, ...days.reverse(), ...hours] };
const tags = (since: number) => planWindow(live, { t0: NOW - since, t1: NOW }).packs.map((p) => p.pack.tag);

test("plan: windows of 1 h, 6 h, 12 h, 1 d and 3 d read the live packs they overlap, oldest first", () => {
  const seg = segments.map((p) => p.tag);
  const hourTags = (from: number) => hours.slice(from).map((p) => p.tag);
  assert.deepEqual(tags(HOUR), seg, "1 h: the segments of the open hour");
  assert.deepEqual(tags(6 * HOUR), [...hourTags(7), ...seg], "6 h: hours 07 to 11 and the segments");
  assert.deepEqual(tags(12 * HOUR), [...hourTags(1), ...seg], "12 h: hours 01 to 11 and the segments");
  assert.deepEqual(tags(DAY), ["feed-d-20261026", ...hourTags(0), ...seg], "1 d: the day before, every hour and the segments");
  assert.deepEqual(tags(3 * DAY), ["feed-d-20261025", "feed-d-20261026", ...hourTags(0), ...seg], "3 d: both days; nothing before the corpus");
  const plan = planWindow(live, { t0: NOW - HOUR, t1: NOW });
  assert.equal(plan.dataset, "feed");
  assert.deepEqual(plan.packs[0].span, { t0: D27 + 12 * HOUR, t1: D27 + 12 * HOUR + 600 });
  // A window that ends where a pack starts does not read it: spans are half-open.
  assert.deepEqual(
    planWindow(live, { t0: D27, t1: D27 + HOUR }).packs.map((p) => p.pack.tag),
    ["feed-h-2026102700"],
  );
});

test("plan: suffix is an exact public suffix: np.com, co.uk and com keep their registrable domains and no other", () => {
  const comNp = keyRangeOf({ suffix: "com.np" });
  assert.deepEqual([comNp.lo, comNp.hi, comNp.labels], ["np.com.", "np.com/", 3]);
  const keep = (range: ReturnType<typeof keyRangeOf>, keys: string[]) => keys.filter((k) => inRange(range, k));
  assert.deepEqual(keep(comNp, ["np.com.example", "np.org.example", "np.com", "np.com-x.y", "np.example", "np.com.example.www"]), ["np.com.example"]);
  const coUk = keyRangeOf({ suffix: "co.uk" });
  assert.deepEqual(keep(coUk, ["uk.co.example", "uk.example", "uk.co", "uk.com.example", "uk.co-op.example"]), ["uk.co.example"]);
  const com = keyRangeOf({ suffix: "com" });
  assert.deepEqual(keep(com, ["com.example", "np.com.example", "com.example.www", "comx.a", "com-x.a"]), ["com.example"]);
  // suffix=np is `.np` itself: example.com.np has the suffix com.np.
  assert.deepEqual(keep(keyRangeOf({ suffix: "np" }), ["np.example", "np.com.example"]), ["np.example"]);
  // A new-name row is any name: for kind fqdn the range is every name below.
  assert.deepEqual(keep(keyRangeOf({ suffix: "com.np", kind: "fqdn" }), ["np.com.example", "np.com.example.www", "np.org.x"]), ["np.com.example", "np.com.example.www"]);
});

test("plan: under is the parent itself and every name below it, and with suffix both must hold", () => {
  const np = keyRangeOf({ under: "np" });
  assert.deepEqual([np.lo, np.hi], ["np", "np/"]);
  const keep = (range: ReturnType<typeof keyRangeOf>, keys: string[]) => keys.filter((k) => inRange(range, k));
  assert.deepEqual(keep(np, ["np", "np.example", "np.com.example", "np-x.a", "npx.a", "no.a"]), ["np", "np.example", "np.com.example"]);
  const reg = keyRangeOf({ under: "example.com.np" });
  assert.deepEqual(keep(reg, ["np.com.example", "np.com.example-two", "np.com.example.www", "np.com.exampl"]), ["np.com.example", "np.com.example.www"]);
  const both = keyRangeOf({ suffix: "com.np", under: "example.com.np" });
  assert.deepEqual([both.lo, both.hi], ["np.com.example", "np.com.example/"]);
  assert.deepEqual(keep(both, ["np.com.example", "np.com.example.www", "np.com.other"]), ["np.com.example"]);
  const none = keyRangeOf({});
  assert.deepEqual([none.lo, none.hi], [null, null]);
  assert.equal(inRange(none, "anything.at.all"), true);
  for (const bad of ["COM.np", "a..b", "ex ample.com", ""]) assert.throws(() => keyRangeOf({ suffix: bad }), isFeed("range"), bad);
});

test("plan: a pack whose key bounds miss the range, or that holds no record, is not read", () => {
  const set = {
    feed: [pack("only-uk", "d", 297 * DAY, 298 * DAY, "uk.a", "uk.z"), pack("empty", "d", 298 * DAY, 299 * DAY, null, null), pack("has-np", "h", D27, D27 + HOUR, "com.a", "np.zz")],
  };
  const plan = planWindow(set, { t0: 297 * DAY, t1: NOW, suffix: "com.np" });
  assert.deepEqual(
    plan.packs.map((p) => p.pack.tag),
    ["has-np"],
  );
  assert.deepEqual(
    planWindow(set, { t0: 297 * DAY, t1: NOW }).packs.map((p) => p.pack.tag),
    ["only-uk", "has-np"],
  );
});

test("plan: the key bounds hold at their edges: a pack whose last key is the parent is read, one wholly below a suffix is not", () => {
  const one = (keyMin: string, keyMax: string, query: { under?: string; suffix?: string }) =>
    planWindow({ feed: [pack("p", "d", 298 * DAY, 299 * DAY, keyMin, keyMax)] }, { t0: 298 * DAY, t1: 299 * DAY, ...query }).packs.map((p) => p.pack.tag);
  // under=np starts at the key `np` itself: a pack that ends there holds it.
  assert.deepEqual(one("com.a", "np", { under: "np" }), ["p"]);
  // suffix=np is the keys from `np.`: a pack that ends at com.z holds none.
  assert.deepEqual(one("com.a", "com.z", { suffix: "np" }), []);
  // And one that starts at the end of the range, `np/`, holds none either.
  assert.deepEqual(one("np/", "uk.z", { suffix: "np" }), []);
});

// The manifest facts of a feed pack written to memory, as GHCR and the index
// heads give them to packFromManifest of @domains/root: its layers part.NNN and
// idx, and time.part.NNN and time.idx when it has a time copy, each with the
// digest and size of its own bytes; the annotations of section 4.2, `count`,
// `bytes` and `sha256` the pack's own; and both heads, parsed from the index
// bytes. The manifest digest, the writer and the PSL hash are synthetic.
const sha = (bytes: Uint8Array) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const TITLE = "org.opencontainers.image.title";
function manifestFacts(tier: "d" | "h", start: number, end: number, mem: MemFeed, sources: string[]): ManifestFacts {
  const layer = (title: string, bytes: Uint8Array) => ({ mediaType: "application/octet-stream", digest: sha(bytes), size: bytes.length, annotations: { [TITLE]: title } });
  const layers = [...mem.parts.map((p, i) => layer(partTitle(i), p)), layer(IDX_TITLE, mem.summary.idx)];
  if (mem.time !== null) layers.push(...mem.time.parts.map((p, i) => layer(timePartTitle(i), p)), layer(TIME_IDX_TITLE, mem.time.summary.idx));
  const headOf = (idx: Uint8Array) => {
    const h = parseHead(idx, idx.length);
    return { dataset: h.header.dataset, records: h.header.records, keyMin: h.keyMin, keyMax: h.keyMax, parts: h.parts.map((p) => p.bytes) };
  };
  return {
    repo: repoOf(packageOfDataset("feed")),
    tag: tierTag("feed", tier, iso(start)),
    digest: `sha256:${createHash("sha256").update(`synthetic manifest ${tier} ${start}`).digest("hex")}`,
    json: {
      artifactType: artifactType("pack"),
      annotations: {
        ...packAnnotations(mem.summary, "synthetic writer"),
        [TIER_ANNOTATION]: tier,
        [VERIFY_ANNOTATIONS.spanStart]: iso(start),
        [VERIFY_ANNOTATIONS.spanEnd]: iso(end),
        [VERIFY_ANNOTATIONS.source]: sources.join(","),
        [VERIFY_ANNOTATIONS.psl]: "e".repeat(64),
      },
      layers,
    },
    head: headOf(mem.summary.idx),
    timeHead: mem.time === null ? null : headOf(mem.time.summary.idx),
  };
}

test("plan: a root that buildRoot of @domains/root builds from the packs' manifests lists the day pack's time copy, and readFeed reads it", async () => {
  // A day pack of 2026-10-26 with its time copy, and an hour pack of
  // 2026-10-27T00 with none; their entries come from packFromManifest.
  const dayRows: FeedRecord[] = [row("com.day-a", D * DAY, { sources: [BIT.isc] }), row("com.day-b", D * DAY + 20 * HOUR), row("np.com.day-c", D * DAY + 23 * HOUR)];
  const hourRows: FeedRecord[] = [row("com.hour-a", (D + 1) * DAY + 60), row("net.hour-b", (D + 1) * DAY + 120)];
  const day = await writeFeed(dayRows);
  const hour = await writeFeed(hourRows, { time: false });
  const root = buildRoot({
    live: null,
    add: [packFromManifest(manifestFacts("d", D * DAY, (D + 1) * DAY, day, ["isc-new", "oi-nrd"])), packFromManifest(manifestFacts("h", (D + 1) * DAY, (D + 1) * DAY + HOUR, hour, ["oi-nrd"]))],
    psl: "e".repeat(64),
    now: "2026-10-27T01:05:00Z",
  });
  assert.ok(Array.isArray(root.datasets.feed), "root.json lists a dataset's packs as the list itself");
  const [dayEntry, hourEntry] = root.datasets.feed ?? [];
  assert.deepEqual(dayEntry.time, {
    idx: { digest: sha(day.time?.summary.idx ?? new Uint8Array()), size: day.time?.summary.idx.length },
    parts: day.time?.parts.map((p) => ({ digest: sha(p), size: p.length })),
  });
  assert.equal(Object.hasOwn(hourEntry, "time"), false);
  const plan = planWindow(root.datasets, { t0: (D + 1) * DAY + HOUR - DAY, t1: (D + 1) * DAY + HOUR });
  assert.deepEqual(
    plan.packs.map((p) => p.pack.tag),
    ["feed-d-20261026", "feed-h-2026102700"],
  );
  const packs = new Map([
    ["feed-d-20261026", day],
    ["feed-h-2026102700", hour],
  ]);
  const page = await readFeed(plan, { open: memoryOpen(packs), table, order: "first_seen.desc" });
  // Newest first: the hour pack from its key copy, then the day pack from its time copy.
  assert.deepEqual(page.stats.copiesRead, ["key", "time"]);
  assert.ok(page.stats.timeBlocksRead > 0, "the day pack's time copy was read");
  const want = [...dayRows, ...hourRows].filter((r) => inWindow(r, plan.window, table.precision)).sort((a, b) => compareRows(b, a));
  assert.deepEqual(page.rows, want);
  assert.deepEqual(
    want.map((r) => r.key),
    ["net.hour-b", "com.hour-a", "np.com.day-c", "com.day-b", "com.day-a"],
  );
});

test("plan: a pack's time copy is { idx, parts } of digests and sizes, or null or absent; any other shape is refused", () => {
  const window = { t0: 298 * DAY, t1: 299 * DAY };
  const blob = (c: string, size: number) => ({ digest: `sha256:${c.repeat(64)}`, size });
  const time = { idx: blob("a", 200), parts: [blob("b", 4000), blob("c", 3000)] };
  const withTime = (t: unknown): LivePack => ({ ...pack("f", "d", 298 * DAY, 299 * DAY), time: t as LivePack["time"] });
  assert.deepEqual(planWindow({ feed: [withTime(time)] }, window).packs[0].pack.time, time);
  for (const ok of [null, undefined]) assert.equal(planWindow({ feed: [withTime(ok)] }, window).packs.length, 1, String(ok));
  for (const bad of [
    {},
    "time.idx",
    { idx: blob("a", 200), parts: [] },
    { idx: blob("a", 200) },
    { idx: { digest: "sha256:abc", size: 200 }, parts: [blob("b", 4000)] },
    { idx: blob("a", 63), parts: [blob("b", 4000)] },
    { idx: blob("a", 200), parts: [blob("b", 15)] },
    { idx: blob("a", 200), parts: [{ digest: `sha256:${"b".repeat(64)}`, size: 1.5 }] },
  ])
    assert.throws(() => planWindow({ feed: [withTime(bad)] }, window), isFeed("live"), JSON.stringify(bad));
});

test("plan: a live set not of root.json's shape is refused, never read as empty", () => {
  const listed = [pack("f", "d", 298 * DAY, 299 * DAY)];
  const window = { t0: 298 * DAY, t1: 299 * DAY };
  // The shape this planner once took, { packs: [...] }: refused, not 0 packs.
  assert.throws(() => planWindow({ feed: { packs: listed } } as never, window), isFeed("live"));
  for (const bad of [{ feed: "feed-d-20261026" }, { feed: null }, { feed: {} }]) assert.throws(() => planWindow(bad as never, window), isFeed("live"), JSON.stringify(bad));
  for (const bad of [null, [listed], "datasets"]) assert.throws(() => planWindow(bad as never, window), isFeed("live"), JSON.stringify(bad));
  // A dataset the root does not list has no live pack.
  assert.deepEqual(planWindow({ "new-name": listed }, window).packs, []);
  assert.deepEqual(planWindow({ feed: listed }, window).packs.length, 1);
});

test("plan: kind fqdn reads the new-name packs, and a live set that breaks the rules is refused", () => {
  const set = { feed: [pack("f", "d", 298 * DAY, 299 * DAY)], "new-name": [pack("n", "d", 298 * DAY, 299 * DAY)] };
  assert.deepEqual(
    planWindow(set, { t0: 298 * DAY, t1: 299 * DAY, kind: "fqdn" }).packs.map((p) => p.pack.tag),
    ["n"],
  );
  assert.equal(planWindow(set, { t0: 298 * DAY, t1: 299 * DAY, kind: "fqdn" }).dataset, "new-name");
  assert.deepEqual(planWindow({}, { t0: 0, t1: 1 }).packs, []);
  const overlap = { feed: [pack("a", "d", 298 * DAY, 299 * DAY), pack("b", "h", 298 * DAY + HOUR, 298 * DAY + 2 * HOUR)] };
  assert.throws(() => planWindow(overlap, { t0: 0, t1: 400 * DAY }), isFeed("live"));
  const backwards = { feed: [pack("a", "d", 299 * DAY, 298 * DAY)] };
  assert.throws(() => planWindow(backwards, { t0: 0, t1: 400 * DAY }), isFeed("live"));
  const badSpan = { feed: [{ ...pack("a", "d", 298 * DAY, 299 * DAY), span: { start: "2026-10-26", end: "tomorrow" } }] };
  assert.throws(() => planWindow(badSpan, { t0: 0, t1: 400 * DAY }), isFeed("live"));
  const halfBounds = { feed: [pack("a", "d", 298 * DAY, 299 * DAY, null, "com.z")] };
  assert.throws(() => planWindow(halfBounds, { t0: 0, t1: 400 * DAY }), isFeed("live"));
  for (const [t0, t1] of [
    [5, 5],
    [6, 5],
    [-1, 5],
    [0.5, 5],
  ])
    assert.throws(() => planWindow(set, { t0, t1 }), isFeed("window"), `${t0} ${t1}`);
  assert.throws(() => planWindow(set, { t0: 0, t1: 1, kind: "names" as never }), isFeed("usage"));
});

test("plan: the tiers readFeed reads through a time copy are the tiers whose packs @domains/root refuses to name without one", () => {
  // Two lists, one rule: a root that named such a pack with no time copy would
  // fail every page over it, and readFeed would sort a pack the root never checked.
  assert.deepEqual([...TIME_COPY_TIERS], [...ROOT_TIME_COPY_TIERS]);
});
