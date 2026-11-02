# The Worker

The Worker is the one Cloudflare Worker of this project. Its name is `domains-pkgforge-dev`, and its custom domain is `domains.pkgforge.dev`. The code is `apps/api/src/index.ts`, and the configuration is `apps/api/wrangler.toml`. The shape of this document is mirror-archlinux's docs/worker.md at commit `669ac725f8081445c164113f2ed092533de112e2`.

⭐ The Worker only reads. It reads GHCR with no credential, keeps entries in the Cache API, and holds no secret. The operator's wrangler login deploys it. CI deploys nothing and holds no Cloudflare credential.

This document is for the operator and the maintainer. DOM-059 generates the documents of the routes for callers, and DOM-060 writes the consumer contract. Both come last (`TODO/RULES.md` §5, ruling 26).

## Paths

| path | answers |
| --- | --- |
| `/healthz` | 200 `{"ok":true,"version":"<12 hex>","root_age_s":N}`; 503 with `ok: false` when `root_age_s` is above 21,600 or no root can be read |
| `/v1/index/latest` | 200: the envelope of `docs/architecture.md` §7.1, with `data` `{format, root_seq, as_of, root, references}` |
| `/` | 200: a plain text stub that names the service and no route |
| `/llms-full.txt` | 200: a plain text stub with the marker `reason-<reason>` and one line for each reason of an error answer |

Every other path answers 404 with the reason `not-found`. Every method but GET, HEAD and OPTIONS answers 405 with the reason `method-not-allowed` and `allow: GET, HEAD, OPTIONS`, on every path. OPTIONS answers 204 on every path. HEAD gets the answer of GET with no body, and makes the same subrequests. The Worker ignores the query string.

- `version` is the BUILD variable that the deploy sets, the 12 hex digits of the commit. It is null when the deploy set none, or set a value that is not 12 lowercase hex digits.
- `root_age_s` is the whole seconds since the root's `created`, the time its promotion built it. It is null when no root can be read.
- `data.root` is the digest of the manifest that `root:latest` names. `references` names `ghcr.io/pkgforge-dev/domains.pkgforge.dev/root:latest` and the same root by that digest, so a client can read the root with no Worker (`docs/architecture.md` §11).

The two stubs stay until DOM-059 generates `/`, `/llms.txt`, `/llms-full.txt`, `/openapi.json` and `/SKILL.md` from the route registry.

## Answers

| status | when |
| --- | --- |
| 200 | a route answered; `/v1/index/latest` with `cache-control: public, max-age=30`, the stubs with `public, max-age=300`, `/healthz` with `no-store` |
| 204 | OPTIONS |
| 404 | `not-found` |
| 405 | `method-not-allowed` |
| 500 | `internal-error`: an exception in the Worker, never taken for GHCR's fault and never answered from a kept root |
| 502 | `source-unavailable`: GHCR failed, a subrequest ran past 10 s or the reads of the root past 25 s, or GHCR answered something the Worker refuses; with `retry-after: 30` |
| 503 | `no-root`: GHCR holds no `root:latest`; with `retry-after: 30`. `/healthz` answers its own body with 503 |

Every error answer of the Worker is the problem of `packages/core/src/problem.ts`: `application/problem+json` with `status`, `title`, `detail`, `reason` and `see`, `x-content-type-options: nosniff` and `cache-control: no-store`. `see` is `/llms-full.txt#reason-<reason>`, and the stub at that path holds the marker of each reason (`apps/api/src/guide.ts`).

Every answer of the Worker carries `access-control-allow-origin: *`. Its `access-control-expose-headers` names the provenance headers, `retry-after` and `allow`. No answer allows credentials. An error of the platform, such as a request past `cpu_ms`, is Cloudflare's own answer, and carries neither the problem nor these headers.

The Worker answers 502 to these, among others:

- a refusal of `Bearer QQ==` with no Bearer challenge, a realm that is not `https://ghcr.io/token`, or a token request that fails;
- a manifest over 64 KiB, or one that is not an OCI manifest;
- a `root:latest` whose artifact type is not `application/vnd.pkgforge.domains.root.v1`, or that holds no layer `root.json` or two;
- a layer `root.json` over 8 MiB, bytes that miss its digest, text that is not UTF-8 JSON, or a `format` other than `domains.root.v1`;
- a blob redirect with no https Location, or to a host outside `*.githubusercontent.com`;
- a range answer that is not exactly the bytes asked for;
- a subrequest past 10 s, reads of the root past 25 s in all, or a subrequest that fails on the network.

