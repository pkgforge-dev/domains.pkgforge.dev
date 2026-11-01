// packages/adapter/node/sandbox.ts and sandbox-child.ts: runAdapter in a Node
// child that cannot reach the network. The two plants of fixtures/plants/ (a
// fetch captured at import, a node:net socket) pass the harness's trap and
// reach a local server in process, three times, once a run; in the sandbox
// each is refused with ERR_ACCESS_DENIED and the server counts nothing more.
// A clean adapter (the stream fixture of scripts/ingest/fixtures/) answers in
// the sandbox exactly what it answers in process, and the child refuses to run
// unless each of the four permissions is denied. The plant misbehave.ts holds
// the rest of sandbox.ts's header, one misdeed a run: reads past readPaths,
// the environment, writes, processes, workers, a run that never returns, the
// cause chain, stdout before the answer, an exit and the answer's cap.
//
//   node scripts/test.mjs packages/adapter --name sandbox
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { type AddressInfo, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { readBits, readRecordings, readTcpRecordings } from "../node/files.ts";
import { REPO_ROOT, readPaths, runSandboxed, SANDBOX_CHILD, SandboxCause } from "../node/sandbox.ts";
import { runAdapter } from "../src/harness.ts";
import type { AdapterModule } from "../src/types.ts";
import { ContractError, validateSourceFile } from "../src/validate.ts";
import { PSL, PSL_FILE } from "./fixture-psl.ts";

const NOW = "2026-10-30T08:35:00Z";
const PLANTS = join(import.meta.dirname, "fixtures", "plants");
const STREAM = join(REPO_ROOT, "scripts", "ingest", "fixtures", "adapters", "fixture-stream");
const plant = async (name: string): Promise<AdapterModule> => (await import(pathToFileURL(join(PLANTS, name)).href)) as AdapterModule;

// Rejects with a ContractError of exactly this check.
async function refuses(p: Promise<unknown>, check: string): Promise<ContractError> {
  let caught: unknown = null;
  try {
    await p;
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof ContractError, `expected a ContractError ${check}, got ${caught === null ? "no error" : String(caught)}`);
  assert.equal(caught.check, check, caught.message);
  return caught;
}

async function listening(server: Server | ReturnType<typeof createHttpServer>): Promise<number> {
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return (server.address() as AddressInfo).port;
}

// Each plant's sandboxed run fails as `threw`, its cause the permission model's refusal.
function deniedCause(err: ContractError): void {
  assert.ok(err.cause instanceof SandboxCause, String(err.cause));
  assert.equal(err.cause.code, "ERR_ACCESS_DENIED", err.cause.message);
}

test("adapter sandbox: an adapter that captured fetch at import reaches the network in process and is refused in the sandbox", async () => {
  let hits = 0;
  const server = createHttpServer((_req, res) => {
    hits += 1;
    res.end("reached");
  });
  const port = await listening(server);
  try {
    const cursor = { url: `http://127.0.0.1:${port}/plant` };
    // runAdapter runs three times, and its trap on the global fetch sees none of the three.
    await runAdapter(await plant("captured-fetch.ts"), { recordings: [], psl: PSL, cursor, now: NOW });
    assert.equal(hits, 3);
    const err = await refuses(runSandboxed({ module: join(PLANTS, "captured-fetch.ts"), recordings: PLANTS, psl: PSL_FILE, cursor, now: NOW }), "threw");
    deniedCause(err);
    assert.match(err.message, /fetch failed/);
    assert.equal(hits, 3);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test("adapter sandbox: an adapter that opens node:net reaches the network in process and is refused in the sandbox", async () => {
  let connections = 0;
  const sockets = new Set<Socket>();
  const server = createServer((s) => {
    connections += 1;
    sockets.add(s);
    // The plant destroys its socket once this byte arrives; the reset is expected.
    s.on("error", () => {});
    s.end("x");
  });
  const port = await listening(server);
  try {
    await runAdapter(await plant("net-connect.ts"), { recordings: [], psl: PSL, cursor: { port }, now: NOW });
    assert.equal(connections, 3);
    deniedCause(await refuses(runSandboxed({ module: join(PLANTS, "net-connect.ts"), recordings: PLANTS, psl: PSL_FILE, cursor: { port }, now: NOW }), "threw"));
    assert.equal(connections, 3);
  } finally {
    for (const s of sockets) s.destroy();
    await new Promise<void>((ok) => server.close(() => ok()));
  }
});

test("adapter sandbox: the child refuses to run unless net, child, worker and fs.write are each denied", () => {
  const env: Record<string, string> = {};
  for (const k of ["PATH", "SystemRoot"]) if (process.env[k] !== undefined) env[k] = process.env[k] as string;
  const cases: [string, string[], RegExp][] = [
    ["no --permission", [], /not sandboxed: net, child, worker, fs\.write not denied/],
    ["--allow-net", ["--permission", `--allow-fs-read=${REPO_ROOT}`, "--allow-net"], /not sandboxed: net not denied/],
    ["--allow-child-process", ["--permission", `--allow-fs-read=${REPO_ROOT}`, "--allow-child-process"], /not sandboxed: child not denied/],
    ["--allow-worker", ["--permission", `--allow-fs-read=${REPO_ROOT}`, "--allow-worker"], /not sandboxed: worker not denied/],
    ["--allow-fs-write=*", ["--permission", `--allow-fs-read=${REPO_ROOT}`, "--allow-fs-write=*"], /not sandboxed: fs\.write not denied/],
  ];
  for (const [what, flags, why] of cases) {
    const r = spawnSync(process.execPath, [...flags, SANDBOX_CHILD], { env, input: "{}", encoding: "utf8", windowsHide: true, timeout: 60_000 });
    assert.equal(r.status, 2, `${what}: ${r.stderr}`);
    assert.match(r.stderr, why, what);
    assert.equal(r.stdout, "", what);
  }
});

test("adapter sandbox: a clean adapter's three runs come back with their records, as in process", async () => {
  const module = join(STREAM, "src", "index.ts");
  const sourceFile = join(STREAM, "source.json");
  const recordings = join(STREAM, "recordings");
  const sandboxed = await runSandboxed({ module, sourceFile, recordings, psl: PSL_FILE, cursor: null, now: NOW });
  const sources = validateSourceFile(JSON.parse(readFileSync(sourceFile, "utf8")), readBits(REPO_ROOT)).sources;
  const mod = (await import(pathToFileURL(module).href)) as AdapterModule;
  const inProcess = await runAdapter(mod, { recordings: readRecordings(recordings), tcp: readTcpRecordings(recordings), psl: PSL, cursor: null, now: NOW, sources });
  assert.deepEqual(sandboxed, inProcess);
  assert.deepEqual(
    sandboxed.first.written.map((w) => [w.segment.dataset, w.records.length, w.raw instanceof Uint8Array && !Buffer.isBuffer(w.raw)]),
    [
      ["names", 4, true],
      ["domains", 3, true],
      ["names", 2, true],
      ["domains", 2, true],
    ],
  );
  assert.deepEqual(sandboxed.first.result.cursor, { next: 2 });
});

test("adapter sandbox: its own failures are threw or options: a module that does not load, a list that is not one, a child past its time, a path that is not absolute", async () => {
  const base = { module: join(PLANTS, "captured-fetch.ts"), recordings: PLANTS, psl: PSL_FILE, cursor: { url: "http://127.0.0.1:9/" }, now: NOW };
  const missing = await refuses(runSandboxed({ ...base, module: join(PLANTS, "no-such-plant.ts") }), "threw");
  assert.match(missing.message, /no-such-plant\.ts does not load/);
  const notList = await refuses(runSandboxed({ ...base, psl: join(PLANTS, "net-connect.ts") }), "options");
  assert.match(notList.message, /the sandbox's inputs do not load/);
  // Node starts in more than a millisecond: the child is ended by its PID.
  const slow = await refuses(runSandboxed({ ...base, timeoutMs: 1 }), "threw");
  assert.equal(slow.message, "threw: the sandbox timed out after 1 ms");
  await refuses(runSandboxed({ ...base, module: "fixtures/plants/captured-fetch.ts" }), "options");
  await refuses(runSandboxed({ ...base, timeoutMs: 0 }), "options");
  // The review of DOM-026: each path option is held, and so is the answer's bound.
  await refuses(runSandboxed({ ...base, sourceFile: "source.json" }), "options");
  await refuses(runSandboxed({ ...base, root: "." }), "options");
  await refuses(runSandboxed({ ...base, maxAnswerBytes: 0 }), "options");
});

// ---------------------------------------------------------------- the review of DOM-026

// Each adapter is held to the sandbox only by a test that runs it there, so the
// tree is read for one: an adapter added without it fails here (the review's door sweep).
test("adapter sandbox: every adapter directory has a test that runs its module through runSandboxed", () => {
  const adapters = join(REPO_ROOT, "adapters");
  const dirs = readdirSync(adapters, { withFileTypes: true }).filter((d) => d.isDirectory() && existsSync(join(adapters, d.name, "source.json")));
  assert.ok(dirs.length >= 1, "adapters/ holds an adapter");
  for (const d of dirs) {
    const tests = readdirSync(join(adapters, d.name), { recursive: true, encoding: "utf8" }).filter((f) => /\.test\.(ts|mjs)$/.test(f));
    const sandboxed = tests.filter((f) => /\brunSandboxed\(/.test(readFileSync(join(adapters, d.name, f), "utf8")));
    assert.ok(sandboxed.length > 0, `adapters/${d.name}: no test calls runSandboxed (tests: ${tests.join(", ") || "none"})`);
  }
});
// The plant misbehave.ts, one misdeed a run: each claim of sandbox.ts's header
// held by a plant that breaks it (the guard mutation found only the network held).
const MISBEHAVE = join(PLANTS, "misbehave.ts");
const misdeed = (cursor: Readonly<Record<string, string>>, extra: { timeoutMs?: number } = {}) => runSandboxed({ module: MISBEHAVE, recordings: PLANTS, psl: PSL_FILE, cursor, now: NOW, ...extra });

test("adapter sandbox: the child reads only what it is given: a file outside the checkout and a file of the checkout outside readPaths are refused, as is its parent's environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dom026-sandbox-"));
  try {
    const outside = join(dir, "outside.txt");
    writeFileSync(outside, "readable in process");
    const inProcess = await runAdapter(await plant("misbehave.ts"), { recordings: [], psl: PSL, cursor: { do: "read", path: outside }, now: NOW });
    assert.equal(inProcess.first.result.stats.read_bytes, 19);
    deniedCause(await refuses(misdeed({ do: "read", path: outside }), "threw"));
    // README.md is of the checkout, and the child is not given it.
    assert.ok(!readPaths({ module: MISBEHAVE, recordings: PLANTS, psl: PSL_FILE, cursor: null, now: NOW }, REPO_ROOT).some((p) => join(REPO_ROOT, "README.md").startsWith(p)));
    deniedCause(await refuses(misdeed({ do: "read", path: join(REPO_ROOT, "README.md") }), "threw"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const name = "DOM026_SANDBOX_WITNESS";
  const value = "witness-".repeat(3);
  process.env[name] = value;
  try {
    const inProcess = await runAdapter(await plant("misbehave.ts"), { recordings: [], psl: PSL, cursor: { do: "env", name }, now: NOW });
    assert.equal(inProcess.first.result.stats.env_length, value.length);
    const sandboxed = await misdeed({ do: "env", name });
    assert.equal(sandboxed.first.result.stats.env_length, 0);
  } finally {
    delete process.env[name];
  }
});

test("adapter sandbox: the child writes no file, inside the checkout or out, spawns no process and starts no worker", async () => {
  const inside = join(REPO_ROOT, ".tmp", `sandbox-write-witness-${randomUUID()}`);
  const dir = mkdtempSync(join(tmpdir(), "dom026-sandbox-"));
  try {
    for (const path of [inside, join(dir, "x.txt")]) {
      deniedCause(await refuses(misdeed({ do: "write", path }), "threw"));
      assert.equal(existsSync(path), false, path);
    }
  } finally {
    rmSync(inside, { force: true });
    rmSync(dir, { recursive: true, force: true });
  }
  for (const what of ["spawn", "worker"]) deniedCause(await refuses(misdeed({ do: what }), "threw"));
});

test("adapter sandbox: a run that never returns is ended by its PID at timeoutMs", { timeout: 60_000 }, async () => {
  const started = Date.now();
  const err = await refuses(misdeed({ do: "hang" }, { timeoutMs: 2_000 }), "threw");
  assert.equal(err.message, "threw: the sandbox timed out after 2000 ms");
  assert.ok(Date.now() - started < 30_000, `ended after ${Date.now() - started} ms`);
});

test("adapter sandbox: the cause chain comes back whole: the first string code down it, every message, bounded on a cycle, and runAdapter's own check", async () => {
  const nested = await refuses(misdeed({ do: "nested" }), "threw");
  assert.ok(nested.cause instanceof SandboxCause);
  assert.equal(nested.cause.code, "OUTER");
  assert.deepEqual(nested.cause.causes.slice(1), ["outer", "inner"]);
  const numeric = await refuses(misdeed({ do: "numeric" }), "threw");
  assert.equal((numeric.cause as SandboxCause).code, "STR");
  const cycle = await refuses(misdeed({ do: "cycle" }), "threw");
  assert.equal((cycle.cause as SandboxCause).causes.length, 16);
  assert.equal((cycle.cause as SandboxCause).code, "LOOP");
  const result = await refuses(misdeed({ do: "result" }), "result");
  assert.match(result.message, /^result: run 1: segments is not a list/);
});

test("adapter sandbox: what a module prints before the answer is not the answer; an exit, an exit with no answer and an answer past maxAnswerBytes are threw", async () => {
  const printed = await misdeed({ do: "stdout" });
  assert.deepEqual(printed.first.result.cursor, { do: "stdout" });
  const exit = await refuses(misdeed({ do: "exit" }), "threw");
  assert.match(exit.message, /^threw: the sandbox child exited 3/);
  const silent = await refuses(misdeed({ do: "exit0" }), "threw");
  assert.match(silent.message, /^threw: the sandbox child answered no line sandbox-answer-[0-9a-f-]{36}$/);
  const module = join(STREAM, "src", "index.ts");
  const big = await refuses(runSandboxed({ module, recordings: join(STREAM, "recordings"), psl: PSL_FILE, cursor: null, now: NOW, maxAnswerBytes: 1024 }), "threw");
  assert.equal(big.message, "threw: the sandbox answered more than 1024 bytes");
});
