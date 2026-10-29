// packages/ghcr/src/reader.ts against the mock registry of packages/testkit
// (world): GHCR's answers, its token endpoint and the blob host stand in, and
// no test reaches the network. Every test but the timeout uses the reader's
// production dial, the global fetch, which the world replaces; inWorld fails a
// test that leaves an answer body neither read nor cancelled. Each refusal is
// planted alone: the guard it names is the only one that can catch it, and the
// message the test reads is that guard's own. Repositories, tags, tokens,
// digests and bytes are synthetic.
import assert from "node:assert/strict";
import { test } from "node:test";
import { BLOB_HOST, inWorld, MANIFEST_TYPE, manifestJson, REGISTRY, T0, type World, type WorkerModule } from "@domains/testkit";
import { NAMESPACE } from "../src/layout.ts";
import {
  DUMMY,
  dialer,
  GhcrError,
  type GhcrErrorCode,
  ghcr,
  ghcrReader,
  MANIFEST_LIMIT_BYTES,
  MANIFEST_MAX_BYTES,
  memoryCache,
  nextTagPage,
  resetTokens,
  sha256Digest,
  TAG_PAGE,
} from "../src/reader.ts";

const UA = "domains.pkgforge.dev/test (synthetic)";
const REPO = "pkgforge-dev/domains.pkgforge.dev/ref";
const GHCR = "https://ghcr.io";
// The world serves nothing to a Worker here; the reader runs in the test itself.
const NOOP: WorkerModule = { fetch: () => new Response(null, { status: 204 }) };
const run = (setup: (w: World) => void | Promise<void>, fn: (w: World) => Promise<void>) => inWorld(NOOP, setup, fn, { resetIsolate: resetTokens });

const headersOf = (init: RequestInit): Record<string, string> => (init.headers ?? {}) as Record<string, string>;
const authOf = (init: RequestInit): string | null => headersOf(init).authorization ?? null;
const enc = (s: string) => new TextEncoder().encode(s);
const digestOf = async (s: string) => sha256Digest(enc(s));
const LAYER = `sha256:${"1".repeat(64)}`;
const BODY = manifestJson([["public_suffix_list.dat", LAYER, 338012]], { artifactType: "application/vnd.pkgforge.domains.ref.v1" });

async function refusal(p: Promise<unknown>, code: GhcrErrorCode, re: RegExp): Promise<GhcrError> {
  let caught: unknown = null;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  assert.ok(caught instanceof GhcrError, `expected GhcrError ${code}, got ${String(caught)}`);
  assert.equal(caught.code, code, caught.message);
  assert.match(caught.message, re);
  return caught;
}

// GHCR's challenge for a pull of REPO, as it sends it (MEASURED 2026-10-29T00:38:16Z, probe).
const CHALLENGE = { "www-authenticate": `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:${REPO}:pull"` };

// The registry refuses the dummy token, and the token endpoint answers `token`
// (or refuses with `tokenStatus`). The token's answer is `tokenBody`.
function privateFlow(w: World, opts: { tokenStatus?: number; tokenBody?: Record<string, unknown>; status?: 401 | 403; challenge?: Record<string, string> } = {}) {
  w.intercept = (url, init) => {
    if (url.startsWith(`${GHCR}/token`)) {
      if ((opts.tokenStatus ?? 200) !== 200) return w.response(opts.tokenStatus ?? 403, '{"errors":[{"code":"DENIED","message":"requested access to the resource is denied"}]}', {}, { url });
      return w.response(200, JSON.stringify(opts.tokenBody ?? { token: "tok1" }), { "content-type": "application/json" }, { url });
    }
    const a = authOf(init);
    if (url.startsWith(REGISTRY) && (a === DUMMY || a === null)) {
      // A bare request (no authorization) always gets the challenge.
      const status = a === null ? 401 : (opts.status ?? 401);
      const headers = a === null || status === 401 ? (opts.challenge ?? CHALLENGE) : {};
      return w.response(status, '{"errors":[{"code":"UNAUTHORIZED"}]}', headers, { url });
    }
    return undefined;
  };
}

test("reader: a public manifest reads with the dummy token alone, carries the User-Agent, and hashes to its own digest", async () => {
  await run(
    (w) => {
      w.manifest("ref:psl-0232f4df0831", [["public_suffix_list.dat", LAYER, 338012]], { artifactType: "application/vnd.pkgforge.domains.ref.v1" });
    },
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      const m = await g.getManifest(REPO, "psl-0232f4df0831");
      assert.equal(m.digest, await digestOf(BODY));
      assert.equal(m.json.artifactType, "application/vnd.pkgforge.domains.ref.v1");
      assert.equal(m.json.layers?.[0]?.annotations?.["org.opencontainers.image.title"], "public_suffix_list.dat");
      assert.equal(m.contentType, MANIFEST_TYPE);
      assert.equal(m.from, "registry");
      assert.equal(w.requests.length, 1);
      const init = w.requests[0]?.init ?? {};
      assert.equal(authOf(init), DUMMY);
      assert.equal(headersOf(init)["user-agent"], UA);
      assert.equal(init.redirect, "manual");
      assert.equal(g.dial.count, 1);
      assert.equal(g.dial.tokenRequests, 0);
      // The same manifest by its digest.
      w.manifests.set(`ref:${m.digest}`, BODY);
      assert.equal((await g.getManifest(REPO, m.digest)).digest, m.digest);
    },
  );
});

