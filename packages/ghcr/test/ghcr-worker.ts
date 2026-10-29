// packages/ghcr/test/ghcr-worker.ts — the Worker the ghcr workerd test runs. It
// proves the reader runs in workerd under the pinned compatibility date and
// flags (no nodejs_compat) with its production dial: the global fetch, called
// through the wrapper, never bare (the sibling project's "Illegal invocation"
// of 2026-10-22), `redirect: "manual"` handing back the blob's 307, the
// AbortController time limit, and crypto.subtle for the digest.
//
//   GET /manifest?repo=R&ref=T            the manifest's digest, artifactType and the requests it took
//   GET /tags?repo=R                      every tag, by Link
//   GET /range?repo=R&digest=D&start=S&end=E   bytes [S, E) through the signed URL, as hex
// A GhcrError answers 502 with its code; any other path answers 404.
import { GhcrError, ghcrReader } from "../src/index.ts";
// Not exported by the index: only a test resets the isolate's tokens.
import { resetTokens } from "../src/reader.ts";

const UA = "domains.pkgforge.dev/test (synthetic, workerd)";
const json = (value: unknown, status = 200): Response => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const hex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

async function answer(url: URL): Promise<Response> {
  // Each request starts as a new isolate would: no kept token.
  resetTokens();
  const g = ghcrReader({ userAgent: UA });
  const repo = url.searchParams.get("repo") ?? "";
  switch (url.pathname) {
    case "/manifest": {
      const m = await g.getManifest(repo, url.searchParams.get("ref") ?? "");
      return json({ digest: m.digest, artifactType: m.json.artifactType ?? null, layers: m.json.layers?.length ?? 0, requests: g.dial.count, tokenRequests: g.dial.tokenRequests });
    }
    case "/tags": {
      const t = await g.listTags(repo);
      return json({ count: t.tags.length, first: t.tags[0] ?? null, last: t.tags.at(-1) ?? null, pages: t.pages, truncated: t.truncated });
    }
    case "/range": {
      const r = await g.readRange(repo, url.searchParams.get("digest") ?? "", Number(url.searchParams.get("start")), Number(url.searchParams.get("end")));
      return json({ hex: hex(r.bytes), size: r.size, host: r.host, unexpected: r.unexpected, se: r.se, signed: r.signed, requests: g.dial.count });
    }
    default:
      return json({ error: `no route ${url.pathname}` }, 404);
  }
}

export default {
  async fetch(request: Request): Promise<Response> {
    try {
      return await answer(new URL(request.url));
    } catch (error) {
      if (error instanceof GhcrError) return json({ code: error.code, status: error.status, message: error.message }, 502);
      throw error;
    }
  },
};
