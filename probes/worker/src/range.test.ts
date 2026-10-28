// probes/worker/src/range.test.ts — the /range route (DOM-007) in Node, against
// the GHCR stand-in and the Cache API stub of @domains/testkit's world: the three
// steps and their headers, the token flow, the cache modes and their TTLs, and
// each refusal, each planted in the registry's answer. The registry, its blob
// and its signed URLs are synthetic; no answer here was recorded from GHCR.
// probes/worker/test/range-workerd.test.ts runs the same route in workerd.
//
//   node scripts/test.mjs probes/worker --name range
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { BLOB_HOST, digest, inWorld, sha256hex, type World, type WorkerModule } from "@domains/testkit";
import { ProbeError } from "./gaps.ts";
import { bearerRealm, DEFAULT_REPO, DUMMY, LIMITS, MANIFEST_ACCEPT, parseContentRange, parseQuery, pickLayer, type RangeAnswer, rangeRoute, redact, signedTtl, TTL_S } from "./range.ts";
import type { Env } from "./types.ts";

const ENV = {} as unknown as Env;
const LAYER = digest("b");
const SIZE = 300_000;
const TAG = "size-test";
// Synthetic blob bytes: a pattern no two nearby offsets share. The world's cache
// stub keeps a body as text, so the bytes stay below 0x80, which UTF-8 keeps as
// they are; the workerd test reads bytes of every value through the real Cache API.
const DATA = Uint8Array.from({ length: SIZE }, (_, i) => (i * 7 + (i >> 8) * 13 + 3) & 127);

// The probe's dispatch in miniature: the route, and a ProbeError as its status.
const worker: WorkerModule = {
  async fetch(request) {
    const url = new URL(request.url);
    try {
      return await rangeRoute.handle(request, ENV, url, () => Date.now());
    } catch (err) {
      if (err instanceof ProbeError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
      throw err;
    }
  },
};

const headersOf = (init: RequestInit): Record<string, string> => (init.headers ?? {}) as Record<string, string>;

// The blob host: a 206 of the asked range of DATA, as Azure Blob answers one.
function serveBlob(w: World, host = BLOB_HOST): void {
  w.intercept = (url, init) => {
    if (!url.startsWith(host)) return undefined;
    const m = /^bytes=(\d+)-(\d+)$/.exec(headersOf(init).range ?? "");
    if (m === null) return w.response(400, "no range", {}, { url });
    const first = Number(m[1]);
    const last = Number(m[2]);
    return w.response(206, DATA.slice(first, last + 1), { "content-range": `bytes ${first}-${last}/${SIZE}`, "content-length": String(last - first + 1), "accept-ranges": "bytes" }, { url });
  };
}

// The manifest digest of TAG, as GHCR names it: the SHA-256 of its bytes.
const pinnedOf = async (w: World): Promise<string> => `sha256:${await sha256hex(w.manifests.get(`probe:${TAG}`) ?? "")}`;

// The probe package: TAG and its manifest digest name one manifest of one layer.
async function seed(w: World): Promise<void> {
  w.manifest(`probe:${TAG}`, [["payload.bin", LAYER, SIZE]]);
  w.manifests.set(`probe:${await pinnedOf(w)}`, w.manifests.get(`probe:${TAG}`) ?? "");
  w.blobs.set(`probe@${LAYER}`, true);
  serveBlob(w);
}

async function ask(w: World, query: string): Promise<{ status: number; text: string; body: RangeAnswer }> {
  const res = await w.get(`/range?${query}`);
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as RangeAnswer };
}

const sha = (bytes: Uint8Array): string => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString("hex");