test("reader: the dummy token refused, the anonymous flow asks the realm for a pull token of the repository and asks again once", async () => {
  await run(
    (w) => {
      w.manifest("ref:psl-x", [["public_suffix_list.dat", LAYER]]);
      privateFlow(w);
    },
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      await g.getManifest(REPO, "psl-x");
      assert.equal(w.requests.length, 3);
      const [first, tok, again] = w.requests;
      assert.equal(authOf(first?.init ?? {}), DUMMY);
      const t = new URL(tok?.url ?? "");
      assert.equal(`${t.origin}${t.pathname}`, "https://ghcr.io/token");
      assert.equal(t.searchParams.get("service"), "ghcr.io");
      assert.equal(t.searchParams.get("scope"), `repository:${REPO}:pull`);
      assert.equal(authOf(tok?.init ?? {}), null);
      assert.equal(authOf(again?.init ?? {}), "Bearer tok1");
      assert.equal(g.dial.tokenRequests, 1);
      // The token is kept: the next read sends it first, once.
      await g.getManifest(REPO, "psl-x");
      assert.equal(w.requests.length, 4);
      assert.equal(authOf(w.requests[3]?.init ?? {}), "Bearer tok1");
    },
  );
});

test("reader: a token with no expires_in is kept 30 s (the default 60 less 30), and one with expires_in is kept at most 300 s", async () => {
  await run(
    (w) => {
      w.manifest("ref:a", [["x", LAYER]]);
      privateFlow(w);
    },
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      await g.getManifest(REPO, "a");
      w.advance(29);
      await g.getManifest(REPO, "a");
      assert.equal(authOf(w.requests.at(-1)?.init ?? {}), "Bearer tok1");
      w.advance(2);
      const before = w.requests.length;
      await g.getManifest(REPO, "a");
      // Expired: the dummy token first again, then a new token.
      assert.equal(authOf(w.since(before)[0]?.init ?? {}), DUMMY);
    },
  );
  await run(
    (w) => {
      w.manifest("ref:a", [["x", LAYER]]);
      privateFlow(w, { tokenBody: { token: "tok2", expires_in: 3600 } });
    },
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      await g.getManifest(REPO, "a");
      w.advance(299);
      await g.getManifest(REPO, "a");
      assert.equal(authOf(w.requests.at(-1)?.init ?? {}), "Bearer tok2");
      w.advance(2);
      const before = w.requests.length;
      await g.getManifest(REPO, "a");
      assert.equal(authOf(w.since(before)[0]?.init ?? {}), DUMMY);
    },
  );
});

test("reader: a 403 with no challenge sends one bare request for the challenge, then the token flow", async () => {
  await run(
    (w) => {
      w.manifest("ref:a", [["x", LAYER]]);
      privateFlow(w, { status: 403 });
    },
    async (w) => {
      await ghcrReader({ userAgent: UA }).getManifest(REPO, "a");
      assert.deepEqual(
        w.requests.map((r) => [new URL(r.url).pathname, authOf(r.init)]),
        [
          ["/v2/pkgforge-dev/domains.pkgforge.dev/ref/manifests/a", DUMMY],
          ["/v2/pkgforge-dev/domains.pkgforge.dev/ref/manifests/a", null],
          ["/token", null],
          ["/v2/pkgforge-dev/domains.pkgforge.dev/ref/manifests/a", "Bearer tok1"],
        ],
      );
    },
  );
});

test("reader: a token endpoint that denies the pull (a private or absent package) is refused, with no read after it", async () => {
  await run(
    (w) => privateFlow(w, { tokenStatus: 403 }),
    async (w) => {
      const e = await refusal(ghcrReader({ userAgent: UA }).getManifest(REPO, "a"), "refused", /token request answered 403/);
      assert.equal(e.status, 401);
      assert.equal(w.requests.length, 2);
    },
  );
});

test("reader: a token answer that holds no token is refused", async () => {
  await run(
    (w) => privateFlow(w, { tokenBody: { nothing: true } }),
    async () => {
      await refusal(ghcrReader({ userAgent: UA }).getManifest(REPO, "a"), "refused", /holds no token/);
    },
  );
});

test("reader: a realm that is not exactly https://ghcr.io/token is refused, and no request goes to it", async () => {
  // Each is one way a looser match than the origin and the path would pass:
  // another scheme, a host that ends in or starts with ghcr.io, a userinfo
  // that reads as the host, another port, another path.
  const realms = [
    "http://ghcr.io/token",
    "https://ghcr.io.evil.example/token",
    "https://evil.example/token",
    "https://evilghcr.io/token",
    "https://ghcr.io@evil.example/token",
    "https://ghcr.io:8443/token",
    "https://ghcr.io/v2/token",
    "https://ghcr.io/",
  ];
  for (const realm of realms) {
    await run(
      (w) => privateFlow(w, { challenge: { "www-authenticate": `Bearer realm="${realm}",service="ghcr.io"` } }),
      async (w) => {
        await refusal(ghcrReader({ userAgent: UA }).getManifest(REPO, "a"), "refused", /realm that is not https:\/\/ghcr\.io\/token/);
        assert.equal(w.requests.length, 1, realm);
        assert.ok(!w.requests.some((r) => r.url.includes("evil")));
      },
    ).catch((e: Error) => {
      throw new Error(`${realm}: ${e.message}`);
    });
  }
  // The default port written out is the same endpoint: the token flow runs.
  await run(
    (w) => {
      w.manifest("ref:a", [["x", LAYER]]);
      privateFlow(w, { challenge: { "www-authenticate": 'Bearer realm="https://ghcr.io:443/token",service="ghcr.io"' } });
    },
    async (w) => {
      await ghcrReader({ userAgent: UA }).getManifest(REPO, "a");
      assert.equal(new URL(w.requests[1]?.url ?? "").pathname, "/token");
    },
  );
});

