# Progress

The record: where the work stands and what is next. The work order below is
the only one.

## State

- **Tree:** the session started on local `f105a12` with DOM-029 staged. Upstream `main` is `4fcdb48`, which records the second Worker deployment and closes DOM-030. This commit integrates the reviewed DOM-029 work and closes DOM-012.
- **Last session:** started 2026-11-27T07:59:17Z. Final recorded instant: 2026-11-27T08:44Z.
- **Deployed:** Worker `domains-pkgforge-dev` version `c8a325ab`, build `9f4da663dc5a`, deployed 2026-11-03T15:22:17Z with wrangler 4.156.1 (DOM-030, done). No serving R2 cache bucket. The probe Worker and bucket remain for DOM-056. The `root`, `obs`, `state`, `names`, `feed`, `ref` and `probe` GHCR packages are public. This session changed no deployment and ran no hosted THC ingest.
- **CI:** `ci.yml` runs the gate on each push to `main` (DOM-013).

## Baseline

| measure | reading |
| --- | --- |
| opening gate | Node v26.7.0, exit 1, 2,173 passing tests, 16 skips and two failing THC monthly tests. Windows awk stdout emitted CRLF. The parser now handles LF and CRLF and preserves literal payload CR. |
| pinned toolchain | Node v26.13.0 and npm 12.2.1 |
| deployed Worker and anonymous root | 2026-11-27T08:32:27Z, `/healthz` HTTP 200, build `9f4da663dc5a`. Anonymous GHCR read of the reported digest `sha256:9a57c30e0db7e5d7d36aee83f3e0f69f56f141ddc293173d6bea48013cbc8bec` validated root sequence 1248. |
| candidate gate | 2026-11-27T08:41:43Z, exit 0 on `61ae27216cc4`, 2,226 tests passed, 3 Windows skips, 199 files |
| reconciled gate | `npm run gate`, with Node v26.13.0 and the rebased lockfile. The exact passing tree is in `.tmp/gate-passes.jsonl`. |

**63 items. 33 open, 2 partial, 0 blocked, 28 done.**

## What this session did

- Reviewed and repaired DOM-029's adapter, ingest workflow, state, promotion, ledger, compaction and record. The fixes bound malformed lines, distinguish host faults, protect gap repair across compaction and keep eligible late domains inputs available for daily exact-feed rebuilds. The daily holds incomplete publication pairs and their filters. DOM-029 records the independent gate part (c) evidence.
- Planned the two historical ingest windows against anonymous root 1248. September 1 through November 1 gave 60 run legs and two gaps. November 2 through November 26 gave 24 legs and a November 18 gap. The November 19 file was quarantined in the dry plan. These readings precede any live THC run. The September 12 standalone canary precedes bulk dispatch.
- Recovered DOM-012's 32 hosted poll artifacts. The committed-evidence replay passed with seven observed days for all four feeds, 1,037 polls from 31 runs in the sample and an 11.1-minute maximum gap. The deployed Worker and anonymous root were checked separately. The hosted proof, offline replay and both review and mechanical gate evidence close DOM-012.
- Corrected the README's description of public metadata and OCI artifacts and kept consumer route documentation in DOM-059, under ruling 26. Recorded the 60-run ingest sample under DOM-034. Three runs had state or root move failures with no common cause established by their public logs.

## What is in progress

| entry | waits for |
| --- | --- |
| DOM-029 | first live THC run, September canary, historical backfill, daily and higher-tier checks, ledger timing and verified historical feed repair |
| DOM-023 | its live compaction Prove after THC supplies the required day inputs |

DOM-046 is open and waits on DOM-047 and DOM-058 (ruling 10).

## Start here next session

1. Close the partial entries as each Waiting line comes due. Each Waiting line names the run or the reading that closes it.
2. THC: follow the close order in DOM-029. Drain workflow runs on earlier commits before the first THC promotion, and record the first live day L. Run the September 12 canary before the bulk backfill. Plan consecutive windows of at most 62 days, September 1 through November 1 (or L if earlier), then November 2 through L, including the one-day case if L is November 2. Dispatch only windows with work. After promotion, verify the no-work plan, both OBS manifest digests per day and full-day live coverage or verified replacement lineage. Run range compaction after the scheduled daily. Reconstruct the historical feed days ahead of closing the entry, including downstream days whose original joins used incomplete history. Prove rebuilt original-span higher-tier replacements. Then build the September weeks (September 7, 14 and 21) and the September and October months, and measure the first eligible ledger build. DOM-023's live Prove follows.
3. Compaction: DOM-023 is partial, built and gated. The chain's step `due` and DOM-026's dispatched day built its first day packs (runs 41266798719 and 41275690155), and its live Prove waits on DOM-029's THC backfill and range compaction (item 2). Its Waiting line names what closes it. The cron's late run 41287131429 built the days 2026-10-29 to 2026-10-31, so the live `feed` has no hole (DOM-026's Correction of 2026-11-01T10:40Z).
4. The feed's other adapters: DOM-027 and DOM-028. DOM-012 supplies the publication measurements.
5. The Worker and the first routes: DOM-030 done, DOM-031, DOM-032, DOM-033. Then the watchdogs and the coverage table: DOM-034, DOM-035. Then run the operator checkpoint (`.com.np`, `.com` and `co.uk` windows from 1 h to 7 d through `https://domains.pkgforge.dev/v1/new`), record it in DOM-032 and continue (ruling 16).
6. Names: DOM-036, DOM-037, DOM-038, DOM-039, DOM-040, DOM-041.
7. THC's monthly database and the reverse routes: DOM-042, DOM-043, DOM-044, DOM-045.
8. Authority sources and validation: DOM-047, DOM-048, DOM-049, DOM-050, DOM-051, DOM-052.
9. Hardening: DOM-053, DOM-054, DOM-055, DOM-056, DOM-057, DOM-058. Then DOM-046, the CNAME source, from what DOM-047 and DOM-058 found (ruling 10).
10. The root documents and the consumer contract: DOM-059, DOM-060. They stay last (ruling 26).

`node scripts/todo/next.mjs` derives the same waves from the `Depends on` lines.

Known limits:
- Current Worker routes expose metadata. Named-hole dataset readers need the DOM-029 validator before deployment.
- Root 1248 already contains OpenINTEL-only November weeks 45 through 47. All 63 daily manifests for November 2–22 and the nine live weekly manifests read anonymously with one PSL. Historical feed repair needs exact daily membership verified against prior roots or saved plans, corrected exact joins in day order and original-span replacements guarded under `root-writer`. Later feed days can need repair after earlier sightings change their newness.
- Daily pairing establishes co-publication of a domains and feed day. The pinned workflow's exact join and artifact verification establish their contents. A same-span reference from a manual promotion alone gives no exact-join evidence.
- Runner duration and September memory estimates await the canary. The estimated ledger rebuild cost awaits its first eligible hosted daily.
- Name-level newness is censored for about 200 days (DOM-041).

## Open questions

No operator action is pending. DOM-062's zone-rule exclusion remains settled.
Its deployed load proof is still due. Historical feed repair remains work in
DOM-029, with the verified input inventory before any promotion.

## Settled

The durable list is `TODO/RULES.md` §5. This file keeps the pointer.
