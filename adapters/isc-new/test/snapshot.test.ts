import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { type Fetch, memoryWriter, parseRecording, replayFetch, sha256Hex } from "@domains/adapter";
import { runSandboxed } from "@domains/adapter/node";
import { loadPsl } from "@domains/names";
import { BIT, datedUrl, DPK1_EPOCH_DAY, fetchSnapshot, ISC_FEEDS, type IscFault, MAX_GZIP_BYTES, parseSnapshot, type SnapshotFile, SOURCE, writeIndexedSnapshot } from "../src/index.ts";

const USER_AGENT = "domains.pkgforge.dev ISC adapter fixture";
const DAY = "2026-11-26";
const ALIAS = `${ISC_FEEDS}domaindata.json.gz`;
const psl = await loadPsl(readFileSync(new URL("../../../packages/names/test/fixtures/psl-2026-10-27.dat", import.meta.url)));
const context = (fetch: Fetch) => ({ fetch, userAgent: USER_AGENT });
const gzip = (plain: string | Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(gzipSync(plain));
const row = (domainname: string, firstseen = DAY) => ({ domainname, firstseen, score: 15, ip: null, scorereason: "feed metadata" });
const document = (...rows: readonly unknown[]) => gzip(JSON.stringify(rows));

async function fileOf(raw: Uint8Array, pathDay: string | null = DAY): Promise<SnapshotFile> {
  return { kind: "file", pathDay, raw, url: pathDay === null ? ALIAS : datedUrl(pathDay), sha256: await sha256Hex(raw), validators: {} };
}

function fixture(name: string) {
  return parseRecording(JSON.parse(readFileSync(new URL(`../fixtures/${name}.http.json`, import.meta.url), "utf8")), name);
}

test("isc snapshot: the exact empty response is a valid zero-row array", async () => {
  const recorded = fixture("empty");
  const replay = replayFetch([recorded]);
  const file = await fetchSnapshot(context(replay.fetch), { day: "2026-11-27" });
  assert.equal(file.kind, "file");
  assert.equal(file.raw.byteLength, 55);
  assert.equal(file.sha256, "4ee056600b5563434856c56784710604f8eab060518aa7670a12f9634f46ca8f");
  const parsed = await parseSnapshot(file, psl);
  assert.deepEqual([parsed.day, parsed.rows, parsed.index], [null, 0, null]);
  assert.equal(replay.requests[0]?.userAgent, USER_AGENT);
  assert.deepEqual(replay.misses, []);
});

test("isc snapshot: the curated ISC slice writes reproducible records and supplies the exact gzip and URL to the writer", async () => {
  const recording = fixture("slice");
  const replay = replayFetch([recording]);
  const file = await fetchSnapshot(context(replay.fetch), { day: DAY });
  assert.equal(file.kind, "file");
  assert.deepEqual(file.raw, recording.response.body);
  const first = await parseSnapshot(file, psl);
  assert.equal(first.day, DAY);
  assert.equal(first.rows, 200);
  assert.ok(first.index !== null && first.index.count > 0 && first.index.count <= 200);
  const writer = memoryWriter();
  const segment = await writeIndexedSnapshot(first, writer);
  assert.deepEqual(segment.window, { start: "2026-11-26T00:00:00Z", end: "2026-11-27T00:00:00Z" });
  assert.deepEqual(segment.raw, { bytes: file.raw.byteLength, sha256: file.sha256 });
  assert.equal(writer.written[0]?.url, datedUrl(DAY));
  assert.deepEqual(writer.written[0]?.raw, recording.response.body);
  const again = memoryWriter();
  assert.deepEqual(await writeIndexedSnapshot(await parseSnapshot(file, psl), again), segment);
  assert.deepEqual(again.written, writer.written);
});

test("isc snapshot: sandboxed replay holds raw bytes and the dated segment to the source definition", async () => {
  const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));
  const replay = await runSandboxed({
    module: path("../src/snapshot-test-entry.ts"),
    sourceFile: path("../source.json"),
    recordings: path("../fixtures/"),
    psl: path("../../../packages/names/test/fixtures/psl-2026-10-27.dat"),
    cursor: null,
    now: "2026-12-01T12:00:00Z",
  });
  const gzip = fixture("slice").response.body;
  assert.deepEqual(replay.first.written, replay.again.written);
  assert.equal(replay.first.written.length, 1);
  const written = replay.first.written[0]!;
  assert.deepEqual(written.raw, gzip);
  assert.equal(written.url, datedUrl(DAY));
  assert.deepEqual(written.segment, replay.first.result.segments[0]);
  assert.deepEqual([written.segment.source, written.segment.precision, written.segment.window.start], [SOURCE, "day", `${DAY}T00:00:00Z`]);
  assert.deepEqual(
    replay.first.requests.map((r) => [r.method, r.url]),
    [["GET", datedUrl(DAY)]],
  );
  assert.deepEqual([replay.first.connections, replay.next.written, replay.next.requests], [[], [], []]);
});

