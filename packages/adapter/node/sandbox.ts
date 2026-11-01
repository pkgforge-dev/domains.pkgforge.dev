// packages/adapter/node/sandbox.ts — run an adapter's contract (runAdapter of
// src/harness.ts) in a Node child that cannot reach the network.
//
//   const { first, again, next } = await runSandboxed({ module, sourceFile, recordings, psl, cursor, now });
//
// The trap of harness.ts replaces the global fetch, WebSocket, XMLHttpRequest
// and EventSource while a run lasts; a fetch an adapter captured at import, or
// a socket of node:net, passes it. The child runs under Node's permission
// model, with no --allow-net, --allow-child-process, --allow-worker or
// --allow-fs-write, where fetch, net, tls, http, dns, child_process and
// worker_threads all refuse with ERR_ACCESS_DENIED (MEASURED on Node 26.7.0,
// DOM-026). It reads only what readPaths names: the module's directory, the
// recordings, the list, the source file, and of the checkout ROOT its
// packages/, node_modules/, package.json and config/source-bits.json, so a
// .dev.vars or a .env file of the checkout is out of its reach. Its
// environment is PATH and SystemRoot alone, so no token reaches it.
//
// The child (sandbox-child.ts) refuses to run unless all four are denied, then
// loads the list, the source file and both kinds of recordings, imports the
// module, runs runAdapter, and prints its answer after a line that holds a
// marker of this call, drawn from a cryptographic source and passed on stdin
// before the module loads: what the module prints before the answer is not
// read as it. runSandboxed answers as runAdapter answers: the three runs, each
// with its written records and raw bytes; or a ContractError of the check that
// failed, whose cause is a SandboxCause with the first `code` of the child's
// error and its causes (ERR_ACCESS_DENIED for a refused socket). Its own
// failures are ContractError `threw`: a child past timeoutMs (ended by its
// PID, never its image name), one that exited other than 0, one whose answer
// has no marker line or is not a SandboxAnswer, or one that passed
// maxAnswerBytes (64 MiB by default).
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { HarnessResult, HarnessRun } from "../src/harness.ts";
import type { Cursor } from "../src/types.ts";
import { CONTRACT_CHECKS, type ContractCheck, ContractError } from "../src/validate.ts";
import type { Written } from "../src/writer.ts";

export const SANDBOX_CHILD = join(import.meta.dirname, "sandbox-child.ts");
// The checkout: the one directory a child reads unless told otherwise.
export const REPO_ROOT = resolve(import.meta.dirname, "..", "..", "..");
export const SANDBOX_TIMEOUT_MS = 120_000;
export const SANDBOX_MAX_ANSWER = 64 << 20;
// What of the child's stderr a failure quotes.
const STDERR_KEPT = 64 << 10;

export interface SandboxOptions {
  // The adapter module, absolute: adapters/<dir>/src/index.ts.
  readonly module: string;
  // Its source.json, absolute; when given, every segment is held to its sources.
  readonly sourceFile?: string;
  // A directory of *.http.json and *.tcp.json recordings, absolute.
  readonly recordings: string;
  // The list file, absolute.
  readonly psl: string;
  readonly cursor: Cursor;
  readonly now: string;
  readonly userAgent?: string;
  // The checkout whose packages/, node_modules/, package.json and
  // config/source-bits.json the child reads; REPO_ROOT by default.
  readonly root?: string;
  readonly timeoutMs?: number;
  // The most the child may answer; SANDBOX_MAX_ANSWER by default.
  readonly maxAnswerBytes?: number;
}

// What the child answers, as sandbox-child.ts prints it.
export interface SandboxRunJson {
  readonly result: HarnessRun["result"];
  readonly requests: HarnessRun["requests"];
  readonly connections: HarnessRun["connections"];
  // Each Written, its raw bytes as base64.
  readonly written: readonly (Omit<Written, "raw"> & { readonly raw: string | null })[];
}

export type SandboxAnswer =
  | { readonly ok: true; readonly first: SandboxRunJson; readonly again: SandboxRunJson; readonly next: SandboxRunJson }
  | { readonly ok: false; readonly check: ContractCheck; readonly detail: string; readonly causeCode: string | null; readonly causes: readonly string[] };

// The cause a sandboxed ContractError carries: the first `code` of the child's
// error and its causes (`code` null when none had one), and their messages.
export class SandboxCause extends Error {
  readonly code: string | null;
  readonly causes: readonly string[];
  constructor(code: string | null, causes: readonly string[]) {
    super(causes.length === 0 ? "no cause" : causes.join(" <- "));
    this.name = "SandboxCause";
    this.code = code;
    this.causes = causes;
  }
}

