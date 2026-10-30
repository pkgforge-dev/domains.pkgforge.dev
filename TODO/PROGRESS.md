# Progress

The record: where the work stands and what is next. Rewritten every session;
it carries no history (the git log and the entries do). The work order below
is the only one.

## State

- **Tree:** committed on `main` and pushed. The skeleton is commit 4e1db17; the first wave of builds (the workspace, CI, the probe Worker and the measurement workflows) follows it, then waves 2 and 3. Wave 4, the root and the feed (DOM-020, DOM-022), follows them, then the Renovate moves and DOM-011's close. Wave 5, the compaction (DOM-023), is the commit that carries this record.
- **Last session:** started 2026-10-28T10:11:54Z: asked the operator what was unsettled (rulings 14 to 17 of `TODO/RULES.md` section 5, and 18 to 25 on 2026-10-29), then works the order unattended.
- **Deployed:** the probe Worker `domains-probe` on workers.dev and its bucket `domains-probe` (DOM-061, deployed 2026-10-28T15:13:54Z, first tick 15:23:24Z). Its version 12cec14c, deployed 2026-10-28T23:42:35Z, adds `/kafka`, `/range` and `/decode`, and the bucket holds DOM-008's sample packs under `sample/v1/`, and the public GHCR packages `probe` (DOM-006) and `ref` (DOM-019, refreshed daily at 05:13 UTC). No serving Worker, no custom domain and no cache bucket yet.
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

**62 items. 39 open, 7 partial, 0 blocked, 16 done.**

## What this session did

- Asked the operator the four questions the record left open and recorded the answers as rulings 14 to 17 (`TODO/RULES.md` section 5): the agent runs this project's Cloudflare and repository changes itself; the zone's rate-limit rules stay the operator's blocked decision (DOM-062, new); the `/v1/new` checkpoint is not a stop; the clock thresholds stay 15 and 60 minutes.
- Asked the operator the two design questions wave 2 and wave 3 left open and recorded the answers as rulings 18 and 19: the group `root-writer` lives in `root-promote.yml` (DOM-020 changes rule 13 of the workflow check), and an RDAP creation date before 2026 sets `suspect` and is not evidence (DOM-050).
- Asked the operator three more questions and recorded the answers as rulings 20 to 22: the agent decides common-sense matters itself; a force-push with the admin bypass is allowed when asked for or needed; the root names every PSL hash its live packs use (`psl_live`, DOM-020).
- Under ruling 20, handled Renovate's pull requests: closed #4 (wrangler 4.155.0: the pin of 4.150.0 holds the compatibility date of the tests and the probe until DOM-030 moves both) and #5 (the runner image ubuntu v26: the clock and feed measurements run on ubuntu-24.04 until DOM-003), each with its reason as a comment. #1 (biome), #2 (node) and #3 (workers-types) go into the tree after wave 4's commit, each with a green gate; Renovate closes a pull request whose update is already on `main`.
- Did not rewrite history to remove the account name that commit 1a5a972 and its descendants carry (ruling 21 allows it when needed). A rewrite would change the SHA of every commit from 1a5a972 on, which the record, `docs/resources.md` and the immutable annotations of the `probe` and `ref` packages cite. The old commits would stay reachable through the open Renovate branches based on them. The name derives the probe's URL, and the probe is deleted when its measurements close (DOM-056). The current tree holds it nowhere, and `node scripts/scan-secrets.mjs` now refuses the shape of a wrangler account name.
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
- Closed DOM-014 and DOM-015 on `ci.yml` run 40789086109: 749 of 749 tests passed on Linux, with the workflow policy as the gate's third step.
- Redeployed the probe with the routes `/kafka`, `/range` and `/decode` at 23:42:35Z. It used `versions deploy`, so the cron triggers stayed as they were (DOM-002).
  - The Worker opens TCP sockets to the Zonestream broker and decodes its batches.
  - workers.dev keeps Cache API entries.
  - The sample packs are in R2 and decode to their manifest's CRC.
  - DOM-011's 24-hour tiles chain started at 23:43:26Z.