test("isc snapshot: DPK1 rows are registrable reversed keys with ISC day precision and T2 list evidence", async () => {
  const day = DPK1_EPOCH_DAY;
  const file = await fileOf(document(row("Staff.Example.COM.", day), row("*.other.example.com", day), row("bücher.example", day), row("co.uk", day)), null);
  const parsed = await parseSnapshot(file, psl);
  assert.ok(parsed.index);
  assert.equal(parsed.day, day);
  assert.equal(parsed.index.refused, 1);
  assert.deepEqual(parsed.index.window, { start: "2026-01-01T00:00:00Z", end: "2026-01-02T00:00:00Z" });
  assert.deepEqual(
    [...parsed.index.records],
    ["com.example", "example.xn--bcher-kva"].map((key) => ({ key, flags: 0, sources: [{ bit: BIT, first: 0, last: 0 }], evidence: [{ tier: 2, basis: 2, source: BIT, at: 0, confidence: 0 }] })),
  );
  const writer = memoryWriter();
  const segment = await writeIndexedSnapshot(parsed, writer);
  assert.equal(segment.source, SOURCE);
  assert.equal(segment.precision, "day");
  assert.equal(writer.written[0]?.url, ALIAS);
});

test("isc snapshot: a pre-epoch file remains valid raw with its original date and no DPK1 index", async () => {
  const day = "2025-10-26";
  const file = await fileOf(document(row("example.com", day)), day);
  const parsed = await parseSnapshot(file, psl);
  assert.deepEqual([parsed.day, parsed.rows, parsed.index], [day, 1, null]);
  assert.equal(parsed.file, file);
  assert.equal(await sha256Hex(parsed.file.raw), file.sha256);
  const writer = memoryWriter();
  await assert.rejects(writeIndexedSnapshot(parsed, writer), { name: "IscFault", code: "date" });
  assert.deepEqual(writer.written, []);
});

test("isc snapshot: the conditional request uses the supplied validator and keeps alias and dated metadata distinct", async () => {
  const cached = "Wed, 25 Nov 2026 08:00:00 GMT";
  const seen: [string, string | null, string | null][] = [];
  const watched = context(async (input, init) => {
    assert.equal(init?.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    const headers = new Headers(init.headers);
    assert.equal(headers.get("user-agent"), USER_AGENT);
    assert.equal(headers.get("accept-encoding"), "identity");
    seen.push([String(input), headers.get("if-none-match"), headers.get("if-modified-since")]);
    return new Response(null, { status: 304, headers: String(input) === ALIAS ? {} : { etag: '"dated"' } });
  });
  const alias = await fetchSnapshot(watched, { validators: { etag: '"alias"', lastModified: cached } });
  const dated = await fetchSnapshot(watched, { day: DAY, validators: { lastModified: cached } });
  assert.deepEqual(seen, [
    [ALIAS, '"alias"', null],
    [datedUrl(DAY), null, cached],
  ]);
  assert.deepEqual(alias, { kind: "unchanged", url: ALIAS, pathDay: null, validators: { etag: '"alias"', lastModified: cached } });
  assert.deepEqual(dated, { kind: "unchanged", url: datedUrl(DAY), pathDay: DAY, validators: { etag: '"dated"', lastModified: cached } });
});

test("isc snapshot: content identity follows the exact bytes independently of ETag or length", async () => {
  // Gzip's stored blocks keep the two equal-length documents equal in size.
  const one = Uint8Array.from(gzipSync(JSON.stringify([row("aaa.example.com")]), { level: 0 }));
  const two = Uint8Array.from(gzipSync(JSON.stringify([row("bbb.example.com")]), { level: 0 }));
  assert.equal(one.byteLength, two.byteLength);
  const read = (raw: Uint8Array<ArrayBuffer>, etag: string) =>
    fetchSnapshot(
      context(async () => new Response(raw, { headers: { etag } })),
      { day: DAY },
    );
  const old = await read(one, '"old"');
  const relabelled = await read(one, '"new"');
  const revised = await read(two, '"new"');
  assert.equal(old.kind, "file");
  assert.equal(relabelled.kind, "file");
  assert.equal(revised.kind, "file");
  assert.equal(old.sha256, relabelled.sha256);
  assert.notDeepEqual(old.validators, relabelled.validators);
  assert.deepEqual(relabelled.validators, revised.validators);
  assert.notEqual(relabelled.sha256, revised.sha256);
});

test("isc snapshot: an unannounced body retains exact bytes across partial buffers and caps the read", async () => {
  const raw = Uint8Array.from(gzipSync(`[${" ".repeat(1024 ** 2)}${JSON.stringify(row("example.com"))}]`, { level: 0 }));
  let offset = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset === raw.length) controller.close();
      else {
        const end = Math.min(offset + 331, raw.length);
        controller.enqueue(raw.subarray(offset, end));
        offset = end;
      }
    },
  });
  const file = await fetchSnapshot(context(async () => new Response(body)));
  assert.equal(file.kind, "file");
  assert.deepEqual(file.raw, raw);
  assert.equal((await parseSnapshot(file, psl)).day, DAY);

  const chunk = new Uint8Array(1024 ** 2);
  let remaining = MAX_GZIP_BYTES / chunk.byteLength + 3;
  let cancelled = false;
  const tooLong = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) controller.close();
      else {
        controller.enqueue(chunk);
        remaining -= 1;
      }
    },
    cancel() {
      cancelled = true;
    },
  });
  await assert.rejects(fetchSnapshot(context(async () => new Response(tooLong))), { name: "IscFault", code: "size" });
  assert.equal(cancelled, true);
});

