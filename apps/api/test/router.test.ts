// apps/api/test/router.test.ts — the router of apps/api/src/index.ts
// (TODO/serve.md DOM-030): 404 and 405 as problem+json with `see`, OPTIONS, CORS
// on every answer, HEAD, the two stubs, GET /v1/index/latest and its provenance.
// Every registry answer is synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { PROBLEM_TYPE, RESERVED_MEMBERS } from "@domains/core";
import { GUIDE_STUB, INDEX_STUB, marker, REASONS, type Reason } from "../src/guide.ts";
import worker, { handle } from "../src/index.ts";
import { resetRoot } from "../src/root.ts";
import { apiWorld, body, ENV, plantRoot, rootDoc } from "./helpers.ts";

const ROUTE_PATHS = ["/healthz", "/v1/index/latest", "/v1/"];

test("router: a path with no route answers 404 problem+json with status, title, detail, reason and see, and CORS", async () => {
  await apiWorld(
    () => undefined,
    async (w) => {
      const res = await w.get("/v2/nothing");
      assert.equal(res.status, 404);
      assert.equal(res.headers.get("content-type"), PROBLEM_TYPE);
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
      assert.equal(res.headers.get("cache-control"), "no-store");
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const p = await body(res);
      assert.deepEqual(Object.keys(p).sort(), [...RESERVED_MEMBERS].sort());
      assert.deepEqual(p, { status: 404, title: "Not Found", detail: "No route answers /v2/nothing.", reason: "not-found", see: "/llms-full.txt#reason-not-found" });
      assert.equal(w.requests.length, 0, "a 404 makes no subrequest");
    },
  );
});

test("router: every method but GET, HEAD and OPTIONS answers 405 problem+json with allow, on a route and off one", async () => {
  await apiWorld(
    () => undefined,
    async (w) => {
      for (const [method, path] of [
        ["POST", "/healthz"],
        ["PUT", "/v1/index/latest"],
        ["DELETE", "/"],
        ["PATCH", "/nothing"],
      ] as const) {
        const res = await w.request(path, method);
        assert.equal(res.status, 405, `${method} ${path}`);
        assert.equal(res.headers.get("allow"), "GET, HEAD, OPTIONS");
        assert.equal(res.headers.get("content-type"), PROBLEM_TYPE);
        assert.equal(res.headers.get("access-control-allow-origin"), "*");
        const p = await body(res);
        assert.equal(p.reason, "method-not-allowed");
        assert.equal(p.status, 405);
        assert.equal(p.see, "/llms-full.txt#reason-method-not-allowed");
      }
      assert.equal(w.requests.length, 0);
    },
  );
});

test("router: OPTIONS answers 204 with the CORS headers and no body, on any path", async () => {
  await apiWorld(
    () => undefined,
    async (w) => {
      for (const path of ["/healthz", "/v1/index/latest", "/nothing"]) {
        const res = await w.request(path, "OPTIONS", { origin: "https://example.test", "access-control-request-method": "GET" });
        assert.equal(res.status, 204);
        assert.equal(res.headers.get("access-control-allow-origin"), "*");
        assert.equal(res.headers.get("access-control-allow-methods"), "GET, HEAD, OPTIONS");
        assert.equal(res.headers.get("access-control-allow-headers"), "*");
        assert.equal(res.headers.get("access-control-allow-credentials"), null);
        assert.equal(await res.text(), "");
      }
      assert.equal(w.requests.length, 0);
    },
  );
});

test("router: / answers the plain text stub, which names the service and no route", async () => {
  await apiWorld(
    () => undefined,
    async (w) => {
      const res = await w.get("/");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "public, max-age=300");
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      const t = await res.text();
      assert.equal(t, INDEX_STUB);
      assert.match(t, /^domains\.pkgforge\.dev\n/);
      for (const path of ROUTE_PATHS) assert.equal(t.includes(path), false, `the stub names ${path}`);
    },
  );
});