test("range: cache=none reads the manifest, the blob's redirect and the range, three subrequests, and answers the bytes' ends and hash", async () => {
  await inWorld(worker, seed, async (w) => {
    const pinned = await pinnedOf(w);
    const { status, text, body } = await ask(w, `tag=${pinned}&offset=25600&length=25600`);
    assert.equal(status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.status, 206);
    assert.equal(body.failed_at, null);
    assert.deepEqual(
      body.steps.map((s) => [s.step, s.from, s.auth, s.status]),
      [
        ["manifest", "ghcr", "dummy", 200],
        ["blob", "ghcr", "dummy", 307],
        ["range", "ghcr", "none", 206],
      ],
    );
    assert.equal(body.subrequests, 3);
    assert.deepEqual(body.manifest, { digest: pinned });
    assert.deepEqual(body.layer, { digest: LAYER, size: SIZE, title: "payload.bin", index: 0 });
    const slice = DATA.slice(25600, 51200);
    assert.deepEqual(body.bytes, { read: 25600, first: 25600, last: 51199, head: hexOf(slice.subarray(0, 16)), tail: hexOf(slice.subarray(25584)), sha256: sha(slice) });
    assert.equal(body.signed?.host, "pkg-containers.githubusercontent.com");
    assert.equal(body.signed?.expected_host, true);
    assert.equal(body.signed?.se_in_s, 400);
    assert.deepEqual(body.cache, { mode: "none", puts: [] });
    // The manifest GET carries the dummy token and the OCI Accept list; the blob GET the dummy token; the signed URL no Authorization and the Range.
    const [man, blob, range] = w.requests;
    assert.equal(man?.url, `https://ghcr.io/v2/${DEFAULT_REPO}/manifests/${pinned}`);
    assert.deepEqual(headersOf(man?.init ?? {}), { accept: MANIFEST_ACCEPT, authorization: DUMMY });
    assert.equal(man?.init.redirect, "manual");
    assert.equal(blob?.url, `https://ghcr.io/v2/${DEFAULT_REPO}/blobs/${LAYER}`);
    assert.deepEqual(headersOf(blob?.init ?? {}), { authorization: DUMMY });
    assert.equal(blob?.init.redirect, "manual");
    assert.ok(range?.url.startsWith(`${BLOB_HOST}/`));
    assert.deepEqual(headersOf(range?.init ?? {}), { range: "bytes=25600-51199" });
    // Every subrequest carries a time cap; the answer never carries the signed URL.
    assert.deepEqual(w.timeouts, [LIMITS.subrequest_ms, LIMITS.subrequest_ms, LIMITS.subrequest_ms]);
    assert.ok(!text.includes("sig="), "the signature is not in the answer");
    assert.ok(!text.includes("ghcrblobs"), "the signed URL's path is not in the answer");
  });
});

test("range: a digest asked is checked against the manifest's bytes, and bytes that hash to another refuse the read", async () => {
  await inWorld(worker, seed, async (w) => {
    const other = digest("c");
    w.manifests.set(`probe:${other}`, w.manifests.get(`probe:${TAG}`) ?? "");
    const { status, body } = await ask(w, `tag=${other}`);
    assert.equal(status, 200);
    assert.equal(body.ok, false);
    assert.equal(body.failed_at, "manifest");
    assert.equal(body.status, 200);
    assert.match(body.error ?? "", /hash to sha256:[0-9a-f]{64}, not the digest asked/);
    assert.equal(body.subrequests, 1);
    assert.equal(body.bytes, null);
  });
});

test("range: a docker-content-digest that differs from the manifest's bytes refuses the read", async () => {
  await inWorld(worker, seed, async (w) => {
    const body = w.manifests.get(`probe:${TAG}`) ?? "";
    w.intercept = (url) => (url.includes("/manifests/") ? w.response(200, body, { "docker-content-digest": digest("d") }, { url }) : undefined);
    const answer = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(answer.ok, false);
    assert.match(answer.error ?? "", /docker-content-digest says sha256:d{64}/);
  });
});