test("reader: a 129-character reference and an upper-case tag are refused before any request, and 128 characters are asked", async () => {
  await run(
    () => undefined,
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      await refusal(g.getManifest(REPO, "a".repeat(129)), "usage", /129 characters; a tag is at most 128/);
      await refusal(g.headManifest(REPO, "a".repeat(129)), "usage", /129 characters/);
      await refusal(g.getManifest(REPO, "Latest"), "usage", /upper case/);
      await refusal(g.getManifest(REPO, "-x"), "usage", /not a tag/);
      await refusal(g.getManifest("Pkgforge-dev/x", "a"), "usage", /not a repository path/);
      await refusal(g.getManifest("pkgforge-dev", "a"), "usage", /not a repository path/);
      assert.equal(w.requests.length, 0);
      // 128 characters is a tag: it is asked, and the stand-in holds none.
      await refusal(g.getManifest(REPO, "a".repeat(128)), "missing", /no manifest/);
      assert.equal(w.requests.length, 1);
    },
  );
});

test("reader: a manifest over 64 KiB, one that hashes to another digest, one GHCR names by another digest, and one that is not a manifest are refused", async () => {
  const big = JSON.stringify({ schemaVersion: 2, pad: "x".repeat(MANIFEST_MAX_BYTES) });
  const wrong = `sha256:${"9".repeat(64)}`;
  await run(
    (w) => {
      w.manifests.set("ref:big", big);
      w.manifests.set(`ref:${wrong}`, BODY);
      w.manifests.set("ref:v1", '{"schemaVersion":1}');
      w.manifests.set("ref:notjson", "not json");
      w.manifests.set("ref:badlayer", JSON.stringify({ schemaVersion: 2, layers: [{ mediaType: "x", digest: "sha256:1", size: 1 }] }));
    },
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      await refusal(g.getManifest(REPO, "big"), "too-large", /over 65536 bytes/);
      await refusal(g.getManifest(REPO, wrong), "integrity", /hashes to sha256:/);
      await refusal(g.getManifest(REPO, "v1"), "upstream", /schemaVersion 2/);
      await refusal(g.getManifest(REPO, "notjson"), "upstream", /not UTF-8 JSON/);
      await refusal(g.getManifest(REPO, "badlayer"), "upstream", /layers\[0\] is not a descriptor/);
      w.intercept = (url) => (url.endsWith("/manifests/named") ? w.response(200, BODY, { "docker-content-digest": wrong }, { url }) : undefined);
      await refusal(g.getManifest(REPO, "named"), "integrity", /GHCR named sha256:9{64}/);
    },
  );
});

test("reader: 404 is missing, 429 is rate-limited, 500 is upstream, each with its status", async () => {
  await run(
    (w) => {
      w.intercept = (url) => {
        if (url.endsWith("/manifests/busy")) return w.response(429, '{"errors":[{"code":"TOOMANYREQUESTS"}]}', {}, { url });
        if (url.endsWith("/manifests/down")) return w.response(500, "down", {}, { url });
        return undefined;
      };
    },
    async () => {
      const g = ghcrReader({ userAgent: UA });
      assert.equal((await refusal(g.getManifest(REPO, "absent"), "missing", /holds no manifest absent/)).status, 404);
      assert.equal((await refusal(g.getManifest(REPO, "busy"), "rate-limited", /429/)).status, 429);
      assert.equal((await refusal(g.getManifest(REPO, "down"), "upstream", /answered 500/)).status, 500);
    },
  );
});

test("reader: headManifest reads the digest and size from GHCR's headers, and refuses a HEAD with no digest or another digest", async () => {
  const d = await digestOf(BODY);
  await run(
    (w) => {
      w.intercept = (url, init) => {
        if (init.method !== "HEAD") return undefined;
        if (url.endsWith("/manifests/psl-a") || url.endsWith(`/manifests/${d}`))
          return w.response(200, "", { "docker-content-digest": d, "content-length": "876", "content-type": MANIFEST_TYPE }, { url });
        if (url.endsWith("/manifests/nodigest")) return w.response(200, "", { "content-length": "876" }, { url });
        if (url.endsWith(`/manifests/sha256:${"2".repeat(64)}`)) return w.response(200, "", { "docker-content-digest": d, "content-length": "876" }, { url });
        return w.response(404, "", {}, { url });
      };
    },
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      assert.deepEqual(await g.headManifest(REPO, "psl-a"), { repo: REPO, ref: "psl-a", digest: d, size: 876, contentType: MANIFEST_TYPE });
      assert.equal((await g.headManifest(REPO, d)).digest, d);
      assert.equal(w.requests[0]?.init.method, "HEAD");
      await refusal(g.headManifest(REPO, "nodigest"), "upstream", /no sha256 docker-content-digest/);
      await refusal(g.headManifest(REPO, `sha256:${"2".repeat(64)}`), "integrity", /with the digest/);
      await refusal(g.headManifest(REPO, "gone"), "missing", /holds no manifest gone/);
    },
  );
});

// A tag list of `count` synthetic tags, paged as GHCR pages it: `n` a page and a
// relative Link to `?last=<tag>&n=<n>` (MEASURED 2026-10-29T00:38:16Z, probe).
function tagRegistry(w: World, count: number, mutate: (link: string, last: string) => string = (l) => l) {
  const all = Array.from({ length: count }, (_, i) => `t-${String(i).padStart(5, "0")}`);
  w.intercept = (url) => {
    const u = new URL(url);
    if (u.pathname !== `/v2/${REPO}/tags/list`) return undefined;
    const n = Number(u.searchParams.get("n") ?? "100");
    const last = u.searchParams.get("last");
    const from = last === null ? 0 : all.indexOf(last) + 1;
    const page = all.slice(from, from + n);
    const headers: Record<string, string> = { "content-type": "application/json" };
    const end = page.at(-1);
    if (from + n < all.length && end !== undefined) headers.link = mutate(`</v2/${REPO}/tags/list?last=${end}&n=${n}>; rel="next"`, end);
    return w.response(200, JSON.stringify({ name: REPO, tags: page }), headers, { url });
  };
  return all;
}

