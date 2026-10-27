# Resources

Every cloud resource this project creates, with the command that deletes it.
A row is written **before** its resource is created, in the same change
(AGENTS.md absolute 9). A resource nobody can find is a resource nobody can
remove.

The ledger has no rows yet: nothing is created. The repository is public, so the
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

## GHCR packages

OCI artifacts under the `pkgforge-dev` organisation. A package is created by the
first push of a workflow, with that workflow's own `GITHUB_TOKEN`, and the
workflow makes it public (`TODO/RULES.md` §5). No token is created for it.

| package | linked repository | visibility | pushed by | created | delete |
| --- | --- | --- | --- | --- | --- |

The delete column for every package reads: none by an agent or a workflow. The
operator alone may delete one, in the GitHub interface or with
`gh api -X DELETE /orgs/pkgforge-dev/packages/container/<package>`, and
deleting one destroys data that is kept always.

## GitHub Actions workflows

A workflow is a resource: it runs on a schedule or a push, spends minutes and
writes to GHCR.

| workflow | file | trigger | permissions | created | delete |
| --- | --- | --- | --- | --- | --- |

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