The tests of `packages/ghcr/test/reader.test.ts` and `packages/ghcr/test/timer.test.ts` hold the reader's own checks of these. They cover the realm, the token flow and its lifetimes, the Location, the range and its Content-Range, the 64 KiB cap and the times. `apps/api/test/ghcr.test.ts` drives the realm, the cap, a Location that is not https or is off `*.githubusercontent.com`, and a wrong Content-Range through a route.

### Provenance

A JSON answer that read the root carries the headers of `docs/architecture.md` §7.1, built by `packages/core/src/provenance.ts` from the reads the request made:

| header | value |
| --- | --- |
| `x-domains-root` | the digest of the root manifest that gave the answer |
| `x-domains-as-of` | the root's `as_of`; absent when the root names no pack and has none |
| `x-domains-cache` | `hit` when the Cache API served every read of the root, `ghcr` when GHCR did, `mixed` for both; absent on a stale answer |
| `x-domains-tiers-read` | `0`: the root is not a pack, and `meta.tiers_read` is empty |
| `x-domains-sources-used` | empty: no source answered |
| `x-domains-body` | `derived` |
| `x-domains-degraded` | `1` only when the answer comes from a stale root after a failed read |

A request whose root is the root the isolate keeps reads only the manifest, so its `x-domains-cache` names the tier of that one read. A stale answer comes from the root the isolate keeps, which no read of its request served, so it names no tier.

## GHCR tokens

The Worker reads GHCR through `ghcrReader` of `packages/ghcr/src/reader.ts`, the one port of mirror-archlinux's token flow in this project. Every GHCR subrequest sends the dummy token `Bearer QQ==` first, which GHCR accepts for every public package.

When GHCR answers 401 or 403 to the dummy token:

1. The reader reads the Bearer challenge in `www-authenticate`. After a 403 with no challenge, it sends one request with no authorization, which gets the challenge.
2. It accepts the realm only when it is `https://ghcr.io/token`.
3. It asks the realm for a pull token, with `service=ghcr.io` and `scope=repository:pkgforge-dev/domains.pkgforge.dev/<package>:pull`.
4. It sends the subrequest again, once, with that token.

The reader keeps the token in the isolate for its `expires_in` less 30 s, at most 300 s. It keeps it 30 s when the answer has no `expires_in`. It stores the token nowhere else, so the Worker has no `token` cache entry. The token reads only public packages. The reader reads only the repositories `pkgforge-dev/domains.pkgforge.dev/<package>`. Every request sends the contact User-Agent, `USER_AGENT` of `packages/core/src/contact.ts` (ruling 11).

## Caching

The Worker uses the Cache API (`apps/api/src/cache.ts`). There is one cache per data centre, and entries do not replicate. Every key is a GET request on the request host under `/__cache/v1`.

| entry | key | holds | time to live |
| --- | --- | --- | --- |
| `man` | repository and reference | a manifest | `latest` and any other tag: 30 s; a digest: 1 year |
| `blob` | repository and digest | a blob's signed URL | the signed URL's `se` less 120 s, at most 600 s |
| `body` | repository, digest and range | immutable bytes: `root.json`, and the index and blocks of a pack | 1 year |

The Worker stores no signed URL whose `se` is less than 121 s ahead. The reader checks what it reads back: a manifest read by digest against that digest, and a signed URL against its host and its `se`. The digest of a manifest read by tag is the SHA-256 of the bytes the request read. The Worker holds every `body` entry to its length, and the entry of a whole blob to its digest. An entry that fails is a miss, and the Worker logs it.

The Worker writes a pack block's entry only once the pack reader's checks held its bytes. An entry whose bytes then fail inflate or the CRC-32 is a logged miss. The Worker then reads the block again from GHCR and overwrites the entry. A cache that fails is a miss, never a failed answer. A write runs in `ctx.waitUntil`, after the answer.

⚠ The 1-year time to live holds only because a digest names one content. Change `/__cache/v1` in `apps/api/src/cache.ts` to `/__cache/v2` to clear every entry with one deploy.

The Worker has no `loc` entry: no route of DOM-030 answers a location. DOM-040's redirects to dumps add it.

## The root

`apps/api/src/root.ts` reads the root of each request:

1. It reads the manifest of `root:latest` through the `man` entry or GHCR. A new `root:latest` shows within 30 s.
2. When that digest is the digest of the root the isolate keeps, the kept root answers, with no other read.
3. Otherwise it reads `root.json` by its digest through the `body` entry or GHCR, and holds the bytes to the digest. It parses them and checks the head fields: `format`, `root_seq`, `created`, `as_of` and `previous`.
4. The isolate keeps the root for the next request, unless it keeps a root of a higher `root_seq`. A request that met the older manifest while another request loaded the newer root answers from the older root, and the newer root stays kept. `root:latest` only moves forward in `root_seq`: a promotion and a rollback each give the live `root_seq` plus 1 (`packages/root/src/build.ts`).

