// packages/feed/src/read.ts: pages of rows in first_seen order across the live
// packs of a window, through the time copy or the key copy and a sort in
// memory, with cursors, filters, day precision and the block budget. Real packs
// in memory (DOM-017's writer and reader, node:zlib at level 9). The rows of the
// order tests are synthetic; the filter test uses the recorded OpenINTEL
// payloads (helpers.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  FEED_CODEC,
  FEED_PROVISIONAL,
  FEED_SUSPECT,
  FEED_SUSPECT_CERT,
  FEED_TIME_CODEC,
  type FeedRecord,
  MemorySink,
  NEW_NAME_CODEC,
  NEW_NAME_TIME_CODEC,
  PackReader,
  partsSource,
} from "@domains/pack";
import { nodeCompress } from "@domains/pack/node";
import {
  buildFeedDay,
  type CopyChoice,
  compareRows,
  describeRow,
  type FeedCursor,
  FeedError,
  type FeedFilter,
  type FeedOrder,
  type FeedPage,
  inRange,
  inWindow,
  keyCopyFirst,
  type LivePack,
  type OpenedPack,
  planWindow,
  readFeed,
  rowMatches,
  TIME_COPY_TIERS,
  type WindowPlan,
  writeFeedPack,
} from "../src/index.ts";
import type { OiNrdPayload } from "./helpers.ts";
import {
  BIT,
  CONFIRMED_EVENT,
  collect,
  D,
  DAY,
  HOUR,
  isc,
  livePack,
  type MemFeed,
  memoryOpen,
  mergeEvents,
  OLD_CERT_EVENT,
  oiConfirmed,
  oiNrd,
  recorded,
  rng,
  row,
  seen,
  table,
  whoisds,
  writeFeed,
} from "./helpers.ts";

const isFeed = (code: string) => (e: unknown) => e instanceof FeedError && e.code === code;
const byKey = (a: { key: string }, b: { key: string }) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

// n rows of day `d` with synthetic keys: a third at the start of the day from
// a day source (ISC), the rest at a random second of the day.
function dayRows(n: number, seed: number, d = D): FeedRecord[] {
  const next = rng(seed);
  const keys = new Set<string>();
  while (keys.size < n) keys.add(`${["com", "net", "org", "np.com", "uk.co", "np"][Math.floor(next() * 6)]}.syn${Math.floor(next() * 1e9).toString(36)}`);
  return [...keys]
    .sort()
    .map((k) => (next() < 1 / 3 ? row(k, d * DAY, { sources: [BIT.isc] }) : row(k, d * DAY + Math.floor(next() * DAY), { feedFlags: next() < 0.1 ? FEED_SUSPECT | FEED_SUSPECT_CERT : 0 })));
}

// Every page of a read, by cursor, until the reader gives no cursor.
async function allPages(plan: WindowPlan<LivePack>, packs: Map<string, MemFeed>, options: { order: FeedOrder; limit: number; filter?: FeedFilter; copy?: CopyChoice }) {
  const out: FeedRecord[] = [];
  let after: FeedCursor | null = null;
  let pages = 0;
  for (;;) {
    const page: FeedPage = await readFeed(plan, { open: memoryOpen(packs), table, after, ...options });
    out.push(...page.rows);
    pages += 1;
    if (page.next === null) break;
    after = page.next;
    assert.ok(pages < 10_000);
  }
  return { rows: out, pages };
}

// The answer by brute force: every row of every pack, kept and sorted.
function oracle(all: FeedRecord[], plan: WindowPlan<LivePack>, order: FeedOrder, filter: FeedFilter = {}): FeedRecord[] {
  const kept = all.filter((r) => inRange(plan.range, r.key) && inWindow(r, plan.window, table.precision) && rowMatches(r, filter));
  kept.sort(order === "first_seen.asc" ? compareRows : (a, b) => compareRows(b, a));
  return kept;
}

