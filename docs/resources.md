# Resources

Every cloud resource this project creates, with the command that deletes it.
A row is written **before** its resource is created, in the same change
(AGENTS.md absolute 9). A resource nobody can find is a resource nobody can
remove.

A created column that reads `pending` names a resource that the tree holds and
that does not exist yet: a Worker or a bucket the operator has not created, a
package no run has pushed, or a workflow file not yet on `main`. The entry that
creates it replaces `pending` with the date. The repository is public, so the
ledger names the Cloudflare account and the zone as `ACCOUNT_ID` and `ZONE_ID`
and records no identifier that fingerprints a private system
([`security/secrets.md`](security/secrets.md)). A command reads both from the
operator's login when it runs: `npx wrangler whoami` names the account, and the
`pkgforge.dev` zone is found in the Cloudflare dashboard. A Worker's wrangler
configuration may carry the `account_id` a custom domain needs
(`docs/architecture.md` §12).

⛔ **Nothing in GHCR is deleted** (the operator's ruling of 2026-10-27,
`TODO/RULES.md` §5). The undo of a package is the operator's alone.

## Workers

| Worker | hostname | created | owner | delete |
| --- | --- | --- | --- | --- |
| `domains-probe` (`probes/worker/`) | its workers.dev URL, which `wrangler deploy` prints; `preview_urls = false`, no route. Crons `* * * * *` and `*/5 * * * *`. R2 binding `PROBE` to the bucket `domains-probe`. | 2026-10-28T15:13:54Z, deployed by the agent under ruling 14 with `npx wrangler@4.150.0 deploy` (DOM-061) | DOM-061; DOM-056 deletes it | `npx wrangler@4.150.0 delete --name domains-probe` |

A Worker row names its hostname, its cron triggers and every binding it holds
(R2, service, rate limit). The delete column is `npx wrangler delete --name <worker>`. It removes the Worker's custom domain, its record and its cron triggers.

Two Workers are temporary measurement Workers: the probe `domains-probe` (DOM-061) and the drill `domains-drill` (DOM-053). Each runs on workers.dev for its life, with `preview_urls = false`, binds only a temporary bucket and holds no data of value (`SECURITY.md`). Every Worker that serves callers has `workers_dev = false`. The row of a temporary Worker names the entry that deletes it, and moves to Retired with the date when it is deleted: the probe when DOM-002, DOM-005, DOM-007 and DOM-008 have closed (DOM-056 deletes it), the drill when its entry ends.

## Custom domains and certificates

A `[[routes]]` entry with `custom_domain = true` creates two things: a DNS
record and a certificate. A four-label hostname can trigger an advanced
certificate pack. Record the pack here when one is issued.

| hostname | Worker | certificate pack | created | delete |
| --- | --- | --- | --- | --- |

## R2

At most 5 GB, as a cache (the operator's ruling of 2026-10-27, `TODO/RULES.md`
§5). A bucket row records the lifecycle rule or the clock that holds that bound.
The one cache bucket is `domains-pkgforge-cache`. The temporary buckets of the
probe and the drill (`domains-probe`, `domains-drill`) hold measurement data only,
each with the lifecycle rule or the deletion that keeps it small, and are deleted
with their Workers.

| bucket | bound by | created | rules | delete |
| --- | --- | --- | --- | --- |
| `domains-probe` | the Worker `domains-probe`, binding `PROBE` | 2026-10-28, created by the agent under ruling 14 with `npx wrangler@4.150.0 r2 bucket create domains-probe`, and the rule added with `r2 bucket lifecycle add` (DOM-061) | lifecycle rule `expire-hot`: objects under `hot/` (1 MiB each, one every 5 minutes) expire after 3 days; the tick records (about 200 B each) and `heartbeat.json` stay. DOM-008's sample packs `sample/v1/per-1024.pack`, `per-4096.pack` and `per-16384.pack` (put 2026-10-28T23:41:46Z to 23:42:05Z with `r2 object put --remote`) have no rule and go with the bucket | expire or delete every object (the lifecycle rule with `--expire-days 1` and a wait, or `npx wrangler@4.150.0 r2 object delete domains-probe/<key>`), then `npx wrangler@4.150.0 r2 bucket delete domains-probe` |