`validateRoot` of `packages/root`, in the reader's form, runs once for each root and isolate, when a route first reads the datasets. On the root of 435,492 B of `root_seq` 73 it took 10 to 28 ms in one reading and 5 to 10 ms in another. Each reading was five runs in Node v26.7.0 on Windows 11 (MEASURED 2026-11-02, DOM-030). The `cpu_ms` is 50. No reading gives the CPU of the same work on Cloudflare, and DOM-054 measures it.

The reads of one request's root have 25 s in all, beside the 10 s of each subrequest. Past the 25 s the request answers as GHCR failed. When the read of a new root fails and the isolate keeps a root, the request answers from the kept root. The answer then carries `x-domains-degraded: 1` and `cache-control: no-store`, and the Worker logs it. It carries no `x-domains-cache`, since no read of its request served it. Without a kept root the failure is the answer.

A fault of the Worker itself is a 500, never a stale answer. Two requests share no promise, so one request's reads never wait on the I/O of another.

## Packs

`apps/api/src/pack.ts` opens a pack that the root names with the two options of `PackReader.open` (`packages/pack/src/reader.ts`):

- `partSizes`, the sizes of the part layers that the pack's manifest gives. The index's parts table must name the same count and sizes, or the open fails with `PackError` `tiling` before any block is read.
- `maxRawBlockBytes`, 1 MiB. A block above it fails with `PackError` `page` before its bytes are read. The largest raw block of the 613 live pack copies was 164,536 B (MEASURED 2026-11-02, DOM-030).

The Worker adds three bounds of its own, each refused with `PackError` `page` before a block is read:

- the index: the Worker reads it whole, in one read held to its digest, and refuses one above 1 MiB. Every live index is at most 4,457 B. The reader takes the head and the pages from those bytes.
- `recordsPerBlock` is at most 8,192, and `pageEntries` at most 256. Every live pack has 4,096 and 64.

The raw bound alone does not bound the heap of a decoded block. Front coding lets a few raw bytes name a long key. A names block of 65,535 keys that share a prefix, half the bound raw, held 27.6 MiB in Node. At 8,192 records a block the worst block measured, a `domains` block of 958,942 raw bytes, held 13.0 MiB (MEASURED 2026-11-02, Node v26.7.0, DOM-030). The routes that read blocks at once keep that heap times the blocks in flight under the isolate's 128 MB (DOM-032).

A block's bytes go into their `body` entry only once the reader's checks held them, so a block that fails at GHCR is never kept.

No route of DOM-030 reads a pack. The routes of DOM-032 and later read packs through it.

## Logs

The Worker calls `console.error` on each 5xx answer, on each cache failure and on each stale root, with the request's `cf-ray`. It logs nothing else. `apps/api/wrangler.toml` sets `[observability] enabled = true`, `head_sampling_rate = 1` and `[observability.logs] invocation_logs = false`.

## Limits

| setting | value |
| --- | --- |
| `compatibility_date` | `2026-10-13`, the newest date the workerd of wrangler 4.150.0 runs, and the date of the test harness |
| `compatibility_flags` | `no_nodejs_compat`, `no_nodejs_compat_v2`: the Worker uses only Web APIs |
| `[limits] cpu_ms` | 50 |
| `workers_dev`, `preview_urls` | `false` |
| subrequest deadline | 10 s for the head of an answer, and 10 s for its body |
| manifest size | 64 KiB |
| `root.json` size | 8 MiB |
| reads of one request's root | 25 s in all |
| raw block of a pack | 1 MiB |
| index of a pack | 1 MiB, read whole |
| records a block, entries an index page | 8,192 and 256 |

A request takes at most three Cache API lookups: `man`, `body` and `blob`. It makes at most two GHCR subrequests, the manifest and the blob redirect of `root.json`. It makes one range read of the signed URL. It makes two when the blob host refuses a kept signed URL, after the reader asks the registry for a new one. When GHCR refuses `Bearer QQ==`, a subrequest can take a token request and a second try, and one more request when a 403 has no challenge.