test("router: the see member of each problem names a marker that /llms-full.txt holds, for every reason of the list, and the stub names no route", async () => {
  await apiWorld(
    () => undefined,
    async (w) => {
      const res = await w.get("/llms-full.txt");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "text/plain; charset=utf-8");
      const t = await res.text();
      assert.equal(t, GUIDE_STUB);
      for (const reason of Object.keys(REASONS) as Reason[]) {
        const lines = t.split("\n").filter((l) => l.startsWith(`${marker(reason)}: `));
        assert.equal(lines.length, 1, `one line for ${reason}`);
      }
      for (const path of ROUTE_PATHS) assert.equal(t.includes(path), false, `the stub names ${path}`);
      for (const line of t.split("\n")) assert.ok(line.length <= 700, `a line of ${line.length} characters`);
      // The see of a live 404 and 405 resolves to a marker in the stub.
      for (const res2 of [await w.get("/nothing"), await w.request("/", "POST")]) {
        const see = String((await body(res2)).see);
        const [path, fragment] = see.split("#");
        assert.equal(path, "/llms-full.txt");
        assert.ok(t.includes(`\n${fragment}: `), `the stub holds ${fragment}`);
      }
    },
  );
});

test("router: every reason the Worker's sources name is in the list of guide.ts", async () => {
  const { readdirSync, readFileSync } = await import("node:fs");
  const dir = new URL("../src/", import.meta.url);
  const named = new Set<string>();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".ts")) continue;
    for (const m of readFileSync(new URL(f, dir), "utf8").matchAll(/fail\(\d{3}, "([a-z-]+)"/g)) named.add(m[1]!);
  }
  assert.ok(named.size >= 5, `found ${[...named].join(", ")}`);
  for (const r of named) assert.ok(Object.hasOwn(REASONS, r), `${r} is not in REASONS`);
});

test("router: GET /v1/index/latest answers the envelope with the root digest and its GHCR references, and x-domains-root equals data.root", async () => {
  let planted = { manifest: "", layer: "", size: 0 };
  await apiWorld(
    async (w, blobs) => {
      planted = await plantRoot(w, blobs, rootDoc({ as_of: "2026-10-27T02:00:00Z", root_seq: 75 }));
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
      assert.equal(res.headers.get("cache-control"), "public, max-age=30");
      assert.deepEqual(await body(res), {
        data: {
          format: "domains.root.v1",
          root_seq: 75,
          as_of: "2026-10-27T02:00:00Z",
          root: planted.manifest,
          references: {
            root_latest: "ghcr.io/pkgforge-dev/domains.pkgforge.dev/root:latest",
            root_digest: `ghcr.io/pkgforge-dev/domains.pkgforge.dev/root@${planted.manifest}`,
          },
        },
        meta: { as_of: "2026-10-27T02:00:00Z", root: planted.manifest, sources_used: [], sources_failed: [], tiers_read: [], partial: false, next_cursor: null },
      });
      assert.equal(res.headers.get("x-domains-root"), planted.manifest);
      assert.equal(res.headers.get("x-domains-as-of"), "2026-10-27T02:00:00Z");
      assert.equal(res.headers.get("x-domains-cache"), "ghcr");
      assert.equal(res.headers.get("x-domains-body"), "derived");
      // The root is not a pack: the header and meta.tiers_read both say none was read.
      assert.equal(res.headers.get("x-domains-tiers-read"), "0");
      assert.equal(res.headers.get("x-domains-sources-used"), "");
      assert.equal(res.headers.get("x-domains-degraded"), null);
      assert.equal(res.headers.get("access-control-allow-origin"), "*");
      assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    },
  );
});

test("router: x-domains-tiers-read equals the length of meta.tiers_read, cold, warm and for a new isolate", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      for (let i = 0; i < 3; i += 1) {
        if (i === 2) resetRoot();
        const res = await w.get("/v1/index/latest");
        const meta = ((await body(res)) as { meta: { tiers_read: unknown[] } }).meta;
        assert.equal(res.headers.get("x-domains-tiers-read"), String(meta.tiers_read.length));
      }
    },
  );
});

