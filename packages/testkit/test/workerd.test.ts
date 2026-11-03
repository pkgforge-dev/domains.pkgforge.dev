// packages/testkit/src/workerd.ts: the smoke Worker runs in workerd under the
// pinned compatibility date and flags, deflate-raw streams and the Cache API
// exist there, the instance is disposed when the test body throws, a date the
// runtime refuses fails the start, the pinned workerd binary runs the pinned date
// with the pinned flags and refuses the day after its newest, the harness starts
// from any working directory, and the Worker reaches no network unless the test
// gives an outbound handler.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import type { Miniflare } from "miniflare";
import { BUNDLE_OPTIONS, bundle, COMPATIBILITY_DATE, COMPATIBILITY_FLAGS, miniflareOptions, withWorker } from "../src/workerd.ts";

const SMOKE = join(import.meta.dirname, "smoke-worker.ts");
const TEXT = "api.example.com.np\nnp.com.example.api\n".repeat(50);

// The workerd package that Miniflare loads. Its binary is the runtime of every
// harness test, and its version is the package's own.
function harnessWorkerd(): { bin: string; version: string } {
  const fromMiniflare = createRequire(fileURLToPath(import.meta.resolve("miniflare")));
  const workerd = fromMiniflare("workerd") as { default: string; version: string };
  return { bin: workerd.default, version: workerd.version };
}

// `workerd test` on a config of one module Worker at `date`, with the harness's
// flags. The binary checks the date when it loads the config and exits on its
// own; execFile ends the one child it started, by its handle, after 60 s. The
// Worker's test fails when `process` or `Buffer` exists: from 2026-08-04 a date
// turns the Node.js APIs on, and the two flags turn them off.
const NO_NODE_WORKER = [
  "export default { async test() {",
  '  const seen = [typeof globalThis.process, typeof globalThis.Buffer].join(" ");',
  '  if (seen !== "undefined undefined") throw new Error(`process and Buffer: ${seen}`);',
  "} };",
  "",
].join("\n");
function workerdTest(bin: string, date: string): Promise<{ code: number | string | null; out: string }> {
  const dir = mkdtempSync(join(tmpdir(), "workerd-date-"));
  writeFileSync(join(dir, "w.mjs"), NO_NODE_WORKER);
  const flags = COMPATIBILITY_FLAGS.map((f) => JSON.stringify(f)).join(", ");
  writeFileSync(
    join(dir, "config.capnp"),
    [
      'using Workerd = import "/workerd/workerd.capnp";',
      'const config :Workerd.Config = ( services = [ (name = "main", worker = .w) ] );',
      `const w :Workerd.Worker = ( modules = [ (name = "w", esModule = embed "w.mjs") ], compatibilityDate = ${JSON.stringify(date)}, compatibilityFlags = [${flags}] );`,
      "",
    ].join("\n"),
  );
  return new Promise((done) => {
    execFile(bin, ["test", join(dir, "config.capnp")], { timeout: 60_000, encoding: "utf8" }, (error, stdout, stderr) => {
      rmSync(dir, { recursive: true, force: true });
      done({ code: error === null ? 0 : (error.code ?? null), out: `${stdout}${stderr}` });
    });
  });
}

test("workerd: the pinned compatibility date is 2026-11-02, and the flags are mirror-archlinux's", () => {
  assert.equal(COMPATIBILITY_DATE, "2026-11-02");
  assert.deepEqual([...COMPATIBILITY_FLAGS], ["no_nodejs_compat", "no_nodejs_compat_v2"]);
});

// The root package.json pins miniflare beside wrangler. The two must load one
// workerd, so the harness runs the runtime that the pinned wrangler bundles.
test("workerd: the harness runs workerd 1.20261101.1, the one the pinned wrangler 4.156.1 depends on", () => {
  const { version } = harnessWorkerd();
  const wrangler = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve("wrangler/package.json")), "utf8")) as { version: string; dependencies: Record<string, string> };
  assert.equal(wrangler.version, "4.156.1");
  assert.equal(wrangler.dependencies.workerd, version);
  assert.equal(version, "1.20261101.1");
});

