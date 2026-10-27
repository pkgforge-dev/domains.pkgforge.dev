# Progress

The record: where the work stands and what is next. Rewritten every session;
it carries no history (the git log and the entries do). The work order below
is the only one.

## State

- **Tree:** uncommitted. The first commit carries the skeleton, the two designs, this record and its 61 entries.
- **Last session:** started 2026-10-27T08:19:47Z: the design and work record, written for an agent that has never seen another repository of the operator; an authoring session, nothing built.
- **Deployed:** nothing. No Worker, no R2 bucket, no custom domain and no GHCR package exists. `https://github.com/pkgforge-dev/domains.pkgforge.dev` is public and empty (MEASURED 2026-10-27T08:22:42Z, `gh repo view pkgforge-dev/domains.pkgforge.dev --json isEmpty,visibility`).
- **CI:** none. No workflow exists yet (DOM-013 creates the first).

## Baseline

| measure | reading |
| --- | --- |
| `node scripts/todo/check.mjs` | exit 0 on the tree that carries this record |
| `node scripts/todo/count.mjs --check` | exit 0 on the same tree |
| the Actions settings of the repository | MEASURED 2026-10-27T08:34:25Z: Actions enabled, all actions allowed, `default_workflow_permissions` is `write`, so every workflow must declare its permissions (DOM-014 checks that) |
| GitHub's schedule on a sibling repository | the `*/15` workflow of mirror-archlinux ran 40 times in its last 300 runs with a median gap of 233 min (MEASURED 2026-10-27T06:33Z by the operator's agent), and 67 runs with a median gap of 229 min, p90 314 and max 443 at 09:14Z; DOM-001 measures this repository |
| the corpus | none. THC's daily dumps give a horizon of 2026-09-01 once DOM-029 backfills them |

**61 items. 61 open, 0 partial, 0 blocked, 0 done.**

## What this session did

