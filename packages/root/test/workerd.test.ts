// packages/root in workerd (Miniflare, through @domains/testkit), under the
// harness's compatibility date and flags (no nodejs_compat): the Worker reads
// root.json with this package, so the path is run, not assumed.
// test/root-worker.ts answers what validateRoot and buildRoot give in workerd,
// and each answer is held equal to Node's on the same input. Synthetic packs.
//
//   node scripts/test.mjs packages/root --name workerd
import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { withWorker } from "@domains/testkit";
import { buildRoot } from "../src/index.ts";
import { live, PSL_LIVE, pack, plain } from "./helpers.ts";

const WORKER = join(import.meta.dirname, "root-worker.ts");

test("root workerd: validateRoot and buildRoot answer in workerd as in Node, and a RootError keeps its code", async () => {
  const one = buildRoot({ live: null, psl: PSL_LIVE, now: "2026-10-28T00:00:00Z" });
  const two = buildRoot({ live: live(one), psl: PSL_LIVE, now: "2026-10-28T01:00:00Z", add: [pack("names", "d", "2026-10-26T00:00:00Z")] });
  const ask = { root: plain(two), live: live(two), add: [pack("names", "d", "2026-10-27T00:00:00Z")], psl: PSL_LIVE, now: "2026-10-28T02:00:00Z" };
  const nodeNext = buildRoot({ live: ask.live, add: ask.add, psl: ask.psl, now: ask.now });
  await withWorker({ scriptPath: WORKER }, async (w) => {
    const res = await w.fetch("/root", { method: "POST", body: JSON.stringify(ask) });
    assert.equal(res.status, 200);
    const got = (await res.json()) as { reader: number; writer: string; next: unknown };
    assert.equal(got.reader, 2);
    assert.equal(got.writer, "2026-10-27T00:00:00Z");
    assert.deepEqual(got.next, JSON.parse(JSON.stringify(nodeNext)));
    // An unknown format is refused in workerd too, with its code.
    const refused = await w.fetch("/root", { method: "POST", body: JSON.stringify({ ...ask, root: { ...plain(two), format: "domains.root.v2" } }) });
    assert.equal(refused.status, 422);
    assert.equal(((await refused.json()) as { code: string }).code, "format");
  });
});
