// packages/adapter/test/fixtures/plants/misbehave.ts — a plant of many
// misdeeds, one a run, named by the cursor's `do` (the review of DOM-026):
// what the sandbox must refuse (read a file it was not given, read the
// environment, write a file, spawn a process, start a worker), what it must
// end (a run that never returns) and what it must report as its own failure
// (a cause chain, an invalid result, stdout before the answer, an exit). The
// paths and names come in the cursor, so the child needs no environment.
// test/sandbox.test.ts holds each one through runSandboxed.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { Worker } from "node:worker_threads";
import type { AdapterContext, Cursor, RunResult } from "../../../src/types.ts";

interface Misdeed {
  readonly do: string;
  readonly path?: string;
  readonly name?: string;
}

const coded = (message: string, code: unknown, cause?: unknown): Error => Object.assign(new Error(message, cause === undefined ? {} : { cause }), { code });

export async function run(cursor: Cursor, _ctx: AdapterContext): Promise<RunResult> {
  const c = cursor as unknown as Misdeed;
  const done = (stats: Record<string, number> = {}): RunResult => ({ segments: [], cursor, stats, errors: [] });
  switch (c.do) {
    case "read":
      return done({ read_bytes: readFileSync(c.path as string).byteLength });
    case "env":
      return done({ env_length: (process.env[c.name as string] ?? "").length });
    case "write":
      writeFileSync(c.path as string, "planted");
      return done();
    case "spawn": {
      const r = spawnSync(process.execPath, ["-e", "0"]);
      if (r.error !== undefined) throw r.error;
      return done({ status: r.status ?? -1 });
    }
    case "worker":
      await new Promise((ok, fail) => {
        const w = new Worker("0", { eval: true });
        w.once("exit", ok);
        w.once("error", fail);
      });
      return done();
    case "hang":
      setInterval(() => {}, 1_000);
      return new Promise<RunResult>(() => {});
    case "nested":
      throw coded("outer", "OUTER", coded("inner", "INNER"));
    case "numeric":
      throw coded("outer", 42, coded("inner", "STR"));
    case "cycle": {
      const e = coded("cycle", "LOOP") as Error & { cause?: unknown };
      e.cause = e;
      throw e;
    }
    case "result":
      return { segments: "x" } as unknown as RunResult;
    case "stdout":
      process.stdout.write('\n{"ok":true}\nnull\n');
      return done();
    case "exit":
      process.exit(3);
      break;
    case "exit0":
      process.exit(0);
      break;
  }
  throw new Error(`misbehave: no misdeed ${JSON.stringify(c.do)}`);
}