- Wrote `docs/architecture.md` (the design in force), `docs/sources.md` (every source, its cadence, its failure mode and its adapter's entry) and `docs/research/README.md` with `docs/research/2026-10-27-designs.md` (where the two designs agree, where they split and what decided each split).
- Kept the two independent designs and their scripts and results in `docs/research/`. Corrected four wrong cross-references in design B (it now says so in its header).
- Copied three research files of the operator's other repository into `docs/research/web-pkgforge-2026-10-27/`, and its GHCR reader into `docs/research/reference/ghcr.ts`, each with a provenance line.
- Filed 60 entries in five files: 12 measurements first, then the build in six phases. The review below added DOM-061, so the record holds 61.
- Kept the outputs and three scripts of those measurements in `docs/research/2026-10-27-record/`.
- Measured read-only, with the commands in the entries: THC's monthly CSV has two columns and no CNAME column (DOM-010); Geomys's names-tile host answers 429 to a client with no email address in its User-Agent (DOM-011); IPng serves names tiles for a recent range only (DOM-011); the ISC and WhoisDS publication data points (DOM-012); the Actions settings of this repository (DOM-014).
- Fixed the findings of an independent review of this record (2026-10-27): the probe Worker's deploy became its own entry (DOM-061) so the workspace, the pack format and the Worker measurements no longer wait for 48 hours; the workflow policy table and every entry's workflows were reconciled; the DOM-011, DOM-012 and DOM-049 samples moved from crons into long chained jobs; raw data is kept in a raw lane (Kafka batches and tile bodies as received); a VPS is pulled from, never pushed to, so no token exists; the ingest lanes propose cursors and one `promote` job advances them; THC's October volumes and the Hugging Face path were corrected, with a step-change rule for the quarantine; the commit hook, its tests and the secret shapes were tightened.

## What is in progress

Nothing is built. DOM-046 is open and waits on DOM-047 and DOM-058 (ruling 10). DOM-025 starts only if DOM-003 records a Worker clock.

## Start here next session

1. The measurements that need days of wall time, started first so they run while you build: DOM-001 (48 hours) and DOM-012 (7 days), which need only a push to `main` and a dispatch. Then DOM-061, the deploy of the probe Worker, as soon as Operator action 1 is done: its two cron triggers start DOM-002's 48 hours, and DOM-002 reads them.
2. The runner measurements and the workspace: DOM-004, DOM-006, DOM-009, DOM-010, DOM-013.
3. The Worker measurements and the next foundation steps: DOM-005, DOM-007, DOM-008 (each waits for DOM-061, not for DOM-002's 48 hours), then DOM-011, DOM-014, DOM-015. Then DOM-003, once DOM-001 and DOM-002 have closed.
4. Foundation and the format: DOM-016, DOM-017 (the pack format waits for no measurement: its header names its codec and block size).
5. The verifier, the GHCR tool, the ledger, the root and the feed: DOM-018, DOM-019, DOM-021, DOM-020, DOM-022. Then compaction: DOM-023.
6. The ingest skeleton, built to the clock verdict: DOM-024. Then DOM-025 only if DOM-003 recorded a Worker clock; otherwise close it on the ruling.
7. The feed's adapters: DOM-026, DOM-027, DOM-028, DOM-029.
8. The Worker and the first routes: DOM-030, DOM-031, DOM-032, DOM-033. Then the watchdogs and the coverage table: DOM-034, DOM-035. Then stop at the operator checkpoint: `.com.np`, `.com` and `co.uk` windows from 1 h to 7 d through `https://domains.pkgforge.dev/v1/new`.
9. Names: DOM-036, DOM-037, DOM-038, DOM-039, DOM-040, DOM-041.
10. THC's monthly database and the reverse routes: DOM-042, DOM-043, DOM-044, DOM-045.
11. Authority sources and validation: DOM-047, DOM-048, DOM-049, DOM-050, DOM-051, DOM-052.
12. Hardening: DOM-053, DOM-054, DOM-055, DOM-056, DOM-057, DOM-058. Then DOM-046, the CNAME source, from what DOM-047 and DOM-058 found (ruling 10).
13. The root documents and the consumer contract: DOM-059, DOM-060.

`node scripts/todo/next.mjs` derives the same waves from the `Depends on` lines.

**While Operator action 1 is absent** (no wrangler login yet), the Cloudflare side cannot start, and the build does not stop: build the GHCR and Actions side first. None of it needs Cloudflare. It is DOM-013 (workspace, harness, CI), DOM-014 (workflow policy), DOM-006 (a push measurement), DOM-015 and DOM-016 (names and the source registry), DOM-017 to DOM-020 (the pack format, the verifier, the GHCR tool and the root), DOM-021 to DOM-023 (the ledger, the feed packs and compaction), and the runner measurements DOM-004, DOM-009, DOM-010 and DOM-011. DOM-001 and DOM-012 run in Actions beside that work. What waits for the operator is DOM-061 and, behind it, DOM-002, DOM-005, DOM-007 and DOM-008; DOM-003 waits for DOM-002's 48 hours, and DOM-024 and the adapters wait for DOM-003. So Operator action 1 is on the critical path of the ingest: ask for it at the start of the first session.

Known limits, each from a measurement of 2026-10-27:
- The design values for sizes, run times and caps in `docs/architecture.md` are estimates marked [E] until DOM-001 to DOM-012 and DOM-023, DOM-043 and DOM-054 replace them.
- THC's daily dumps miss 2026-10-04 and 2026-10-09, so the corpus has two gaps that `meta` reports.
- Name-level newness is censored for about 200 days (DOM-041). Domain-level newness from feeds with their own history is not.

## Open questions

**Operator actions**, each only the operator can do:

1. **A wrangler login on the account that holds the `pkgforge.dev` zone.** `npx wrangler whoami` must list the account named by `account_id` in `worker/wrangler.toml` of mirror-archlinux at commit `669ac725f8081445c164113f2ed092533de112e2`; an agent may run it, because it lists account names and reads no secret. R2 must be enabled on it: `npx wrangler r2 bucket list` answers. DOM-061 needs this first (it deploys the probe that DOM-002, DOM-005, DOM-007 and DOM-008 use). DOM-030 and DOM-031 need it too. Every entry that deploys runs `whoami` first and records the account name it printed.
2. **The `pkgforge.dev` zone's rate-limit rules.** The operator ruled on 2026-10-27 that the zone's rate-limit rules lose their reach over the public services: no consumer is gated (`TODO/RULES.md` §5, ruling 12). DOM-030's Operator line reads the rules before the first deploy and asks for `domains.pkgforge.dev` to be left out of any rule that covers it.
3. **The repository's default workflow permissions** (optional hardening, admin only). It is `write` today. `gh api -X PUT repos/pkgforge-dev/domains.pkgforge.dev/actions/permissions/workflow -f default_workflow_permissions=read -F can_approve_pull_request_reviews=false`. Every workflow declares its own permissions either way (DOM-014).

5. **The deletion of the probe Worker and its bucket**, once DOM-002, DOM-005, DOM-007 and DOM-008 have closed. The commands are in DOM-056 and DOM-061.

**Rulings asked for:** none. The CNAME source, the User-Agent contact, the zone's rate-limit rules and CZDS were settled on 2026-10-27 (`TODO/RULES.md` §5, rulings 10 to 13).

## Settled

The durable list is `TODO/RULES.md` §5. This file keeps the pointer, not the list.
