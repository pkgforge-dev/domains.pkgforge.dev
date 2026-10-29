// packages/adapter in workerd (Miniflare, through @domains/testkit), under the
// harness's compatibility date and flags (no nodejs_compat): the Worker path is
// proven, not assumed. The harness and the band check answer in workerd what
// they answer in Node, on the same synthetic recordings and on THC's measured
// daily sizes (docs/research/measure/DOM-009/result.json, per_day[].gz_bytes).
//
//   node scripts/test.mjs packages/adapter --name workerd
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { withWorker } from "@domains/testkit";
import { type BandDay, checkBand } from "../src/band.ts";
import { runAdapter } from "../src/harness.ts";
import { readRecordings } from "../node/files.ts";
import { dayAdapter } from "./synthetic.ts";

const WORKER = join(import.meta.dirname, "adapter-worker.ts");
const HTTP = join(import.meta.dirname, "fixtures", "http");
const ROOT = join(import.meta.dirname, "..", "..", "..");
const RECORDINGS = readdirSync(HTTP)
  .filter((n) => n.endsWith(".http.json"))
  .sort()
  .map((name) => ({ name, json: JSON.parse(readFileSync(join(HTTP, name), "utf8")) as unknown }));
const INPUT = { recordings: RECORDINGS, cursor: { last_day: "2026-10-25" }, now: "2026-10-29T06:00:00Z" };
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });

test("adapter workerd: the harness, its checks and the band verdicts answer in workerd what they answer in Node", async () => {
  const node = await runAdapter(dayAdapter(), { recordings: readRecordings(HTTP), cursor: INPUT.cursor, now: INPUT.now });
  const days = (JSON.parse(readFileSync(join(ROOT, "docs", "research", "measure", "DOM-009", "result.json"), "utf8")) as { per_day: { day: string; gz_bytes: number }[] }).per_day.map((d) => ({
    day: d.day,
    count: d.gz_bytes,
  }));
  const history: BandDay[] = [];
  const nodeBand = days.map((d) => {
    const r = checkBand(d.count, history, { metric: "bytes", min: 0.4, max: 2.5, relative: true }, { precision: "day" });
    history.push({ day: d.day, count: d.count, quarantined: r.verdict === "quarantine" });
    return { day: d.day, ...r };
  });
  await withWorker({ scriptPath: WORKER }, async (w) => {
    const res = await w.fetch("/harness", post(INPUT));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; first: { segments: unknown[]; cursor: unknown; requests: unknown[] }; next: { segments: unknown[] } };
    assert.equal(body.ok, true, JSON.stringify(body));
    // The same segments, digests included: Web Crypto in workerd and in Node.
    assert.deepEqual(body.first.segments, node.first.result.segments);
    assert.deepEqual(body.first.cursor, node.first.result.cursor);
    assert.deepEqual(body.first.requests, node.first.requests);
    assert.deepEqual(body.next.segments, []);
    for (const [plant, check] of [
      ["extra-url", "unrecorded"],
      ["nondeterministic", "deterministic"],
      ["global-fetch", "global-fetch"],
      ["network-globals", "global-fetch"],
      ["no-user-agent", "user-agent"],
    ]) {
      const r = (await (await w.fetch(`/harness?plant=${plant}`, post(INPUT))).json()) as { ok: boolean; check: string; message: string };
      assert.deepEqual([r.ok, r.check], [false, check], `${plant}: ${r.message}`);
      // workerd's WebSocket and EventSource are trapped as Node's are.
      if (plant === "network-globals") assert.match(r.message, /was called for WebSocket wss:\/\/feed\.example\.test\/ws, XMLHttpRequest, EventSource https:\/\/feed\.example\.test\/events$/);
    }
    // The fake fetch and the trap answered: nothing reached the outbound service.
    assert.deepEqual(w.outbound, []);
    const band = await (await w.fetch("/band", post({ days }))).json();
    assert.deepEqual(band, JSON.parse(JSON.stringify(nodeBand)));
  });
});

test("adapter workerd: liveFetch works as a method of ctx, where workerd refuses the global fetch itself", async () => {
  await withWorker({ scriptPath: WORKER, outbound: (req) => new Response(`answered ${req.headers.get("user-agent")}`) }, async (w) => {
    const target = encodeURIComponent("https://feed.example.test/x");
    const live = (await (await w.fetch(`/live?url=${target}`)).json()) as { ok: boolean; status: number; text: string };
    assert.deepEqual(live, { ok: true, status: 200, text: "answered adapter-workerd-test" });
    assert.deepEqual(w.outbound, ["https://feed.example.test/x"]);
    const method = (await (await w.fetch(`/method?url=${target}`)).json()) as { ok: boolean; error: string };
    assert.equal(method.ok, false);
    assert.match(method.error, /Illegal invocation/);
    assert.equal(w.outbound.length, 1);
  });
});
