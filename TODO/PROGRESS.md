# Progress

The record: where the work stands and what is next. Rewritten every session;
it carries no history (the git log and the entries do). The work order below
is the only one.

## State

- **Tree:** committed on `main` and pushed. The skeleton is commit 4e1db17; the first wave of builds (the workspace, CI, the probe Worker and the measurement workflows) follows it.
- **Last session:** started 2026-10-28T10:11:54Z: asked the operator what was unsettled (rulings 14 to 17 of `TODO/RULES.md` section 5), then works the order unattended.
- **Deployed:** nothing yet. No Worker, no R2 bucket of this project, no custom domain and no GHCR package exists (MEASURED 2026-10-28T10:16Z, `npx wrangler r2 bucket list` names no `domains-` bucket).
- **CI:** `ci.yml` runs the gate on each push to `main` (DOM-013). Its first run is the one of the commit that adds it.

## Baseline

| measure | reading |
| --- | --- |
| `node scripts/todo/check.mjs` | exit 0 on the tree that carries this record |
| `node scripts/todo/count.mjs --check` | exit 0 on the same tree |
| the Actions settings of the repository | MEASURED 2026-10-28T10:18:52Z after the change under ruling 14: `{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}`. Every workflow still declares its permissions (DOM-014 checks that) |
| the gate at this session's start | MEASURED 2026-10-28T10:13Z, `npm run gate`: exit 0, 95 tests in 12 files, tree 2d95e9f84f24 |
| GitHub's schedule on a sibling repository | the `*/15` workflow of mirror-archlinux ran 40 times in its last 300 runs with a median gap of 233 min (MEASURED 2026-10-27T06:33Z by the operator's agent), and 67 runs with a median gap of 229 min, p90 314 and max 443 at 09:14Z; DOM-001 measures this repository |
| the corpus | none. THC's daily dumps give a horizon of 2026-09-01 once DOM-029 backfills them |

**62 items. 53 open, 8 partial, 1 blocked, 0 done.**

## What this session did

- Asked the operator the four questions the record left open and recorded the answers as rulings 14 to 17 (`TODO/RULES.md` section 5): the agent runs this project's Cloudflare and repository changes itself; the zone's rate-limit rules stay the operator's blocked decision (DOM-062, new); the `/v1/new` checkpoint is not a stop; the clock thresholds stay 15 and 60 minutes.
- Set the repository's default workflow permission to `read` (former Operator action 3), under ruling 14.
- Built the first wave, eight entries, now partial: the npm workspace with `packages/core` and the workerd harness `packages/testkit`, the type check as a gate step and `ci.yml` (DOM-013); the probe Worker `probes/worker` (DOM-061); and the measurement workflows and scripts of DOM-001, DOM-004, DOM-006, DOM-009, DOM-010 and DOM-012. Three review lenses ran on the wave (door sweep, guard mutation, claim audit); their findings are fixed in the same change, and each entry's Built and Correction bullets record what was measured and corrected.
- Set the probe's compatibility date to 2026-10-13, the newest date the workerd that wrangler 4.150.0 pins runs, so the probe deploys with the date its tests run with (DOM-061 and DOM-030 Corrections).

## What is in progress

Eight entries are partial. Each one's Waiting line names the instant its result is due and what closes it:

| entry | waits for |
| --- | --- |
| DOM-013 | the `ci.yml` run of the pushed commit |
| DOM-061 | the bucket, its lifecycle rule and the deploy of the probe, then a read of `/gaps?hours=1` |
| DOM-001 | 48 hours of the schedule and the chain (`CHAIN_END` set to the first dispatch plus 48 hours) |
| DOM-004 | one run of `measure-kafka.yml` |
| DOM-006 | two runs of `measure-push.yml` and the anonymous read of the probe package |
| DOM-009 | one run of `measure-thc-day.yml` for one day, then the 54-day matrix |
| DOM-010 | one run of `measure-thc-monthly.yml`, up to 6 hours of streaming |
| DOM-012 | 7 days of the `measure-feeds.yml` chain |