// Ends a process and what it started, by its PID: on Windows a child's
// children outlive it, so the tree is ended by taskkill /PID (as
// scripts/test.mjs endTree does). Never by image name.
function endByPid(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync(join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

function bytesOf(base64: string | null): Uint8Array | null {
  if (base64 === null) return null;
  const buf = Buffer.from(base64, "base64");
  // A plain Uint8Array, as the in-process writer holds, not a Buffer.
  const out = new Uint8Array(buf.byteLength);
  out.set(buf);
  return out;
}

const runOf = (r: SandboxRunJson): HarnessRun => ({
  result: r.result,
  requests: r.requests,
  connections: r.connections,
  written: r.written.map((w): Written => ({ ...w, raw: bytesOf(w.raw) })),
});

type Obj = Readonly<Record<string, unknown>>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isRun = (v: unknown): boolean => isObj(v) && isObj(v.result) && Array.isArray(v.written) && Array.isArray(v.requests) && Array.isArray(v.connections);

// The answer's shape, held before a field of it is read: a child may print
// anything, and a defect of it must fail as `threw`, not as a TypeError.
function isAnswer(v: unknown): v is SandboxAnswer {
  if (!isObj(v)) return false;
  if (v.ok === true) return isRun(v.first) && isRun(v.again) && isRun(v.next);
  return (
    v.ok === false &&
    typeof v.check === "string" &&
    typeof v.detail === "string" &&
    (v.causeCode === null || typeof v.causeCode === "string") &&
    Array.isArray(v.causes) &&
    v.causes.every((c) => typeof c === "string")
  );
}

// What the child may read (one --allow-fs-read each): the module's own
// directory, its inputs, and the parts of the checkout that its imports and
// readBits reach. Node resolves a package import through node_modules/ to
// packages/, and reads package.json for the module's type.
export function readPaths(o: SandboxOptions, root: string): string[] {
  const paths = [dirname(o.module), o.recordings, o.psl, ...(o.sourceFile === undefined ? [] : [o.sourceFile])];
  for (const rel of ["packages", "node_modules", "package.json", join("config", "source-bits.json")]) paths.push(join(root, rel));
  return [...new Set(paths)];
}

function checkOptions(o: SandboxOptions): void {
  for (const k of ["module", "recordings", "psl"] as const)
    if (typeof o[k] !== "string" || !isAbsolute(o[k])) throw new ContractError("options", `${k} ${JSON.stringify(o[k])} is not an absolute path`);
  if (o.sourceFile !== undefined && (typeof o.sourceFile !== "string" || !isAbsolute(o.sourceFile)))
    throw new ContractError("options", `sourceFile ${JSON.stringify(o.sourceFile)} is not an absolute path`);
  if (o.root !== undefined && (typeof o.root !== "string" || !isAbsolute(o.root))) throw new ContractError("options", `root ${JSON.stringify(o.root)} is not an absolute path`);
  const t = o.timeoutMs;
  if (t !== undefined && (!Number.isInteger(t) || t < 1)) throw new ContractError("options", `timeoutMs ${t} is not a positive integer`);
  const m = o.maxAnswerBytes;
  if (m !== undefined && (!Number.isInteger(m) || m < 1)) throw new ContractError("options", `maxAnswerBytes ${m} is not a positive integer`);
}

export async function runSandboxed(options: SandboxOptions): Promise<HarnessResult> {
  checkOptions(options);
  const root = options.root ?? REPO_ROOT;
  const timeoutMs = options.timeoutMs ?? SANDBOX_TIMEOUT_MS;
  const maxAnswer = options.maxAnswerBytes ?? SANDBOX_MAX_ANSWER;
  const marker = `sandbox-answer-${randomUUID()}`;
  const env: Record<string, string> = {};
  for (const k of ["PATH", "SystemRoot"]) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  const input = JSON.stringify({
    module: options.module,
    sourceFile: options.sourceFile ?? null,
    recordings: options.recordings,
    psl: options.psl,
    cursor: options.cursor,
    now: options.now,
    userAgent: options.userAgent ?? null,
    root,
    marker,
  });
  const reads = readPaths(options, root).map((p) => `--allow-fs-read=${p}`);
  const child = spawn(process.execPath, ["--permission", ...reads, SANDBOX_CHILD], { env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  const out: Buffer[] = [];
  let outBytes = 0;
  let tooBig = false;
  let err = "";
  let timedOut = false;
  child.stdout.on("data", (b: Buffer) => {
    outBytes += b.byteLength;
    if (outBytes > maxAnswer) {
      tooBig = true;
      endByPid(child);
    } else out.push(b);
  });
  child.stderr.on("data", (b: Buffer) => {
    err = (err + b.toString("utf8")).slice(-STDERR_KEPT);
  });
  // A child that exits before it reads stdin closes the pipe; its exit code says why.
  child.stdin.on("error", () => {});
  child.stdin.end(input);
  const timer = setTimeout(() => {
    timedOut = true;
    endByPid(child);
  }, timeoutMs);
  const code = await new Promise<number | null>((done, fail) => {
    child.once("error", fail);
    child.once("close", (c) => done(c));
  }).finally(() => clearTimeout(timer));
  if (timedOut) throw new ContractError("threw", `the sandbox timed out after ${timeoutMs} ms`);
  if (tooBig) throw new ContractError("threw", `the sandbox answered more than ${maxAnswer} bytes`);
  const tail = err.trim().split("\n").slice(-5).join(" | ");
  if (code !== 0) throw new ContractError("threw", `the sandbox child exited ${code}${tail === "" ? "" : `: ${tail}`}`);
  // The answer follows the last marker line: what the module printed before it is not the answer.
  const text = Buffer.concat(out).toString("utf8");
  const frame = `\n${marker}\n`;
  const at = text.lastIndexOf(frame);
  if (at === -1) throw new ContractError("threw", `the sandbox child answered no line ${marker}`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.slice(at + frame.length));
  } catch (e) {
    throw new ContractError("threw", `the sandbox child answered no JSON: ${(e as Error).message}`);
  }
  if (!isAnswer(parsed)) throw new ContractError("threw", "the sandbox child answered JSON that is not a SandboxAnswer");
  const answer = parsed;
  if (answer.ok === false) {
    if (!(CONTRACT_CHECKS as readonly string[]).includes(answer.check)) throw new ContractError("threw", `the sandbox child answered the check ${JSON.stringify(answer.check)}: ${answer.detail}`);
    throw new ContractError(answer.check, answer.detail, { cause: new SandboxCause(answer.causeCode, answer.causes) });
  }
  return { first: runOf(answer.first), again: runOf(answer.again), next: runOf(answer.next) };
}