test("router: every answer exposes the ten headers a page may read, a preflight is kept a day, and every body is nosniff", async () => {
  const EXPOSED = "x-domains-root, x-domains-as-of, x-domains-tiers-read, x-domains-sources-used, x-domains-sources-failed, x-domains-cache, x-domains-body, x-domains-degraded, retry-after, allow";
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      for (const path of ["/", "/llms-full.txt", "/healthz", "/v1/index/latest", "/nothing"]) {
        const res = await w.get(path);
        assert.equal(res.headers.get("access-control-expose-headers"), EXPOSED, path);
        assert.equal(res.headers.get("x-content-type-options"), "nosniff", path);
        assert.equal(res.headers.get("access-control-allow-credentials"), null, path);
      }
      const pre = await w.request("/healthz", "OPTIONS", { origin: "https://example.test", "access-control-request-method": "GET" });
      assert.equal(pre.headers.get("access-control-max-age"), "86400");
      assert.equal(pre.headers.get("allow"), "GET, HEAD, OPTIONS");
      assert.equal(pre.headers.get("access-control-expose-headers"), EXPOSED);
    },
  );
});

test("router: a path is matched whole and as written: a trailing slash, a doubled slash or another case answers 404", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      for (const path of ["/healthz/", "/v1/index/latest/", "//", "/Healthz", "//healthz", "/v1/index"]) {
        const res = await w.get(path);
        assert.equal(res.status, 404, path);
        assert.equal((await body(res)).reason, "not-found", path);
      }
      assert.equal(w.requests.length, 0);
      const llms = await w.get("/llms-full.txt");
      assert.equal(llms.headers.get("cache-control"), "public, max-age=300");
    },
  );
});

test("router: the 405 and the 503 no-root are the whole problems the entry names", async () => {
  await apiWorld(
    () => undefined,
    async (w) => {
      const p405 = await w.request("/healthz", "DELETE");
      assert.deepEqual(await body(p405), {
        status: 405,
        title: "Method Not Allowed",
        detail: "This service answers GET, HEAD, OPTIONS, not DELETE.",
        reason: "method-not-allowed",
        see: "/llms-full.txt#reason-method-not-allowed",
      });
      const p503 = await w.get("/v1/index/latest");
      assert.equal(p503.status, 503);
      assert.equal(p503.headers.get("cache-control"), "no-store");
      assert.deepEqual(await body(p503), { status: 503, title: "Service Unavailable", detail: "GHCR holds no root:latest.", reason: "no-root", see: "/llms-full.txt#reason-no-root" });
    },
  );
});

test("router: the reasons are DOM-059's twelve and internal-error, each line says whether to retry, and the retryable ones are the four of a passing fault", () => {
  assert.deepEqual(Object.keys(REASONS), [
    "not-found",
    "method-not-allowed",
    "bad-parameter",
    "bad-window",
    "window-too-large",
    "unknown-suffix",
    "bad-cursor",
    "work-budget",
    "not-implemented",
    "unsupported-by-source",
    "no-root",
    "source-unavailable",
    "internal-error",
  ]);
  const retry = Object.entries(REASONS)
    .filter(([, line]) => /(^| )Retry /.test(line) && !/Do not retry/.test(line))
    .map(([r]) => r);
  assert.deepEqual(retry, ["work-budget", "no-root", "source-unavailable", "internal-error"]);
  for (const [r, line] of Object.entries(REASONS)) assert.ok(/Do not retry/.test(line) !== retry.includes(r), `${r} says once whether to retry`);
  // The service promises what it sets itself, not that no limit of Cloudflare's exists.
  assert.ok(INDEX_STUB.includes("This service asks for no key and no account, and sets no rate limit."));
  assert.ok(INDEX_STUB.includes("Source: https://github.com/pkgforge-dev/domains.pkgforge.dev"));
});

test("router: the stubs point to no feature of a route that is not deployed: no bulk file, no cursor to follow", () => {
  for (const stub of [GUIDE_STUB, INDEX_STUB]) {
    assert.doesNotMatch(stub, /bulk|follow the cursor|\/v1\/(?!index\/latest)/i);
  }
  assert.equal(REASONS["window-too-large"], "The time window is longer than one request reads. Do not retry; ask for a shorter window.");
  assert.equal(REASONS["work-budget"], "The answer needs more reads than one request makes. Retry with a narrower request.");
});