// Each row whole, every field of it, as one line: two pages are equal when they
// hold the same rows in the same order, not only the same (first_seen, key).
const rowsOf = (rows: FeedRecord[]) => rows.map((r) => JSON.stringify([r.firstSeen, r.key, r.flags, r.sources, r.basis, r.confidence, r.feedFlags]));

test("read: a day pack read by its time copy gives the rows of a window in first_seen order, page after page, equal to a sort of every row", async () => {
  const rows = dayRows(1500, 31);
  const day = await writeFeed(rows);
  assert.equal(day.summary.blocks, 24);
  assert.equal(day.time?.summary.blocks, 24);
  const packs = new Map([["feed-d-20261026", day]]);
  const live = { feed: [livePack("feed-d-20261026", "d", D * DAY, (D + 1) * DAY, day)] };
  const windows = [
    [D * DAY, (D + 1) * DAY],
    [D * DAY + 6 * HOUR, D * DAY + 12 * HOUR],
    [D * DAY - 3 * HOUR, D * DAY + 1],
  ];
  for (const [t0, t1] of windows) {
    for (const suffix of [undefined, "np"]) {
      const plan = planWindow(live, { t0, t1, suffix });
      for (const order of ["first_seen.desc", "first_seen.asc"] as const) {
        const want = oracle(rows, plan, order);
        assert.ok(want.length > 0);
        const viaTime = await allPages(plan, packs, { order, limit: 211, copy: "time" });
        assert.deepEqual(rowsOf(viaTime.rows), rowsOf(want), `${order} [${t0}, ${t1}) ${suffix ?? "all"}: time copy`);
        const viaSort = await allPages(plan, packs, { order, limit: 211, copy: "key" });
        assert.deepEqual(rowsOf(viaSort.rows), rowsOf(want), `${order} [${t0}, ${t1}) ${suffix ?? "all"}: key copy and sort`);
        const auto = await allPages(plan, packs, { order, limit: 211 });
        assert.deepEqual(rowsOf(auto.rows), rowsOf(want), `${order} [${t0}, ${t1}) ${suffix ?? "all"}: the rule's choice`);
      }
    }
  }
});

test("read: one page of the time copy reads its blocks in order, each once, from the newest until the page holds its rows, and no block of the key copy", async () => {
  const rows = dayRows(2000, 32);
  const day = await writeFeed(rows);
  const packs = new Map([["d", day]]);
  const plan = planWindow({ feed: [livePack("d", "d", D * DAY, (D + 1) * DAY, day)] }, { t0: D * DAY, t1: (D + 1) * DAY });
  // The time copy in order: position p is in block floor(p / 64).
  const inTime = [...rows].sort(compareRows);
  for (const order of ["first_seen.desc", "first_seen.asc"] as const) {
    for (const limit of [1, 10, 100, 1000]) {
      const page = await readFeed(plan, { open: memoryOpen(packs), table, order, limit });
      const want = oracle(rows, plan, order).slice(0, limit);
      assert.deepEqual(rowsOf(page.rows), rowsOf(want), `${order} limit ${limit}`);
      // It reads from the first row of the order to its last row, suspect rows
      // between them among them: the blocks of those positions.
      const at = inTime.indexOf(want[want.length - 1]);
      const blocks = order === "first_seen.desc" ? Math.floor((inTime.length - 1) / 64) - Math.floor(at / 64) + 1 : Math.floor(at / 64) + 1;
      assert.deepEqual([page.stats.blocksRead, page.stats.timeBlocksRead], [blocks, blocks], `${order} limit ${limit}`);
      assert.deepEqual([page.stats.packsRead, page.stats.copiesRead], [["d"], ["time"]]);
    }
  }
  // The next page starts after the cursor, through the time copy's index.
  const first = await readFeed(plan, { open: memoryOpen(packs), table, limit: 10 });
  const second = await readFeed(plan, { open: memoryOpen(packs), table, limit: 10, after: first.next });
  assert.deepEqual(rowsOf(second.rows), rowsOf(oracle(rows, plan, "first_seen.desc").slice(10, 20)));
  // It reads from the row below the cursor to its own last row: their blocks.
  const from = inTime.findIndex((r) => r.key === first.next?.key) - 1;
  const to = inTime.findIndex((r) => r.key === second.rows[second.rows.length - 1].key);
  assert.equal(second.stats.blocksRead, Math.floor(from / 64) - Math.floor(to / 64) + 1);
});