test("reader: listTags follows Link across every page of a mock registry of 2,500 tags and counts them all", async () => {
  await run(
    () => undefined,
    async (w) => {
      const all = tagRegistry(w, 2500);
      const list = await ghcrReader({ userAgent: UA }).listTags(REPO);
      assert.equal(list.tags.length, 2500);
      assert.equal(new Set(list.tags).size, 2500);
      assert.deepEqual(list.tags, all);
      assert.equal(list.pages, 3);
      assert.equal(list.truncated, false);
      assert.equal(w.requests.length, 3);
      assert.equal(new URL(w.requests[0]?.url ?? "").searchParams.get("n"), String(TAG_PAGE));
    },
  );
});

test("reader: listTags cut at maxPages says truncated", async () => {
  await run(
    () => undefined,
    async (w) => {
      tagRegistry(w, 2500);
      const list = await ghcrReader({ userAgent: UA }).listTags(REPO, { maxPages: 2 });
      assert.equal(list.tags.length, 2000);
      assert.equal(list.truncated, true);
    },
  );
});

test("reader: a next Link outside the repository's tag list, or one naming a page already read, is an error, not the end of the list", async () => {
  await run(
    () => undefined,
    async (w) => {
      tagRegistry(w, 2500, (_l, last) => `<https://evil.example/v2/${REPO}/tags/list?last=${last}&n=1000>; rel="next"`);
      await refusal(ghcrReader({ userAgent: UA }).listTags(REPO), "upstream", /next page outside it \(https:\/\/evil\.example/);
    },
  );
  // On ghcr.io itself, the list of another repository: only the path check stops it.
  for (const other of ["other/repo", "pkgforge-dev/domains.pkgforge.dev/obs"]) {
    await run(
      () => undefined,
      async (w) => {
        tagRegistry(w, 2500, (_l, last) => `</v2/${other}/tags/list?last=${last}&n=1000>; rel="next"`);
        await refusal(ghcrReader({ userAgent: UA }).listTags(REPO), "upstream", new RegExp(`next page outside it \\(https://ghcr\\.io/v2/${other.replaceAll(".", "\\.")}/tags/list\\)`));
        assert.equal(w.requests.length, 1, other);
      },
    );
  }
  await run(
    () => undefined,
    async (w) => {
      tagRegistry(w, 2500, () => `</v2/${REPO}/tags/list?n=1000>; rel="next"`);
      await refusal(ghcrReader({ userAgent: UA }).listTags(REPO), "upstream", /a page it already gave/);
    },
  );
  assert.equal(nextTagPage(null, REPO), null);
  assert.equal(nextTagPage('<x>; rel="prev"', REPO), null);
});

test("reader: a package whose tag list is null or absent lists no tag, and a page that is not a list is refused", async () => {
  await run(
    (w) => {
      w.intercept = (url) => {
        if (url.includes("/ref/tags/list")) return w.response(200, JSON.stringify({ name: REPO, tags: null }), {}, { url });
        if (url.includes("/obs/tags/list")) return w.response(200, JSON.stringify({ name: "x" }), {}, { url });
        if (url.includes("/feed/tags/list")) return w.response(200, JSON.stringify({ tags: [1, 2] }), {}, { url });
        return undefined;
      };
    },
    async () => {
      const g = ghcrReader({ userAgent: UA });
      assert.deepEqual((await g.listTags(REPO)).tags, []);
      assert.deepEqual((await g.listTags("pkgforge-dev/domains.pkgforge.dev/obs")).tags, []);
      await refusal(g.listTags("pkgforge-dev/domains.pkgforge.dev/feed"), "upstream", /no list of tags/);
    },
  );
});

const BLOB = `sha256:${"b".repeat(64)}`;
const blobBytes = (start: number, end: number) => Uint8Array.from({ length: end - start }, (_, i) => (start + i) % 251);

// The blob host: answers a Range of the 65,536-byte synthetic blob with 206, as
// pkg-containers.githubusercontent.com does (MEASURED 2026-10-29T00:38:32Z).
function blobHost(w: World, host = BLOB_HOST, answer?: (start: number, end: number, url: string) => Response | undefined) {
  w.intercept = (url, init) => {
    if (!url.startsWith(host)) return undefined;
    assert.equal(authOf(init), null, "no Authorization goes to the signed URL");
    const m = /^bytes=(\d+)-(\d+)$/.exec(headersOf(init).range ?? "");
    assert.ok(m, "the signed URL is asked with a Range");
    const start = Number(m[1]);
    const end = Number(m[2]) + 1;
    const custom = answer?.(start, end, url);
    if (custom) return custom;
    return w.response(206, blobBytes(start, end), { "content-range": `bytes ${start}-${end - 1}/65536`, "content-length": String(end - start), "accept-ranges": "bytes" }, { url });
  };
}

test("reader: a Range read goes through the 307 to the signed URL, sends no Authorization there, and returns exactly the bytes asked for", async () => {
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, true);
      blobHost(w);
    },
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      const r = await g.readRange(REPO, BLOB, 100, 200);
      assert.deepEqual(r.bytes, blobBytes(100, 200));
      assert.equal(r.size, 65536);
      assert.equal(r.host, "pkg-containers.githubusercontent.com");
      assert.equal(r.unexpected, false);
      assert.equal(r.se, T0 + 400_000);
      assert.equal(r.signed, "registry");
      assert.equal(w.requests.length, 2);
      assert.equal(authOf(w.requests[0]?.init ?? {}), DUMMY);
      assert.equal(headersOf(w.requests[0]?.init ?? {}).range, "bytes=100-199");
      assert.equal(headersOf(w.requests[1]?.init ?? {})["user-agent"], UA);
    },
  );
});

