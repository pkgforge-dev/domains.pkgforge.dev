# The Worker

The Worker is the one Cloudflare Worker of this project. Its name is `domains-pkgforge-dev`, and its custom domain is `domains.pkgforge.dev`. The code is `apps/api/src/index.ts`, and the configuration is `apps/api/wrangler.toml`. The shape of this document is mirror-archlinux's docs/worker.md at commit `669ac725f8081445c164113f2ed092533de112e2`.

⭐ The Worker reads GHCR anonymously and caches verified bytes in the Cache API and through its private R2 binding. It holds no secret. The operator's wrangler login deploys it. CI deploys nothing and holds no Cloudflare credential.

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

- a registry refusal for which the anonymous pull flow cannot obtain a Bearer challenge, a realm that is not `https://ghcr.io/token`, or a token request that fails;
- a manifest over 64 KiB, or one that is not an OCI manifest;
- a `root:latest` whose artifact type is not `application/vnd.pkgforge.domains.root.v1`, or that holds no layer `root.json` or two;
- a layer `root.json` over 8 MiB, bytes that miss its digest, text that is not UTF-8 JSON, or a `format` other than `domains.root.v1`;
- a blob redirect with no https Location, or to a host outside `*.githubusercontent.com`;
- a range answer that is not exactly the bytes asked for;
- a subrequest past 10 s, reads of the root past 25 s in all, or a subrequest that fails on the network.

The tests of `packages/ghcr/test/reader.test.ts` and `packages/ghcr/test/timer.test.ts` hold the reader's own checks of these. They cover the realm, the token flow and its lifetimes, the Location, the range and its Content-Range, the 64 KiB cap and the times. `apps/api/test/ghcr.test.ts` drives the realm, the cap, a Location that is not https or is off `*.githubusercontent.com`, and a wrong Content-Range through a route.

### Provenance

A JSON answer that read the root carries the headers of `docs/architecture.md` §7.1. `packages/core/src/provenance.ts` validates the read record before the Worker builds the response.

| header | value |
| --- | --- |
| `x-domains-root` | the digest of the root manifest that gave the answer |
| `x-domains-as-of` | the root's `as_of`; absent when the root names no pack and has none |
| `x-domains-cache` | `hit` when the Cache API served every accepted read, `ghcr` when GHCR did, `r2` for R2 alone, `mixed` for multiple tiers. A root using R2 reports `mixed` because its selector used another tier. |
| `x-domains-cache-tiers` | The distinct accepted tiers, in lexical order, from `cache`, `ghcr`, `r2`. For example, `ghcr,r2` means GHCR selected the root and R2 served its checked `root.json`. |
| `x-domains-root-tier` | The tier that supplied the `root.json` bytes validated by this successful request. Values are `cache`, `ghcr` and `r2`. |
| `x-domains-tiers-read` | `0`: the root is not a pack, and `meta.tiers_read` is empty |
| `x-domains-sources-used` | empty: no source answered |
| `x-domains-body` | `derived` |
| `x-domains-degraded` | `1` only when the answer comes from a stale root after a failed read |

A request that reuses the checked isolate root reports the tier of its manifest read in the cache headers and omits `x-domains-root-tier`. A stale fallback omits all three tier headers. A missed, rejected or bypassed tier and a background fill contribute no accepted read.

## GHCR tokens

The Worker reads GHCR through `ghcrReader` of `packages/ghcr/src/reader.ts`, the one port of mirror-archlinux's token flow in this project. A registry request starts with a valid cached pull token for its repository when available, or the public placeholder `Bearer QQ==`.

A bare registry request can return a 401 Bearer challenge for a public package. GHCR issues a short-lived pull token for public reads without an account or stored credentials.

When GHCR answers 401 or 403 to a registry request:

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

The `body` reader checks the Cache API, the eligible slot in the `CACHE` R2 binding and then GHCR. The R2 object carries the complete kind, repository, digest and range identity beside the bytes, so a collision is a miss. The Worker checks the object's returned length and age and bounds the streamed read. It checks whole root and index blobs by SHA-256 and parses them before accepting their tier. A pack block with bad length, inflate or CRC falls through to the next tier. A verified R2 body can refill the Cache API. The sole R2 fill input is a verified GHCR body. Fills run under `ctx.waitUntil`.

