# Progress

The record: where the work stands and what is next. The work order below is
the only one.

## State

- **Tree:** `c0170e9` introduced the 2025 ISC archive workflow and the offline exact-history planner and builder on `main`. This increment adds the indexed ISC runner and local history collection.
- **Session:** started 2026-11-27T07:59:17Z. This record includes the completed ISC archive and the September THC canary.
- **Deployed:** Worker `domains-pkgforge-dev` version `c8a325ab`, build `9f4da663dc5a`, deployed 2026-11-03T15:22:17Z with wrangler 4.156.1 (DOM-030, done). No serving R2 cache bucket. The probe Worker and bucket remain for DOM-056. The `root`, `obs`, `state`, `names`, `feed`, `ref` and `probe` GHCR packages are public. THC run 46007734746 published the November 26 names and domains segments in root 1259. The September 12 canary published both OBS manifests and root promotion left them owed. The manual ISC archive workflow registered on November 27 at 13:55:57Z and published 67 verified 2025 raw artifacts. The indexed ISC `feeds` lane is inactive.
- **CI:** `ci.yml` runs the gate on each push to `main` (DOM-013). Hosted run [46011370453](https://github.com/pkgforge-dev/domains.pkgforge.dev/actions/runs/46011370453) passed on `c0170e9` with 2,257 tests in 202 files and zero skips.

## Baseline

| measure | reading |
| --- | --- |
| opening gate | Node v26.7.0, exit 1, 2,173 passing tests, 16 skips and two failing THC monthly tests. Windows awk stdout emitted CRLF. The parser now handles LF and CRLF and preserves literal payload CR. |
| pinned toolchain | Node v26.13.0 and npm 12.2.1 |
| deployed Worker and anonymous root | 2026-11-27T08:32:27Z, `/healthz` HTTP 200, build `9f4da663dc5a`. Anonymous GHCR read of the reported digest `sha256:9a57c30e0db7e5d7d36aee83f3e0f69f56f141ddc293173d6bea48013cbc8bec` validated root sequence 1248. |
| deployed metadata recheck | 2026-11-27T20:45:28–29Z, `curl.exe -fsS` against `/healthz` and `/v1/index/latest` returned HTTP 200, build `9f4da663dc5a`. Anonymous GHCR read verified root sequence 1271 at `sha256:8274a616cabc1b2e0a97bfc1edfe83aaccb93185c0dc2a3729f51fd98ba9526f`. |
| candidate gate | 2026-11-27T08:41:43Z, exit 0 on `61ae27216cc4`, 2,226 tests passed, 3 Windows skips, 199 files |
| reconciled gate | `npm run gate`, with Node v26.13.0 and the rebased lockfile. The exact passing tree is in `.tmp/gate-passes.jsonl`. |

**63 items. 32 open, 3 partial, 0 blocked, 28 done.**

## What this session did

- Reviewed and repaired DOM-029's adapter, ingest workflow, state, promotion, ledger, compaction and record. The fixes bound malformed lines, distinguish host faults, protect gap repair across compaction and keep eligible late domains inputs available for daily exact-feed rebuilds. The daily holds incomplete publication pairs and their filters. DOM-029 records the independent gate part (c) evidence.
- Planned the two historical ingest windows against anonymous root 1248. September 1 through November 1 gave 60 run legs and two gaps. November 2 through November 26 gave 24 legs and a November 18 gap. The November 19 file was quarantined in the dry plan. These readings precede any live THC run. September 12 canary 46009749305 succeeded in 25m 32s and both OBS manifest hashes match its logs. Both refs stayed owed across the hole to the live spans. Bulk dispatch remains due.
- Recovered DOM-012's 32 hosted poll artifacts. The committed-evidence replay passed with seven observed days for all four feeds, 1,037 polls from 31 runs in the sample and an 11.1-minute maximum gap. The deployed Worker and anonymous root were checked separately. The hosted proof, offline replay and both review and mechanical gate evidence close DOM-012.
- Corrected the README's description of public metadata and OCI artifacts and kept consumer route documentation in DOM-059, under ruling 26. Recorded the 60-run ingest sample under DOM-034. Three runs had state or root move failures with no common cause established by their public logs.
- Archived 2025-10-26 through 2025-12-31 in 11 successful ISC windows. Public OBS enumeration matched one raw tag per UTC date, and independent manifest, gzip and member verification passed for October 26, November 16 and December 31. Ruling 28 starts indexed evidence on 2026-01-01. The indexed runner passed the production CLI fixture under `--no-push`. The independent admission exercise on root 1271 found that a continuous bridge to October 22 was needed for an oldest-first rollout. Production staging, promotion and adoption remain due (DOM-027).
- Verified the original November 2–22 archive lineage for 21 days and 63 manifest digests. The history plan against root 1248 covers six domains and feed weeks and leaves 12 downstream feed packs unresolved. `history.mjs collect --preflight` verified 174 public manifests and counted 357 layer files holding 511,653,054 blob bytes across 434 logical ranges. Collection and candidate building were exercised with local inputs. Production blob verification, full historical replay and guarded publication remain open (DOM-029).

## What is in progress

| entry | waits for |
| --- | --- |
| DOM-029 | replanned historical backfill, canary admission or re-adoption, daily and higher-tier checks, ledger timing and verified historical feed repair |
| DOM-023 | its live compaction Prove after THC supplies the required day inputs |
| DOM-027 | bounded indexed staging, edge-connected promotion, guarded cursor adoption, production run and indexed root proof |

DOM-046 is open and waits on DOM-047 and DOM-058 (ruling 10).

## Start here next session

1. Close the partial entries as each Waiting line comes due. Each Waiting line names the run or the reading that closes it.
2. THC: L is November 26, verified in root 1259. Replan consecutive windows of at most 62 days, September 1 through November 1 (or L if earlier), then November 2 through L. Verify the canary's owed or archived identity in that plan. Dispatch only windows with work, after the morning compaction matrices finish and during 03:30–16:00 UTC, aiming to start by 12:00 UTC. After promotion, verify the no-work plan, both OBS manifest digests per day and full-day live coverage or verified replacement lineage. Run range compaction after the scheduled daily. Pin the actual post-backfill root for the history plan, collect the inputs, verify original-span replacements and resolve downstream feed days before closing. Then build the September weeks (September 7, 14 and 21) and the September and October months, and measure the first eligible ledger build. DOM-023's live Prove follows.
3. Compaction: DOM-023 is partial, built and gated. The chain's step `due` and DOM-026's dispatched day built its first day packs (runs 41266798719 and 41275690155), and its live Prove waits on DOM-029's THC backfill and range compaction (item 2). Its Waiting line names what closes it. The cron's late run 41287131429 built the days 2026-10-29 to 2026-10-31, so the live `feed` has no hole (DOM-026's Correction of 2026-11-01T10:40Z).
4. The feed's other adapters: DOM-027's 2025 raw archive is verified. Pin the current domains edge and state. Stage and verify dated indexed manifests from 2026-01-01, promote edge-connected groups and adopt only the live covered cursor. Keep the `feeds` lane inactive until the indexed handoff is verified. Verify the next ordinary run and its anonymous root separately. DOM-028 follows. DOM-012 supplies the publication measurements.
5. The Worker and the first routes: DOM-030 done, DOM-031, DOM-032, DOM-033. Then the watchdogs and the coverage table: DOM-034, DOM-035. Then run the operator checkpoint (`.com.np`, `.com` and `co.uk` windows from 1 h to 7 d through `https://domains.pkgforge.dev/v1/new`), record it in DOM-032 and continue (ruling 16).
6. Names: DOM-036, DOM-037, DOM-038, DOM-039, DOM-040, DOM-041.
7. THC's monthly database and the reverse routes: DOM-042, DOM-043, DOM-044, DOM-045.
8. Authority sources and validation: DOM-047, DOM-048, DOM-049, DOM-050, DOM-051, DOM-052.
9. Hardening: DOM-053, DOM-054, DOM-055, DOM-056, DOM-057, DOM-058. Then DOM-046, the CNAME source, from what DOM-047 and DOM-058 found (ruling 10).
10. The root documents and the consumer contract: DOM-059, DOM-060. They stay last (ruling 26).

`node scripts/todo/next.mjs` derives the same waves from the `Depends on` lines.

Known limits:
- Current Worker routes expose metadata. Named-hole dataset readers need the DOM-029 validator before deployment.
- The pre-backfill root 1248 contains OpenINTEL-only November weeks 45 through 47. Original daily membership is verified by 63 digests. The local history CLI emits unpublished candidates and lists 12 unresolved downstream packs for that plan. A post-backfill plan, production layer verification, original-span replacements guarded under `root-writer` and later exact feed checks remain due.
- Daily pairing establishes co-publication of a domains and feed day. The pinned workflow's exact join and artifact verification establish their contents. A same-span reference from a manual promotion alone gives no exact-join evidence.
- The September canary measured wall time. GitHub's logs supplied no peak RSS or peak spool-disk measurement. The estimated ledger rebuild cost awaits its first eligible hosted daily.
- Name-level newness is censored for about 200 days (DOM-041).

## Open questions

No operator action is pending. DOM-062's zone-rule exclusion remains settled.
Its deployed load proof is still due. Historical feed repair remains work in
DOM-029, with the verified input inventory before any promotion.

## Settled

The durable list is `TODO/RULES.md` §5. This file keeps the pointer.