test("reader: a cache keeps the signed URL until its se less 60 s, and a kept URL the host refuses is asked for again once", async () => {
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, true);
      blobHost(w);
    },
    async (w) => {
      const cache = memoryCache();
      const g = ghcrReader({ userAgent: UA, cache });
      await g.readRange(REPO, BLOB, 0, 10);
      const r = await g.readRange(REPO, BLOB, 10, 20);
      assert.equal(r.signed, "cache");
      assert.equal(w.requests.filter((q) => q.url.startsWith(REGISTRY)).length, 1);
      // se is 400 s ahead: past 340 s the URL is not used.
      w.advance(341);
      assert.equal((await g.readRange(REPO, BLOB, 0, 10)).signed, "registry");
      assert.equal(w.requests.filter((q) => q.url.startsWith(REGISTRY)).length, 2);
      // The host refuses the kept URL (as an expired signature): one new 307, one read.
      blobHost(w, BLOB_HOST, (_s, _e, url) => (url.includes("refused") ? w.response(403, "AuthenticationFailed", {}, { url }) : undefined));
      for (const [k, v] of cache.entries) cache.entries.set(k, { ...v, value: v.value.replace("sig=", "refused=1&sig=") });
      const again = await g.readRange(REPO, BLOB, 0, 10);
      assert.equal(again.signed, "registry");
      assert.deepEqual(again.bytes, blobBytes(0, 10));
    },
  );
});

test("reader: a redirect to a host outside *.githubusercontent.com is refused, and nothing is asked of it", async () => {
  const se = encodeURIComponent(new Date(T0 + 300_000).toISOString());
  // The second one holds the suffix without its leading dot, as a substring match would take it.
  for (const host of ["blobs.example.net", "githubusercontent.com.attacker.net", "evilgithubusercontent.com"]) {
    await run(
      (w) => {
        w.blobs.set(`ref@${BLOB}`, `https://${host}/x/${BLOB}?se=${se}&sig=s`);
        blobHost(w, `https://${host}`);
      },
      async (w) => {
        await refusal(ghcrReader({ userAgent: UA }).readRange(REPO, BLOB, 0, 16), "redirect", /which is not on \*\.githubusercontent\.com nor a host this reader allows/);
        assert.equal(w.requests.length, 1, host);
      },
    ).catch((e: Error) => {
      throw new Error(`${host}: ${e.message}`);
    });
  }
});

test("reader: a redirect to a host the caller allows is read and reported as unexpected", async () => {
  const se = new Date(T0 + 300_000).toISOString();
  for (const host of ["blobs.example.net", "githubusercontent.com.attacker.net"]) {
    await run(
      (w) => {
        w.blobs.set(`ref@${BLOB}`, `https://${host}/x/${BLOB}?se=${encodeURIComponent(se)}&sig=s`);
        blobHost(w, `https://${host}`);
      },
      async () => {
        const r = await ghcrReader({ userAgent: UA, allowBlobHosts: [host] }).readRange(REPO, BLOB, 0, 16);
        assert.equal(r.unexpected, true, host);
        assert.equal(r.host, host);
        assert.equal(r.se, T0 + 300_000);
        assert.deepEqual(r.bytes, blobBytes(0, 16));
      },
    );
  }
});

test("reader: a kept signed URL that is not https, or not on a host a 307 may name, is not asked: the registry gives a new one", async () => {
  const key = `ghcr:u:${REPO}@${BLOB}`;
  const se = T0 + 400_000;
  for (const url of [`http://pkg-containers.githubusercontent.com/x/${BLOB}?sig=s`, `https://evil.example/x/${BLOB}?sig=s`]) {
    await run(
      (w) => {
        w.blobs.set(`ref@${BLOB}`, true);
        blobHost(w);
      },
      async (w) => {
        const cache = memoryCache();
        await cache.put(key, JSON.stringify({ url, se }), 3600);
        const r = await ghcrReader({ userAgent: UA, cache }).readRange(REPO, BLOB, 0, 16);
        assert.equal(r.signed, "registry", url);
        assert.equal(r.host, "pkg-containers.githubusercontent.com");
        assert.ok(!w.requests.some((q) => q.url === url || q.url.startsWith("http://") || q.url.includes("evil")), url);
      },
    );
  }
});

test("reader: a signed URL whose se is far ahead is kept at most 15 minutes less the margin", async () => {
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, true);
      // se a day after the 307.
      w.seAfter = 86_400;
      blobHost(w);
    },
    async (w) => {
      const cache = memoryCache();
      const g = ghcrReader({ userAgent: UA, cache });
      assert.equal((await g.readRange(REPO, BLOB, 0, 10)).se, T0 + 86_400_000);
      assert.equal(cache.entries.get(`ghcr:u:${REPO}@${BLOB}`)?.until, T0 + 840_000);
      w.advance(839);
      assert.equal((await g.readRange(REPO, BLOB, 0, 10)).signed, "cache");
      w.advance(2);
      assert.equal((await g.readRange(REPO, BLOB, 0, 10)).signed, "registry");
    },
  );
});