test("read: a key range reads the key copy and sorts when its blocks are few, and the time copy otherwise, by keyCopyFirst; both give the sort", async () => {
  const rows = dayRows(2000, 36);
  const day = await writeFeed(rows);
  const packs = new Map([["d", day]]);
  const live = { feed: [livePack("d", "d", D * DAY, (D + 1) * DAY, day)] };
  // 2,000 rows at 64 a block: 32 blocks; com is about a sixth of them.
  assert.equal(day.summary.blocks, 32);
  const plan = planWindow(live, { t0: D * DAY, t1: (D + 1) * DAY, under: "com" });
  const reader = await PackReader.open(day.summary.idx, partsSource(day.parts), FEED_CODEC);
  const range = (await reader.index.locate("com/")) - Math.max(0, await reader.index.locate("com")) + 1;
  assert.ok(range >= 4 && range <= 8, String(range));
  for (const [limit, copy] of [
    [1000, "key"],
    [10, "time"],
  ] as const) {
    assert.equal(keyCopyFirst(range, 32, 64, limit), copy === "key", `limit ${limit}`);
    const page = await readFeed(plan, { open: memoryOpen(packs), table, limit });
    assert.deepEqual(page.stats.copiesRead, [copy], `limit ${limit}`);
    assert.deepEqual(rowsOf(page.rows), rowsOf(oracle(rows, plan, "first_seen.desc").slice(0, limit)), `limit ${limit}`);
    if (copy === "key") assert.equal(page.stats.blocksRead, range);
  }
  // A forced copy is the copy read, whatever the rule would choose: the time
  // copy where it chose the key copy, and the key copy where it chose the time.
  for (const [limit, copy] of [
    [1000, "time"],
    [10, "key"],
  ] as const) {
    const page = await readFeed(plan, { open: memoryOpen(packs), table, limit, copy });
    assert.deepEqual(page.stats.copiesRead, [copy], `limit ${limit}, forced ${copy}`);
    assert.deepEqual(rowsOf(page.rows), rowsOf(oracle(rows, plan, "first_seen.desc").slice(0, limit)), `limit ${limit}, forced ${copy}`);
  }
  // The rule at its edge: R * R * r against want * B, the key copy at the tie.
  assert.equal(keyCopyFirst(5, 123, 4096, 1000), true);
  assert.equal(keyCopyFirst(6, 123, 4096, 1000), false);
  assert.equal(keyCopyFirst(2, 4, 1000, 1000), true, "2 * 2 * 1000 equals 1000 * 4");
  assert.equal(keyCopyFirst(1, 1, 65_535, 1), false);
  // A range wider than the budget left goes to the time copy, which gives rows
  // as it reads; the key copy would give none.
  const tight = await readFeed(plan, { open: memoryOpen(packs), table, limit: 1000, maxBlocks: range - 1 });
  assert.deepEqual(tight.stats.copiesRead, ["time"]);
  assert.equal(tight.partial, true);
  assert.ok(tight.rows.length > 0);
});

