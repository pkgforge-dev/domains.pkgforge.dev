// packages/feed in workerd (Miniflare, through @domains/testkit), under the
// harness's compatibility date and flags (no nodejs_compat): the Worker path is
// run, not assumed. test/feed-worker.ts plans a window and reads a page with
// packages/feed/src, from the time copy and from the key copy; each page is
// held equal to the page Node reads from the same bytes. Synthetic rows.
//
//   node scripts/test.mjs packages/feed --name workerd
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { toHex } from "@domains/pack";
import { withWorker } from "@domains/testkit";
import { type LivePack, planWindow, readFeed } from "../src/index.ts";
import { BIT, D, DAY, HOUR, livePack, type MemCopy, type MemFeed, memoryOpen, rng, row, SOURCE_ROWS, table, writeFeed } from "./helpers.ts";

const WORKER = join(import.meta.dirname, "feed-worker.ts");

function rowsOf(n: number, seed: number, t0: number, span: number, sources: number[]) {
  const next = rng(seed);
  const keys = new Set<string>();
  while (keys.size < n) keys.add(`${["com", "net", "np.com"][Math.floor(next() * 3)]}.syn${Math.floor(next() * 1e9).toString(36)}`);
  return [...keys].sort().map((k) => row(k, t0 + (span === DAY && next() < 0.3 ? 0 : Math.floor(next() * span)), { sources: span === DAY && next() < 0.3 ? [BIT.isc] : sources }));
}

test("feed workerd: the planner and readFeed over both copies answer in workerd as in Node, and refuse a time copy of another pack", async () => {
  // A day pack with a time copy and two hour packs of the next day without.
  const dayRows = rowsOf(400, 51, D * DAY, DAY, [BIT.oiNrd]).map((r) => (r.sources[0] === BIT.isc ? { ...r, firstSeen: D * DAY } : r));
  const packs = new Map<string, MemFeed>([["feed-d-20261026", await writeFeed(dayRows)]]);
  const live: LivePack[] = [livePack("feed-d-20261026", "d", D * DAY, (D + 1) * DAY, packs.get("feed-d-20261026") as MemFeed)];
  for (const h of [0, 1]) {
    const tag = `feed-h-202610270${h}`;
    packs.set(tag, await writeFeed(rowsOf(50, 60 + h, (D + 1) * DAY + h * HOUR, HOUR, [BIT.oiNrd]), { time: false }));
    live.push(livePack(tag, "h", (D + 1) * DAY + h * HOUR, (D + 1) * DAY + (h + 1) * HOUR, packs.get(tag) as MemFeed));
  }
  const copyHex = (c: MemCopy) => ({ idx: toHex(c.summary.idx), parts: c.parts.map(toHex) });
  const hex = (m: MemFeed) => ({ ...copyHex(m), time: m.time === null ? null : copyHex(m.time) });
  const body = (query: object, read: object, dayTime?: MemCopy) => {
    const p = Object.fromEntries([...packs].map(([tag, m]) => [tag, hex(m)]));
    if (dayTime !== undefined) p["feed-d-20261026"].time = copyHex(dayTime);
    return { method: "POST", body: JSON.stringify({ packs: p, live: { feed: live }, sources: SOURCE_ROWS, query, read }) };
  };
  const cases = [
    { query: { t0: (D + 1) * DAY + 2 * HOUR - DAY, t1: (D + 1) * DAY + 2 * HOUR }, read: { order: "first_seen.desc", limit: 120, copy: "auto", after: null } },
    { query: { t0: D * DAY + 6 * HOUR, t1: D * DAY + 9 * HOUR, suffix: "com" }, read: { order: "first_seen.asc", limit: 30, copy: "time", after: null } },
    { query: { t0: D * DAY, t1: (D + 2) * DAY }, read: { order: "first_seen.desc", limit: 500, copy: "key", after: null } },
  ] as const;
  await withWorker({ scriptPath: WORKER }, async (w) => {
    for (const c of cases) {
      const res = await w.fetch("/feed", body(c.query, c.read));
      assert.equal(res.status, 200, JSON.stringify(c));
      const got = (await res.json()) as { rows: unknown[]; next: unknown; partial: boolean; stats: { blocksRead: number; packsRead: string[]; copiesRead: string[] } };
      const want = await readFeed(planWindow({ feed: live }, c.query), { open: memoryOpen(packs), table, ...c.read });
      assert.ok(want.rows.length > 0);
      assert.deepEqual(got.rows, want.rows, JSON.stringify(c));
      assert.deepEqual(got.next, want.next);
      assert.equal(got.partial, want.partial);
      assert.deepEqual(got.stats, want.stats);
    }
    // The first case reads the day pack from its time copy.
    assert.ok(((await (await w.fetch("/feed", body(cases[0].query, cases[0].read))).json()) as { stats: { copiesRead: string[] } }).stats.copiesRead.includes("time"));
    // The day pack's time copy swapped for the time copy of another pack, of
    // one row: refused in workerd too.
    const other = await writeFeed([row("com.other", D * DAY + 1)]);
    const refused = await w.fetch("/feed", body(cases[0].query, cases[0].read, other.time as MemCopy));
    assert.equal(refused.status, 422);
    assert.equal(((await refused.json()) as { code: string }).code, "time");
  });
});
