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
| `domains-probe` (`probes/worker/`) | its workers.dev URL, which `wrangler deploy` prints; `preview_urls = false`, no route. No cron: `crons = []` from the deploy of 2026-10-30T18:30:46Z (DOM-002). The crons `* * * * *` and `*/5 * * * *` ran from 2026-10-28T15:23:24Z, and the last tick was scheduled at 2026-10-30T18:34:24Z. Routes `/`, `/gaps`, `/range` and `/decode`; DOM-005 took out `/kafka` (2026-10-30T19:51:58Z). R2 binding `PROBE` to the bucket `domains-probe`. | 2026-10-28T15:13:54Z, deployed by the agent under ruling 14 with `npx wrangler@4.150.0 deploy` (DOM-061) | DOM-061; DOM-056 deletes it | `npx wrangler@4.150.0 delete --name domains-probe` |
| `domains-pkgforge-dev` (`apps/api/`) | the custom domain `domains.pkgforge.dev` (row below); `workers_dev = false`, `preview_urls = false`, no cron, no resource binding, no secret. Its one binding is the variable `BUILD`, the commit, which each deploy sets with `--var BUILD:<12 hex>` (`docs/worker.md`) | 2026-11-02T07:57:49Z, deployed by the agent under ruling 14 with `cd apps/api && npx wrangler@4.150.0 deploy --var BUILD:$(git rev-parse --short=12 HEAD)` (DOM-030) | DOM-030 | remove the custom domain first (its row below), then `cd apps/api && npx wrangler@4.150.0 delete` |

A Worker row names its hostname, its cron triggers and every binding it holds
(R2, service, rate limit). The delete column is `npx wrangler delete --name <worker>`. It removes the Worker and its cron triggers. That it also removes the Worker's custom domain and its DNS record is assumed, not measured: the delete of wrangler 4.150.0 sends one DELETE of the Worker's service and makes no call on its domains. So a row removes the custom domain first.

Two Workers are temporary measurement Workers: the probe `domains-probe` (DOM-061) and the drill `domains-drill` (DOM-053). Each runs on workers.dev for its life, with `preview_urls = false`, binds only a temporary bucket and holds no data of value (`SECURITY.md`). Every Worker that serves callers has `workers_dev = false`. The row of a temporary Worker names the entry that deletes it, and moves to Retired with the date when it is deleted: the probe when DOM-002, DOM-005, DOM-007 and DOM-008 have closed (DOM-056 deletes it), the drill when its entry ends.

## Custom domains and certificates

A `[[routes]]` entry with `custom_domain = true` creates two things: a DNS
record and a certificate. A four-label hostname can trigger an advanced
certificate pack. Record the pack here when one is issued.

