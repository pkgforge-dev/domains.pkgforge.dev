import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { GhcrError, ghcrReader, TITLE } from "@domains/ghcr";
import { ApiCache } from "../src/cache.ts";
import { USER_AGENT } from "../src/ghcr.ts";
import { R2_LOOKUP_MS, R2_ROOT_HARD_MS, R2Cache, type R2CacheBucket } from "../src/r2cache.ts";
import { resetRoot, ROOT_REPO, ROOT_TYPE, RootUnavailable, rootOf } from "../src/root.ts";
import { rootDoc, sha256 } from "./helpers.ts";

const registry = `https://ghcr.io/v2/${ROOT_REPO}`;
const blobHost = "https://pkg-containers.githubusercontent.com";
const value = (body: Uint8Array<ArrayBuffer>) => new Response(body).body as ReadableStream<Uint8Array>;

function otherRoot(body: Uint8Array): Uint8Array<ArrayBuffer> {
  const text = new TextDecoder().decode(body);
  const changed = text.replace(/"root_seq":7[45]/, '"root_seq":76');
  assert.notEqual(changed, text);
  return new TextEncoder().encode(changed);
}

beforeEach(resetRoot);

async function fixture(doc = rootDoc()) {
  const bytes = new TextEncoder().encode(JSON.stringify(doc));
  const layer = await sha256(bytes);
  const manifest = JSON.stringify({
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: ROOT_TYPE,
    config: { mediaType: "application/vnd.oci.empty.v1+json", digest: await sha256("{}"), size: 2 },
    layers: [{ mediaType: "application/json", digest: layer, size: bytes.byteLength, annotations: { [TITLE]: "root.json" } }],
  });
  const root = await sha256(manifest);
  const enteredR2 = Promise.withResolvers<void>();
  const r2Body = Promise.withResolvers<ReadableStream<Uint8Array> | null>();
  const enteredGhcr = Promise.withResolvers<void>();
  const ghcrHead = Promise.withResolvers<Response>();
  const ghcrAbort = Promise.withResolvers<void>();
  const logged = Promise.withResolvers<void>();
  const calls: string[] = [];
  const logs: string[] = [];
  const writes: { cache: string[]; bucket: ArrayBuffer[] } = { cache: [], bucket: [] };
  const waits: Promise<unknown>[] = [];
  let r2Reads = 0;
  const bucket: R2CacheBucket = {
    async get(key) {
      r2Reads += 1;
      enteredR2.resolve();
      const body = await r2Body.promise;
      return body === null
        ? null
        : { key, body, size: bytes.byteLength, uploaded: new Date(Date.now()), customMetadata: { identity: JSON.stringify([1, "root", ROOT_REPO, layer, 0, bytes.byteLength]) } };
    },
    async put(_key, body) {
      writes.bucket.push(body);
    },
  };
  const waitUntil = (p: Promise<unknown>): void => {
    waits.push(p);
  };
  const log = (m: string): void => {
    logs.push(m);
    logged.resolve();
  };
  const r2 = new R2Cache({ bucket, waitUntil, log });
  const cache = new ApiCache({
    host: "worker.test",
    ray: "-",
    r2,
    waitUntil,
    cache: {
      match: async () => undefined,
      async put(req) {
        writes.cache.push(new URL(req.url).pathname.split("/")[3] ?? "");
      },
    },
  });
  const g = ghcrReader({
    userAgent: USER_AGENT,
    cache,
    fetcher: async (url, init) => {
      calls.push(url);
      if (url === `${registry}/manifests/latest`) return new Response(manifest);
      if (url === `${registry}/blobs/${layer}`) {
        const se = new Date(Date.now() + 480_000).toISOString();
        return new Response(null, { status: 307, headers: { location: `${blobHost}/blobs/${layer}?se=${encodeURIComponent(se)}` } });
      }
      assert.ok(url.startsWith(`${blobHost}/blobs/${layer}?`));
      enteredGhcr.resolve();
      const signal = init.signal;
      assert.ok(signal);
      return await new Promise((resolve, reject) => {
        const cancel = () => {
          ghcrAbort.resolve();
          reject(signal.reason);
        };
        signal.addEventListener("abort", cancel, { once: true });
        ghcrHead.promise.then(resolve, reject);
      });
    },
  });
  const range = (body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> = bytes): Response =>
    new Response(body, { status: 206, headers: { "content-range": `bytes 0-${bytes.byteLength - 1}/${bytes.byteLength}` } });
  const start = (deadline?: number) => rootOf(g, cache, log, deadline);
  const settle = () => Promise.all(waits);
  const lookups = () => r2Reads;
  return { bytes, root, layer, calls, logs, logged, writes, enteredR2, r2Body, enteredGhcr, ghcrHead, ghcrAbort, range, start, settle, lookups, r2 };
}