## GHCR packages

OCI artifacts under the `pkgforge-dev` organisation. A package is created by the
first push of a workflow, with that workflow's own `GITHUB_TOKEN`, and the
workflow makes it public (`TODO/RULES.md` §5). No token is created for it.

| package | linked repository | visibility | pushed by | created | delete |
| --- | --- | --- | --- | --- | --- |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/probe` | `pkgforge-dev/domains.pkgforge.dev`, proven by the second run of DOM-006 | public, proven by the anonymous read of DOM-006 | `measure-push.yml` (DOM-006), tags `size-<MiB>m`, `layers-<N>` and `retag` | 2026-10-28, by `measure-push.yml` run 40714201294 (DOM-006): it did not exist before the run, and the package record reads `public` | none by an agent or a workflow |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/root` | `pkgforge-dev/domains.pkgforge.dev`, through the first push of `root-promote.yml` with its own `GITHUB_TOKEN` (ruling 6), run 40905355025; a later write by a workflow proves the link, and none has written since | public: MEASURED 2026-10-29T15:49:24Z, `node scripts/root/show.mjs --ref latest` and `node scripts/ghcr/check-public.mjs root` exit 0 with no credential, and an anonymous `curl` of `root/manifests/latest` answers 200 | `root-promote.yml` (DOM-020), the one writer: write-once dated tags `r-<YYYYMMDDtHHMMSSz>`, one a promotion, and `latest`, which moves forward only, last, after the guard read (`docs/architecture.md` section 4.7). The first run writes `root_seq` 1 with no pack. New roots stop when `root-promote.yml` and every call of it are removed; whether `gh workflow disable root-promote.yml` also stops its runs through `workflow_call` is not measured | 2026-10-29T15:49:16Z, by `root-promote.yml` run 40905355025 (DOM-020): `root:latest` did not exist before the run (`live none`), and it pushed `r-20261029t154910z`, `root_seq` 1 with no pack | none by an agent or a workflow (absolute 13): the dated roots stay, like every package |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/ref` | `pkgforge-dev/domains.pkgforge.dev`, through the first push of `ref-refresh.yml` with its own `GITHUB_TOKEN` (ruling 6); its page under the repository answered 200 on 2026-10-29T06:49Z | public, proven by `node scripts/ghcr/check-public.mjs ref` with no credential at 2026-10-29T06:47:38Z (exit 0), and by the same check in the run | `ref-refresh.yml` (DOM-019), daily at 05:13 UTC: tags `psl-<sha12>`, `ctlogs-<sha12>` and `sources-<sha12>`, each written once. A new content adds one tag. The first run pushed `psl-1f96bae40adf` (338,012 B), `ctlogs-29e361747007` (62,375 B) and `sources-d33793f12605` (214 B, `config/sources.json` at 74dd42a); an unchanged file adds nothing. `gh workflow disable ref-refresh.yml` stops new tags | 2026-10-29, by `ref-refresh.yml` run 40831098846 (DOM-019), dispatched at 06:44:59Z: absent at 2026-10-29T00:38:16Z, three tags at 06:47:38Z | none by an agent or a workflow (absolute 13): the tags stay, like every package |

The probe package grows with every dispatch of `measure-push.yml`: about 5.5 GiB
at the default inputs (a push of 1,536 MiB and one of 4,096 MiB), so about 11 GiB
after the two runs DOM-006's Prove needs. It is kept, like every package.

The delete column for every package reads: none by an agent or a workflow. The
operator alone may delete one, in the GitHub interface or with
`gh api -X DELETE /orgs/pkgforge-dev/packages/container/<package>`, and
deleting one destroys data that is kept always.

## GitHub Actions workflows

A workflow is a resource: it runs on a schedule or a push, spends minutes and
writes to GHCR.

| workflow | file | trigger | permissions | created | delete |
| --- | --- | --- | --- | --- | --- |
| CI | `ci.yml` | push to `main`, pull request, dispatch | `gate`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-013) | remove the file |
| Measure clock schedule | `measure-clock-schedule.yml` | cron `*/5 * * * *`, dispatch | `tick`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-001) | `gh workflow disable measure-clock-schedule.yml` once 48 hours of ticks exist, then remove the file |
| Measure clock chain | `measure-clock-chain.yml` | dispatch only; each run dispatches the next until the repository variable `CHAIN_END` | `measure-chain`: `actions: write`, `contents: read` | 2026-10-28, commit 5e7a646 (DOM-001) | the chain ends by itself once `CHAIN_END` has passed (an empty `CHAIN_END` never ends it); `gh workflow disable measure-clock-chain.yml`, then remove the file |
| Measure clock chain keepalive | `measure-clock-chain-keep.yml` | cron `*/30 * * * *`, dispatch | `keepalive`: `actions: write`, `contents: read` | 2026-10-28, commit 5e7a646 (DOM-001) | `gh workflow disable measure-clock-chain-keep.yml` once the chain has ended, then remove the file |
| Measure feeds | `measure-feeds.yml` | dispatch only; a chain of long jobs, each dispatching the next until the dispatch input `until` (the start plus 7 days) | `measure-chain`: `actions: write`, `contents: read`; `poll`: `contents: read` | 2026-10-28, commit 5e7a646; GitHub accepted the file from commit 69eff0d (DOM-012) | `gh workflow disable measure-feeds.yml`, then remove the file |
| measure-kafka | `measure-kafka.yml` | dispatch only | `measure`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-004) | remove the file |
| Measure a GHCR push | `measure-push.yml` | dispatch only | `measure-push`: `contents: read`, `packages: write` | 2026-10-28, commit 5e7a646 (DOM-006) | remove the file; the package it pushed stays |
| Measure THC day | `measure-thc-day.yml` | dispatch only | `plan`, `measure` and `merge`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-009) | remove the file |
| measure-thc-monthly | `measure-thc-monthly.yml` | dispatch only | `measure`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-010) | remove the file |
| Measure tiles | `measure-tiles.yml` | dispatch only; a chain of jobs, each dispatching the next until the dispatch input `until` | `measure-chain`: `actions: write`, `contents: read`; `rounds`: `contents: read` | 2026-10-28, commit ec0014f (DOM-011); the chain dispatched at 2026-10-28T23:43:26Z with `until=2026-10-29T23:43:25Z` | the chain ends by itself after `until`; `gh workflow disable measure-tiles.yml`, then remove the file |
| Measure Range reads through the probe Worker | `measure-range-load.yml` | dispatch only | `measure`: `contents: read` | 2026-10-28, commit ec0014f (DOM-007) | remove the file with the probe (DOM-056) |
| Promote the root | `root-promote.yml` | dispatch, and `workflow_call` from the ingest and compaction workflows; every run waits in the concurrency group `root-writer` (`queue: max`, no cancel, ruling 18), and two runs through `workflow_call` queue in it (MEASURED 2026-10-29T15:50Z, DOM-020: the second call's promote job started 2 s after the first's ended) | `promote`: `contents: read`, `packages: write` (`issues: write` joins when DOM-034 adds the issue script; until then the no-op step that stands in for it needs no grant, and fails the job) | 2026-10-29, commit 34c573f (DOM-020); its first run, 40905355025, was dispatched at 15:48:58Z and ended `success` | `gh workflow disable root-promote.yml`, then remove the file and every call of it; the root package and its tags stay |
| Refresh the ref package | `ref-refresh.yml` | cron `13 5 * * *`, dispatch | `ref`: `contents: read`, `packages: write` (`issues: write` joins with DOM-034) | 2026-10-29, commit 74dd42a (DOM-019); its first run, 40831098846, was dispatched at 06:44:59Z and ended `success` | `gh workflow disable ref-refresh.yml`, then remove the file; the ref package and its tags stay |
| Compact the days | `compact-daily.yml` | cron `35 1 * * *`, dispatch with `day`, `rebuild` and `first-ledger`; every run waits in the concurrency group `compact` (`queue: max`, no cancel) | `plan`, `count`, `compact`, `day`, `gather`: `contents: read`; `assemble`: `contents: read`, `packages: write` (the day packs, to `names` and `feed`); `push`: `contents: read`, `packages: write`, after `assemble`, in the group `root-writer` (`ledger-filter-YYYYMMDD` of `state`); `promote`: calls `root-promote.yml` with `contents: read`, `packages: write`. Every job that holds `packages: write` runs on `main` alone, except `promote`, which only calls `root-promote.yml` and runs after jobs that do (rule 3 of `scripts/check-workflows.mjs`) | pending (DOM-023) | `gh workflow disable compact-daily.yml`, then remove the file; the packs and the filters it pushed stay |
| Compact the weeks | `compact-weekly.yml` | cron `50 3 * * 1`, dispatch with `span` and `rebuild`; group `compact` | `plan`, `count`, `compact`, `gather`: `contents: read`; `assemble`: `contents: read`, `packages: write`; `promote`: calls `root-promote.yml` with `contents: read`, `packages: write` | pending (DOM-023) | `gh workflow disable compact-weekly.yml`, then remove the file; the packs it pushed stay |
| Compact the months | `compact-monthly.yml` | cron `50 4 1 * *`, dispatch with `span` and `rebuild`; group `compact` | as `compact-weekly.yml` | pending (DOM-023) | `gh workflow disable compact-monthly.yml`, then remove the file; the packs it pushed stay |
| Compact the years | `compact-yearly.yml` | cron `50 5 1 1 *`, dispatch with `span` and `rebuild`; group `compact` | as `compact-weekly.yml` | pending (DOM-023) | `gh workflow disable compact-yearly.yml`, then remove the file; the packs it pushed stay |
| Measure a compaction range | `measure-compact.yml` | dispatch only, with `dataset`, `inputs`, `rows` and `overlap` | `measure`: `contents: read`; it pushes nothing and reads nothing from GHCR | pending (DOM-023) | temporary: remove the file and `scripts/compact/measure.mjs` with its test when DOM-023 closes, after the result lands in `docs/research/measure/DOM-023/` |

The delete column is removing the file in a commit, or `gh workflow disable <workflow>` to stop it without a commit.

## Other Cloudflare resources

D1 databases, KV namespaces, Queues, Analytics Engine datasets and Workers Rate
Limiting namespaces. No Durable Object, Container or Sandbox is ever created on
a request path or as the clock (`AGENTS.md` absolute 10).

| resource | kind | bound by | created | owner | delete |
| --- | --- | --- | --- | --- | --- |

## Zone rules

Rules this project changes on the `pkgforge.dev` zone, which other sites share.

| zone ruleset | change | created | owner | undo |
| --- | --- | --- | --- | --- |

## Secrets (names only)

No secret exists. A row is added in the same change as the name in
`.dev.vars.example` (`security/secrets.md`).

| Worker | secret | what it is | owner |
| --- | --- | --- | --- |

## Expiries

Anything that stops working on a date: tokens, certificates, plans.

| what | expires | owner | renew |
| --- | --- | --- | --- |

## Retired

Resources this project created and later deleted, with the command that deleted
them.

| resource | id | deleted | by |
| --- | --- | --- | --- |

## Deploys

Newest first. The operator deploys the Worker from their machine, and a session
adds the row from what the operator reports. A deploy script, when it exists,
writes this table.

| when | Worker | version | commit |
| --- | --- | --- | --- |