| hostname | Worker | certificate pack | created | delete |
| --- | --- | --- | --- | --- |
| `domains.pkgforge.dev` | `domains-pkgforge-dev`, by `routes = [ { pattern = "domains.pkgforge.dev", custom_domain = true } ]` in `apps/api/wrangler.toml` | none: the name is one label below the `pkgforge.dev` zone, so the zone's Universal certificate covers it | 2026-11-02T07:57:49Z, by the first deploy of the Worker (DOM-030), with its proxied `AAAA` record | in the dashboard: Workers and Pages, `domains-pkgforge-dev`, Settings, Domains and Routes, remove `domains.pkgforge.dev`. That this removes its DNS record is assumed, not measured, and the removal reads it back with `cf dns records list -z pkgforge.dev --name domains.pkgforge.dev`. That `npx wrangler@4.150.0 delete` of the Worker removes the custom domain too is assumed, not measured (the paragraph under the Workers table) |

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
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/root` | `pkgforge-dev/domains.pkgforge.dev`, through the first push of `root-promote.yml` with its own `GITHUB_TOKEN` (ruling 6), run 40905355025. Later writes by `root-promote.yml` through `workflow_call` prove the link: the first, from `ingest-live.yml` run 41257033038, pushed `r-20261101t004617z`, `root_seq` 2, at 2026-11-01T00:46:24Z, and `root:latest` held `root_seq` 45 at 07:40:26Z (`node scripts/root/show.mjs`, exit 0) | public: MEASURED 2026-10-29T15:49:24Z, `node scripts/root/show.mjs --ref latest` and `node scripts/ghcr/check-public.mjs root` exit 0 with no credential, and an anonymous `curl` of `root/manifests/latest` answers 200 | `root-promote.yml` (DOM-020), the one writer: write-once dated tags `r-<YYYYMMDDtHHMMSSz>`, one a promotion, and `latest`, which moves forward only, last, after the guard read (`docs/architecture.md` section 4.7). The first run writes `root_seq` 1 with no pack. New roots stop when `root-promote.yml` and every call of it are removed; whether `gh workflow disable root-promote.yml` also stops its runs through `workflow_call` is not measured | 2026-10-29T15:49:16Z, by `root-promote.yml` run 40905355025 (DOM-020): `root:latest` did not exist before the run (`live none`), and it pushed `r-20261029t154910z`, `root_seq` 1 with no pack | none by an agent or a workflow (absolute 13): the dated roots stay, like every package |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/obs` | `pkgforge-dev/domains.pkgforge.dev`, through the first push of `ingest-live.yml` with its own `GITHUB_TOKEN` (ruling 6), run 41257033038 | public: MEASURED 2026-11-01T07:38:26Z to 07:40:36Z, `node scripts/ghcr/tags.mjs obs` and `node scripts/ghcr/check-public.mjs obs` exit 0 with no credential. `scripts/ghcr/push.mjs` reads each pushed object back with no credential and exits 4 when it does not read | `ingest-live.yml` (DOM-024), the job `ingest`: write-once segment tags `<source>.<start>.<end>` and `<source>.<YYYYMMDD>.<sha12>`, each with `-d` for a segment of `domains`, and the raw lane tags `raw-<source>.<start>.<end>` (`docs/architecture.md` section 4.1). `gh workflow disable ingest-live.yml` stops new tags | 2026-11-01T00:42:39Z, by `ingest-live.yml` run 41257033038 (DOM-026), the job `ingest (kafka, oi-nrd)`: its first push is `obs:raw-oi-nrd.20261022t130050z.20261022t140000z`, and the run pushed 36 segments and 36 raw lane objects. No run pushed a segment before it, since every lane was empty until DOM-026 | none by an agent or a workflow (absolute 13): the tags stay, like every package |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/state` | `pkgforge-dev/domains.pkgforge.dev`, through the first push of `ingest-live.yml` with its own `GITHUB_TOKEN` (ruling 6), run 41257033038 | public: MEASURED 2026-11-01T07:38:26Z to 07:40:36Z, `node scripts/ghcr/tags.mjs state --prefix state-` and `node scripts/ghcr/check-public.mjs state` exit 0 with no credential. Each move reads its tag back with no credential (`docs/format.md` section 17.2) | `ingest-live.yml` (DOM-024), the job `push`: `latest`, which moves under the guard, its write-once run tags `state-<YYYYMMDDtHHMMSSz>` and the daily snapshot `state-<YYYYMMDD>`; `ledger-delta`, which moves under the guard, and its run tags `ledger-delta-<YYYYMMDDtHHMMSSz>`. `compact-daily.yml` (DOM-023), the job `push`: write-once `ledger-filter-<YYYYMMDD>`, and moves of `ledger-delta`. `gh workflow disable` of both stops new tags | 2026-11-01T00:45:58Z, by `ingest-live.yml` run 41257033038 (DOM-024, DOM-026), the job `push`: it read `live state:latest none`, pushed `state:state-20261101t004553z`, moved `latest` from none, read it back with no credential, and wrote the snapshot `state-20261101`. `compact-daily.yml` run 41266798719 pushed the first `ledger-filter-20261025` at 02:55:26Z and moved `ledger-delta` from none at 02:55:36Z | none by an agent or a workflow (absolute 13): the tags stay, like every package |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/names` | `pkgforge-dev/domains.pkgforge.dev`, through the first push of `compact-daily.yml` with its own `GITHUB_TOKEN` (ruling 6), run 41266798719 | public: MEASURED 2026-11-01T07:38:26Z to 07:40:36Z, `node scripts/ghcr/tags.mjs names --prefix domains-d-` and `node scripts/ghcr/check-public.mjs names` exit 0 with no credential. `scripts/ghcr/push.mjs` reads each pushed pack back with no credential | `compact-daily.yml`, `compact-weekly.yml`, `compact-monthly.yml` and `compact-yearly.yml` (DOM-023), the job `assemble`: write-once tier tags `<dataset>-<tier>-<span>` of `names` and `domains`, and `-rN` after a rebuild | 2026-11-01T02:54:26Z, by `compact-daily.yml` run 41266798719 (DOM-023), which the chain's step `due` dispatched: the job `assemble (domains-d-20261026, day, 2026-10-26)` pushed `names:domains-d-20261026` first. At 02:51:36Z to 02:51:37Z its day legs read that `names` lists no tag with no credential. The run pushed `domains-d-20261025` to `domains-d-20261027` and `names-d-20261025` to `names-d-20261028` | none by an agent or a workflow (absolute 13): the tags stay, like every package |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/feed` | `pkgforge-dev/domains.pkgforge.dev`, through the first push of `compact-daily.yml` with its own `GITHUB_TOKEN` (ruling 6), run 41266798719 | public: MEASURED 2026-11-01T07:38:26Z to 07:40:36Z, `node scripts/ghcr/tags.mjs feed --prefix feed-` and `node scripts/ghcr/check-public.mjs feed` exit 0 with no credential. `scripts/ghcr/push.mjs` reads each pushed pack back with no credential | `ingest-live.yml` (DOM-024), the job `push`: the hour packs `feed-h-<YYYYMMDDHH>`, written once (`scripts/state/hours.mjs`). The four compaction workflows (DOM-023), the job `assemble`: the tier packs of `feed` and `new-name`, and `-rN` after a rebuild | 2026-11-01T02:54:35Z, by `compact-daily.yml` run 41266798719 (DOM-023): the job `assemble (feed-d-20261027, day, 2026-10-27)` pushed `feed:feed-d-20261027` first. At 00:45:54Z the job `push` of `ingest-live.yml` run 41257033038 read that `feed` lists no tag with no credential, and the day legs of run 41266798719 read the same at 02:52:14Z to 02:52:37Z. The run pushed `feed-d-20261025` to `feed-d-20261027` | none by an agent or a workflow (absolute 13): the tags stay, like every package |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/ref` | `pkgforge-dev/domains.pkgforge.dev`, through the first push of `ref-refresh.yml` with its own `GITHUB_TOKEN` (ruling 6); its page under the repository answered 200 on 2026-10-29T06:49Z | public, proven by `node scripts/ghcr/check-public.mjs ref` with no credential at 2026-10-29T06:47:38Z (exit 0), and by the same check in the run | `ref-refresh.yml` (DOM-019), daily, by its cron `13 5 * * *`, which GitHub started hours late, or by the chain's step `due` 20 minutes after that instant (DOM-023): tags `psl-<sha12>`, `ctlogs-<sha12>` and `sources-<sha12>`, each written once. A new content adds one tag. The first run pushed `psl-1f96bae40adf` (338,012 B), `ctlogs-29e361747007` (62,375 B) and `sources-d33793f12605` (214 B, `config/sources.json` at 74dd42a); an unchanged file adds nothing. `gh workflow disable ref-refresh.yml` stops new tags | 2026-10-29, by `ref-refresh.yml` run 40831098846 (DOM-019), dispatched at 06:44:59Z: absent at 2026-10-29T00:38:16Z, three tags at 06:47:38Z | none by an agent or a workflow (absolute 13): the tags stay, like every package |