test("read: a cursor whose key the pack does not hold still gives the next key of the same first_seen, by the time copy and by sort", async () => {
  // A cursor from before a compaction: the provisional hour pack held
  // com.b0, and the pack read now does not. Three rows of one first_seen.
  const F0 = D * DAY + 500;
  const pack = await writeFeed([row("com.a1", F0), row("com.b1", F0), row("com.c1", F0)]);
  const plan = planWindow({ feed: [livePack("d", "d", D * DAY, (D + 1) * DAY, pack)] }, { t0: D * DAY, t1: (D + 1) * DAY });
  for (const copy of ["time", "key"] as const) {
    const read = async (order: FeedOrder, key: string) =>
      (await readFeed(plan, { open: memoryOpen(new Map([["d", pack]])), table, order, after: { firstSeen: F0, key }, copy })).rows.map((r) => r.key);
    assert.deepEqual(await read("first_seen.asc", "com.b0"), ["com.b1", "com.c1"], `${copy}: asc`);
    assert.deepEqual(await read("first_seen.desc", "com.b0"), ["com.a1"], `${copy}: desc`);
    // A cursor at a key the pack holds is passed strictly.
    assert.deepEqual(await read("first_seen.asc", "com.b1"), ["com.c1"], `${copy}: asc after a held key`);
    assert.deepEqual(await read("first_seen.desc", "com.b1"), ["com.a1"], `${copy}: desc after a held key`);
  }
});

test("read: the packs of a window are read newest first, and a cursor goes on across them with no row twice", async () => {
  const dayRowsD = dayRows(600, 33, D);
  const hourRows = Array.from({ length: 6 }, (_, h) =>
    dayRows(40, 40 + h, D + 1).map((r) => ({ ...r, firstSeen: (D + 1) * DAY + h * HOUR + (r.firstSeen % HOUR), sources: [BIT.oiNrd], feedFlags: FEED_PROVISIONAL })),
  );
  const packs = new Map<string, MemFeed>([["feed-d-20261026", await writeFeed(dayRowsD)]]);
  const live: LivePack[] = [livePack("feed-d-20261026", "d", D * DAY, (D + 1) * DAY, packs.get("feed-d-20261026") as MemFeed)];
  for (const [h, rows] of hourRows.entries()) {
    const tag = `feed-h-202610270${h}`;
    packs.set(tag, await writeFeed(rows, { time: false }));
    live.push(livePack(tag, "h", (D + 1) * DAY + h * HOUR, (D + 1) * DAY + (h + 1) * HOUR, packs.get(tag) as MemFeed));
  }
  const all = [...dayRowsD, ...hourRows.flat()];
  const now = (D + 1) * DAY + 6 * HOUR;
  const plan = planWindow({ feed: live }, { t0: now - DAY, t1: now });
  for (const order of ["first_seen.desc", "first_seen.asc"] as const) {
    const got = await allPages(plan, packs, { order, limit: 37, copy: "time" });
    const want = oracle(all, plan, order);
    assert.deepEqual(rowsOf(got.rows), rowsOf(want), order);
    assert.equal(new Set(rowsOf(got.rows)).size, got.rows.length, "no row twice");
  }
  const first = await readFeed(plan, { open: memoryOpen(packs), table, limit: 50 });
  assert.deepEqual(first.stats.packsRead, ["feed-h-2026102705", "feed-h-2026102704"], "newest first, and no further than the page needs");
  assert.deepEqual(first.stats.copiesRead, ["key", "key"], "an hour pack has no time copy");
  // provisional=exclude leaves the hour packs' rows out.
  const settled = await allPages(plan, packs, { order: "first_seen.desc", limit: 200, filter: { provisional: "exclude" } });
  assert.ok(settled.rows.length > 0 && settled.rows.every((r) => (r.feedFlags & FEED_PROVISIONAL) === 0));
  assert.deepEqual(rowsOf(settled.rows), rowsOf(oracle(all, plan, "first_seen.desc", { provisional: "exclude" })));
});