test("range: cache=block keeps the manifest, the signed URL and the block; the same block again makes no subrequest, and another block makes one", async () => {
  await inWorld(worker, seed, async (w) => {
    const pinned = await pinnedOf(w);
    const first = (await ask(w, `tag=${pinned}&offset=1024&length=1024&cache=block`)).body;
    assert.equal(first.ok, true);
    assert.equal(first.subrequests, 3);
    assert.deepEqual({ manifest: first.cache.manifest, signed: first.cache.signed, block: first.cache.block }, { manifest: "miss", signed: "miss", block: "miss" });
    assert.deepEqual(
      first.cache.puts.map((p) => [p.kind, p.ttl_s, p.ok]),
      [
        ["man", TTL_S.manifest_by_digest, true],
        ["loc", 400 - TTL_S.signed_margin, true],
        ["blk", TTL_S.block, true],
      ],
    );
    const again = (await ask(w, `tag=${pinned}&offset=1024&length=1024&cache=block`)).body;
    assert.equal(again.ok, true);
    assert.equal(again.subrequests, 0);
    assert.deepEqual(
      again.steps.map((s) => [s.step, s.from, s.status]),
      [
        ["manifest", "cache", 200],
        ["range", "cache", 206],
      ],
    );
    // The signed URL's cache was not read, so the answer names no state for it.
    assert.deepEqual({ ...again.cache, puts: undefined }, { mode: "block", manifest: "hit", block: "hit", puts: undefined });
    assert.deepEqual(again.bytes, first.bytes);
    const next = (await ask(w, `tag=${pinned}&offset=2048&length=1024&cache=block`)).body;
    assert.equal(next.ok, true);
    assert.equal(next.subrequests, 1);
    assert.deepEqual(
      next.steps.map((s) => [s.step, s.from, s.status]),
      [
        ["manifest", "cache", 200],
        ["blob", "cache", 307],
        ["range", "ghcr", 206],
      ],
    );
    assert.equal(next.bytes?.sha256, sha(DATA.slice(2048, 3072)));
    assert.equal(w.requests.length, 4);
  });
});

test("range: cache=signed keeps a manifest asked by tag 30 s and the block not at all", async () => {
  await inWorld(worker, seed, async (w) => {
    const first = (await ask(w, `tag=${TAG}&cache=signed`)).body;
    assert.deepEqual(
      first.cache.puts.map((p) => [p.kind, p.ttl_s]),
      [
        ["man", TTL_S.manifest_by_tag],
        ["loc", 280],
      ],
    );
    assert.equal(first.cache.block, undefined);
    w.advance(29);
    assert.equal((await ask(w, `tag=${TAG}&cache=signed`)).body.subrequests, 1);
    w.advance(1);
    const later = (await ask(w, `tag=${TAG}&cache=signed`)).body;
    assert.equal(later.cache.manifest, "miss");
    assert.equal(later.cache.signed, "hit");
    assert.equal(later.subrequests, 2);
  });
});

test("range: a signed URL is kept until its se minus 120 s, at most 600 s, and one too near its se is not kept", async () => {
  const now = Date.parse("2026-10-28T15:31:12Z");
  assert.equal(signedTtl(now + 400_000, now), 280);
  assert.equal(signedTtl(now + 3_600_000, now), TTL_S.signed_max);
  assert.equal(signedTtl(now + 120_500, now), 0);
  assert.equal(signedTtl(now - 1_000, now), 0);
  await inWorld(worker, seed, async (w) => {
    w.seAfter = 100;
    const body = (await ask(w, `tag=${TAG}&cache=signed`)).body;
    assert.equal(body.ok, true);
    const loc = body.cache.puts.find((p) => p.kind === "loc");
    assert.deepEqual(loc, { kind: "loc", ttl_s: 0, ok: false, ms: 0, error: "a TTL under 1 s: not kept" });
    assert.equal(w.cache.ofKind("loc").length, 0);
  });
});

test("range: a cache that fails to match or to put is reported, and the read still goes to GHCR", async () => {
  await inWorld(worker, seed, async (w) => {
    w.cache.failMatch = true;
    w.cache.failPut = true;
    const body = (await ask(w, `tag=${TAG}&cache=block`)).body;
    assert.equal(body.ok, true);
    assert.equal(body.subrequests, 3);
    assert.deepEqual([body.cache.manifest, body.cache.block, body.cache.signed], ["error", "error", "error"]);
    assert.deepEqual(
      body.cache.puts.map((p) => [p.kind, p.ok, p.error]),
      [
        ["man", false, "cache stub: put failed"],
        ["loc", false, "cache stub: put failed"],
        ["blk", false, "cache stub: put failed"],
      ],
    );
  });
});

test("range: a cached block of the wrong length is not trusted, and the read goes to GHCR", async () => {
  await inWorld(worker, seed, async (w) => {
    assert.equal((await ask(w, `tag=${TAG}&length=1024&cache=block`)).body.ok, true);
    const [entry] = w.cache.ofKind("blk");
    assert.ok(entry);
    const stored = w.cache.entries.get(entry.url);
    assert.ok(stored);
    stored.body = "short";
    const body = (await ask(w, `tag=${TAG}&length=1024&cache=block`)).body;
    assert.equal(body.ok, true);
    assert.equal(body.cache.block, "error");
    assert.deepEqual(
      body.steps.map((s) => [s.step, s.from, s.error ?? null]),
      [
        ["manifest", "cache", null],
        ["range", "cache", "the cached block is not 1024 bytes"],
        ["blob", "cache", null],
        ["range", "ghcr", null],
      ],
    );
  });
});