test("reader: a kept signed URL whose se is less than the margin ahead is not used", async () => {
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, true);
      blobHost(w);
    },
    async (w) => {
      const cache = memoryCache();
      // The cache would keep it an hour; its se is 30 s ahead.
      await cache.put(`ghcr:u:${REPO}@${BLOB}`, JSON.stringify({ url: w.signedUrl(BLOB), se: T0 + 30_000 }), 3600);
      const r = await ghcrReader({ userAgent: UA, cache }).readRange(REPO, BLOB, 0, 10);
      assert.equal(r.signed, "registry");
      assert.equal(w.requests.filter((q) => q.url.startsWith(REGISTRY)).length, 1);
    },
  );
});

test("reader: a kept signed URL the host answers 404 is asked for again exactly once", async () => {
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, true);
      blobHost(w, BLOB_HOST, (_s, _e, url) => (url.includes("gone=1") ? w.response(404, "BlobNotFound", {}, { url }) : undefined));
    },
    async (w) => {
      const cache = memoryCache();
      const signed = w.signedUrl(BLOB).replace("sig=", "gone=1&sig=");
      await cache.put(`ghcr:u:${REPO}@${BLOB}`, JSON.stringify({ url: signed, se: T0 + 400_000 }), 300);
      const r = await ghcrReader({ userAgent: UA, cache }).readRange(REPO, BLOB, 0, 10);
      assert.equal(r.signed, "registry");
      assert.deepEqual(r.bytes, blobBytes(0, 10));
      assert.deepEqual(
        w.requests.map((q) => (q.url.startsWith(REGISTRY) ? "registry" : q.url.includes("gone=1") ? "kept" : "fresh")),
        ["kept", "registry", "fresh"],
      );
    },
  );
});

test("reader: a redirect that is not https is refused, and nothing is asked of it", async () => {
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, `http://pkg-containers.githubusercontent.com/x/${BLOB}?sig=s`);
    },
    async (w) => {
      await refusal(ghcrReader({ userAgent: UA }).readRange(REPO, BLOB, 0, 16), "redirect", /not https/);
      assert.equal(w.requests.length, 1);
    },
  );
});

test("reader: a range answer that is not exactly the range asked for is refused", async () => {
  const cases: [string, (s: number, e: number, url: string, w: World) => Response, GhcrErrorCode, RegExp][] = [
    ["another start", (s, e, url, w) => w.response(206, blobBytes(s, e), { "content-range": `bytes ${s + 1}-${e}/65536` }, { url }), "integrity", /Content-Range is "bytes 1-16\/65536"/],
    ["a short body", (s, e, url, w) => w.response(206, blobBytes(s, e - 1), { "content-range": `bytes ${s}-${e - 1}/65536` }, { url }), "integrity", /the body is 15 bytes, not 16/],
    ["a long body", (s, e, url, w) => w.response(206, blobBytes(s, e + 1), { "content-range": `bytes ${s}-${e - 1}/65536` }, { url }), "integrity", /longer than the 16 bytes/],
    ["no Content-Range", (s, e, url, w) => w.response(206, blobBytes(s, e), {}, { url }), "integrity", /Content-Range is null/],
    ["a 200 that ignored the range", (_s, _e, url, w) => w.response(200, blobBytes(0, 65536), { "content-length": "65536" }, { url }), "upstream", /ignored the range/],
    ["a 416", (_s, _e, url, w) => w.response(416, "", { "content-range": "bytes */65536" }, { url }), "range", /past the end/],
    ["a 500", (_s, _e, url, w) => w.response(500, "", {}, { url }), "upstream", /^pkg-containers\.githubusercontent\.com answered 500 for bytes 0 to 15/],
  ];
  for (const [what, answer, code, re] of cases) {
    await run(
      (w) => {
        w.blobs.set(`ref@${BLOB}`, true);
        blobHost(w, BLOB_HOST, (s, e, url) => answer(s, e, url, w));
      },
      async () => {
        await refusal(ghcrReader({ userAgent: UA }).readRange(REPO, BLOB, 0, 16), code, re);
      },
    ).catch((e: Error) => {
      throw new Error(`${what}: ${e.message}`);
    });
  }
});

test("reader: a whole blob from byte 0 may come as a 200 of exactly that length", async () => {
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, true);
      blobHost(w, BLOB_HOST, (s, e, url) => w.response(200, blobBytes(s, e), { "content-length": String(e - s) }, { url }));
    },
    async () => {
      const r = await ghcrReader({ userAgent: UA }).readRange(REPO, BLOB, 0, 64);
      assert.deepEqual(r.bytes, blobBytes(0, 64));
      assert.equal(r.size, 64);
    },
  );
});

test("reader: a range that is empty, negative, not whole or over the cap is refused before any request", async () => {
  await run(
    () => undefined,
    async (w) => {
      const g = ghcrReader({ userAgent: UA, maxRangeBytes: 1024 });
      await refusal(g.readRange(REPO, BLOB, 10, 10), "usage", /0 <= start < end/);
      await refusal(g.readRange(REPO, BLOB, -1, 10), "usage", /0 <= start < end/);
      await refusal(g.readRange(REPO, BLOB, 0.5, 10), "usage", /whole numbers/);
      await refusal(g.readRange(REPO, BLOB, 0, 1025), "usage", /at most 1024/);
      await refusal(g.readRange(REPO, "sha256:abc", 0, 10), "usage", /not a sha256: digest/);
      assert.equal(w.requests.length, 0);
    },
  );
});