- Read the account's plan with the `cf` CLI: Workers Paid, so the 10 ms CPU limit of Workers Free does not bind the probe (DOM-002).
- Ruling 11: the THC readers of DOM-009 and DOM-010 sent no User-Agent. The constant now lives in `scripts/lib/user-agent.mjs`, and every reader sends it, with tests that hold it.
- Set the probe's compatibility date to 2026-10-13, the newest date the workerd that wrangler 4.150.0 pins runs, so the probe deploys with the date its tests run with (DOM-061 and DOM-030 Corrections).
- Built the third wave, five entries:
  - DOM-016: the source registry and the adapter contract (`packages/adapter`, `config/source-bits.json`, `config/sources.json`, `scripts/sources/build.mjs`, now a gate step).
  - DOM-017: the pack format DPK1, its writer, reader and merge (`packages/pack`, `docs/format.md`).
  - DOM-018: the verifier (`scripts/verify-pack.mjs`).
  - DOM-019: GHCR's layout, the anonymous reader, the push tool and `ref-refresh.yml` (`packages/ghcr`, `scripts/ghcr`).
  - DOM-021: the exact ledger and the provisional filter (`packages/ledger`).
- Ran the three lenses on wave 3 (door sweep 12, claim audit 16, guard mutation 15 findings), fixed them in six groups of disjoint files, and had a separate verification plant about 120 mutants against the fixes. Its 11 problems are fixed or recorded in the entries that inherit them (DOM-020, DOM-022, DOM-023, DOM-026, DOM-030, DOM-032, DOM-050).
  - The merge of a confidence kept the weaker OpenINTEL level; it now keeps the lowest level that is not 0.
  - A reader can refuse a valid block too large for a Worker before reading it (`maxRawBlockBytes`), and can hold the parts table to the store's sizes (`partSizes`).
  - Settled in `docs/architecture.md` section 3.3: a feed pack holds one record a domain, with `first_seen` a field, and `new-name` is DPK1 dataset 5.
- Closed DOM-016, DOM-017, DOM-018, DOM-019 and DOM-021 on `ci.yml` run 40830988277 (1,172 of 1,172 tests on ubuntu-24.04, none skipped). DOM-019 also on `ref-refresh.yml` run 40831098846: the package `ref` now holds the PSL, the CT log list and `sources.json`, and reads with no credential.
- Built the fourth wave on 2026-10-29, two entries, now partial:
  - DOM-020: the root. `packages/root`, `scripts/root/` and `.github/workflows/root-promote.yml`; rule 13 of the workflow check under ruling 18; the GHCR form of `scripts/verify-pack.mjs`; and `measure-root-writer.yml`, the caller that measures ruling 18 and goes at the entry's close.
  - DOM-022: the feed. `packages/feed`; the time copy that replaced the planned `tidx` layer (DPK1 datasets 6 and 7, `docs/format.md` section 14); the reason bits 4 and 5 of `feed_flags`; the check `time` of the verifier; and `scripts/bench/feed-window.mjs`, with its 21 runs in `docs/research/measure/DOM-022/`.
- Ran the three lenses (door sweep, claim audit, guard mutation) on the build and again on the fixes, fixed or answered every finding in four rounds, and had a final verification plant 90 mutants: 87 killed by the named test, 3 equivalent. `npm run gate` exited 0 at 2026-10-29T14:51:43Z with 1,359 tests: 1,356 pass and 3 platform skips of this Windows machine.
- Decided under ruling 20, each in its entry: the time copy in place of `tidx`, since a page by `tidx` read 122 of 123 blocks and one by the time copy reads 2; the `withdrawn` list of the root, kept 31 days, so a re-run cannot put back a pack a rollback took out; no overlapping packs in `feed` and `new-name`; compact `root.json`; `issues: write` out of the promotion until DOM-034; and a rebuild suffix on tier tags, which DOM-023 builds.
- Fixed the two problems of the final verification: a writer's `validateRoot` now refuses a pack of `feed` or `new-name` of tier `d` to `y` that holds records and no time copy, and `docs/architecture.md` section 3.3 sizes the feed at about 2 to 7 MB a day [E] for the key copy. Section 5.8 step 1 now gives the verify to the job that writes a pack.
- Pushed wave 4 as 34c573f and closed DOM-020 and DOM-022 on `ci.yml` run 40904791877 (1,360 of 1,360 tests on ubuntu-24.04, none skipped).
  - DOM-020 also on `root-promote.yml` run 40905355025: `root:latest` holds `root_seq` 1 with no pack, and reads with no credential.
  - Ruling 18 is measured: two calls of `root-promote.yml` queue in its group `root-writer` (runs 40905625954 and 40905643334, the second promote job 2 s after the first ended). The caller that measured it is removed.