test("range: a 401 to the dummy token runs the token flow once and asks again with the pull token, which the answer never carries", async () => {
  await inWorld(worker, seed, async (w) => {
    const serve = w.intercept;
    w.intercept = (url, init) => {
      const auth = headersOf(init).authorization;
      if (url.includes("/manifests/") && auth === DUMMY) {
        return w.response(401, "", { "www-authenticate": `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${DEFAULT_REPO}:pull"` }, { url });
      }
      if (url.startsWith("https://ghcr.io/token?")) return w.response(200, '{"token":"pulltoken123"}', { "content-type": "application/json" }, { url });
      return serve?.(url, init);
    };
    const { text, body } = await ask(w, `tag=${TAG}`);
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.steps.map((s) => [s.step, s.auth, s.status]),
      [
        ["manifest", "dummy", 401],
        ["token", "none", 200],
        ["manifest", "token", 200],
        ["blob", "dummy", 307],
        ["range", "none", 206],
      ],
    );
    assert.equal(body.subrequests, 5);
    const token = new URL(w.requests[1]?.url ?? "");
    assert.deepEqual([token.origin + token.pathname, token.searchParams.get("service"), token.searchParams.get("scope")], ["https://ghcr.io/token", "ghcr.io", `repository:${DEFAULT_REPO}:pull`]);
    assert.equal(headersOf(w.requests[2]?.init ?? {}).authorization, "Bearer pulltoken123");
    assert.ok(!text.includes("pulltoken123"), "the token is not in the answer");
  });
});

test("range: a 403 with no challenge asks once with no Authorization for the challenge, then the token", async () => {
  await inWorld(worker, seed, async (w) => {
    const serve = w.intercept;
    w.intercept = (url, init) => {
      const auth = headersOf(init).authorization;
      const blob = url.startsWith("https://ghcr.io/v2/") && url.includes("/blobs/");
      if (blob && auth === DUMMY) return w.response(403, "denied", {}, { url });
      if (blob && auth === undefined) return w.response(401, "", { "www-authenticate": 'Bearer realm="https://ghcr.io/token"' }, { url });
      if (url.startsWith("https://ghcr.io/token?")) return w.response(200, '{"access_token":"other456"}', {}, { url });
      return serve?.(url, init);
    };
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.ok, true);
    assert.deepEqual(
      body.steps.map((s) => [s.step, s.auth, s.status]),
      [
        ["manifest", "dummy", 200],
        ["blob", "dummy", 403],
        ["challenge", "none", 401],
        ["token", "none", 200],
        ["blob", "token", 307],
        ["range", "none", 206],
      ],
    );
  });
});

test("range: a challenge whose realm is not https on ghcr.io is refused, and no token is asked", async () => {
  for (const realm of ["http://ghcr.io/token", "https://evil.example.test/token", "not a url"]) {
    await inWorld(worker, seed, async (w) => {
      w.intercept = (url) => (url.includes("/manifests/") ? w.response(401, "", { "www-authenticate": `Bearer realm="${realm}"` }, { url }) : undefined);
      const body = (await ask(w, `tag=${TAG}`)).body;
      assert.equal(body.ok, false);
      assert.equal(body.failed_at, "token");
      assert.match(body.error ?? "", /named no https realm on ghcr\.io/);
      assert.equal(w.requests.length, 1, realm);
    });
  }
});

test("range: a GHCR 429 or 5xx ends the read with that status at its step", async () => {
  for (const [where, status] of [
    ["/manifests/", 429],
    ["/blobs/", 503],
  ] as const) {
    await inWorld(worker, seed, async (w) => {
      w.intercept = (url) => (url.includes(where) ? w.response(status, "slow down", { "retry-after": "60" }, { url }) : undefined);
      const body = (await ask(w, `tag=${TAG}`)).body;
      assert.equal(body.ok, false);
      assert.equal(body.status, status);
      assert.equal(body.failed_at, where === "/blobs/" ? "blob" : "manifest");
    });
  }
});