test("reader: a manifest by digest is kept by the cache, its bytes checked again when read back, and a cache that fails is a miss", async () => {
  const d = await digestOf(BODY);
  await run(
    (w) => {
      w.manifests.set(`ref:${d}`, BODY);
    },
    async (w) => {
      const cache = memoryCache();
      const g = ghcrReader({ userAgent: UA, cache });
      await g.getManifest(REPO, d);
      const hit = await g.getManifest(REPO, d);
      assert.equal(hit.from, "cache");
      assert.equal(w.requests.length, 1);
      // A poisoned entry (other bytes under the digest's key) is not served.
      for (const [k, v] of cache.entries) cache.entries.set(k, { ...v, value: JSON.stringify({ v: 1, contentType: MANIFEST_TYPE, text: BODY.replace("338012", "100") }) });
      assert.equal((await g.getManifest(REPO, d)).from, "registry");
      assert.equal(g.cacheErrors, 1);
      const broken = ghcrReader({
        userAgent: UA,
        cache: {
          get: () => Promise.reject(new Error("cache down")),
          put: () => Promise.reject(new Error("cache down")),
        },
      });
      assert.equal((await broken.getManifest(REPO, d)).digest, d);
      assert.equal(broken.cacheErrors, 2);
    },
  );
});

test("reader: a request with no answer inside the time is a timeout", async () => {
  const hang = (_url: string, init: RequestInit): Promise<Response> =>
    new Promise((_, fail) => {
      init.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" })));
    });
  const g = ghcrReader({ userAgent: UA, fetcher: hang, timeoutMs: 30 });
  await refusal(g.getManifest(REPO, "a"), "timeout", /did not answer within 0\.03 s/);
  const down = ghcrReader({ userAgent: UA, fetcher: () => Promise.reject(new TypeError("fetch failed")) });
  await refusal(down.getManifest(REPO, "a"), "unreachable", /could not be reached: fetch failed/);
});

test("reader: a reader without the contact User-Agent is refused", () => {
  assert.throws(
    () => ghcrReader({ userAgent: "" }),
    (e: unknown) => e instanceof GhcrError && e.code === "usage" && /ruling 11/.test(e.message),
  );
});

test("reader: a repository outside the namespace is refused before any request, by every read, and the probe package is inside it", async () => {
  await run(
    () => undefined,
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      // The second shares the namespace's text but not its last component.
      for (const repo of ["someone/else/pkg", `${NAMESPACE}-evil/x`, "pkgforge-dev/other"]) {
        await refusal(g.readRange(repo, BLOB, 0, 16), "usage", /is outside the namespace pkgforge-dev\/domains\.pkgforge\.dev/);
        await refusal(g.getManifest(repo, "latest"), "usage", /is outside the namespace/);
        await refusal(g.headManifest(repo, "latest"), "usage", /is outside the namespace/);
        await refusal(g.listTags(repo), "usage", /is outside the namespace/);
      }
      assert.equal(w.requests.length, 0);
      // The measurement package `probe` is a package of the namespace: it is asked.
      await refusal(g.getManifest(`${NAMESPACE}/probe`, "layers-1000"), "missing", /no manifest layers-1000/);
      assert.equal(w.requests.length, 1);
    },
  );
});

test("reader: the namespace option sets the repositories a reader reads, and a namespace or an allowed host that is not one is refused", async () => {
  await run(
    (w) => {
      w.intercept = (url) => (url === `${GHCR}/v2/someone/else/pkg/manifests/a` ? w.response(200, BODY, { "content-type": MANIFEST_TYPE }, { url }) : undefined);
    },
    async (w) => {
      const g = ghcrReader({ userAgent: UA, namespace: "someone/else" });
      assert.equal((await g.getManifest("someone/else/pkg", "a")).digest, await digestOf(BODY));
      await refusal(g.getManifest(REPO, "a"), "usage", /is outside the namespace someone\/else/);
      assert.equal(w.requests.length, 1);
    },
  );
  for (const namespace of ["", "Pkgforge-dev", "pkgforge-dev/", "a//b"]) {
    assert.throws(
      () => ghcrReader({ userAgent: UA, namespace }),
      (e: unknown) => e instanceof GhcrError && e.code === "usage" && /is not lowercase path components/.test(e.message),
      JSON.stringify(namespace),
    );
  }
  for (const host of ["", "Blobs.example.net", "blobs.example.net:8443", "*.example.net"]) {
    assert.throws(
      () => ghcrReader({ userAgent: UA, allowBlobHosts: [host] }),
      (e: unknown) => e instanceof GhcrError && e.code === "usage" && /allowBlobHosts is not a list of lowercase host names/.test(e.message),
      JSON.stringify(host),
    );
  }
});

test("reader: ghcr() refuses a URL that is not on https://ghcr.io before any request, so no GHCR token goes elsewhere", async () => {
  await run(
    () => undefined,
    async (w) => {
      const d = dialer({ userAgent: UA });
      for (const url of [
        `https://evil.example/v2/${REPO}/manifests/a`,
        `https://ghcr.io.evil.example/v2/${REPO}/manifests/a`,
        `https://ghcr.io:8443/v2/${REPO}/manifests/a`,
        `http://ghcr.io/v2/${REPO}/manifests/a`,
        "not a url",
      ]) {
        await refusal(ghcr(d, REPO, url), "usage", /is not a URL on https:\/\/ghcr\.io; a GHCR token goes nowhere else/);
      }
      assert.equal(w.requests.length, 0);
      assert.equal(d.count, 0);
    },
  );
});