The created column of `obs`, `state`, `names` and `feed` gives the first push
in its run's log, and their visibility column gives the anonymous reads. The
package records, with `created_at` and `visibility`, are not read:
`gh api orgs/pkgforge-dev/packages/container/domains.pkgforge.dev%2F<package>`
exits 1 with HTTP 403 for each, since the gh login holds no `read:packages`
scope (READ 2026-11-01T07:38:06Z).

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
| Measure clock schedule | `measure-clock-schedule.yml` | cron `*/5 * * * *`, dispatch | `tick`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-001) | disabled 2026-10-30T20:21:36Z with `gh workflow disable measure-clock-schedule.yml`, once its 48 hours were read (DOM-001); remove the file |
| Measure clock chain | `measure-clock-chain.yml` | dispatch only; each run dispatches the next until the repository variable `CHAIN_END` | `measure-chain`: `actions: write`, `contents: read` | 2026-10-28, commit 5e7a646 (DOM-001) | ended by itself at `CHAIN_END` 2026-10-30T15:15:58Z, its last run created at 15:15:09Z (DOM-001); `gh workflow disable measure-clock-chain.yml`, then remove the file |
| Measure clock chain keepalive | `measure-clock-chain-keep.yml` | cron `*/30 * * * *`, dispatch | `keepalive`: `actions: write`, `contents: read` | 2026-10-28, commit 5e7a646 (DOM-001) | disabled 2026-10-30T20:21:36Z with `gh workflow disable measure-clock-chain-keep.yml`, the chain having ended (DOM-001); remove the file |
| Measure feeds | `measure-feeds.yml` | dispatch only; a chain of long jobs, each dispatching the next until the dispatch input `until` (the start plus 7 days) | `measure-chain`: `actions: write`, `contents: read`; `poll`: `contents: read` | 2026-10-28, commit 5e7a646; GitHub accepted the file from commit 69eff0d (DOM-012) | `gh workflow disable measure-feeds.yml`, then remove the file |
| measure-kafka | `measure-kafka.yml` | dispatch only | `measure`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-004) | remove the file |
| Measure a GHCR push | `measure-push.yml` | dispatch only | `measure-push`: `contents: read`, `packages: write` | 2026-10-28, commit 5e7a646 (DOM-006) | remove the file; the package it pushed stays |
| Measure THC day | `measure-thc-day.yml` | dispatch only | `plan`, `measure` and `merge`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-009) | remove the file |
| measure-thc-monthly | `measure-thc-monthly.yml` | dispatch only | `measure`: `contents: read` | 2026-10-28, commit 5e7a646 (DOM-010) | remove the file |
| Measure tiles | `measure-tiles.yml` | dispatch only; a chain of jobs, each dispatching the next until the dispatch input `until` | `measure-chain`: `actions: write`, `contents: read`; `rounds`: `contents: read` | 2026-10-28, commit ec0014f (DOM-011); the chain dispatched at 2026-10-28T23:43:26Z with `until=2026-10-29T23:43:25Z` | the chain ends by itself after `until`; `gh workflow disable measure-tiles.yml`, then remove the file |
| Measure Range reads through the probe Worker | `measure-range-load.yml` | dispatch only | `measure`: `contents: read` | 2026-10-28, commit ec0014f (DOM-007) | remove the file with the probe (DOM-056) |
| Promote the root | `root-promote.yml` | dispatch, and `workflow_call` from the ingest and compaction workflows; every run waits in the concurrency group `root-writer` (`queue: max`, no cancel, ruling 18), and two runs through `workflow_call` queue in it (MEASURED 2026-10-29T15:50Z, DOM-020: the second call's promote job started 2 s after the first's ended) | `promote`: `contents: read`, `packages: write` (`issues: write` joins when DOM-034 adds the issue script; until then the no-op step that stands in for it needs no grant, and fails the job) | 2026-10-29, commit 34c573f (DOM-020); its first run, 40905355025, was dispatched at 15:48:58Z and ended `success` | `gh workflow disable root-promote.yml`, then remove the file and every call of it; the root package and its tags stay |
| Refresh the ref package | `ref-refresh.yml` | cron `13 5 * * *`, dispatch, and the chain's step `due` when due (DOM-023, below the table) | `ref`: `contents: read`, `packages: write` (`issues: write` joins with DOM-034) | 2026-10-29, commit 74dd42a (DOM-019); its first run, 40831098846, was dispatched at 06:44:59Z and ended `success` | `gh workflow disable ref-refresh.yml`, then remove the file and its row of `DUE`; the ref package and its tags stay |
| Compact the days | `compact-daily.yml` | cron `35 1 * * *`, dispatch with `day`, `rebuild` and `first-ledger`, and the chain's step `due` when due (DOM-023, below the table); every run waits in the concurrency group `compact` (`queue: max`, no cancel) | `plan`, `count`, `compact`, `day`, `gather`: `contents: read`; `assemble`: `contents: read`, `packages: write` (the day packs, to `names` and `feed`); `push`: `contents: read`, `packages: write`, after `assemble`, in the group `root-writer` (`ledger-filter-YYYYMMDD` of `state`, then the move of `ledger-delta` under the guard with `scripts/state/move.mjs ledger-delta --onto` the newest filter pushed); `promote`: calls `root-promote.yml` with `contents: read`, `packages: write`. Every job that holds `packages: write` runs on `main` alone, except `promote`, which only calls `root-promote.yml` and runs after jobs that do (rule 3 of `scripts/check-workflows.mjs`) | 2026-10-30, commit c9081dd (DOM-023); its first run, 41176163422, was dispatched at 2026-10-31T06:20:01Z and ended `success`, and run 41266798719, which the chain's step `due` dispatched at 2026-11-01T02:50:28Z, built its first day packs | `gh workflow disable compact-daily.yml`, then remove the file and its row of `DUE`; the packs and the filters it pushed stay |
| Compact the weeks | `compact-weekly.yml` | cron `50 3 * * 1`, dispatch with `span` and `rebuild`, and the chain's step `due` when due (DOM-023, below the table); group `compact` | `plan`, `count`, `compact`, `gather`: `contents: read`; `assemble`: `contents: read`, `packages: write`; `promote`: calls `root-promote.yml` with `contents: read`, `packages: write` | 2026-10-30, commit c9081dd (DOM-023); no run (READ 2026-11-01T07:48:19Z, `gh run list --workflow compact-weekly.yml`) | `gh workflow disable compact-weekly.yml`, then remove the file and its row of `DUE`; the packs it pushed stay |
| Compact the months | `compact-monthly.yml` | cron `50 4 1 * *`, dispatch with `span` and `rebuild`, and the chain's step `due` when due (DOM-023, below the table); group `compact` | as `compact-weekly.yml` | 2026-10-30, commit c9081dd (DOM-023); its first run, 41275876366, which the chain's step `due` dispatched at 2026-11-01T05:10:16Z, ended `success` with no unit ready | `gh workflow disable compact-monthly.yml`, then remove the file and its row of `DUE`; the packs it pushed stay |
| Compact the years | `compact-yearly.yml` | cron `50 5 1 1 *`, dispatch with `span` and `rebuild`, and the chain's step `due` when due (DOM-023, below the table); group `compact` | as `compact-weekly.yml` | 2026-10-30, commit c9081dd (DOM-023); no run (READ 2026-11-01T07:48:19Z, `gh run list --workflow compact-yearly.yml`) | `gh workflow disable compact-yearly.yml`, then remove the file and its row of `DUE`; the packs it pushed stay |
| Ingest live | `ingest-live.yml` | cron `7,37 * * * *` (once an interval of the chain, ruling 27), dispatch with `sources`, `from` and `to`, and the dispatches of its own job `chain` under the clock `actions-chain` of `config/clock.json` (DOM-003); every run waits in the concurrency group `ingest-live` (`queue: max`, no cancel) | `plan`: `contents: read`; `ingest`: `contents: read`, `packages: write` (segments and raw lane objects, to `obs`); `push`: `contents: read`, `packages: write`, in the group `root-writer` (`feed-h-` hour packs, `ledger-delta` and `latest` of `state`); `promote`: calls `root-promote.yml` with `contents: read`, `packages: write`; `chain`: `actions: write`, `contents: read`, with which it dispatches this workflow and the five workflows of `DUE` of `scripts/ingest/chain.mjs` (DOM-023). Every job that holds `packages: write` runs on `main` alone, except `promote` (rule 3 of `scripts/check-workflows.mjs`). `issues: write` joins the job `ingest` with DOM-034 | 2026-10-30, commit ad767b3 (DOM-024); its first run, the schedule run 41142944289 at 23:11:29Z, ended `success`, and run 41257033038, created 2026-11-01T00:30:19Z, is its first run with a leg (DOM-026) | `gh workflow disable ingest-live.yml`, which also ends the chain, since a dispatch of a disabled workflow starts no run [assumed, not measured], and with it the step `due`, so the crons alone start the compactions and `ref-refresh.yml`, hours late; then remove the file. The packages it pushed stay |
| Worker tests | `worker.yml` | push to `main` that changes `apps/api/**` or the workflow, dispatch | `test`: `contents: read` | 2026-11-02T07:55:11Z, the push of c0c7cd5 (DOM-030); its first run 41409385897 concluded `success` | remove the file |
| Measure a compaction range | `measure-compact.yml` | dispatch only, with `dataset`, `inputs`, `rows` and `overlap` | `measure`: `contents: read`; it pushes nothing and reads nothing from GHCR | 2026-10-30, commit c9081dd (DOM-023); its run 41032308505, dispatched at 09:17:09Z, ended `success` | temporary: remove the file and `scripts/compact/measure.mjs` with its test when DOM-023 closes, after the result lands in `docs/research/measure/DOM-023/` |