test("range: a redirect to http is refused and its URL is never fetched", async () => {
  await inWorld(worker, seed, async (w) => {
    w.blobs.set(`probe@${LAYER}`, `http://pkg-containers.githubusercontent.com/ghcrblobs10/blobs/${LAYER}?se=2026-10-27T03%3A06%3A40Z&sig=x`);
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.ok, false);
    assert.equal(body.failed_at, "blob");
    assert.equal(body.status, 307);
    assert.equal(body.error, "the redirect's Location is http, not https");
    assert.equal(w.requests.length, 2);
  });
});

test("range: a redirect to another https host is followed and reported as not the expected host", async () => {
  await inWorld(worker, seed, async (w) => {
    const other = "https://blobs.example.test";
    w.blobs.set(`probe@${LAYER}`, `${other}/b/${LAYER}?se=2026-10-27T03%3A10%3A00Z&sig=x`);
    serveBlob(w, other);
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.ok, true);
    assert.deepEqual(body.signed, { host: "blobs.example.test", expected_host: false, se: "2026-10-27T03:10:00.000Z", se_in_s: 600 });
  });
});

test("range: GHCR answering the blob itself, not a redirect, is refused and its body never read", async () => {
  await inWorld(worker, seed, async (w) => {
    w.blobs.set(`probe@${LAYER}`, (url) => w.response(200, DATA, {}, { url }));
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.ok, false);
    assert.equal(body.failed_at, "blob");
    assert.match(body.error ?? "", /answered the blob itself/);
    const track = w.bodies.find((b) => b.url.includes("/blobs/"));
    assert.deepEqual([track?.read, track?.cancelled], [false, true]);
  });
});

test("range: a 200 from the blob host, which ignored Range, is refused and the whole blob never read", async () => {
  await inWorld(worker, seed, async (w) => {
    w.intercept = (url) => (url.startsWith(BLOB_HOST) ? w.response(200, DATA, { "content-length": String(SIZE) }, { url }) : undefined);
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.ok, false);
    assert.equal(body.status, 200);
    assert.equal(body.failed_at, "range");
    assert.match(body.error ?? "", /ignored Range/);
    const track = w.bodies.find((b) => b.url.startsWith(BLOB_HOST));
    assert.deepEqual([track?.read, track?.cancelled], [false, true]);
  });
});

test("range: a body longer or shorter than asked, or a Content-Range other than asked, is refused", async () => {
  const cases: [string, (first: number, last: number) => [Uint8Array, string], RegExp][] = [
    ["long", (a, b) => [DATA.slice(a, b + 11), `bytes ${a}-${b}/${SIZE}`], /more than the 1024 bytes asked/],
    ["short", (a, b) => [DATA.slice(a, b - 9), `bytes ${a}-${b}/${SIZE}`], /sent 1014 of the 1024 bytes asked/],
    ["other range", (a, b) => [DATA.slice(a + 1, b + 2), `bytes ${a + 1}-${b + 1}/${SIZE}`], /Content-Range .* is not bytes 0-1023\/300000/],
    ["other total", (a, b) => [DATA.slice(a, b + 1), `bytes ${a}-${b}/${SIZE + 1}`], /is not bytes 0-1023\/300000/],
    ["no header", (a, b) => [DATA.slice(a, b + 1), ""], /Content-Range "" is not/],
  ];
  for (const [name, answer, why] of cases) {
    await inWorld(worker, seed, async (w) => {
      w.intercept = (url, init) => {
        if (!url.startsWith(BLOB_HOST)) return undefined;
        const m = /^bytes=(\d+)-(\d+)$/.exec(headersOf(init).range ?? "");
        const [bytes, range] = answer(Number(m?.[1]), Number(m?.[2]));
        return w.response(206, bytes, range === "" ? {} : { "content-range": range }, { url, chunk: 100 });
      };
      const body = (await ask(w, `tag=${TAG}&length=1024`)).body;
      assert.equal(body.ok, false, name);
      assert.equal(body.failed_at, "range", name);
      assert.match(body.error ?? "", why, name);
      assert.equal(body.bytes, null, name);
    });
  }
});

test("range: a subrequest that times out is reported as timeout at its step", async () => {
  await inWorld(worker, seed, async (w) => {
    w.intercept = (url) => {
      if (url.startsWith(BLOB_HOST)) throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      return undefined;
    };
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.ok, false);
    assert.equal(body.status, null);
    assert.equal(body.failed_at, "range");
    assert.equal(body.error, "timeout");
  });
});