test("reader: a 403 to the pull token after the anonymous flow is refused, with its status", async () => {
  await run(
    (w) => {
      w.manifest("ref:a", [["x", LAYER]]);
      privateFlow(w);
      const flow = w.intercept;
      w.intercept = (url, init) => (authOf(init) === "Bearer tok1" ? w.response(403, '{"errors":[{"code":"DENIED"}]}', {}, { url }) : flow?.(url, init));
    },
    async (w) => {
      const e = await refusal(ghcrReader({ userAgent: UA }).getManifest(REPO, "a"), "refused", /GHCR refused an anonymous read of manifest a of .+ \(403\)/);
      assert.equal(e.status, 403);
      assert.equal(w.requests.length, 3);
    },
  );
});

test("reader: a kept manifest over the caller's maxBytes is not served from the cache", async () => {
  const big = JSON.stringify({ schemaVersion: 2, pad: "x".repeat(70_000) });
  assert.ok(enc(big).byteLength > MANIFEST_MAX_BYTES);
  await run(
    (w) => {
      w.manifests.set("ref:big", big);
    },
    async (w) => {
      const cache = memoryCache();
      await cache.put(`ghcr:m:${REPO}@big`, JSON.stringify({ v: 1, contentType: MANIFEST_TYPE, text: big }), 3600);
      await refusal(ghcrReader({ userAgent: UA, cache }).getManifest(REPO, "big"), "too-large", /over 65536 bytes/);
      assert.equal(w.requests.length, 1);
    },
  );
});

test("reader: a kept manifest entry of another version is a miss", async () => {
  const d = await digestOf(BODY);
  await run(
    (w) => {
      w.manifests.set(`ref:${d}`, BODY);
    },
    async (w) => {
      const cache = memoryCache();
      await cache.put(`ghcr:m:${REPO}@${d}`, JSON.stringify({ v: 2, contentType: MANIFEST_TYPE, text: BODY }), 3600);
      assert.equal((await ghcrReader({ userAgent: UA, cache }).getManifest(REPO, d)).from, "registry");
      assert.equal(w.requests.length, 1);
    },
  );
});

test("reader: maxBytes over GHCR's own limit, and a repository over 255 characters, are refused before any request", async () => {
  await run(
    () => undefined,
    async (w) => {
      const g = ghcrReader({ userAgent: UA });
      await refusal(g.getManifest(REPO, "a", { maxBytes: MANIFEST_LIMIT_BYTES + 1 }), "usage", /maxBytes 4194305 is not a whole number from 1 to 4194304/);
      const long = (n: number) => `${NAMESPACE}/${"a".repeat(n - NAMESPACE.length - 1)}`;
      assert.equal(long(256).length, 256);
      await refusal(g.getManifest(long(256), "a"), "usage", /at most 255 characters/);
      assert.equal(w.requests.length, 0);
      // The limits themselves are asked.
      await refusal(g.getManifest(REPO, "a", { maxBytes: MANIFEST_LIMIT_BYTES }), "missing", /no manifest a/);
      await refusal(g.getManifest(long(255), "a"), "missing", /no manifest a/);
      assert.equal(w.requests.length, 2);
    },
  );
});

test("reader: a descriptor whose size is not a whole number of at least 0 is refused", async () => {
  await run(
    (w) => {
      for (const [ref, size] of [
        ["neg", -1],
        ["frac", 1.5],
        ["text", "10"],
      ] as const)
        w.manifests.set(`ref:${ref}`, JSON.stringify({ schemaVersion: 2, layers: [{ mediaType: "x", digest: LAYER, size }] }));
    },
    async () => {
      const g = ghcrReader({ userAgent: UA });
      for (const ref of ["neg", "frac", "text"]) await refusal(g.getManifest(REPO, ref), "upstream", /layers\[0\] is not a descriptor/);
    },
  );
});

test("reader: a HEAD whose length is absent, 0 or over GHCR's limit is refused", async () => {
  const d = await digestOf(BODY);
  const lengths: Record<string, string | null> = { none: null, zero: "0", huge: String(MANIFEST_LIMIT_BYTES + 1) };
  await run(
    (w) => {
      w.intercept = (url, init) => {
        const ref = url.split("/manifests/")[1] ?? "";
        if (init.method !== "HEAD" || !(ref in lengths)) return undefined;
        const length = lengths[ref];
        return w.response(200, "", { "docker-content-digest": d, ...(length === null || length === undefined ? {} : { "content-length": length }) }, { url });
      };
    },
    async () => {
      const g = ghcrReader({ userAgent: UA });
      for (const ref of Object.keys(lengths)) await refusal(g.headManifest(REPO, ref), "upstream", /with the length/);
    },
  );
});

test("reader: a 200 to a Range that does not start at 0, and a 206 whose Content-Range ends elsewhere, are refused", async () => {
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, true);
      // The length is the range's, so only the start tells the host ignored it.
      blobHost(w, BLOB_HOST, (s, e, url) => w.response(200, blobBytes(0, e - s), { "content-length": String(e - s) }, { url }));
    },
    async () => {
      await refusal(ghcrReader({ userAgent: UA }).readRange(REPO, BLOB, 100, 200), "upstream", /answered 200 to a Range of bytes 100 to 199, so it ignored the range/);
    },
  );
  await run(
    (w) => {
      w.blobs.set(`ref@${BLOB}`, true);
      // The start and the body length are right; the end is one short.
      blobHost(w, BLOB_HOST, (s, e, url) => w.response(206, blobBytes(s, e), { "content-range": `bytes ${s}-${e - 2}/65536` }, { url }));
    },
    async () => {
      await refusal(ghcrReader({ userAgent: UA }).readRange(REPO, BLOB, 100, 200), "integrity", /Content-Range is "bytes 100-198\/65536", not bytes 100-199/);
    },
  );
});