test("root hedge: R2 below the soft deadline skips GHCR and preserves the held-root provenance", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reply = f.start();
  await f.enteredR2.promise;
  t.mock.timers.tick(249);
  assert.equal(f.calls.length, 1);
  f.r2Body.resolve(value(f.bytes));
  const accepted = await reply;
  assert.equal(accepted.bodyTier, "r2");
  assert.deepEqual(
    accepted.reads.map((r) => r.tier),
    ["ghcr", "r2"],
  );
  t.mock.timers.tick(1_000);
  assert.equal(f.calls.length, 1);
  assert.equal(f.lookups(), 1);
  await f.settle();
  assert.deepEqual(f.writes, { cache: ["man", "body"], bucket: [] });
  const reused = await f.start();
  assert.equal(reused.bodyTier, null);
  assert.equal(reused.root.digest, f.root);
  assert.equal(reused.reads.length, 1);
  assert.equal(f.lookups(), 1);
});

test("root hedge: GHCR starts at 250 ms and R2 can win after that with no losing signed-URL or bucket write", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reply = f.start();
  await f.enteredR2.promise;
  t.mock.timers.tick(249);
  assert.equal(f.calls.length, 1);
  t.mock.timers.tick(1);
  await f.enteredGhcr.promise;
  const reading = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  f.ghcrHead.resolve(
    f.range(
      new ReadableStream<Uint8Array>(
        {
          pull() {
            reading.resolve();
          },
          cancel() {
            stopped.resolve();
          },
        },
        { highWaterMark: 0 },
      ),
    ),
  );
  await reading.promise;
  t.mock.timers.tick(499);
  f.r2Body.resolve(value(f.bytes));
  const accepted = await reply;
  await f.ghcrAbort.promise;
  await stopped.promise;
  await f.settle();
  assert.equal(accepted.bodyTier, "r2");
  assert.equal(accepted.stale, false);
  assert.equal(accepted.root.digest, f.root);
  assert.equal(f.calls.length, 3);
  assert.equal(f.lookups(), 1);
  assert.deepEqual(f.logs, []);
  assert.deepEqual(f.writes, { cache: ["man", "body"], bucket: [] });
});

test("root hedge: verified GHCR wins promptly, fills once, and cancels a late native GET body when it settles", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reply = f.start();
  await f.enteredR2.promise;
  t.mock.timers.tick(R2_LOOKUP_MS);
  await f.enteredGhcr.promise;
  f.ghcrHead.resolve(f.range());
  const accepted = await reply;
  assert.deepEqual(
    accepted.reads.map((r) => r.tier),
    ["ghcr", "ghcr"],
  );
  assert.equal(accepted.bodyTier, "ghcr");
  const other = { kind: "root", repo: ROOT_REPO, digest: f.layer, start: 0, end: f.bytes.byteLength } as const;
  assert.equal(await f.r2.get(other), null);
  assert.equal(f.lookups(), 1, "uncancelable binding GET occupies its slot until it settles");
  const stopped = Promise.withResolvers<void>();
  f.r2Body.resolve(
    new ReadableStream({
      cancel() {
        stopped.resolve();
      },
    }),
  );
  await stopped.promise;
  await f.settle();
  assert.deepEqual(f.writes.cache, ["man", "body", "blob"]);
  assert.deepEqual(f.writes.bucket, [f.bytes.buffer]);
  assert.deepEqual(f.logs, []);
});

test("root hedge: late R2 corruption is a miss, and GHCR is the sole source and fill", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reply = f.start();
  await f.enteredR2.promise;
  t.mock.timers.tick(R2_LOOKUP_MS);
  await f.enteredGhcr.promise;
  f.r2Body.resolve(value(otherRoot(f.bytes)));
  // Let the R2 digest finish before offering a GHCR answer.
  await Promise.race([f.logged.promise, reply]);
  f.ghcrHead.resolve(f.range());
  assert.equal((await reply).bodyTier, "ghcr");
  await f.settle();
  assert.deepEqual(f.logs, ["R2 root read failed: its bytes do not hash to the digest"]);
  assert.deepEqual(f.writes.bucket, [f.bytes.buffer]);
});