test("range: an unreachable host is reported with its error, with any URL query removed", async () => {
  await inWorld(worker, seed, async (w) => {
    w.intercept = (url) => {
      if (url.startsWith(BLOB_HOST)) throw new TypeError(`fetch failed for ${url}`);
      return undefined;
    };
    const { text, body } = await ask(w, `tag=${TAG}`);
    assert.equal(body.failed_at, "range");
    assert.match(body.error ?? "", /^unreachable: TypeError: fetch failed for https:\/\/pkg-containers\.githubusercontent\.com\/ghcrblobs10\/blobs\/sha256:b{64}\?REDACTED$/);
    assert.ok(!text.includes("sig="));
  });
});

test("range: a manifest over 64 KiB, one that is not JSON, and an image index are refused at the manifest step", async () => {
  const big = JSON.stringify({ schemaVersion: 2, layers: [{ digest: LAYER, size: SIZE }], pad: "x".repeat(LIMITS.manifest_bytes) });
  const index = JSON.stringify({ schemaVersion: 2, mediaType: "application/vnd.oci.image.index.v1+json", manifests: [{ digest: digest("e"), size: 500 }] });
  for (const [body, why] of [
    [big, /over 65536 bytes/],
    ["{not json", /not JSON/],
    [index, /an image index/],
    [JSON.stringify({ schemaVersion: 2, layers: [{ digest: "md5:x", size: 1 }] }), /layer 0 has no sha256 digest/],
  ] as const) {
    await inWorld(worker, seed, async (w) => {
      w.manifests.set(`probe:${TAG}`, body);
      const answer = (await ask(w, `tag=${TAG}`)).body;
      assert.equal(answer.ok, false);
      assert.equal(answer.failed_at, "manifest");
      assert.match(answer.error ?? "", why);
      assert.equal(w.requests.length, 1);
    });
  }
});

test("range: the largest layer is the one read, the first of equal sizes", () => {
  const layer = (c: string, size: number, title?: string) => ({ digest: digest(c), size, ...(title ? { annotations: { "org.opencontainers.image.title": title } } : {}) });
  assert.deepEqual(pickLayer({ layers: [layer("1", 10), layer("2", 300, "a"), layer("3", 300, "b"), layer("5", 5)] }), { digest: digest("2"), size: 300, title: "a", index: 1 });
  assert.equal(pickLayer({ layers: [] }), "the manifest has no layers");
  assert.equal(pickLayer([]), "the manifest is not a JSON object");
  assert.equal(pickLayer({ layers: [layer("1", -1)] }), "layer 0 has no sha256 digest and whole size");
});

test("range: an offset and length past the layer's end answer 400 after the manifest, and nothing else is asked", async () => {
  await inWorld(worker, seed, async (w) => {
    const res = await w.get(`/range?tag=${TAG}&offset=${SIZE - 100}&length=101`);
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: string }).error, /pass the end of layer 0, 300000 bytes/);
    assert.equal(w.requests.length, 1);
    assert.equal((await ask(w, `tag=${TAG}&offset=${SIZE - 100}&length=100`)).body.ok, true);
  });
});

