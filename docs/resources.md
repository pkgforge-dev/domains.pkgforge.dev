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
| `domains-probe` | the Worker `domains-probe`, binding `PROBE` | 2026-10-28, created by the agent under ruling 14 with `npx wrangler@4.150.0 r2 bucket create domains-probe`, and the rule added with `r2 bucket lifecycle add` (DOM-061) | lifecycle rule `expire-hot`: objects under `hot/` (1 MiB each, one every 5 minutes) expire after 3 days; the tick records (about 200 B each) and `heartbeat.json` stay | expire or delete every object (the lifecycle rule with `--expire-days 1` and a wait, or `npx wrangler@4.150.0 r2 object delete domains-probe/<key>`), then `npx wrangler@4.150.0 r2 bucket delete domains-probe` |

## GHCR packages

OCI artifacts under the `pkgforge-dev` organisation. A package is created by the
first push of a workflow, with that workflow's own `GITHUB_TOKEN`, and the
workflow makes it public (`TODO/RULES.md` §5). No token is created for it.

| package | linked repository | visibility | pushed by | created | delete |
| --- | --- | --- | --- | --- | --- |
| `ghcr.io/pkgforge-dev/domains.pkgforge.dev/probe` | `pkgforge-dev/domains.pkgforge.dev`, proven by the second run of DOM-006 | public, proven by the anonymous read of DOM-006 | `measure-push.yml` (DOM-006), tags `size-<MiB>m`, `layers-<N>` and `retag` | 2026-10-28, by `measure-push.yml` run 40714201294 (DOM-006): it did not exist before the run, and the package record reads `public` | none by an agent or a workflow |

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