The private bucket holds only the finite slots in `docs/architecture.md` §4.9. Wrangler simulates the binding for local development. An unavailable binding, a failed R2 read or a rejected object falls through to the same GHCR reader. The root selector, signed URLs, pull tokens and raw feeds stay out of R2.

⚠ The 1-year time to live holds only because a digest names one content. Changing `/__cache/v1` in `apps/api/src/cache.ts` abandons the old Cache API namespace. R2 has its own stable slot layout and deployment rules in `docs/architecture.md` §4.9.

The Worker has no `loc` entry: no route of DOM-030 answers a location. DOM-040's redirects to dumps add it.

## The root

`apps/api/src/root.ts` reads the root of each request:

1. It reads the manifest of `root:latest` through the `man` entry or GHCR. A new `root:latest` shows within 30 s.
2. When that digest is the digest of the root the isolate keeps, the kept root answers, with no other read.
3. Otherwise it reads `root.json` by its digest. On a `body` entry miss, it tries one eligible R2 slot. A settled miss starts GHCR immediately. A pending R2 lookup starts GHCR at the soft deadline while R2 remains eligible through the root-only hard deadline. The first body that passes SHA-256 and the checks of `format`, `root_seq`, `created`, `as_of` and `previous` supplies the recorded body tier. A GHCR source failure leaves R2 eligible through the hard deadline.
4. The isolate keeps the root for the next request, unless it keeps a root of a higher `root_seq`. A request that met the older manifest while another request loaded the newer root answers from the older root, and the newer root stays kept. `root:latest` only moves forward in `root_seq`: a promotion and a rollback each give the live `root_seq` plus 1 (`packages/root/src/build.ts`).

`validateRoot` of `packages/root`, in the reader's form, runs once for each root and isolate, when a route first reads the datasets. On the root of 435,492 B of `root_seq` 73 it took 10 to 28 ms in one reading and 5 to 10 ms in another. Each reading was five runs in Node v26.7.0 on Windows 11 (MEASURED 2026-11-02, DOM-030). The `cpu_ms` is 50. No reading gives the CPU of the same work on Cloudflare, and DOM-054 measures it.

The reads of one request's root have 25 s in all, beside the 10 s of each subrequest. Past the 25 s the request answers as GHCR failed. When the read of a new root fails and the isolate keeps a root, the request answers from the kept root with `x-domains-degraded: 1` and `cache-control: no-store`. The Worker logs the fallback and omits both cache headers. Without a kept root the failure is the answer.

A fault of the Worker itself is a 500, never a stale answer. Two requests share no promise, so one request's reads never wait on the I/O of another.

## Packs

`apps/api/src/pack.ts` opens a pack that the root names with the two options of `PackReader.open` (`packages/pack/src/reader.ts`):

- `partSizes`, the sizes of the part layers that the pack's manifest gives. The index's parts table must name the same count and sizes, or the open fails with `PackError` `tiling` before any block is read.
- `maxRawBlockBytes`, 1 MiB. A block above it fails with `PackError` `page` before its bytes are read. The largest raw block of the 613 live pack copies was 164,536 B (MEASURED 2026-11-02, DOM-030).

The Worker adds three bounds of its own, each refused with `PackError` `page` before a block is read:

- the index: the Worker reads it whole, in one read held to its digest, and refuses one above 1 MiB. Every live index is at most 4,457 B. The reader takes the head and the pages from those bytes.
- `recordsPerBlock` is at most 8,192, and `pageEntries` at most 256. Every live pack has 4,096 and 64.

The raw bound alone does not bound the heap of a decoded block. Front coding lets a few raw bytes name a long key. A names block of 65,535 keys that share a prefix, half the bound raw, held 27.6 MiB in Node. At 8,192 records a block the worst block measured, a `domains` block of 958,942 raw bytes, held 13.0 MiB (MEASURED 2026-11-02, Node v26.7.0, DOM-030). The routes that read blocks at once keep that heap times the blocks in flight under the isolate's 128 MB (DOM-032).