Each subrequest has 10 s for its head and 10 s for its body. The reads of the root stop at 25 s in all. So a caller waits at most about 25 s for an answer that reads the root. The Worker does not remember a failure. While GHCR stalls, each request waits until its reads fail or the 25 s pass, and then answers from the kept root. No reading gives the CPU of a root load on Cloudflare, and DOM-054 measures it with the waits.

The test `compatibility` of `apps/api/test/config.test.ts` holds the date and the flags equal to the harness's.

No route asks for a key, an account or a quota, or limits a caller's rate (`AGENTS.md` absolute 8). The Worker refuses no caller.

## Deploy

The operator's wrangler login deploys the Worker by hand, from the operator's machine. Under ruling 14 the agent runs these steps with that login. CI holds no Cloudflare credential and deploys nothing.

`.github/workflows/worker.yml` runs on a push to `main` that changes `apps/api/**` or the workflow, and on dispatch:

| job | does |
| --- | --- |
| `test` | `node scripts/test.mjs apps/api` on the Node of `.node-version`, after `npm ci` |

To deploy, from a clean tree at the tip of `origin/main` that the gate passed:

1. Run `npx wrangler@4.150.0 whoami`. It must name the account that holds the `pkgforge.dev` zone. `apps/api/wrangler.toml` names no account, so a login with a second account makes wrangler ask which. Record that `whoami` named that account. Record neither its name, which carries its workers.dev subdomain, nor its id.
2. ⚠ Before the first deploy, list the zone's DNS records of the name, and expect none. When its output is not a terminal, as in an agent's shell, wrangler 4.150.0 replaces such a record with no question. It also takes the name from another Worker's custom domain. If the list holds a record, stop and ask the operator: ruling 14 reaches no zone setting outside this project's resources.

```bash
cf dns records list -z pkgforge.dev --name domains.pkgforge.dev
```

3. Deploy with the commit as the version:

```bash
cd apps/api && npx wrangler@4.150.0 deploy --var BUILD:$(git rev-parse --short=12 HEAD)
```

4. Check the deployed Worker with the `curl` lines of the Prove of DOM-030 (`TODO/serve.md`). `/healthz` must name the 12 hex digits of the commit.
5. Add a row to the Deploys table of `docs/resources.md` with the version id that `wrangler deploy` printed.

The first deploy creates the custom domain `domains.pkgforge.dev` and its DNS record. The hostname is one label below the zone, so the zone's Universal certificate covers it. No reading shows that wrangler finds the zone of the custom domain with no `account_id`, and the first deploy measures it. If wrangler asks for an account, set `CLOUDFLARE_ACCOUNT_ID` in the shell of the deploy and deploy again. Never write the id into a file of the tree.

⚠ A new version can take some seconds to reach every data centre. Run the checks again after 20 s before you roll back.

To roll back to the previous version, run `cd apps/api && npx wrangler@4.150.0 rollback`. wrangler reads the Worker's name from the `wrangler.toml` of the current directory, so the command fails from the repository root. To roll back further, deploy the earlier commit of `apps/api/`. To remove the Worker, follow its rows in `docs/resources.md`.

Check the configuration with no deploy:

```bash
cd apps/api && npx wrangler@4.150.0 deploy --dry-run --outdir ../../.tmp/api-dry
```

## Tests

```bash
node scripts/test.mjs apps/api
```

The tests of `apps/api/test/` run in Node with the world of `packages/testkit/src/world.ts`. The world gives a mock fetch that stands in for GHCR and the blob host, and a Cache API stub with a clock. `apps/api/test/workerd.test.ts` runs the Worker from its real entry in workerd with a mock registry. They need no network. `packages/ghcr` tests the GHCR reader's own checks: `node scripts/test.mjs packages/ghcr`.

## Monitoring

DOM-034 builds the status run, which reads `/healthz` with no credential and raises an issue on a failed probe (`TODO/ops.md`). While GHCR fails and the isolate keeps a root, `/healthz` answers 200 `ok: true` with `x-domains-degraded: 1`, until that root is 6 hours old. So the probe reads the header and counts `1` as a failed probe. A person or an outside monitor sees a stopped Actions chain as a growing `root_age_s`: the Worker cannot dispatch a workflow.

## Trust

The Worker holds no secret, no credential and no resource binding. Its one binding is the variable `BUILD`. A pull token that GHCR gives on a refusal reads only public packages, and the isolate keeps it at most 300 s. A caller reaches the Worker on its custom domain alone (`workers_dev = false`).

Its answers come from GHCR's public packages. The Worker holds a manifest read by digest, `root.json` and the index of a pack to their digests. It holds a block of a pack to its length and its CRC-32. Only the operator's wrangler login can deploy it, and nothing in CI can.