- Asked the operator three design questions from wave 4's findings and recorded the answers as rulings 23 to 25: a quarantined day is served but never as new (DOM-029); a day no source covers is a hole named in `gaps`, not an empty pack (DOM-029); a rebuilt tier pack takes the suffix `-rN` on its tag (DOM-023).
- Moved biome to 2.6.4 (Renovate #1); its new rule `useMathMinMax` flags four string reductions, each now carrying a `biome-ignore` with its reason. Moved Node to 26.13.0 and `@types/node` to 26.6.6 (#2); the local gate ran on Node 26.7.0, and `ci.yml` runs the new version. Closed #3 (`@cloudflare/workers-types` 5.20261029.1) under ruling 20 with its reason: the types stay at 5.20261013.1, the compatibility date the pinned workerd runs, and DOM-030 moves wrangler, the date and the types together.
- Closed DOM-011 on 2026-10-30 from the chain's 9 runs: `PASS`, 48 of 48 slots, Geomys never throttled with the contact User-Agent, and a reliable set of 12 shards (Sycamore, Willow, Tuscolo and Gouda, 2026h2 to 2027h2) growing by 67.2 million entries a day. THC's day holds 91% to 94% of the four logs' names and Kafka about half, so the tiles are a source of their own. DOM-037 carries the reliable set; DOM-012 carries the chain's short tail runs as a Found.
- Built the fifth wave on 2026-10-29 and 2026-10-30, the compaction (DOM-023), now partial:
  - `packages/compact/` and the CLIs of `scripts/compact/`: the plan of a tier unit, the merge by key ranges in a matrix, the assembly, the hour pack of `feed`, and the day job that builds the `domains` and `feed` day packs and the ledger filter.
  - The four compaction workflows, `compact-daily.yml` to `compact-yearly.yml`, and `measure-compact.yml`.
  - The suffix `-rN` of ruling 25 in `packages/ghcr` and `packages/root`, the carry of the suspect verdicts in `packages/feed`, `docs/format.md` sections 15 and 16, and the half of rule 3 of the workflow check that keeps a job with `packages: write` on `main`.
- Ran the three lenses on wave 5 and fixed their findings in two rounds. A verification then planted 86 mutants: 79 killed, 2 equivalent, and 5 gaps. A third round answered the gaps with tests or by deleting the clause, and no mutant was planted after it. Decided D1, D2 and D3 under ruling 20, each a Decision of DOM-023: a unit that starts before `corpus_since` is never built, `new-name` has no hour pack, and a rebuild finds the build that already holds its bytes. `npm run gate` exited 0 at 2026-10-30T05:30:42Z with 1,573 tests: 1,570 pass and 3 platform skips of this Windows machine. No compaction has run on GitHub.
- Recorded what the compaction leaves to other entries, a Found or a Decision in each: DOM-014, DOM-024, DOM-029, DOM-034, DOM-036, DOM-037, DOM-038, DOM-041, DOM-042 and DOM-043.

## What is in progress

Seven entries are partial. Each one's Waiting line names the instant its result is due and what closes it:

| entry | waits for |
| --- | --- |
| DOM-001 | 48 hours of the schedule and the chain (`CHAIN_END` 2026-10-30T15:15:58Z) |
| DOM-002 | 48 hours of the probe's crons from its first tick, 2026-10-28T15:23:24Z |
| DOM-005 | the probe's `/kafka` deploy and its 10-minute run now; the memory sweep after DOM-002 sets `crons = []` |
| DOM-007 | the `/range` deploy, the cache check and the single reads now; the loads at 20, 50 and 100 requests a second after `crons = []` |
| DOM-008 | the sample packs in R2 and the `/decode` deploy now; the 2,000-request CPU run after `crons = []` |
| DOM-012 | 7 days of the `measure-feeds.yml` chain |
| DOM-023 | the first scheduled run of `compact-daily.yml` and one run of `measure-compact.yml` after the push; then its live Prove, once DOM-024's `state` guard moves `ledger-delta` and DOM-029's backfill has put THC's days in the root |

DOM-046 is open and waits on DOM-047 and DOM-058 (ruling 10). DOM-025 starts only if DOM-003 records a Worker clock.

## Start here next session

1. Close the partial entries as each Waiting line comes due. Each Waiting line names the run or the reading that closes it.
   - DOM-001, DOM-002, DOM-005, DOM-007 and DOM-008 close after DOM-002's 48 hours, 2026-10-30T15:30Z. The probe's loads wait for its `crons = []`.
   - DOM-012 closes after its 7 days.
2. DOM-003, once DOM-001 and DOM-002 have closed.
3. Compaction: DOM-023 is partial, built and gated, and has not run on GitHub. After the push, dispatch `measure-compact.yml` and record its result. Its live Prove waits on DOM-024's `state` guard and DOM-029's THC backfill (items 4 and 5), and its Waiting line names what closes it.
4. The ingest skeleton, built to the clock verdict: DOM-024. Then DOM-025 only if DOM-003 recorded a Worker clock; otherwise close it on the ruling.
5. The feed's adapters: DOM-026, DOM-027, DOM-028, DOM-029.
6. The Worker and the first routes: DOM-030, DOM-031, DOM-032, DOM-033. Then the watchdogs and the coverage table: DOM-034, DOM-035. Then run the operator checkpoint (`.com.np`, `.com` and `co.uk` windows from 1 h to 7 d through `https://domains.pkgforge.dev/v1/new`), record it in DOM-032 and continue (ruling 16).
7. Names: DOM-036, DOM-037, DOM-038, DOM-039, DOM-040, DOM-041.
8. THC's monthly database and the reverse routes: DOM-042, DOM-043, DOM-044, DOM-045.
9. Authority sources and validation: DOM-047, DOM-048, DOM-049, DOM-050, DOM-051, DOM-052.
10. Hardening: DOM-053, DOM-054, DOM-055, DOM-056, DOM-057, DOM-058. Then DOM-046, the CNAME source, from what DOM-047 and DOM-058 found (ruling 10).
11. The root documents and the consumer contract: DOM-059, DOM-060.

`node scripts/todo/next.mjs` derives the same waves from the `Depends on` lines.

Known limits, each from a measurement of 2026-10-27:
- The design values for sizes, run times and caps in `docs/architecture.md` are estimates marked [E] until DOM-001 to DOM-012 and DOM-023, DOM-043 and DOM-054 replace them.
- THC's daily dumps miss 2026-10-04 and 2026-10-09, so the corpus has two gaps that `meta` reports.
- Name-level newness is censored for about 200 days (DOM-041). Domain-level newness from feeds with their own history is not.

## Open questions

**Operator actions**, each only the operator can do:

None. The question on Renovate's pull requests was settled by ruling 20 on 2026-10-29: the agent decides such matters itself.

DOM-062's zone rule is settled: the operator applied the exclusion of `domains.pkgforge.dev` from the rate-limit rule `200req/Second` at 2026-10-28T15:53:56Z, and the agent read version 22 back with the `cf` CLI. DOM-062 closes with its load test once DOM-030 is live.

Former Operator actions 1 (a wrangler login: present, on the operator's account (its name is not recorded: it carries the workers.dev subdomain), R2 enabled, MEASURED 2026-10-28T10:19:05Z) and 3 (the default workflow permission: `read` since 2026-10-28T10:18:52Z) are settled. The deletion of the probe Worker and its bucket is the agent's under ruling 14 (DOM-056).

**Design questions:** none. DOM-029's question, whether a sighting by a quarantined source stops a later sighting of the domain being new, was decided on 2026-10-30 under ruling 20: yes, as `basePacks` and `rebuildLedger` of `packages/compact/src/daily.ts` do today (DOM-029's Decision of 2026-10-30T09:12Z).

The two design questions of 2026-10-28 and 2026-10-29 were answered on 2026-10-29 (`TODO/RULES.md` §5, rulings 18 and 19): the group `root-writer` lives in `root-promote.yml`, and an RDAP creation date before 2026 sets `suspect` and is not stored as evidence. The questions of wave 4 were decided on 2026-10-29 under ruling 20, each in its entry: the time copy in place of `tidx` (DOM-022), no overlapping packs in `feed` and `new-name` and the `withdrawn` list (DOM-020), and the conflict of a rebuilt tier pack with its write-once tag, decided as a rebuild suffix on tier tags that DOM-023 builds (DOM-023's Decision of 2026-10-29T15:18Z, `docs/architecture.md` section 4.7 rule 2). The other questions of wave 5 were decided on 2026-10-30 under ruling 20: D1, D2 and D3 of DOM-023, and the domains segments of the live CT sources (DOM-036, DOM-037).

**Rulings asked for:** none. The four open points of 2026-10-27 were answered on 2026-10-28 (`TODO/RULES.md` §5, rulings 14 to 17), and the questions of 2026-10-29 the same day (rulings 18 to 22, then 23 to 25 on wave 4's findings).

## Settled

The durable list is `TODO/RULES.md` §5. This file keeps the pointer, not the list.