test("range: a query the route does not read answers 400 and makes no subrequest; a repo outside the namespace is one", async () => {
  const bad = [
    "",
    "tag=",
    "tag=Size-1536m",
    `tag=${TAG}&repo=pkgforge-dev/mirror-archlinux/x86_64/core`,
    `tag=${TAG}&repo=pkgforge-dev/domains.pkgforge.devx/probe`,
    `tag=${TAG}&repo=pkgforge-dev/domains.pkgforge.dev`,
    `tag=${TAG}&repo=ghcr.io/pkgforge-dev/domains.pkgforge.dev/probe`,
    `tag=${TAG}&repo=pkgforge-dev/domains.pkgforge.dev/../mirror-archlinux`,
    // Refused by the regex's end anchor alone: a valid first component, then dot segments.
    `tag=${TAG}&repo=pkgforge-dev/domains.pkgforge.dev/probe/../../mirror-archlinux/x`,
    `tag=${TAG}&repo=pkgforge-dev/domains.pkgforge.dev/probe/../../../other-org/pkg`,
    `tag=${TAG}&repo=pkgforge-dev/domains-pkgforge-dev/probe`,
    `tag=${TAG}&repo=pkgforge-dev/domains.pkgforge.dev/Probe`,
    `tag=${TAG}&length=0`,
    `tag=${TAG}&length=${LIMITS.max_length + 1}`,
    `tag=${TAG}&offset=-1`,
    `tag=${TAG}&offset=1e3`,
    `tag=${TAG}&cache=all`,
    `tag=${TAG}&tag=${TAG}`,
    `tag=${TAG}&url=https://example.test/`,
    `tag=${TAG}&repo=${DEFAULT_REPO}${"/a".repeat(LIMITS.query_chars)}`,
  ];
  await inWorld(worker, seed, async (w) => {
    for (const query of bad) {
      const res = await w.get(`/range?${query}`);
      assert.equal(res.status, 400, query);
      await res.text();
    }
    assert.equal(w.requests.length, 0);
  });
  assert.throws(
    () => parseQuery(new URL(`https://p.test/range?tag=${TAG}&repo=pkgforge-dev/mirror-archlinux/x86_64/core`)),
    (e: unknown) => e instanceof ProbeError && e.status === 400 && /reads no other registry path/.test(e.message),
  );
  assert.deepEqual(parseQuery(new URL(`https://p.test/range?tag=${TAG}`)), { repo: DEFAULT_REPO, ref: TAG, offset: 0, length: 1024, cache: "none" });
});

test("range: the query length and the repo length are each a cap of their own", async () => {
  assert.deepEqual(
    [LIMITS.query_chars, LIMITS.max_length, LIMITS.manifest_bytes, LIMITS.token_bytes, LIMITS.subrequest_ms, LIMITS.total_ms, LIMITS.max_subrequests],
    [512, 1_048_576, 65_536, 4_096, 10_000, 25_000, 9],
  );
  // 253 characters of repo, each slash sent as %2F, with padded numbers: a
  // query over 512 characters whose every value is valid.
  const repo253 = `${DEFAULT_REPO}${"/a".repeat(107)}`;
  assert.equal(repo253.length, 253);
  const long = `tag=${TAG}&repo=${encodeURIComponent(repo253)}&offset=0000000000000000&length=0000000000001024&cache=none`;
  assert.ok(long.length + 1 > LIMITS.query_chars, String(long.length));
  assert.deepEqual(parseQuery(new URL(`https://p.test/range?tag=${TAG}&repo=${repo253}`)).repo, repo253);
  assert.throws(
    () => parseQuery(new URL(`https://p.test/range?${long}`)),
    (e: unknown) => e instanceof ProbeError && /the query is over 512 characters/.test(e.message),
  );
  // 257 characters of repo in a short query: the repo cap alone refuses it.
  const repo257 = `${DEFAULT_REPO}${"/a".repeat(109)}`;
  const short = new URL(`https://p.test/range?tag=${TAG}&repo=${repo257}`);
  assert.ok(short.search.length <= LIMITS.query_chars);
  assert.throws(
    () => parseQuery(short),
    (e: unknown) => e instanceof ProbeError && /repo must be a package of this project/.test(e.message),
  );
});

test("range: a Content-Range naming another first or last byte is refused", async () => {
  for (const [name, range] of [
    ["first", `bytes 1-1023/${SIZE}`],
    ["last", `bytes 0-1024/${SIZE}`],
  ] as const) {
    await inWorld(worker, seed, async (w) => {
      w.intercept = (url) => (url.startsWith(BLOB_HOST) ? w.response(206, DATA.slice(0, 1024), { "content-range": range }, { url }) : undefined);
      const body = (await ask(w, `tag=${TAG}&length=1024`)).body;
      assert.equal(body.ok, false, name);
      assert.match(body.error ?? "", /Content-Range .* is not bytes 0-1023\/300000/, name);
    });
  }
});