A block's bytes re-enter the cache only after the pack reader accepts their length, inflate and CRC. A read from Cache API or R2 that fails those checks gives the next tier an attempt for the same range.

No route of DOM-030 reads a pack. The routes of DOM-032 and later read packs through it.

## Logs

The Worker logs response and cache failures and stale roots with the request's `cf-ray`. The R2 adapter uses fixed failure messages. The response headers carry accepted tiers. `apps/api/wrangler.toml` sets `[observability] enabled = true`, `head_sampling_rate = 1` and `[observability.logs] invocation_logs = false`.

## Limits

| setting | value |
| --- | --- |
| `compatibility_date` | `2026-11-02`, the date of the test harness, `COMPATIBILITY_DATE` of `packages/testkit/src/workerd.ts`. The workerd of wrangler 4.156.1 refuses a date after today (UTC) and a date after 2026-11-08 |
| `compatibility_flags` | `no_nodejs_compat`, `no_nodejs_compat_v2`: the Worker uses only Web APIs |
| `[limits] cpu_ms` | 50 |
| `workers_dev`, `preview_urls` | `false` |
| subrequest deadline | 10 s for the head of an answer, and 10 s for its body |
| manifest size | 64 KiB |
| `root.json` size | 8 MiB |
| reads of one request's root | 25 s in all |
| R2 root lookup, body and checks | start GHCR after 250 ms if R2 is pending, accept R2 within 1,000 ms |
| R2 index and block lookup and body | 250 ms |
| R2 operations | one active binding GET, up to eight eligible lookups per request and one bounded background PUT |
| raw block of a pack | 1 MiB |
| index of a pack | 1 MiB, read whole |
| records a block, entries an index page | 8,192 and 256 |

An ordinary cold metadata request uses at most three Cache API matches and three puts, a GHCR manifest request, a blob redirect and a signed range GET, and one R2 GET and one PUT. With a cold selector, an R2 root accepted before GHCR starts uses at most two Cache API matches and two puts, one manifest request and one R2 GET. The longest retry path plans for 18 operations including fills. Each of the two GHCR registry operations can take four sends, and the signed range can take two when a kept URL must be renewed. These are code bounds. DOM-031 tracks live root latency and the dedicated bucket's Class A and Class B operation measurements.

An R2 root winner aborts the losing GHCR read. The Worker cancels an unused R2 body when it has the stream. The binding GET has no abort option and occupies the single read slot until it settles. An expired or losing GET's late body is canceled if the request is still active. Only a verified GHCR winner can fill R2 or keep a fresh signed URL. [Workers R2 API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)

Each subrequest has 10 s for its head and 10 s for its body. The reads of the root have a 25 s outer deadline. If no current root can be accepted, the Worker answers from the kept root when available. DOM-054 measures root load CPU on Cloudflare.

The test `compatibility` of `apps/api/test/config.test.ts` holds the date and the flags equal to the harness's.

No route asks for a key, an account or a quota, or limits a caller's rate (`AGENTS.md` absolute 8). The Worker refuses no caller.

## Deploy

The operator's wrangler login deploys the Worker by hand, from the operator's machine. Under ruling 14 the agent runs these steps with that login. CI holds no Cloudflare credential and deploys nothing.

`.github/workflows/worker.yml` runs on a push to `main` that changes `apps/api/**` or the workflow, and on dispatch:

| job | does |
| --- | --- |
| `test` | `node scripts/test.mjs apps/api` on the Node of `.node-version`, after `npm ci` |

To deploy, from a clean tree at the tip of `origin/main` that the gate passed:

1. Run `npx wrangler@4.156.1 whoami`. It must name the account that holds the `pkgforge.dev` zone. `apps/api/wrangler.toml` names no account, so a login with a second account makes wrangler ask which. Record that `whoami` named that account. Record neither its name, which carries its workers.dev subdomain, nor its id.
2. ⚠ Before each deploy, list the zone's DNS records of the name. Before the first deploy, expect none. From the second deploy on, expect one proxied `AAAA` record, the one that the first deploy made. When its output is not a terminal, as in an agent's shell, wrangler 4.156.1 replaces such a record with no question. It also takes the name from another Worker's custom domain. If the list holds any other record, or none after the first deploy, stop and ask the operator. Ruling 14 reaches no zone setting outside this project's resources.

```bash
cf dns records list -z pkgforge.dev --name domains.pkgforge.dev
```

3. Check that the custom domain still belongs to `domains-pkgforge-dev`. Record the current Worker version for rollback. Releases with `CACHE` need the private bucket and prefix lifecycle rules in `docs/resources.md`. Follow the bucket's pending setup and rollback there and DOM-031's cold proof in `TODO/storage.md`. Keep the create and deploy steps under the same local login.
4. Deploy with the commit as the version.

```bash
cd apps/api && npx wrangler@4.156.1 deploy --var BUILD:$(git rev-parse --short=12 HEAD)
```

5. Check the deployed Worker with the `curl` lines of the Prove of DOM-030 (`TODO/serve.md`) and the release entry. `/healthz` must name the 12 hex digits of the commit.
6. Add a row to the Deploys table of `docs/resources.md` with the version id that `wrangler deploy` printed.

The first deploy creates the custom domain `domains.pkgforge.dev`, its proxied `AAAA` record and an advanced certificate pack of the zone for `pkgforge.dev`, `domains.pkgforge.dev` and `*.domains.pkgforge.dev`. The edge serves the certificate of that pack for the host, not the zone's Universal certificate (`docs/resources.md`, Custom domains and certificates). With one account in the login and no `account_id`, wrangler finds the account and the zone of the custom domain (MEASURED 2026-11-02T07:57:49Z, DOM-030). If wrangler asks for an account, set `CLOUDFLARE_ACCOUNT_ID` in the shell of the deploy and deploy again. Never write the id into a file of the tree.

⚠ A new version can take some seconds to reach every data centre. Run the checks again after 20 s before you roll back.

To roll back to the previous version, run `cd apps/api && npx wrangler@4.156.1 rollback`. wrangler reads the Worker's name from the `wrangler.toml` of the current directory, so the command fails from the repository root. To roll back further, deploy the earlier commit of `apps/api/`. To remove the Worker, follow its rows in `docs/resources.md`.

Check the configuration with no deploy:

```bash
cd apps/api && npx wrangler@4.156.1 deploy --dry-run --outdir ../../.tmp/api-dry
```

## Tests

```bash
node scripts/test.mjs apps/api
```

The tests of `apps/api/test/` run in Node with the world of `packages/testkit/src/world.ts`. The world gives a mock fetch that stands in for GHCR and the blob host, and a Cache API stub with a clock. `apps/api/test/workerd.test.ts` runs the Worker from its real entry in workerd with a mock registry. They need no network. `packages/ghcr` tests the GHCR reader's own checks: `node scripts/test.mjs packages/ghcr`.

## Monitoring

DOM-034 builds the status run, which reads `/healthz` with no credential and raises an issue on a failed probe (`TODO/ops.md`). While GHCR fails and the isolate keeps a root, `/healthz` answers 200 `ok: true` with `x-domains-degraded: 1`, until that root is 6 hours old. So the probe reads the header and counts `1` as a failed probe. A person or an outside monitor sees a stopped Actions chain as a growing `root_age_s`: the Worker cannot dispatch a workflow.

## Trust

The Worker has the `BUILD` variable and one resource binding, `CACHE`, for the private R2 cache. It holds no secret. A pull token that GHCR gives on a refusal reads only public packages, and the isolate keeps it at most 300 s. A caller reaches the Worker on its custom domain alone (`workers_dev = false`).

Its answers come from GHCR's public packages. The Worker holds a manifest read by digest, `root.json` and the index of a pack to their digests. It holds a block of a pack to its length and its CRC-32. Only the operator's wrangler login can deploy it, and nothing in CI can.
