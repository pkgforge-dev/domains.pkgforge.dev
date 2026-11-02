// apps/api/test/config.test.ts — apps/api/wrangler.toml and the Worker's
// constants against the facts they must equal: the harness's compatibility
// date and flags (the Correction of 2026-10-28T14:25Z in TODO/serve.md
// DOM-030), the entry's settings, and the contact User-Agent of ruling 11.
//
//   node scripts/test.mjs apps/api --name compatibility
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { USER_AGENT as CORE_USER_AGENT } from "@domains/core";
import { COMPATIBILITY_DATE, COMPATIBILITY_FLAGS } from "@domains/testkit";
import { USER_AGENT as SCRIPTS_USER_AGENT } from "../../../scripts/lib/user-agent.mjs";
import { LAYER_MAX_BYTES } from "../../../scripts/root/lib.mjs";
import { ApiCache, type CacheLike, TTL_S } from "../src/cache.ts";
import { LIMITS, readerOf, USER_AGENT } from "../src/ghcr.ts";
import { ROOT_LAYER_MAX_BYTES } from "../src/root.ts";

const toml = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");
const setting = (name: string): string | undefined => toml.match(new RegExp(`^${name} = (.+)$`, "m"))?.[1];
const quoted = (line: string | undefined): string[] => [...(line ?? "").matchAll(/"([^"]*)"/g)].map((m) => m[1]!);

test("compatibility: the compatibility_date of apps/api/wrangler.toml equals COMPATIBILITY_DATE of packages/testkit, and its flags COMPATIBILITY_FLAGS", () => {
  // The deploy runs under the date and the flags the harness tests the Worker with.
  assert.equal(setting("compatibility_date"), `"${COMPATIBILITY_DATE}"`);
  assert.deepEqual(quoted(setting("compatibility_flags")), [...COMPATIBILITY_FLAGS]);
});

test("config: wrangler.toml names the Worker, its entry, the custom domain alone, cpu_ms 50 and the observability block, with no account_id and no binding", () => {
  assert.equal(setting("name"), '"domains-pkgforge-dev"');
  assert.equal(setting("main"), '"src/index.ts"');
  assert.equal(setting("workers_dev"), "false");
  assert.equal(setting("preview_urls"), "false");
  assert.match(toml, /^routes = \[\n {2}\{ pattern = "domains\.pkgforge\.dev", custom_domain = true \},\n\]$/m);
  assert.match(toml, /^\[limits\]\ncpu_ms = 50$/m);
  assert.match(toml, /^\[observability\]\nenabled = true\nhead_sampling_rate = 1$/m);
  assert.match(toml, /^\[observability\.logs\]\ninvocation_logs = false$/m);
  assert.doesNotMatch(toml, /^\s*account_id\s*=/m);
  // The Worker holds no secret and binds nothing: DOM-031 adds the R2 binding.
  assert.doesNotMatch(toml, /^\s*\[\[?(r2_buckets|kv_namespaces|d1_databases|durable_objects|vars|services|queues|triggers)/m);
  assert.doesNotMatch(toml, /^\s*crons\s*=/m);
});

test("config: the User-Agent is the one contact of packages/core, which scripts/lib/user-agent.mjs re-exports; a subrequest has 10 s, a root's reads 25 s, a manifest 64 KiB", () => {
  assert.equal(USER_AGENT, CORE_USER_AGENT);
  assert.equal(SCRIPTS_USER_AGENT, CORE_USER_AGENT);
  // One home: neither the Worker nor the scripts write the string again.
  for (const file of ["../src/ghcr.ts", "../../../scripts/lib/user-agent.mjs"]) {
    assert.doesNotMatch(readFileSync(new URL(file, import.meta.url), "utf8"), /contact: domains@pkgforge\.dev/, file);
  }
  assert.match(USER_AGENT, /contact: domains@pkgforge\.dev/);
  assert.equal(LIMITS.subrequestMs, 10_000);
  assert.equal(LIMITS.rootMs, 25_000);
  assert.equal(LIMITS.manifestBytes, 65_536);
  const g = readerOf(new ApiCache({ host: "domains.example.test", ray: "-", waitUntil: () => undefined, cache: { match: async () => undefined, put: async () => undefined } }));
  assert.equal(g.dial.timeoutMs, 10_000);
  assert.equal(g.dial.userAgent, USER_AGENT);
});

test("config: the times to live are the entry's literals, and root.json's bound is the 8 MiB the root's writer reads", () => {
  assert.deepEqual({ ...TTL_S }, { manifestByTag: 30, manifestByDigest: 31_536_000, signedMargin: 120, signedMax: 600, body: 31_536_000 });
  assert.equal(ROOT_LAYER_MAX_BYTES, 8_388_608);
  assert.equal(ROOT_LAYER_MAX_BYTES, LAYER_MAX_BYTES);
});

// A Cache API double that records the path of each put, and whose reads answer `answer`.
function cacheDouble(answer: () => Response | undefined = () => undefined): CacheLike & { puts: string[] } {
  const puts: string[] = [];
  return {
    puts,
    match: async () => answer(),
    put: async (req: Request) => {
      puts.push(new URL(req.url).pathname);
    },
  };
}

test("config: every cache write runs in waitUntil, a write that fails is logged and never rejects, and a body that breaks off is a logged miss", async () => {
  const saved = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => {
    errors.push(String(args[0]));
  };
  try {
    const waits: Promise<unknown>[] = [];
    const double = cacheDouble();
    const cache = new ApiCache({ host: "a.example.test", ray: "r1", waitUntil: (p) => waits.push(p), cache: double });
    cache.putBytes("pkgforge-dev/domains.pkgforge.dev/root@sha256:x/0-3", new Uint8Array([1, 2, 3]));
    await cache.put("ghcr:m:pkgforge-dev/domains.pkgforge.dev/root@latest", "{}", 60);
    assert.equal(waits.length, 2, "each write is handed to waitUntil");
    await Promise.all(waits);
    assert.deepEqual(double.puts, ["/__cache/v1/body/pkgforge-dev%2Fdomains.pkgforge.dev%2Froot%40sha256%3Ax%2F0-3", "/__cache/v1/man/pkgforge-dev%2Fdomains.pkgforge.dev%2Froot%40latest"]);
    // Every key is on the request's own host.
    assert.equal(new URL(cache.key("man", "n").url).host, "a.example.test");
    assert.equal(new URL(new ApiCache({ host: "b.example.test", ray: "-", waitUntil: () => undefined, cache: double }).key("man", "n").url).host, "b.example.test");

    const failing: CacheLike = { match: async () => undefined, put: async () => Promise.reject(new Error("put refused")) };
    const failWaits: Promise<unknown>[] = [];
    new ApiCache({ host: "a.example.test", ray: "r2", waitUntil: (p) => failWaits.push(p), cache: failing }).putBytes("n", new Uint8Array([1]));
    assert.equal(failWaits.length, 1);
    await failWaits[0];
    assert.ok(errors.includes("domains-pkgforge-dev r2: cache write of body failed: put refused"), errors.join("\n"));

    const broken = new ReadableStream<Uint8Array>({
      pull(c) {
        c.error(new Error("broke off"));
      },
    });
    const brokenCache = new ApiCache({ host: "a.example.test", ray: "r3", waitUntil: () => undefined, cache: cacheDouble(() => new Response(broken)) });
    assert.equal(await brokenCache.getBytes("n"), null);
    assert.ok(
      errors.some((e) => e.startsWith("domains-pkgforge-dev r3: cache read of body failed:")),
      errors.join("\n"),
    );
  } finally {
    console.error = saved;
  }
});
