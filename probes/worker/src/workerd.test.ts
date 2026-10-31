// probes/worker/src/workerd.test.ts — the probe in workerd (Miniflare, through
// @domains/testkit) with an R2 bucket held in memory: the cron path writes ticks
// whose custom metadata a listing returns, and /gaps reads them back. The
// local-integration tier; the deployed probe is the acceptance test (DOM-061).
//
// The compatibility date is the harness's (2026-10-13), which wrangler.toml
// deploys with too: the workerd that wrangler 4.150.0 pins refuses dates after
// 2026-10-13 (packages/testkit/src/workerd.ts, MEASURED 2026-10-28T10:30Z).
//
//   node scripts/test.mjs probes/worker --name workerd
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { withWorker } from "@domains/testkit";

const ENTRY = fileURLToPath(new URL("./index.ts", import.meta.url));
const MIN = 60_000;
const T0 = Date.parse("2026-10-01T12:00:00.000Z");

interface Answer {
  from: string;
  runs: number;
  expected: number;
  complete: boolean;
  slots: { expected: number; hit: number; missed: number };
  hot_puts: number;
  put_errors: number;
  put_ms: { max: number | null };
  list_calls: number;
  beside: { runs: number; expected: number }[];
  ticks: { cron: string; scheduledTime: string }[];
}

test("probe workerd: the crons write ticks, hot objects and the heartbeat to R2, and /gaps reads them back", async () => {
  await withWorker({ scriptPath: ENTRY, r2Buckets: ["PROBE"] }, async (w) => {
    const worker = await w.miniflare.getWorker();
    // 62 minutes of slots: the window's hour, and the first tick of each cron past it.
    for (let m = 0; m < 62; m += 1) {
      const scheduledTime = new Date(T0 + m * MIN);
      assert.equal((await worker.scheduled({ cron: "* * * * *", scheduledTime })).outcome, "ok");
      if (m % 5 === 0) assert.equal((await worker.scheduled({ cron: "*/5 * * * *", scheduledTime })).outcome, "ok");
    }
    const res = await w.fetch("/gaps?hours=1&ticks=1");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Answer;
    assert.equal(body.from, "2026-10-01T12:00:00.000Z");
    assert.equal(body.runs, 60);
    assert.equal(body.expected, 60);
    assert.equal(body.complete, true);
    assert.deepEqual(body.slots, { expected: 60, hit: 60, missed: 0 });
    assert.equal(body.beside[0]!.runs, 12);
    assert.equal(body.hot_puts, 12);
    assert.equal(body.put_errors, 0);
    assert.ok(body.put_ms.max !== null && body.put_ms.max >= 0);
    // The window's 60 and 12 ticks, and the minute and 5-minute ticks of 13:00.
    assert.equal(body.ticks.length, 74);
    assert.ok(body.list_calls >= 4);
    const bucket = await w.miniflare.getR2Bucket("PROBE");
    const hot = await bucket.list({ prefix: "hot/" });
    assert.equal(hot.objects.length, 13);
    for (const object of hot.objects) assert.equal(object.size, 1_048_576);
    const beat = await bucket.get("heartbeat.json");
    assert.ok(beat !== null, "the heartbeat exists");
    const last = (await beat.json()) as { scheduledTime: string; ok: boolean };
    assert.equal(last.ok, true);
    assert.equal(last.scheduledTime, new Date(T0 + 61 * MIN).toISOString());
    // The answer is kept in the Cache API: asked again, it is the same answer,
    // computed at the same instant, with no listing.
    assert.equal(res.headers.get("cache-control"), "public, max-age=60");
    const again = await w.fetch("/gaps?ticks=1&hours=1");
    assert.equal(again.status, 200);
    const cached = (await again.json()) as Answer & { now: string };
    assert.equal(cached.now, (body as Answer & { now: string }).now);
    assert.deepEqual(cached, body);
  });
});

test("probe workerd: a cron with no row in CRONS fails its invocation and writes nothing", async () => {
  await withWorker({ scriptPath: ENTRY, r2Buckets: ["PROBE"] }, async (w) => {
    const worker = await w.miniflare.getWorker();
    const result = await worker.scheduled({ cron: "0 * * * *", scheduledTime: new Date(T0) });
    assert.equal(result.outcome, "exception");
    const bucket = await w.miniflare.getR2Bucket("PROBE");
    assert.equal((await bucket.list()).objects.length, 0);
    const res = await w.fetch("/");
    assert.equal(res.status, 200);
    const routes = ((await res.json()) as { routes: { path: string }[] }).routes.map((route) => route.path);
    assert.deepEqual(routes, ["/", "/gaps", "/range", "/decode"]);
  });
});