test("read: precision: a day-precision row is inside a window its day overlaps, and is never read as its first second", async () => {
  // Pack of 2026-10-25: a WhoisDS row of the file dated 2026-10-26, which is
  // dated 2026-10-25. Pack of 2026-10-26: an ISC row of the day, an oi-nrd row
  // at 03:00, and a second-precision row at exactly 00:00:00.
  const w = (await collect(buildFeedDay([whoisds("whoisds-synthetic.com", "2026-10-26")], ["com.whoisds-synthetic"], { table, window: { t0: (D - 1) * DAY, t1: D * DAY } })))[0];
  const dayD = [
    (
      await collect(
        buildFeedDay([isc({ domainname: "isc-synthetic.com", firstseen: "2026-10-26", score: 0, scorereason: "synthetic" })], ["com.isc-synthetic"], {
          table,
          window: { t0: D * DAY, t1: (D + 1) * DAY },
        }),
      )
    )[0],
    row("com.midnight-synthetic", D * DAY, { sources: [BIT.oiNrd] }),
    row("com.oi-synthetic", D * DAY + 3 * HOUR, { sources: [BIT.oiNrd] }),
  ].sort(byKey);
  assert.equal(w.firstSeen, (D - 1) * DAY);
  const packs = new Map([
    ["d25", await writeFeed([w])],
    ["d26", await writeFeed(dayD)],
  ]);
  const live = { feed: [livePack("d25", "d", (D - 1) * DAY, D * DAY, packs.get("d25") as MemFeed), livePack("d26", "d", D * DAY, (D + 1) * DAY, packs.get("d26") as MemFeed)] };
  const read = async (t0: number, t1: number, copy: CopyChoice) => (await readFeed(planWindow(live, { t0, t1 }), { open: memoryOpen(packs), table, copy })).rows.map((r) => r.key);
  for (const path of ["time", "key"] as const) {
    assert.deepEqual(await read(D * DAY + 6 * HOUR, D * DAY + 12 * HOUR, path), ["com.isc-synthetic"], `${path}: 06:00 to 12:00 holds the ISC day and no time of it`);
    assert.deepEqual(
      await read((D - 1) * DAY + 20 * HOUR, D * DAY + 4 * HOUR, path),
      ["com.oi-synthetic", "com.midnight-synthetic", "com.isc-synthetic", "com.whoisds-synthetic"],
      `${path}: 20:00 the day before to 04:00 holds both days, newest first`,
    );
    assert.deepEqual(await read(D * DAY + 1, D * DAY + 2, path), ["com.isc-synthetic"], `${path}: one second after midnight holds the day row, not the midnight second`);
    assert.deepEqual(await read(D * DAY, D * DAY + 1, path), ["com.midnight-synthetic", "com.isc-synthetic"], `${path}: the first second holds both`);
    assert.deepEqual(await read((D - 1) * DAY + 23 * HOUR, D * DAY, path), ["com.whoisds-synthetic"], `${path}: the last hour of the day before holds its WhoisDS row`);
  }
});

