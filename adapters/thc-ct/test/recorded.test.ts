// adapters/thc-ct over its fixtures (record.mjs, design section 13.3),
// through runSandboxed of @domains/adapter/node: the harness's three runs in
// a Node child that cannot reach the network. fixtures/ holds the synthetic
// answers of 2026-10-31, the slice's gzip at the slice's size; recorded.json
// names the slice's real lines and THC's recorded answers beside them. Each
// test reads what the fixtures hold, never a count typed in by hand.
//
//   node scripts/test.mjs adapters/thc-ct --name "thc-ct recorded"
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
import { canonicalJson, type HarnessResult } from "@domains/adapter";
import { readRecordings, runSandboxed } from "@domains/adapter/node";
import { HOSTS, SOURCE } from "../src/index.ts";

const DIR = join(import.meta.dirname, "..");
const FIXTURES = join(DIR, "fixtures");
const PSL_FILE = join(DIR, "..", "..", "packages", "names", "test", "fixtures", "psl-2026-10-27.dat");
const META = JSON.parse(readFileSync(join(FIXTURES, "recorded.json"), "utf8")) as {
  day: string;
  psl_sha256: string;
  file: { last_modified: string };
  slice: { gzip_bytes: number; gzip_sha256: string; real_sha256: string; lines: number; synthetic_lines: string[] };
  files: Record<string, string>;
};
const SLICE = readFileSync(join(FIXTURES, `slice-${META.day}.txt`), "utf8");
const START = { next: META.day, open: [] };
const NOW = "2026-11-01T00:30:00Z";

let memo: Promise<HarnessResult> | null = null;
const sandboxed = (): Promise<HarnessResult> =>
  (memo ??= runSandboxed({ module: join(DIR, "src", "index.ts"), sourceFile: join(DIR, "source.json"), recordings: FIXTURES, psl: PSL_FILE, cursor: START, now: NOW }));

test("thc-ct recorded: the fixtures are recorded.json's: each file's sha256, the slice's real lines, and every answer of fixtures/ synthetic", () => {
  for (const [name, sha] of Object.entries(META.files))
    assert.equal(
      createHash("sha256")
        .update(readFileSync(join(FIXTURES, name)))
        .digest("hex"),
      sha,
      name,
    );
  const real = SLICE.split("\n").slice(0, META.slice.lines);
  assert.equal(
    createHash("sha256")
      .update(`${real.join("\n")}\n`)
      .digest("hex"),
    META.slice.real_sha256,
  );
  assert.ok(SLICE.endsWith(`${META.slice.synthetic_lines.join("\n")}\n\n`));
  assert.ok(readRecordings(FIXTURES).every((r) => r.origin === "synthetic"));
  assert.ok(readRecordings(join(FIXTURES, "recorded")).every((r) => r.origin === "recorded"));
  assert.equal(createHash("sha256").update(readFileSync(PSL_FILE)).digest("hex"), META.psl_sha256);
});

test("thc-ct recorded: the three runs keep the adapter contract in the sandbox, with no network: run 1 writes the day's two segments from cs2, run 2 the same bytes, run 3 nothing", async () => {
  const h = await sandboxed();
  const bytesOf = (r: HarnessResult["first"]): string[] => r.written.map((w) => canonicalJson([w.records, Buffer.from(w.raw ?? new Uint8Array(0)).toString("base64"), w.url]));
  assert.deepEqual(bytesOf(h.again), bytesOf(h.first));
  assert.deepEqual(h.again.result, h.first.result);
  assert.deepEqual(
    h.first.result.segments.map((s) => [s.source, s.dataset, s.window.start, s.window.end]),
    [
      [SOURCE, "names", `${META.day}T00:00:00Z`, "2026-11-01T00:00:00Z"],
      [SOURCE, "domains", `${META.day}T00:00:00Z`, "2026-11-01T00:00:00Z"],
    ],
  );
  assert.deepEqual(h.first.result.errors, []);
  assert.deepEqual(h.first.result.cursor, { next: "2026-11-01", open: [] });
  assert.deepEqual(
    h.first.requests.map((q) => [q.method, q.url, q.recording]),
    [
      ["HEAD", `${HOSTS.cs2}${META.day}.txt.gz`, "cs2-head-20261031.http.json"],
      ["GET", `${HOSTS.cs2}${META.day}.txt.gz`, "cs2-get-20261031.http.json"],
    ],
  );
  // Run 3, from { next: 2026-11-01 } at 2026-11-01T00:30Z: ctx.now's own day is not asked.
  assert.deepEqual([h.next.result.segments, h.next.requests, h.next.result.errors], [[], [], []]);
  for (const run of [h.first, h.again, h.next]) assert.deepEqual(run.connections, [], "no TCP connection");
});

test("thc-ct recorded: both segments carry the file as their raw layer and cs2's file URL, and the file gunzips to the slice", async () => {
  const h = await sandboxed();
  for (const w of h.first.written) {
    assert.equal(w.raw!.byteLength, META.slice.gzip_bytes);
    assert.equal(createHash("sha256").update(w.raw!).digest("hex"), META.slice.gzip_sha256);
    assert.deepEqual(w.segment.raw, { bytes: META.slice.gzip_bytes, sha256: META.slice.gzip_sha256 });
    assert.equal(w.url, `${HOSTS.cs2}${META.day}.txt.gz`);
    assert.equal(w.rawMember, null);
    assert.equal(w.facts, null);
  }
  assert.equal(gunzipSync(h.first.written[0]!.raw!).toString("utf8"), SLICE);
  // lag_s: ctx.now minus the file's Last-Modified.
  assert.equal(h.first.result.stats.lag_s, (Date.parse(NOW) - Date.parse(META.file.last_modified)) / 1000);
});
