// packages/adapter/node/sandbox-child.ts — the child of runSandboxed
// (sandbox.ts). It runs only as
//   node --permission --allow-fs-read=PATH ... sandbox-child.ts
// with the options as JSON on stdin, and prints on stdout a line of the
// options' marker, then one JSON object (SandboxAnswer of sandbox.ts). The
// marker is read before the module loads, so a module that prints cannot
// forge the line, and the parent reads only what follows the last one:
//   { ok: true, first, again, next }      each run { result, requests, connections, written },
//                                         a written raw as base64
//   { ok: false, check, detail, causeCode, causes }
// Exit codes: 0 either answer · 1 its input is not the options JSON · 2 not
// sandboxed (stderr `sandbox-child: not sandboxed`).
//
// ⛔ It refuses to run unless process.permission.has(x) === false for each of
// net, child, worker and fs.write. Without --permission `has` is undefined,
// and `=== false` fails it, so the guard cannot pass vacuously. has("fs.write")
// asks for a grant of every path: --allow-fs-write=* is refused, and a grant
// of one directory is not seen (MEASURED on Node 26.7.0, 2026-10-31);
// runSandboxed grants none.
//
// A failure of its setup (the list, the source file, the recordings) is
// `options`, a module that does not load is `threw`, and runAdapter's own
// ContractError keeps its check. causeCode is the first `code` down the
// error's cause chain: a fetch refused by the permission model is a TypeError
// whose cause has the code ERR_ACCESS_DENIED.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadPsl } from "@domains/names";
import { type HarnessRun, runAdapter } from "../src/harness.ts";
import type { AdapterModule, Cursor, Source } from "../src/types.ts";
import { ContractError, validateSourceFile } from "../src/validate.ts";
import { readBits, readRecordings, readTcpRecordings } from "./files.ts";
import type { SandboxAnswer, SandboxRunJson } from "./sandbox.ts";

const DENIED = ["net", "child", "worker", "fs.write"] as const;
// Deeper than any cause chain an adapter builds; a cycle reaches it.
const MAX_CAUSES = 16;

interface ChildInput {
  readonly module: string;
  readonly sourceFile: string | null;
  readonly recordings: string;
  readonly psl: string;
  readonly cursor: Cursor;
  readonly now: string;
  readonly userAgent: string | null;
  readonly root: string;
  readonly marker: string;
}

// Writes text, then exits once it has reached the pipe: an adapter may leave a
// handle open that would keep the process alive.
function finish(stream: NodeJS.WriteStream, text: string, code: number): void {
  stream.write(text, () => process.exit(code));
}

const permission = (process as { permission?: { has(scope: string): boolean } }).permission;
const open = DENIED.filter((scope) => permission?.has(scope) !== false);

function chainOf(err: unknown): { causeCode: string | null; causes: string[] } {
  let causeCode: string | null = null;
  const causes: string[] = [];
  let e: unknown = err;
  for (let depth = 0; e !== null && e !== undefined && depth < MAX_CAUSES; depth++) {
    const x = e as { code?: unknown; message?: unknown; cause?: unknown };
    if (causeCode === null && typeof x.code === "string") causeCode = x.code;
    causes.push(typeof x.message === "string" ? x.message : String(e));
    e = x.cause;
  }
  return { causeCode, causes };
}

function failure(check: ContractError["check"], detail: string, err: unknown): SandboxAnswer {
  return { ok: false, check, detail, ...chainOf(err) };
}

const runJson = (r: HarnessRun): SandboxRunJson => ({
  result: r.result,
  requests: r.requests,
  connections: r.connections,
  written: r.written.map((w) => ({ ...w, raw: w.raw === null ? null : Buffer.from(w.raw.buffer, w.raw.byteOffset, w.raw.byteLength).toString("base64") })),
});

async function readStdin(): Promise<string> {
  const parts: Buffer[] = [];
  for await (const chunk of process.stdin) parts.push(chunk as Buffer);
  return Buffer.concat(parts).toString("utf8");
}

async function answer(input: ChildInput): Promise<SandboxAnswer> {
  let setup: { psl: Awaited<ReturnType<typeof loadPsl>>; sources: readonly Source[] | undefined; recordings: ReturnType<typeof readRecordings>; tcp: ReturnType<typeof readTcpRecordings> };
  try {
    const psl = await loadPsl(readFileSync(input.psl));
    const sources = input.sourceFile === null ? undefined : validateSourceFile(JSON.parse(readFileSync(input.sourceFile, "utf8")), readBits(input.root)).sources;
    setup = { psl, sources, recordings: readRecordings(input.recordings), tcp: readTcpRecordings(input.recordings) };
  } catch (err) {
    if (err instanceof ContractError) return failure(err.check, err.message.slice(err.check.length + 2), err);
    return failure("options", `the sandbox's inputs do not load: ${(err as Error)?.message ?? String(err)}`, err);
  }
  let mod: AdapterModule;
  try {
    mod = (await import(pathToFileURL(input.module).href)) as AdapterModule;
  } catch (err) {
    return failure("threw", `the module ${input.module} does not load: ${(err as Error)?.message ?? String(err)}`, err);
  }
  try {
    const r = await runAdapter(mod, {
      recordings: setup.recordings,
      tcp: setup.tcp,
      psl: setup.psl,
      cursor: input.cursor,
      now: input.now,
      ...(input.userAgent === null ? {} : { userAgent: input.userAgent }),
      ...(setup.sources === undefined ? {} : { sources: setup.sources }),
    });
    return { ok: true, first: runJson(r.first), again: runJson(r.again), next: runJson(r.next) };
  } catch (err) {
    if (err instanceof ContractError) return failure(err.check, err.message.slice(err.check.length + 2), err);
    throw err;
  }
}

if (open.length > 0) finish(process.stderr, `sandbox-child: not sandboxed: ${open.join(", ")} not denied; run it through runSandboxed\n`, 2);
else {
  const text = await readStdin();
  let input: ChildInput | null = null;
  try {
    input = JSON.parse(text) as ChildInput;
  } catch (err) {
    finish(process.stderr, `sandbox-child: the options on stdin are not JSON: ${(err as Error).message}\n`, 1);
  }
  if (input !== null) {
    const { marker } = input;
    finish(process.stdout, `\n${marker}\n${JSON.stringify(await answer(input))}`, 0);
  }
}
