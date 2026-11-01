// adapters/oi-nrd over the broker's recorded answers (fixtures/, written once
// by record.mjs against kafka.zonestream.openintel.nl:9092), through
// runSandboxed of @domains/adapter/node: the harness's three runs in a Node
// child that cannot reach the network (design 7.3). The client id is the one
// recorded.json names (settled C10), so the fixtures do not follow the
// constant of scripts/lib/user-agent.mjs. Each test reads what the recording
// holds, never a count typed in by hand.
//
//   node scripts/test.mjs adapters/oi-nrd --name "oi-nrd recorded"
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { type Cursor, canonicalJson, type HarnessResult, parseTcpRecording, type Written } from "@domains/adapter";
import { decodeBatch, splitBatches } from "@domains/adapter/kafka";
import { runSandboxed } from "@domains/adapter/node";
import { key, loadPsl, normalise, split } from "@domains/names";
import { TOPICS } from "../src/index.ts";

const DIR = join(import.meta.dirname, "..");
const FIXTURES = join(DIR, "fixtures");
const PSL_FILE = join(DIR, "..", "..", "packages", "names", "test", "fixtures", "psl-2026-10-27.dat");
const PSL = await loadPsl(readFileSync(PSL_FILE));
const OLD_CERT_S = 7 * 86_400;

interface TopicRecorded {
  readonly source: string;
  readonly c0: number;
  readonly through: string;
  readonly edge: number;
  readonly stop: number;
}
const recorded = JSON.parse(readFileSync(join(FIXTURES, "recorded.json"), "utf8")) as { client_id: string; edge: string; topics: Record<string, TopicRecorded>; psl_sha256: string };
const start = JSON.parse(readFileSync(join(FIXTURES, "cursor.json"), "utf8")) as { cursor: Cursor; now: string };
const recording = parseTcpRecording(JSON.parse(readFileSync(join(FIXTURES, "broker.tcp.json"), "utf8")), "broker.tcp.json");

// The three runs, sandboxed once for the file's tests.
let memo: Promise<HarnessResult> | null = null;
const sandboxed = (): Promise<HarnessResult> =>
  (memo ??= runSandboxed({
    module: join(DIR, "src", "index.ts"),
    sourceFile: join(DIR, "source.json"),
    recordings: FIXTURES,
    psl: PSL_FILE,
    cursor: start.cursor,
    now: start.now,
    userAgent: recorded.client_id,
  }));

const text = (b: Uint8Array | null): string => new TextDecoder().decode(b ?? new Uint8Array(0));
// Each message of a window's raw bytes: its offset and its JSON value.
function messagesOf(w: Written): { offset: number; value: Record<string, unknown> }[] {
  const { batches, partial } = splitBatches(w.raw!);
  assert.equal(partial, 0, "the raw bytes are whole batches");
  return batches.flatMap((b) => decodeBatch(b.bytes).records.map((r) => ({ offset: r.offset, value: JSON.parse(text(r.value)) as Record<string, unknown> })));
}
const specOf = (source: string) => TOPICS.find((t) => t.source === source)!;

test("oi-nrd recorded: the fixtures were recorded under the fixture list, at the broker's address", () => {
  assert.equal(recorded.psl_sha256, PSL.sha256);
  assert.deepEqual(recording.address, { hostname: "kafka.zonestream.openintel.nl", port: 9092 });
  assert.equal(recording.origin, "recorded");
});

test("oi-nrd recorded: the three runs keep the adapter contract in the sandbox, with no network", async () => {
  const h = await sandboxed();
  // Run 2 equals run 1 by the bytes of its records, raw lane and facts.
  const bytesOf = (r: HarnessResult["first"]) =>
    r.written.map((w) => [canonicalJson(w.records), Buffer.from(w.raw ?? new Uint8Array(0)).toString("hex"), canonicalJson(w.rawMember), canonicalJson(w.facts)]);
  assert.deepEqual(bytesOf(h.again), bytesOf(h.first));
  assert.deepEqual(h.again.result, h.first.result);
  // Run 3, from run 1's cursor, writes no window: its records are all in the open window.
  assert.deepEqual(h.next.result.segments, []);
  assert.deepEqual(h.next.result.errors, []);
  // One connection a run, to the recorded address, every request answered by the recording.
  for (const run of [h.first, h.again, h.next]) {
    assert.deepEqual(
      run.connections.map((c) => [c.address, c.opened]),
      [["kafka.zonestream.openintel.nl:9092", true]],
    );
    assert.ok(run.connections[0]!.requests.every((q) => q.exchange !== null));
    assert.deepEqual(run.requests, [], "no HTTP request");
  }
});

test("oi-nrd recorded: each topic writes one window, a domains segment for oi-nrd and oi-nrd-confirmed and a names segment for oi-nrd-fqdn, and the cursor moves to the first offset of the open window", async () => {
  const h = await sandboxed();
  assert.deepEqual(
    h.first.result.segments.map((s) => [s.source, s.dataset, s.window.start, s.window.end, s.count > 0]),
    TOPICS.map((t) => [t.source, t.dataset, recorded.topics[t.topic]!.through, recorded.edge, true]),
  );
  assert.deepEqual(h.first.result.errors, []);
  const cursor = h.first.result.cursor as { topics: Record<string, { "0": number }>; through: Record<string, string> };
  for (const t of TOPICS) {
    assert.deepEqual(cursor.topics[t.topic], { "0": recorded.topics[t.topic]!.edge }, t.topic);
    assert.equal(cursor.through[t.topic], recorded.edge, t.topic);
  }
});