test("read: suspect rows are hidden by default, and basis, source, min_confidence and suspect filter as section 7.3 says", async () => {
  const d27 = [
    oiNrd(recorded<OiNrdPayload>("newly_registered_domain", 172_166_088)),
    mergeEvents(oiNrd(recorded<OiNrdPayload>("newly_registered_domain", 172_166_089)), isc({ domainname: "onlinendib.com", firstseen: "2026-10-27", score: 0, scorereason: "synthetic" })),
    oiConfirmed(CONFIRMED_EVENT),
    isc({ domainname: "isc-synthetic.com", firstseen: "2026-10-27", score: 0, scorereason: "synthetic" }),
    { key: "com.thc-synthetic", flags: 1, sources: [seen(BIT.thc, 299)], evidence: [] },
  ].sort(byKey);
  const build = async (records: typeof d27, d: number) =>
    writeFeed(
      await collect(
        buildFeedDay(
          records,
          records.map((r) => r.key),
          { table, window: { t0: d * DAY, t1: (d + 1) * DAY } },
        ),
      ),
    );
  const packs = new Map([
    ["d287", await build([oiNrd(OLD_CERT_EVENT)], 287)],
    ["d298", await build([whoisds("whoisds-synthetic.com", "2026-10-27")], 298)],
    ["d299", await build(d27, 299)],
  ]);
  const live = { feed: [...packs].map(([tag, p]) => livePack(tag, "d", Number(tag.slice(1)) * DAY, (Number(tag.slice(1)) + 1) * DAY, p)) };
  const plan = planWindow(live, { t0: 287 * DAY, t1: 300 * DAY });
  const keys = async (filter: FeedFilter) => (await readFeed(plan, { open: memoryOpen(packs), table, filter })).rows.map((r) => r.key);
  const shown = ["net.tinifb", "com.tuningledger", "com.thc-synthetic", "com.onlinendib", "com.isc-synthetic", "com.whoisds-synthetic"];
  assert.deepEqual(await keys({}), shown, "suspect excluded by default");
  assert.deepEqual(await keys({ suspect: "include" }), [...shown, "com.creatorwide"]);
  assert.deepEqual(await keys({ suspect: "only" }), ["com.creatorwide"]);
  assert.deepEqual(await keys({ basis: "registered" }), ["com.tuningledger"]);
  assert.deepEqual(await keys({ basis: "claimed" }), ["net.tinifb", "com.tuningledger", "com.onlinendib", "com.isc-synthetic", "com.whoisds-synthetic"]);
  assert.deepEqual(await keys({ basis: "nrd-list" }), ["net.tinifb", "com.onlinendib", "com.isc-synthetic", "com.whoisds-synthetic"]);
  assert.deepEqual(await keys({ basis: "ct" }), ["com.thc-synthetic"]);
  assert.deepEqual(await keys({ basis: "seen" }), shown);
  assert.deepEqual(await keys({ basis: "zone" }), []);
  assert.deepEqual(await keys({ sources: [BIT.isc] }), ["com.onlinendib", "com.isc-synthetic"]);
  assert.deepEqual(await keys({ minConfidence: 2 }), []);
  assert.deepEqual(await keys({ minConfidence: 3 }), ["com.tuningledger"]);
  // Each row by name: its class and the inputs that give it.
  const rows = (await readFeed(plan, { open: memoryOpen(packs), table, filter: { suspect: "include" } })).rows;
  const described = Object.fromEntries(rows.map((r) => [r.key, describeRow(r, table)]));
  assert.deepEqual(described["com.tuningledger"], { class: "registered-confirmed", basis: ["nrd-ct+rdap"], level: 3, flags: [], reasons: [], sources: ["oi-nrd-confirmed"] });
  assert.deepEqual(described["com.onlinendib"], { class: "corroborated", basis: ["nrd-list"], level: 0, flags: ["corroborated"], reasons: [], sources: ["oi-nrd", "isc-new"] });
  assert.deepEqual(described["net.tinifb"], { class: "single", basis: ["nrd-list"], level: 0, flags: [], reasons: [], sources: ["oi-nrd"] });
  assert.deepEqual(described["com.creatorwide"], { class: "single", basis: ["nrd-list"], level: 0, flags: ["suspect"], reasons: ["cert-age"], sources: ["oi-nrd"] });
  assert.deepEqual(described["com.isc-synthetic"].class, "single");
  for (const bad of [{ basis: "registred" }, { suspect: "maybe" }, { provisional: "only" }, { minConfidence: 0 }, { minConfidence: 11 }, { sources: [] }, { sources: [64] }])
    await assert.rejects(readFeed(plan, { open: memoryOpen(packs), table, filter: bad as FeedFilter }), isFeed("usage"), JSON.stringify(bad));
});

