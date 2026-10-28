// packages/testkit/src/world.ts: the GHCR stand-in answers manifests, 404s and
// blob redirects as GHCR does, the Cache API stub keeps an entry for its max-age
// on the world's clock, inWorld fails a test that leaves a body unread, and
// close() puts every global back.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Ctx, WorkerModule } from "../src/world.ts";
import { CacheStub, digest, inWorld, MANIFEST_TYPE, REGISTRY, T0, world } from "../src/world.ts";

interface Cache {
  match(key: Request): Promise<Response | undefined>;
  put(key: Request, res: Response): Promise<void>;
}
// The world installs caches.default; Node's types do not declare it.
const defaultCache = (): Cache => (globalThis as unknown as { caches: { default: Cache } }).caches.default;

const ROOT_JSON = digest("a");

// A Worker in miniature: /man reads root:<ref> through the Cache API, /blob
// asks for a blob and answers its redirect, cancelling the empty 307 body
// unless ?leave=1.
const worker: WorkerModule = {
  async fetch(request: Request, _env: unknown, ctx: Ctx): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/man") {
      const ref = url.searchParams.get("ref") ?? "latest";
      const key = new Request(`https://cache.test/__cache/v1/man/${ref}`);
      const hit = await defaultCache().match(key);
      if (hit) return new Response(await hit.text(), { headers: { "x-from": "cache" } });
      const res = await fetch(`${REGISTRY}/root/manifests/${ref}`, { headers: { accept: MANIFEST_TYPE } });
      const text = await res.text();
      if (res.status === 200) ctx.waitUntil(defaultCache().put(key, new Response(text, { headers: { "cache-control": "max-age=30" } })));
      return new Response(text, { status: res.status, headers: { "x-from": "ghcr" } });
    }
    if (url.pathname === "/blob") {
      const res = await fetch(`${REGISTRY}/root/blobs/${ROOT_JSON}`, { redirect: "manual" });
      if (url.searchParams.get("leave") !== "1") await res.body?.cancel();
      return new Response(res.headers.get("location"), { status: res.status });
    }
    return new Response("no route", { status: 404 });
  },
};

const seed = (w: ReturnType<typeof world>): void => {
  w.manifest("root:latest", [["root.json", ROOT_JSON, 1234]]);
  w.blobs.set(`root@${ROOT_JSON}`, true);
};

test("world: a manifest comes from the stand-in, then from the cache stub until its max-age passes on the clock", async () => {
  await inWorld(worker, seed, async (w) => {
    const first = await w.get("/man");
    assert.equal(first.headers.get("x-from"), "ghcr");
    const m = JSON.parse(await first.text());
    assert.equal(m.mediaType, MANIFEST_TYPE);
    assert.deepEqual(m.layers[0], { mediaType: "application/octet-stream", digest: ROOT_JSON, size: 1234, annotations: { "org.opencontainers.image.title": "root.json" } });
    assert.deepEqual(w.cache.ofKind("man"), [{ url: "https://cache.test/__cache/v1/man/latest", ttl: 30, body: JSON.stringify(m) }]);

    w.advance(29);
    assert.equal((await w.get("/man")).headers.get("x-from"), "cache");
    w.advance(1);
    assert.equal((await w.get("/man")).headers.get("x-from"), "ghcr");
    assert.equal(w.requests.length, 2);
    assert.equal(w.requests[0]?.url, `${REGISTRY}/root/manifests/latest`);
  });
});

test("world: an unknown manifest answers 404 MANIFEST_UNKNOWN", async () => {
  await inWorld(worker, seed, async (w) => {
    const res = await w.get("/man?ref=r-nope");
    assert.equal(res.status, 404);
    assert.match(await res.text(), /MANIFEST_UNKNOWN/);
    assert.equal(w.cache.puts.length, 0);
  });
});