test("router: a fault while the Worker makes a route's context answers 500 internal-error with CORS, never a platform error", async () => {
  const errors: unknown[][] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const request = new Request("https://domains.example.test/healthz");
    Object.defineProperty(request, "headers", {
      get() {
        throw new TypeError("a planted fault in the request");
      },
    });
    const res = await worker.fetch(request, ENV, { waitUntil: () => undefined });
    assert.equal(res.status, 500);
    assert.equal(res.headers.get("content-type"), "application/problem+json");
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(((await res.json()) as Record<string, unknown>).reason, "internal-error");
    assert.ok(errors.some((e) => /^domains-pkgforge-dev -: internal error on \/healthz: TypeError: a planted fault in the request$/.test(String(e[0]))));
  } finally {
    console.error = saved;
  }
});

test("router: a log line with no cf-ray names the request -", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
      w.intercept = async (url) => (url.startsWith("https://ghcr.io/") ? w.response(500, "down", {}, { url }) : undefined);
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).status, 502);
      assert.ok(w.errors.some((e) => String(e[0]).startsWith("domains-pkgforge-dev -: no root: GHCR answered 500")));
    },
  );
});

test("router: a root with no as_of answers with no x-domains-as-of and as_of null", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs, rootDoc({ as_of: null }));
    },
    async (w) => {
      const res = await w.get("/v1/index/latest");
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("x-domains-as-of"), null);
      assert.ok(res.headers.get("x-domains-root"));
      assert.equal(((await body(res)) as { data: { as_of: unknown } }).data.as_of, null);
    },
  );
});

test("router: x-domains-cache says what served the bytes: ghcr cold, hit warm, mixed for a cached manifest with root.json from GHCR", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      assert.equal((await w.get("/v1/index/latest")).headers.get("x-domains-cache"), "ghcr");
      assert.equal((await w.get("/v1/index/latest")).headers.get("x-domains-cache"), "hit");
      // A new isolate whose colo holds the manifest and not root.json.
      resetRoot();
      for (const p of w.cache.ofKind("body")) w.cache.entries.delete(p.url);
      const mixed = await w.get("/v1/index/latest");
      assert.equal(mixed.headers.get("x-domains-cache"), "mixed");
      assert.equal(mixed.headers.get("x-domains-tiers-read"), "0");
      // A new isolate whose colo holds both: every read is a hit, with no subrequest.
      resetRoot();
      const from = w.requests.length;
      const hit = await w.get("/v1/index/latest");
      assert.equal(hit.headers.get("x-domains-cache"), "hit");
      assert.equal(w.since(from).length, 0);
    },
  );
});

test("router: HEAD of /v1/index/latest makes the reads of GET and answers no body", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      const res = await w.head("/v1/index/latest");
      assert.equal(res.status, 200);
      assert.ok(res.headers.get("x-domains-root"));
      assert.equal(await res.text(), "");
      assert.equal(w.requests.length, 3);
    },
  );
});

test("router: the query string is ignored", async () => {
  await apiWorld(
    async (w, blobs) => {
      await plantRoot(w, blobs);
    },
    async (w) => {
      assert.equal((await w.get("/healthz?x=1&ok=false")).status, 200);
      assert.equal((await w.get("/?anything")).status, 200);
      assert.equal((await w.get("/nothing?x=/healthz")).status, 404);
    },
  );
});

test("router: a fault inside a route answers 500 internal-error, logged with the request id", async () => {
  const errors: unknown[][] = [];
  const saved = console.error;
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  try {
    const env = {
      get BUILD(): string {
        throw new TypeError("a planted fault");
      },
    };
    const res = await handle(new Request("https://domains.example.test/healthz", { headers: { "cf-ray": "8f00000000000000-KTM" } }), env, { waitUntil: () => undefined });
    assert.equal(res.status, 500);
    const p = (await res.json()) as Record<string, unknown>;
    assert.equal(p.reason, "internal-error");
    assert.equal(p.see, "/llms-full.txt#reason-internal-error");
    assert.ok(errors.some((e) => /8f00000000000000-KTM: internal error on \/healthz: TypeError: a planted fault/.test(String(e[0]))));
  } finally {
    console.error = saved;
  }
});
