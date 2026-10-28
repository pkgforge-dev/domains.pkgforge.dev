# Progress

The record: where the work stands and what is next. Rewritten every session;
it carries no history (the git log and the entries do). The work order below
is the only one.

## State

- **Tree:** committed on `main` and pushed. The skeleton is commit 4e1db17; the first wave of builds (the workspace, CI, the probe Worker and the measurement workflows) follows it.
- **Last session:** started 2026-10-28T10:11:54Z: asked the operator what was unsettled (rulings 14 to 17 of `TODO/RULES.md` section 5), then works the order unattended.
- **Deployed:** the probe Worker `domains-probe` on workers.dev and its bucket `domains-probe` (DOM-061, deployed 2026-10-28T15:13:54Z; first tick 15:23:24Z), and the public GHCR package `probe` (DOM-006). No serving Worker, no custom domain and no cache bucket yet.
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

**62 items. 47 open, 9 partial, 0 blocked, 6 done.**

## What this session did

- Asked the operator the four questions the record left open and recorded the answers as rulings 14 to 17 (`TODO/RULES.md` section 5): the agent runs this project's Cloudflare and repository changes itself; the zone's rate-limit rules stay the operator's blocked decision (DOM-062, new); the `/v1/new` checkpoint is not a stop; the clock thresholds stay 15 and 60 minutes.
- Set the repository's default workflow permission to `read` (former Operator action 3), under ruling 14.
- Built the first wave, eight entries, now partial: the npm workspace with `packages/core` and the workerd harness `packages/testkit`, the type check as a gate step and `ci.yml` (DOM-013); the probe Worker `probes/worker` (DOM-061); and the measurement workflows and scripts of DOM-001, DOM-004, DOM-006, DOM-009, DOM-010 and DOM-012. Three review lenses ran on the wave (door sweep, guard mutation, claim audit); their findings are fixed in the same change, and each entry's Built and Correction bullets record what was measured and corrected.
- Closed DOM-013 (CI run 40713652294 green on 5e7a646), DOM-004 (`measure-kafka.yml` run 40714194235: PASS, 10.7 GB a day on the wire for the four topics) and DOM-061 (the probe deployed by the agent under ruling 14, both crons writing). DOM-002's 48 hours started with the probe's first tick.
- Fixed `measure-feeds.yml`, which reached `main` with a YAML error (DOM-012 Correction), and dispatched every wave-1 measurement: the clock chain (`CHAIN_END` 2026-10-30T15:15:58Z), the feeds chain (until 2026-11-04T15:15:55Z), Kafka, the GHCR push, THC's one day (PASS, 146 s) and then its 54-day matrix, and THC's monthly stream.
- Closed DOM-006: two runs of `measure-push.yml` pushed with the job's own token, the package `probe` came out public and linked, and it reads anonymously.
- Closed DOM-009 (54 days of THC's dumps on runners: the slowest day 590 s, about 1.40 billion distinct names, and 25% to 31% new names a day even after 53 earlier days) and DOM-010 (the whole September monthly file: 6,364,111,723 two-field records and no CNAME targets, 142 MB/s down and 18.8 MB/s through gzip and awk).
- Read the `pkgforge.dev` zone's rules with the `cf` CLI, as the operator asked: the rate-limit rule `200req/Second` covered `domains.pkgforge.dev`. The agent prepared and validated the exclusion; the operator applied it at 15:53:56Z, and DOM-062 is no longer blocked.
- Built the second wave, six entries, now partial, and ran the three lenses on it:
  - DOM-014: the workflow policy check, now a gate step.
  - DOM-015: the names package with the Public Suffix List and reversed keys. Address literals are refused as `numeric-tld`, and architecture section 3.1 says so.
  - DOM-011: the names-tile chain.
  - The probe routes `/kafka`, `/range` and `/decode` (DOM-005, DOM-007, DOM-008), with their measurement scripts.
- Read the account's plan with the `cf` CLI: Workers Paid, so the 10 ms CPU limit of Workers Free does not bind the probe (DOM-002).
- Ruling 11: the THC readers of DOM-009 and DOM-010 sent no User-Agent. The constant now lives in `scripts/lib/user-agent.mjs`, and every reader sends it, with tests that hold it.
- Set the probe's compatibility date to 2026-10-13, the newest date the workerd that wrangler 4.150.0 pins runs, so the probe deploys with the date its tests run with (DOM-061 and DOM-030 Corrections).

## What is in progress

Nine entries are partial. Each one's Waiting line names the instant its result is due and what closes it:

| entry | waits for |
| --- | --- |
| DOM-001 | 48 hours of the schedule and the chain (`CHAIN_END` 2026-10-30T15:15:58Z) |
| DOM-002 | 48 hours of the probe's crons from its first tick, 2026-10-28T15:23:24Z |
| DOM-005 | the probe's `/kafka` deploy and its 10-minute run now; the memory sweep after DOM-002 sets `crons = []` |
| DOM-007 | the `/range` deploy, the cache check and the single reads now; the loads at 20, 50 and 100 requests a second after `crons = []` |
| DOM-008 | the sample packs in R2 and the `/decode` deploy now; the 2,000-request CPU run after `crons = []` |
| DOM-011 | 24 hours of the `measure-tiles.yml` chain |
| DOM-012 | 7 days of the `measure-feeds.yml` chain |
| DOM-014 | the `ci.yml` run of the commit that carries it |
| DOM-015 | the `ci.yml` run of the commit that carries it |

DOM-046 is open and waits on DOM-047 and DOM-058 (ruling 10). DOM-025 starts only if DOM-003 records a Worker clock.

## Start here next session

1. Close the partial entries as each Waiting line comes due. Each Waiting line names the run or the reading that closes it.
   - DOM-014 and DOM-015 close on the `ci.yml` run of their commit.
   - DOM-001, DOM-002, DOM-005, DOM-007 and DOM-008 close after DOM-002's 48 hours, 2026-10-30T15:30Z. The probe's loads wait for its `crons = []`.
   - DOM-011 closes after its 24 hours, and DOM-012 after 7 days.
2. DOM-003, once DOM-001 and DOM-002 have closed.
3. Foundation and the format: DOM-016, DOM-017 (the pack format waits for no measurement: its header names its codec and block size).
4. The verifier, the GHCR tool, the ledger, the root and the feed: DOM-018, DOM-019, DOM-021, DOM-020, DOM-022. Then compaction: DOM-023.
5. The ingest skeleton, built to the clock verdict: DOM-024. Then DOM-025 only if DOM-003 recorded a Worker clock; otherwise close it on the ruling.
6. The feed's adapters: DOM-026, DOM-027, DOM-028, DOM-029.
7. The Worker and the first routes: DOM-030, DOM-031, DOM-032, DOM-033. Then the watchdogs and the coverage table: DOM-034, DOM-035. Then run the operator checkpoint (`.com.np`, `.com` and `co.uk` windows from 1 h to 7 d through `https://domains.pkgforge.dev/v1/new`), record it in DOM-032 and continue (ruling 16).
8. Names: DOM-036, DOM-037, DOM-038, DOM-039, DOM-040, DOM-041.
9. THC's monthly database and the reverse routes: DOM-042, DOM-043, DOM-044, DOM-045.
10. Authority sources and validation: DOM-047, DOM-048, DOM-049, DOM-050, DOM-051, DOM-052.
11. Hardening: DOM-053, DOM-054, DOM-055, DOM-056, DOM-057, DOM-058. Then DOM-046, the CNAME source, from what DOM-047 and DOM-058 found (ruling 10).
12. The root documents and the consumer contract: DOM-059, DOM-060.

`node scripts/todo/next.mjs` derives the same waves from the `Depends on` lines.

Known limits, each from a measurement of 2026-10-27:
- The design values for sizes, run times and caps in `docs/architecture.md` are estimates marked [E] until DOM-001 to DOM-012 and DOM-023, DOM-043 and DOM-054 replace them.
- THC's daily dumps miss 2026-10-04 and 2026-10-09, so the corpus has two gaps that `meta` reports.
- Name-level newness is censored for about 200 days (DOM-041). Domain-level newness from feeds with their own history is not.

## Open questions

**Operator actions**, each only the operator can do:

None. DOM-062's zone rule is settled: the operator applied the exclusion of `domains.pkgforge.dev` from the rate-limit rule `200req/Second` at 2026-10-28T15:53:56Z, and the agent read version 22 back with the `cf` CLI. DOM-062 closes with its load test once DOM-030 is live.

Former Operator actions 1 (a wrangler login: present, account `Ajamx101@gmail.com's Account`, R2 enabled, MEASURED 2026-10-28T10:19:05Z) and 3 (the default workflow permission: `read` since 2026-10-28T10:18:52Z) are settled. The deletion of the probe Worker and its bucket is the agent's under ruling 14 (DOM-056).

**Design questions**, each settled by the entry named, with a recommendation:

- Rule 13 of `scripts/check-workflows.mjs` (DOM-014), read literally, puts the group `root-writer` on a workflow that calls `root-promote.yml`. DOM-020 and DOM-050 put it in `root-promote.yml` itself, and a caller and its called workflow in one group would wait on each other.
  - (a) Keep the literal rule, and DOM-020 keeps the group in the caller only.
  - (b) Exempt a caller of `root-promote.yml`, and require the group in the called file.
  - Recommendation: (b). DOM-020 decides it with a measured run when it writes `root-promote.yml`, in the same change as the check.

**Rulings asked for:** none. The four open points of 2026-10-27 were answered on 2026-10-28 (`TODO/RULES.md` §5, rulings 14 to 17).

## Settled

The durable list is `TODO/RULES.md` §5. This file keeps the pointer, not the list.