The delete column is removing the file in a commit, or `gh workflow disable <workflow>` to stop it without a commit.

The chain's step `due` (DOM-023) dispatches each workflow of the table `DUE` of
`scripts/ingest/chain.mjs`: the four compactions and `ref-refresh.yml`. The
commit that removes one of those files removes its row of `DUE`, since the
test of `DUE` fails while a removed file keeps its row. A disabled workflow
keeps its row, and the chain then dispatches it at every run, which GitHub
refuses [assumed, not measured], with one warning a run.

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
| `http_ratelimit` of `pkgforge.dev`, its one rule `200req/Second` | its expression ends with `and not (http.host eq "domains.pkgforge.dev")`, so the rule covers no request to the host (ruling 12); nothing else in the rule changed | 2026-10-28T15:53:56Z by the operator, the ruleset's version 22, read back at 15:55:16Z (DOM-062) | the operator (ruling 15) | the operator runs `cf rulesets rules update <rule> -z pkgforge.dev --ruleset-id <ruleset> --body <the rule without that clause>`, the command that DOM-062 validated with `--validate-only` at 2026-10-28T15:36Z for the change; the undo itself is not validated |

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
| 2026-11-02T07:57:49Z | `domains-pkgforge-dev` | `ee2d30ae-d08c-44af-a004-9a7cab4364fe` | c0c7cd58f19e |