test("oi-nrd recorded: the trailing dot is removed: every key is the reversed name of its message without the dot", async () => {
  const h = await sandboxed();
  for (const w of h.first.written) {
    const spec = specOf(w.segment.source);
    const names = messagesOf(w).map((m) => m.value[spec.kind === "fqdn" ? "fqdn" : "domain"] as string);
    assert.ok(names.length > 0);
    // The two domain topics end every name in a dot; newly_registered_fqdn ends
    // none in one (design 1.2: 20,000 of 20,000, and 0 of 20,000).
    assert.ok(
      names.every((n) => n.endsWith(".") === (spec.kind !== "fqdn")),
      `${spec.topic}: the names read end in a dot as the topic's do`,
    );
    const keys = new Set(w.records.map((r) => r.key));
    for (const n of names) {
      const bare = normalise(n.endsWith(".") ? n.slice(0, -1) : n, PSL);
      assert.ok("name" in bare, n);
      const name = spec.kind === "fqdn" ? bare.name : split(bare.name, PSL).reg!;
      assert.ok(keys.has(key(name)), `${spec.topic}: ${n} is keyed ${key(name)}`);
    }
    assert.ok(
      [...keys].every((k) => !k.endsWith(".") && !k.startsWith(".")),
      spec.topic,
    );
  }
});

test("oi-nrd recorded: the raw lane of each window holds its batches as received, CRC-32C checked, and members.json names the topic, partition and offsets", async () => {
  const h = await sandboxed();
  const answers = recording.exchanges.map((x) => Buffer.from(x.response));
  for (const w of h.first.written) {
    const spec = specOf(w.segment.source);
    const r = recorded.topics[spec.topic]!;
    const { batches, partial } = splitBatches(w.raw!);
    assert.equal(partial, 0);
    // decodeBatch checks each batch's CRC-32C; the offsets run from C0 to the edge.
    assert.deepEqual(
      batches.flatMap((b) => decodeBatch(b.bytes).records.map((x) => x.offset)),
      Array.from({ length: r.edge - r.c0 }, (_, i) => r.c0 + i),
    );
    for (const b of batches)
      assert.ok(
        answers.some((a) => a.indexOf(Buffer.from(b.bytes)) !== -1),
        `${spec.topic} batch ${b.baseOffset} is a byte run of a recorded answer`,
      );
    assert.deepEqual(w.rawMember, { topic: spec.topic, partition: 0, base_offset: r.c0, last_offset: r.edge - 1, batches: batches.length });
    assert.deepEqual(w.segment.raw, { bytes: w.raw!.byteLength, sha256: createHash("sha256").update(w.raw!).digest("hex") });
  }
});

test("oi-nrd recorded: the facts of oi-nrd hold each known certificate age, and an age over 7 days is there for each event whose submission_timestamp is more than 7 days before its timestamp", async () => {
  const h = await sandboxed();
  const w = h.first.written.find((x) => x.segment.source === "oi-nrd")!;
  const ages = new Map<string, number>();
  let old = 0;
  for (const { value } of messagesOf(w)) {
    const { timestamp, submission_timestamp: submitted, domain } = value as { timestamp?: unknown; submission_timestamp?: unknown; domain: string };
    if (typeof timestamp !== "number" || typeof submitted !== "number") continue;
    const age = Math.max(0, Math.floor(timestamp - submitted));
    if (age > OLD_CERT_S) old += 1;
    const n = normalise(domain.slice(0, -1), PSL);
    assert.ok("name" in n);
    const k = key(split(n.name, PSL).reg!);
    ages.set(k, Math.min(ages.get(k) ?? age, age));
  }
  assert.ok(ages.size > 0, "the window holds events with a known age");
  assert.deepEqual(
    w.facts,
    [...ages].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, cert_age]) => ({ key: k, cert_age })),
  );
  for (const [k, age] of ages)
    if (age > OLD_CERT_S)
      assert.ok(
        w.facts!.some((f) => f.key === k && f.cert_age > OLD_CERT_S),
        k,
      );
  assert.equal(h.first.result.stats["oi-nrd.cert_age_over_7d"]! >= old, true);
  // The two other sources write no facts layer.
  for (const x of h.first.written.filter((y) => y.segment.source !== "oi-nrd")) assert.equal(x.facts, null, x.segment.source);
});

test("oi-nrd recorded: the cursor's canonical JSON is at most 1024 characters, and so is each segment's", async () => {
  const h = await sandboxed();
  assert.ok(canonicalJson(h.first.result.cursor).length <= 1024, canonicalJson(h.first.result.cursor));
  assert.ok(canonicalJson(start.cursor).length <= 1024);
  for (const s of h.first.result.segments) for (const c of [s.cursorBefore, s.cursorAfter]) assert.ok(canonicalJson(c).length <= 1024);
});