test("read: the block budget ends a page early with a cursor, and refuses a page that cannot give one row", async () => {
  const rows = dayRows(2000, 34);
  const day = await writeFeed(rows);
  const packs = new Map([["d", day]]);
  const plan = planWindow({ feed: [livePack("d", "d", D * DAY, (D + 1) * DAY, day)] }, { t0: D * DAY, t1: (D + 1) * DAY });
  const page = await readFeed(plan, { open: memoryOpen(packs), table, limit: 1000, maxBlocks: 5, copy: "time" });
  assert.equal(page.partial, true);
  assert.equal(page.stats.blocksRead, 5);
  assert.ok(page.rows.length > 0 && page.rows.length < 1000);
  assert.deepEqual(rowsOf(page.rows), rowsOf(oracle(rows, plan, "first_seen.desc").slice(0, page.rows.length)), "the rows it gives are the first of the order");
  assert.deepEqual(page.next, { firstSeen: page.rows[page.rows.length - 1].firstSeen, key: page.rows[page.rows.length - 1].key });
  // The scan path is all or nothing: 32 blocks do not fit 5.
  await assert.rejects(readFeed(plan, { open: memoryOpen(packs), table, limit: 10, maxBlocks: 5, copy: "key" }), isFeed("budget"));
  // The time copy refuses too when a filter drops every row the budget reads.
  await assert.rejects(readFeed(plan, { open: memoryOpen(packs), table, limit: 10, maxBlocks: 2, copy: "time", filter: { basis: "zone" } }), isFeed("budget"));
  for (const bad of [{ limit: 0 }, { limit: 10_001 }, { maxBlocks: 0 }, { order: "key" as FeedOrder }, { after: { firstSeen: -1, key: "com.a" } }, { copy: "both" as CopyChoice }])
    await assert.rejects(readFeed(plan, { open: memoryOpen(packs), table, ...bad }), isFeed("usage"), JSON.stringify(bad));
});

test("read: a pack opened as another dataset than the plan reads is refused", async () => {
  const day = await writeFeed(dayRows(10, 35));
  const live = { "new-name": [livePack("n", "d", D * DAY, (D + 1) * DAY, day)] };
  const plan = planWindow(live, { t0: D * DAY, t1: (D + 1) * DAY, kind: "fqdn" });
  await assert.rejects(readFeed(plan, { open: memoryOpen(new Map([["n", day]])), table }), isFeed("usage"));
});

// The parts of a copy held in memory, as a RangeSource whose every read is
// counted in `reads`.
interface Reads {
  n: number;
}
const counted = (parts: readonly Uint8Array[], reads: Reads) => ({
  read: async (part: number, offset: number, length: number) => {
    reads.n += 1;
    return parts[part].subarray(offset, offset + length);
  },
});

// A plan of one pack of tier `tier` over `span`, and an open() that gives its
// key copy with `time` as its time copy; every read of a part of either copy
// is counted in `reads`.
async function withTime(day: MemFeed, time: (reads: Reads) => Promise<PackReader<FeedRecord> | null>, reads: Reads = { n: 0 }, span: [number, number] = [D * DAY, (D + 1) * DAY], tier = "d") {
  const plan = planWindow({ feed: [livePack("d", tier, span[0], span[1], day)] }, { t0: span[0], t1: span[1] });
  const open = async (): Promise<OpenedPack> => {
    const reader = await PackReader.open(day.summary.idx, counted(day.parts, reads), FEED_CODEC);
    return { reader, time: await time(reads) };
  };
  return readFeed(plan, { open, table });
}

const timeOf = (m: MemFeed, reads: Reads, codec = FEED_TIME_CODEC) => PackReader.open(m.time?.summary.idx as Uint8Array, counted(m.time?.parts ?? [], reads), codec);

const isTime = (pattern: RegExp) => (e: unknown) => isFeed("time")(e) && pattern.test((e as Error).message);

// The page is refused as `check` says, and no block of either copy was read.
async function refusedUnread(page: (reads: Reads) => Promise<FeedPage>, check: (e: unknown) => boolean, what: string): Promise<void> {
  const reads = { n: 0 };
  await assert.rejects(page(reads), check, what);
  assert.equal(reads.n, 0, `${what}: no part of either copy is read`);
}

