// packages/testkit/src/workerd.ts — run a Worker in workerd under node:test.
//
//   await withWorker({ scriptPath: "packages/testkit/test/smoke-worker.ts" }, async (w) => {
//     const res = await w.fetch("/decode?text=abc");
//     assert.equal(res.status, 200);
//   });
//
// withWorker bundles `scriptPath` with esbuild, with the format, target,
// supported and conditions of wrangler 4.150.0's bundleWorker (ESM, target
// es2024, conditions workerd, worker and browser), so a `node:` import fails here
// as it fails a deploy. Wrangler's loader, define and external options are not
// copied: a read of `globalThis.process.env.NODE_ENV` stays a read at run time. It starts one
// Miniflare instance, which runs a workerd child process, with the compatibility
// date and flags below (mirror-archlinux worker/wrangler.toml at 669ac72), runs
// `fn`, and disposes the instance in `finally`, whether `fn` passed or threw.
//
// ⛔ It never looks for a workerd process by name and never ends one: dispose()
// ends the one child its instance started, and scripts/test.mjs ends a timed-out
// test's process tree by PID (docs/conventions/forbidden-patterns.md).
//
// Offline by construction: the instance listens on 127.0.0.1 on a port the
// system picks, fetches no `cf` object, sends no telemetry and registers in no
// dev registry. A fetch the Worker makes goes to `outbound`; with none given,
// it is refused: Miniflare turns the thrown error into a 500 whose body names
// the URL, and `outbound` on the running Worker lists it. A test never reaches
// the network by accident.
//
// The runtime refuses a compatibility date newer than its binary supports, and
// Miniflare 5 refuses a date after today; neither falls back to another date.
// MEASURED 2026-10-28T10:30Z: workerd 1.20261006.1 (the one wrangler 4.150.0
// pins) runs 2026-10-13 and refuses 2026-10-27, "the newest date supported by
// this server binary is 2026-10-13".

import { resolve } from "node:path";
import type { Miniflare } from "miniflare";

export const COMPATIBILITY_DATE = "2026-10-13";
export const COMPATIBILITY_FLAGS: readonly string[] = Object.freeze(["no_nodejs_compat", "no_nodejs_compat_v2"]);
// The origin a path given to fetch() is resolved against. workerd routes every
// request to the one Worker, whatever its host.
export const ORIGIN = "https://worker.test";

type DispatchInit = Parameters<Miniflare["dispatchFetch"]>[1];
type DispatchResponse = Awaited<ReturnType<Miniflare["dispatchFetch"]>>;
type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

// The stand-in for every fetch the Worker makes. It receives Miniflare's Request.
export type Outbound = (request: { url: string; method: string; headers: { get(name: string): string | null } }) => Response | Promise<Response>;

export interface WorkerOptions {
  // The Worker's entry module, TypeScript or JavaScript, bundled before it runs.
  scriptPath: string;
  // Plain variables, as `[vars]` in wrangler.toml.
  bindings?: Record<string, Json>;
  // R2 binding names, each an empty bucket held in memory for this instance.
  r2Buckets?: readonly string[];
  compatibilityDate?: string;
  compatibilityFlags?: readonly string[];
  outbound?: Outbound;
}

export interface RunningWorker {
  // Dispatches a request to the Worker; a path is resolved against ORIGIN.
  fetch(pathOrUrl: string, init?: DispatchInit): Promise<DispatchResponse>;
  miniflare: Miniflare;
  // The URL of every outbound fetch the Worker made, in order.
  outbound: string[];
}

// The esbuild options of every bundle: the format, target, supported and
// conditions of wrangler 4.150.0's bundleWorker, and esbuild's default platform.
export const BUNDLE_OPTIONS = Object.freeze({
  bundle: true,
  write: false,
  format: "esm",
  target: "es2024",
  supported: Object.freeze({ "import-source": true, using: true }),
  conditions: Object.freeze(["workerd", "worker", "browser"]),
  platform: "browser",
  sourcemap: false,
  logLevel: "silent",
} as const);

// The Worker bundled into one ES module, as text.
export async function bundle(scriptPath: string): Promise<string> {
  const esbuild = await import("esbuild");
  const result = await esbuild.build({
    ...BUNDLE_OPTIONS,
    supported: { ...BUNDLE_OPTIONS.supported },
    conditions: [...BUNDLE_OPTIONS.conditions],
    entryPoints: [resolve(scriptPath)],
  });
  const [out, ...more] = result.outputFiles;
  if (out === undefined || more.length > 0) throw new Error(`bundle: ${scriptPath} gave ${result.outputFiles.length} output files, not 1`);
  return out.text;
}

const refuseOutbound: Outbound = (request) => {
  throw new Error(`withWorker: the Worker fetched ${request.url}, and the test gave no outbound handler`);
};

// The options of the Miniflare instance, before convertV4MiniflareOptions: the
// offline settings above, and the test's date, flags, bindings and buckets.
export function miniflareOptions(options: WorkerOptions, script: string, seen: string[]) {
  const outbound = options.outbound ?? refuseOutbound;
  return {
    host: "127.0.0.1",
    port: 0,
    cf: false,
    logRequests: false,
    telemetry: { enabled: false },
    modules: true,
    script,
    scriptPath: resolve(options.scriptPath),
    compatibilityDate: options.compatibilityDate ?? COMPATIBILITY_DATE,
    compatibilityFlags: [...(options.compatibilityFlags ?? COMPATIBILITY_FLAGS)],
    bindings: options.bindings ?? {},
    r2Buckets: [...(options.r2Buckets ?? [])],
    unsafeRegisterWorker: false,
    outboundService: (request: Parameters<Outbound>[0]) => {
      seen.push(request.url);
      return outbound(request);
    },
  };
}

export async function withWorker<T>(options: WorkerOptions, fn: (worker: RunningWorker) => Promise<T>): Promise<T> {
  const script = await bundle(options.scriptPath);
  const { Miniflare, convertV4MiniflareOptions } = await import("miniflare");
  const seen: string[] = [];
  const mf = new Miniflare(convertV4MiniflareOptions(miniflareOptions(options, script, seen)));
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    await mf.ready;
    const value = await fn({
      fetch: (pathOrUrl, init) => mf.dispatchFetch(new URL(pathOrUrl, ORIGIN).href, init),
      miniflare: mf,
      outbound: seen,
    });
    outcome = { ok: true, value };
  } catch (error) {
    outcome = { ok: false, error };
  }
  // dispose() runs whatever happened above. After a failed start it cleans up,
  // then rethrows that same start error, which is already the outcome. Any other
  // dispose error is thrown with the test's error, so neither hides the other.
  try {
    await mf.dispose();
  } catch (disposeError) {
    if (outcome.ok) throw disposeError;
    if (disposeError !== outcome.error) throw new AggregateError([outcome.error, disposeError], "withWorker: the test failed, and dispose() failed after it");
  }
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}