test("workerd: the smoke Worker round-trips text through CompressionStream and DecompressionStream deflate-raw", async () => {
  await withWorker({ scriptPath: SMOKE }, async (w) => {
    const res = await w.fetch(`/decode?text=${encodeURIComponent(TEXT)}`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { text: string; compressedBytes: number };
    assert.equal(body.text, TEXT);
    assert.ok(body.compressedBytes > 0 && body.compressedBytes < TEXT.length, `compressed to ${body.compressedBytes} of ${TEXT.length} bytes`);
  });
});

test("workerd: DecompressionStream deflate-raw reads raw deflate made by node:zlib", async () => {
  await withWorker({ scriptPath: SMOKE }, async (w) => {
    const res = await w.fetch("/decode", { method: "POST", body: deflateRawSync(Buffer.from(TEXT)) });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { text: TEXT, bytes: Buffer.byteLength(TEXT) });
  });
});

test("workerd: a Cache API put is matched in the same request", async () => {
  await withWorker({ scriptPath: SMOKE }, async (w) => {
    const res = await w.fetch("/cache?key=root-latest");
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { stored: "stored at root-latest", matched: "stored at root-latest" });
  });
});

test("workerd: withWorker rethrows the test body's error and disposes the instance", async () => {
  let held: Miniflare | undefined;
  await assert.rejects(
    withWorker({ scriptPath: SMOKE }, async (w) => {
      held = w.miniflare;
      assert.equal((await w.fetch("/nowhere")).status, 404);
      throw new Error("planted failure");
    }),
    /planted failure/,
  );
  assert.ok(held, "the test body ran");
  const instance = held;
  await assert.rejects(() => instance.dispatchFetch("https://worker.test/decode?text=x"), "a disposed instance answers nothing");
});

test("workerd: a compatibility date the runtime refuses fails the start and never runs the test body", async () => {
  let ran = false;
  await assert.rejects(
    withWorker({ scriptPath: SMOKE, compatibilityDate: "2099-01-01" }, async () => {
      ran = true;
    }),
    /2099-01-01/,
  );
  assert.equal(ran, false);
});

// workerd 1.20261101.1, the runtime wrangler 4.156.1 pins, supports dates up to
// 2026-11-08, and refuses a date after today (UTC), as Miniflare does before it
// starts workerd. So through withWorker no date reaches the binary's own bound
// before 2026-11-09, and this test runs the binary that Miniflare runs: at the
// day after its bound it refuses the start and names the bound, rather than
// falling back, and at COMPATIBILITY_DATE it runs with COMPATIBILITY_FLAGS and
// no Node.js API. A runtime upgrade fails this test on purpose, so the pinned
// date is re-read with it.
test("workerd: the pinned runtime refuses 2026-11-09, names 2026-11-08 as the newest date it supports, and runs the pinned date with the pinned flags and no Node.js API", async () => {
  const { bin } = harnessWorkerd();
  const refused = await workerdTest(bin, "2026-11-09");
  assert.notEqual(refused.code, 0, refused.out);
  assert.match(refused.out, /requires compatibility date "2026-11-09", but the newest date supported by this server binary is "2026-11-08"/);
  assert.doesNotMatch(refused.out, /\[ PASS \]/);
  const ran = await workerdTest(bin, COMPATIBILITY_DATE);
  assert.equal(ran.code, 0, ran.out);
  assert.match(ran.out, /\[ PASS \] main/);
});

test("workerd: a fetch the Worker makes is refused unless the test gives an outbound handler", async () => {
  const fetcher = join(import.meta.dirname, "fixtures", "fetch-worker.ts");
  await withWorker({ scriptPath: fetcher }, async (w) => {
    const res = await w.fetch("/?url=https://ghcr.io/v2/");
    // Miniflare answers the Worker's fetch with a 500 that carries the thrown error.
    assert.equal(res.status, 500);
    assert.match(await res.text(), /fetched https:\/\/ghcr\.io\/v2\/, and the test gave no outbound handler/);
    assert.deepEqual(w.outbound, ["https://ghcr.io/v2/"]);
  });
  await withWorker({ scriptPath: fetcher, outbound: (req) => new Response(`stand-in for ${req.url}`, { status: 200 }) }, async (w) => {
    const res = await w.fetch("/?url=https://ghcr.io/v2/");
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "stand-in for https://ghcr.io/v2/");
  });
});

test("workerd: a Worker that imports a node: module fails to bundle, as it fails a deploy without nodejs_compat", async () => {
  const nodeWorker = join(import.meta.dirname, "fixtures", "node-import-worker.ts");
  await assert.rejects(
    withWorker({ scriptPath: nodeWorker }, async () => {}),
    /node:fs/,
  );
});