test("range: a token answer over 4 KiB is refused, and a realm on a host that only ends in ghcr.io is not GHCR", async () => {
  await inWorld(worker, seed, async (w) => {
    const serve = w.intercept;
    w.intercept = (url, init) => {
      if (url.includes("/manifests/") && headersOf(init).authorization === DUMMY) return w.response(401, "", { "www-authenticate": 'Bearer realm="https://ghcr.io/token"' }, { url });
      if (url.startsWith("https://ghcr.io/token?")) return w.response(200, JSON.stringify({ token: "x".repeat(5_000) }), { "content-type": "application/json" }, { url });
      return serve?.(url, init);
    };
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.ok, false);
    assert.equal(body.failed_at, "token");
    assert.equal(body.error, "the token answer is over 4096 bytes");
  });
  await inWorld(worker, seed, async (w) => {
    w.intercept = (url) => (url.includes("/manifests/") ? w.response(401, "", { "www-authenticate": 'Bearer realm="https://evilghcr.io/token"' }, { url }) : undefined);
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.failed_at, "token");
    assert.match(body.error ?? "", /named no https realm on ghcr\.io/);
    assert.equal(w.requests.length, 1);
  });
});

test("range: a step that starts after the answer's 25 s is not sent, and a step's time cap is what is left of them", async () => {
  // A clock that moves 9 s at every reading: the deadline passes within the read.
  let t = 0;
  const slow: WorkerModule = {
    async fetch(request) {
      try {
        return await rangeRoute.handle(request, ENV, new URL(request.url), () => (t += 9_000));
      } catch (err) {
        if (err instanceof ProbeError) return new Response(JSON.stringify({ error: err.message }), { status: err.status });
        throw err;
      }
    },
  };
  await inWorld(slow, seed, async (w) => {
    const body = (await ask(w, `tag=${TAG}`)).body;
    assert.equal(body.ok, false);
    assert.match(body.error ?? "", /the answer's 25000 ms had passed before this step/);
    assert.ok(w.timeouts.length >= 1 && (w.timeouts[0] ?? Number.POSITIVE_INFINITY) < LIMITS.subrequest_ms, JSON.stringify(w.timeouts));
    assert.ok(body.subrequests < LIMITS.max_subrequests);
  });
});

test("range: a signed URL with no se is not kept, and cache modes need the Cache API", async () => {
  await inWorld(worker, seed, async (w) => {
    w.blobs.set(`probe@${LAYER}`, `${BLOB_HOST}/ghcrblobs10/blobs/${LAYER}?sig=synthetic`);
    const body = (await ask(w, `tag=${TAG}&cache=signed`)).body;
    assert.equal(body.ok, true);
    assert.equal(body.signed?.se, null);
    assert.deepEqual(
      body.cache.puts.find((p) => p.kind === "loc"),
      { kind: "loc", ttl_s: 0, ok: false, ms: 0, error: "a TTL under 1 s: not kept" },
    );
  });
  await inWorld(worker, seed, async (w) => {
    Object.defineProperty(globalThis, "caches", { value: undefined, configurable: true, writable: true });
    for (const cache of ["block", "signed"]) {
      const res = await w.get(`/range?tag=${TAG}&cache=${cache}`);
      assert.equal(res.status, 500, cache);
      assert.match(((await res.json()) as { error: string }).error, new RegExp(`cache=${cache} needs the Cache API`));
    }
    assert.equal(w.requests.length, 0);
    assert.equal((await ask(w, `tag=${TAG}&cache=none`)).body.ok, true);
  });
});

test("range: the route is GET /range of DOM-007, and its answer is JSON that no cache keeps", async () => {
  assert.deepEqual([rangeRoute.method, rangeRoute.path, rangeRoute.entry], ["GET", "/range", "DOM-007"]);
  await inWorld(worker, seed, async (w) => {
    const res = await w.get(`/range?tag=${TAG}`);
    assert.equal(res.headers.get("content-type"), "application/json; charset=utf-8");
    assert.equal(res.headers.get("cache-control"), "no-store");
    await res.text();
  });
});

test("range: the helpers read a challenge, a Content-Range and strip a URL's query", () => {
  assert.equal(bearerRealm('Bearer realm="https://ghcr.io/token",service="ghcr.io"'), "https://ghcr.io/token");
  assert.equal(bearerRealm('Basic realm="x"'), null);
  assert.equal(bearerRealm(null), null);
  assert.deepEqual(parseContentRange("bytes 26214400-26240000/1610612736"), { first: 26214400, last: 26240000, total: 1610612736 });
  assert.equal(parseContentRange("bytes */1610612736"), null);
  assert.equal(redact("GET https://h.test/b?se=1&sig=abc failed"), "GET https://h.test/b?REDACTED failed");
});