test("read: a time copy that does not bind to its key copy is refused before a block is read: its records, its dataset, its span", async () => {
  const rows = dayRows(300, 37);
  const day = await writeFeed(rows);
  // Control: the pack's own time copy binds, and the page reads its blocks.
  const control = { n: 0 };
  assert.equal((await withTime(day, (r) => timeOf(day, r), control)).rows.length, 300 - rows.filter((r) => r.feedFlags !== 0).length, "the pack's own time copy binds");
  assert.ok(control.n > 0, "the reads of a page are counted");
  // The time copy of 299 of the rows, and of 301: another number of records.
  const fewer = await writeFeed(rows.slice(1));
  await refusedUnread((reads) => withTime(day, (r) => timeOf(fewer, r), reads), isTime(/holds 299 records and its key copy 300/), "fewer");
  const extra = row("com.synthetic-extra-row", D * DAY + 5);
  assert.ok(!rows.some((r) => r.key === extra.key));
  const more = await writeFeed([...rows, extra].sort(byKey));
  await refusedUnread((reads) => withTime(day, (r) => timeOf(more, r), reads), isTime(/holds 301 records and its key copy 300/), "more");
  // The time copy of the same rows as new-name: dataset 7 beside a feed key copy.
  const sink = new MemorySink();
  const timeSink = new MemorySink();
  const nn = await writeFeedPack(rows, { codec: NEW_NAME_CODEC, compress: nodeCompress, sink, recordsPerBlock: 64, time: { sink: timeSink, recordsPerBlock: 64 } });
  await refusedUnread(
    (reads) => withTime(day, (r) => PackReader.open(nn.time?.idx as Uint8Array, counted(timeSink.parts(), r), NEW_NAME_TIME_CODEC), reads),
    isTime(/is dataset 7; the time copy of dataset 3 is dataset 6/),
    "dataset",
  );
  // The pack listed with the span of the next day: its rows lie before it.
  await refusedUnread((reads) => withTime(day, (r) => timeOf(day, r), reads, [(D + 1) * DAY, (D + 2) * DAY]), isTime(/outside the span/), "span");
  // A time copy the live set lists and open does not give, or the reverse.
  await refusedUnread((reads) => withTime(day, async () => null, reads), isFeed("usage"), "listed, not given");
  const plain = await writeFeed(rows, { time: false });
  const plan = planWindow({ feed: [livePack("d", "d", D * DAY, (D + 1) * DAY, plain)] }, { t0: D * DAY, t1: (D + 1) * DAY });
  await refusedUnread(
    (reads) => readFeed(plan, { open: async () => ({ reader: await PackReader.open(plain.summary.idx, counted(plain.parts, reads), FEED_CODEC), time: await timeOf(day, reads) }), table }),
    isFeed("usage"),
    "given, not listed",
  );
});

test("read: a pack of tier d, w, m or y with no time copy is refused before a block is read; an hour pack and a segment are read from their key copy", async () => {
  const rows = dayRows(300, 38);
  const plain = await writeFeed(rows, { time: false });
  assert.deepEqual(TIME_COPY_TIERS, ["d", "w", "m", "y"]);
  for (const tier of TIME_COPY_TIERS)
    await refusedUnread(
      (reads) => withTime(plain, async () => null, reads, undefined, tier),
      isTime(new RegExp(`^the pack d of tier ${tier} holds 300 rows and no time copy: a pack of tier d, w, m or y is read through its time copy, never sorted whole$`)),
      tier,
    );
  const plan = planWindow({ feed: [livePack("d", "d", D * DAY, (D + 1) * DAY, plain)] }, { t0: D * DAY, t1: (D + 1) * DAY });
  for (const tier of ["h", "seg"]) {
    const reads = { n: 0 };
    const page = await withTime(plain, async () => null, reads, undefined, tier);
    assert.deepEqual(page.stats.copiesRead, ["key"], tier);
    assert.ok(reads.n > 0, tier);
    assert.deepEqual(rowsOf(page.rows), rowsOf(oracle(rows, plan, "first_seen.desc").slice(0, 1000)), tier);
  }
});