test("root hedge: unreachable and corrupt GHCR ranges both allow a late verified R2 root", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  for (const failure of ["unreachable", "corrupt"] as const) {
    const f = await fixture(rootDoc({ root_seq: failure === "unreachable" ? 74 : 75 }));
    const reply = f.start();
    await f.enteredR2.promise;
    t.mock.timers.tick(R2_LOOKUP_MS);
    await f.enteredGhcr.promise;
    if (failure === "unreachable") f.ghcrHead.reject(new Error("offline"));
    else f.ghcrHead.resolve(f.range(otherRoot(f.bytes)));
    t.mock.timers.tick(R2_ROOT_HARD_MS - R2_LOOKUP_MS - 1);
    f.r2Body.resolve(value(f.bytes));
    const accepted = await reply;
    assert.equal(accepted.bodyTier, "r2", failure);
    assert.equal(accepted.stale, false, failure);
    assert.deepEqual(
      accepted.reads.map((r) => r.tier),
      ["ghcr", "r2"],
      failure,
    );
    await f.settle();
    assert.deepEqual(f.writes, { cache: ["man", "body"], bucket: [] }, failure);
  }
});

test("root hedge: a matching digest with an invalid root head enters neither provenance nor any immutable cache", async () => {
  const f = await fixture(rootDoc({ root_seq: 0 }));
  f.r2Body.resolve(value(f.bytes));
  f.ghcrHead.resolve(f.range());
  await assert.rejects(
    () => f.start(),
    (err: unknown) => err instanceof RootUnavailable && /root_seq/.test(err.message),
  );
  await f.settle();
  assert.deepEqual(f.logs, ["R2 root read failed: its bytes do not hold a supported root head"]);
  assert.deepEqual(f.writes, { cache: ["man"], bucket: [] });
});

test("root hedge: at 1,000 ms a stalled R2 body is canceled and GHCR failure preserves the kept root without attribution", async (t) => {
  const kept = await fixture();
  kept.r2Body.resolve(value(kept.bytes));
  assert.equal((await kept.start()).bodyTier, "r2");
  const f = await fixture(rootDoc({ root_seq: 75 }));
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reading = Promise.withResolvers<void>();
  const stopped = Promise.withResolvers<void>();
  f.r2Body.resolve(
    new ReadableStream(
      {
        pull() {
          reading.resolve();
        },
        cancel() {
          stopped.resolve();
        },
      },
      { highWaterMark: 0 },
    ),
  );
  const reply = f.start();
  await reading.promise;
  t.mock.timers.tick(R2_LOOKUP_MS);
  await f.enteredGhcr.promise;
  f.ghcrHead.resolve(new Response(null, { status: 500 }));
  t.mock.timers.tick(749);
  assert.deepEqual(f.logs, []);
  t.mock.timers.tick(1);
  const stale = await reply;
  await stopped.promise;
  await f.settle();
  assert.equal(stale.stale, true);
  assert.equal(stale.root.digest, kept.root);
  assert.equal(stale.bodyTier, null);
  assert.deepEqual(stale.reads, []);
  assert.deepEqual(f.writes, { cache: ["man"], bucket: [] });
  assert.equal(f.logs[0], "R2 root lookup exceeded 1000 ms");
  assert.match(f.logs[1] ?? "", /answering from the kept root .* answered 500/);
});

test("root hedge: an outer deadline stops both candidates and neither can become the held root later", async (t) => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const reply = f.start(300);
  const unavailable = assert.rejects(reply, (err: unknown) => err instanceof RootUnavailable && /within 0\.3 s/.test(err.message));
  await f.enteredR2.promise;
  t.mock.timers.tick(250);
  await f.enteredGhcr.promise;
  t.mock.timers.tick(50);
  await unavailable;
  await f.ghcrAbort.promise;
  const stopped = Promise.withResolvers<void>();
  f.r2Body.resolve(
    new ReadableStream({
      cancel() {
        stopped.resolve();
      },
    }),
  );
  await stopped.promise;
  await f.settle();
  assert.deepEqual(f.writes, { cache: ["man"], bucket: [] });
  const failure = new GhcrError("upstream", "offline");
  const reader = {
    ...ghcrReader({ userAgent: USER_AGENT }),
    async getManifest() {
      throw failure;
    },
  };
  const cache = new ApiCache({ host: "worker.test", ray: "-", waitUntil: () => undefined });
  await assert.rejects(
    () => rootOf(reader, cache, () => undefined),
    (err: unknown) => err instanceof RootUnavailable && err.message === failure.message,
  );
});