The deploy and the dispatches follow the push of the commit that holds them. DOM-046 is open and waits on DOM-047 and DOM-058 (ruling 10). DOM-025 starts only if DOM-003 records a Worker clock.

## Start here next session

1. Close the first wave as each Waiting line comes due: DOM-013, DOM-061, DOM-004, DOM-006 and DOM-009 the same day, DOM-010 within hours, DOM-001 after 48 hours and DOM-012 after 7 days. If a dispatch or the deploy has not run, run it first (each entry's Waiting line names it). The probe's two cron triggers start DOM-002's 48 hours, and DOM-002 reads them.
2. The first wave's remaining Proves, read from the runs: DOM-004, DOM-006, DOM-009, DOM-010, DOM-013.
3. The Worker measurements and the next foundation steps: DOM-005, DOM-007, DOM-008 (each waits for DOM-061, not for DOM-002's 48 hours), then DOM-011, DOM-014, DOM-015. Then DOM-003, once DOM-001 and DOM-002 have closed.
4. Foundation and the format: DOM-016, DOM-017 (the pack format waits for no measurement: its header names its codec and block size).
5. The verifier, the GHCR tool, the ledger, the root and the feed: DOM-018, DOM-019, DOM-021, DOM-020, DOM-022. Then compaction: DOM-023.
6. The ingest skeleton, built to the clock verdict: DOM-024. Then DOM-025 only if DOM-003 recorded a Worker clock; otherwise close it on the ruling.
7. The feed's adapters: DOM-026, DOM-027, DOM-028, DOM-029.
8. The Worker and the first routes: DOM-030, DOM-031, DOM-032, DOM-033. Then the watchdogs and the coverage table: DOM-034, DOM-035. Then run the operator checkpoint (`.com.np`, `.com` and `co.uk` windows from 1 h to 7 d through `https://domains.pkgforge.dev/v1/new`), record it in DOM-032 and continue (ruling 16).
9. Names: DOM-036, DOM-037, DOM-038, DOM-039, DOM-040, DOM-041.
10. THC's monthly database and the reverse routes: DOM-042, DOM-043, DOM-044, DOM-045.
11. Authority sources and validation: DOM-047, DOM-048, DOM-049, DOM-050, DOM-051, DOM-052.
12. Hardening: DOM-053, DOM-054, DOM-055, DOM-056, DOM-057, DOM-058. Then DOM-046, the CNAME source, from what DOM-047 and DOM-058 found (ruling 10).
13. The root documents and the consumer contract: DOM-059, DOM-060.

`node scripts/todo/next.mjs` derives the same waves from the `Depends on` lines.

Known limits, each from a measurement of 2026-10-27:
- The design values for sizes, run times and caps in `docs/architecture.md` are estimates marked [E] until DOM-001 to DOM-012 and DOM-023, DOM-043 and DOM-054 replace them.
- THC's daily dumps miss 2026-10-04 and 2026-10-09, so the corpus has two gaps that `meta` reports.
- Name-level newness is censored for about 200 days (DOM-041). Domain-level newness from feeds with their own history is not.

## Open questions

**Operator actions**, each only the operator can do:

1. ⛔ **DOM-062: the `pkgforge.dev` zone's rate-limit rules.** No rule may cover `domains.pkgforge.dev` (rulings 12 and 15). The login on this machine has no WAF scope, so only the operator can read them: dashboard, `pkgforge.dev`, Security, WAF, Rate limiting rules. Say in chat that none covers the host, or that it is excluded, and DOM-062 closes.

Former Operator actions 1 (a wrangler login: present, account `Ajamx101@gmail.com's Account`, R2 enabled, MEASURED 2026-10-28T10:19:05Z) and 3 (the default workflow permission: `read` since 2026-10-28T10:18:52Z) are settled. The deletion of the probe Worker and its bucket is the agent's under ruling 14 (DOM-056).

**Rulings asked for:** none. The four open points of 2026-10-27 were answered on 2026-10-28 (`TODO/RULES.md` §5, rulings 14 to 17).

## Settled

The durable list is `TODO/RULES.md` §5. This file keeps the pointer, not the list.