test("isc snapshot: an aborted partial body is a timeout and cannot produce a snapshot", async (t) => {
  const abort = new AbortController();
  t.mock.method(AbortSignal, "timeout", () => abort.signal);
  const watched = context(async (input, init) => {
    assert.equal(String(input), ALIAS);
    assert.equal(init?.signal, abort.signal);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.of(0x1f, 0x8b));
        abort.signal.addEventListener("abort", () => controller.error(abort.signal.reason), { once: true });
      },
      pull() {
        abort.abort(new DOMException("body deadline", "TimeoutError"));
      },
    });
    return new Response(body);
  });
  await assert.rejects(fetchSnapshot(watched), { name: "IscFault", code: "timeout" });
});

test("isc snapshot: only 404 means missing, and bad length or HTTP encoding does not become raw", async () => {
  const missing = await fetchSnapshot(
    context(async () => new Response(null, { status: 404 })),
    { day: DAY },
  );
  assert.equal(missing.kind, "missing");
  for (const status of [206, 304, 403, 429, 503]) {
    await assert.rejects(fetchSnapshot(context(async () => new Response(null, { status }))), { name: "IscFault", code: "http" });
  }
  const raw = document(row("example.com"));
  for (const [headers, code] of [
    [{ "content-length": String(raw.byteLength - 1) }, "length"],
    [{ "content-length": String(raw.byteLength + 1) }, "length"],
    [{ "content-length": "1e3" }, "length"],
    [{ "content-length": String(MAX_GZIP_BYTES + 1) }, "size"],
    [{ "content-encoding": "gzip" }, "encoding"],
  ] as const) {
    await assert.rejects(fetchSnapshot(context(async () => new Response(raw, { headers }))), { name: "IscFault", code });
  }
  await assert.rejects(
    fetchSnapshot(
      context(async () => assert.fail("invalid day should make no request")),
      { day: "2026-02-30" },
    ),
    { name: "IscFault", code: "date" },
  );
});

test("isc snapshot: path and firstseen disagreements refuse the index with raw bytes still available", async () => {
  for (const raw of [document(row("example.com", "2026-11-25")), document(row("example.com"), row("example.net", "2026-11-25"))]) {
    const file = await fileOf(raw);
    await assert.rejects(parseSnapshot(file, psl), { name: "IscFault", code: "date" });
    assert.deepEqual(file.raw, raw);
    assert.equal(await sha256Hex(file.raw), file.sha256);
  }
});

test("isc snapshot: malformed rows, framing, UTF-8 and gzip are integrity faults", async () => {
  const good = JSON.stringify(row("example.com"));
  const body = gzip(`[${good}]`);
  const cases: [Uint8Array, IscFault["code"]][] = [
    [gzip(`{"items":[${good}]}`), "format"],
    [gzip(`[${good},]`), "format"],
    [gzip(`[${good}] null`), "format"],
    [gzip(`[${good}`), "format"],
    [gzip(`[${good} ${good}]`), "format"],
    [gzip(`[${good},null]`), "format"],
    [document({ domainname: 18, firstseen: DAY }), "format"],
    [document(row("example.com", "2026-02-30")), "date"],
    [document(row("example.com", `${DAY}T00:00:00Z`)), "date"],
    [document({ ...row("example.com"), scorereason: "x".repeat(8192) }), "size"],
    [gzip(Uint8Array.of(91, 0xff, 93)), "encoding"],
    [body.subarray(0, -4), "gzip"],
    [new Uint8Array([...body, ...body]), "gzip"],
  ];
  for (const [raw, code] of cases) await assert.rejects(parseSnapshot(await fileOf(raw), psl), { name: "IscFault", code });
});

test("isc snapshot: object and UTF-8 framing hold across inflater chunks and ignore metadata for indexing", async () => {
  const start = '[{"domainname":"';
  // The first byte of ü lands at the end of Node's 16 KiB inflate chunk.
  const padding = " ".repeat(16 * 1024 - 1 - start.length);
  const rest = JSON.stringify({ nested: ['} ] \\ "', { bracket: "{" }] });
  const raw = gzip(`${padding}${start}ücher.example","firstseen":"${DAY}","details":${rest}}]`);
  const parsed = await parseSnapshot(await fileOf(raw), psl);
  assert.ok(parsed.index);
  assert.equal(parsed.rows, 1);
  assert.deepEqual(
    [...parsed.index.records].map((record) => record.key),
    ["example.xn--cher-zra"],
  );
});