test("world: a blob answers 307 to a signed URL whose se is seAfter seconds after the clock", async () => {
  await inWorld(worker, seed, async (w) => {
    const res = await w.get("/blob");
    assert.equal(res.status, 307);
    const location = new URL(await res.text());
    assert.equal(location.origin, "https://pkg-containers.githubusercontent.com");
    assert.equal(location.searchParams.get("se"), new Date(T0 + 400_000).toISOString().replace(/\.\d{3}Z$/, "Z"));
  });
});

test("world: inWorld fails a test that leaves a GHCR body neither read nor cancelled, and still restores the globals", async () => {
  const before = globalThis.fetch;
  await assert.rejects(
    inWorld(worker, seed, async (w) => {
      await w.get("/blob?leave=1");
    }),
    /GHCR bodies neither read nor cancelled/,
  );
  assert.equal(globalThis.fetch, before);
});

test("world: a fetch outside the registry throws, and intercept answers before the maps", async () => {
  await inWorld(worker, seed, async (w) => {
    await assert.rejects(() => fetch("https://example.org/x"), /unexpected fetch https:\/\/example\.org\/x/);
    await assert.rejects(() => fetch(`${REGISTRY}/root/tags/list`), /unexpected GHCR path root\/tags\/list/);
    w.intercept = (url) => (url.endsWith("/manifests/latest") ? w.response(503, "down") : undefined);
    const res = await w.get("/man");
    assert.equal(res.status, 503);
  });
});

test("world: close restores fetch, caches, Date.now, console.error and AbortSignal.timeout", () => {
  const saved = { fetch: globalThis.fetch, now: Date.now, error: console.error, timeout: AbortSignal.timeout, caches: Object.getOwnPropertyDescriptor(globalThis, "caches") };
  const w = world(worker);
  assert.notEqual(globalThis.fetch, saved.fetch);
  assert.equal(Date.now(), T0);
  console.error("captured");
  AbortSignal.timeout(10_000);
  assert.deepEqual(w.errors, [["captured"]]);
  assert.deepEqual(w.timeouts, [10_000]);
  w.close();
  assert.equal(globalThis.fetch, saved.fetch);
  assert.equal(Date.now, saved.now);
  assert.equal(console.error, saved.error);
  assert.equal(AbortSignal.timeout, saved.timeout);
  assert.deepEqual(Object.getOwnPropertyDescriptor(globalThis, "caches"), saved.caches);
});

test("world: the cache stub refuses a string key, a non-GET key, a 206 and an answer with no max-age", async () => {
  const stub = new CacheStub({ now: T0 });
  const ok = () => new Response("x", { headers: { "cache-control": "max-age=5" } });
  await assert.rejects(() => stub.put("https://k.test/a", ok()), /GET Request/);
  await assert.rejects(() => stub.put(new Request("https://k.test/a", { method: "POST" }), ok()), /GET Request/);
  await assert.rejects(() => stub.put(new Request("https://k.test/a"), new Response("x", { status: 206, headers: { "cache-control": "max-age=5" } })), /206/);
  await assert.rejects(() => stub.put(new Request("https://k.test/a"), new Response("x", { headers: { "cache-control": "no-store, max-age=5" } })), /no max-age/);
  await assert.rejects(() => stub.put(new Request("https://k.test/a"), new Response("x")), /no max-age/);
  assert.equal(stub.entries.size, 0);
});

test("world: resetIsolate runs before the world exists, and request waits for every waitUntil promise", async () => {
  const order: string[] = [];
  const late: WorkerModule = {
    fetch(_request, _env, ctx) {
      // A promise that settles on a later turn of the event loop, not a microtask.
      ctx.waitUntil(new Promise((settle) => setTimeout(settle, 20)).then(() => order.push("waitUntil")));
      order.push("answer");
      return new Response("ok");
    },
  };
  const w = world(late, { resetIsolate: () => order.push("reset") });
  try {
    await w.get("/");
    assert.deepEqual(order, ["reset", "answer", "waitUntil"]);
  } finally {
    w.close();
  }
});