test("workerd: the bundle takes wrangler's format, target and conditions, for the browser platform", () => {
  assert.equal(BUNDLE_OPTIONS.platform, "browser");
  assert.equal(BUNDLE_OPTIONS.format, "esm");
  assert.equal(BUNDLE_OPTIONS.target, "es2024");
  assert.deepEqual([...BUNDLE_OPTIONS.conditions], ["workerd", "worker", "browser"]);
  assert.deepEqual({ ...BUNDLE_OPTIONS.supported }, { "import-source": true, using: true });
});

test("workerd: a node: import is refused by the bundle step itself, before workerd starts", async () => {
  const nodeWorker = join(import.meta.dirname, "fixtures", "node-import-worker.ts");
  await assert.rejects(bundle(nodeWorker), (e: unknown) => e instanceof Error && /node:fs/.test(e.message) && !/No such module/.test(e.message));
});

test("workerd: the instance is offline and local by default: loopback, a port the system picks, no cf, no telemetry, no dev registry", () => {
  const seen: string[] = [];
  const o = miniflareOptions({ scriptPath: SMOKE }, "export default {}", seen);
  assert.equal(o.host, "127.0.0.1");
  assert.equal(o.port, 0);
  assert.equal(o.cf, false);
  assert.deepEqual(o.telemetry, { enabled: false });
  assert.equal(o.unsafeRegisterWorker, false);
  assert.equal(o.modulesRoot, dirname(resolve(SMOKE)));
  assert.equal(o.compatibilityDate, COMPATIBILITY_DATE);
  assert.deepEqual(o.compatibilityFlags, [...COMPATIBILITY_FLAGS]);
  assert.deepEqual(o.bindings, {});
  assert.deepEqual(o.r2Buckets, []);
  assert.throws(() => o.outboundService({ url: "https://example.invalid/", method: "GET", headers: new Headers() }), /the test gave no outbound handler/);
  assert.deepEqual(seen, ["https://example.invalid/"]);
  const given = miniflareOptions({ scriptPath: SMOKE, compatibilityDate: "2026-10-01", compatibilityFlags: ["x"], bindings: { A: 1 }, r2Buckets: ["B"] }, "", seen);
  assert.deepEqual([given.compatibilityDate, given.compatibilityFlags, given.bindings, given.r2Buckets], ["2026-10-01", ["x"], { A: 1 }, ["B"]]);
});

// Miniflare names the module by its path from modulesRoot. The harness sets it
// to the entry's directory, so a test or a script that runs from a directory
// that does not hold the entry still starts the Worker. The directory is
// packages/testkit/src, on the entry's drive: from it, a name relative to the
// working directory starts with "../", which workerd refuses with "internal
// error". From another drive the name is absolute, and workerd takes it.
test("workerd: withWorker starts the Worker from a working directory that does not hold the entry", async () => {
  const away = resolve(dirname(SMOKE), "..", "src");
  const before = process.cwd();
  process.chdir(away);
  try {
    await withWorker({ scriptPath: SMOKE }, async (w) => {
      assert.equal((await w.fetch("/nowhere")).status, 404);
    });
  } finally {
    process.chdir(before);
  }
});

test("workerd: bindings reach the Worker as plain variables", async () => {
  await withWorker({ scriptPath: join(import.meta.dirname, "fixtures", "env-worker.ts"), bindings: { GREETING: "hello", LIMIT: 5 } }, async (w) => {
    assert.deepEqual(await (await w.fetch("/")).json(), { greeting: "hello", limit: 5 });
  });
});

test("workerd: a dispose that fails after a failed test body is thrown with it, neither hiding the other", async () => {
  const planted = (mf: Miniflare): void => {
    const real = mf.dispose.bind(mf);
    // The real dispose runs first, so the child workerd still ends.
    mf.dispose = async () => {
      await real();
      throw new Error("dispose planted");
    };
  };
  await assert.rejects(
    withWorker({ scriptPath: SMOKE }, async (w) => {
      planted(w.miniflare);
      throw new Error("body planted");
    }),
    (e: unknown) => e instanceof AggregateError && e.errors.map((x: Error) => x.message).join("|") === "body planted|dispose planted",
  );
  await assert.rejects(
    withWorker({ scriptPath: SMOKE }, async (w) => {
      planted(w.miniflare);
    }),
    /dispose planted/,
  );
});
