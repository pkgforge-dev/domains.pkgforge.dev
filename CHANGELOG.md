# Changelog

What shipped and when, newest first. Times are UTC.

## 2026-11-01

- The ingest skeleton runs live at 30 minutes (DOM-024, closed): run 41285713607, the first created on 69920f0, slept 582 s to 08:00:00Z, and the runs after it started 30 minutes apart by their logs, 08:00:07Z to 09:30:06Z. Each run moves `state` once, and `state:latest` reads with no credential. GitHub's API gave the times of 08:00 to 09:00Z an hour late, so the readings come from the logs.
- The first adapter runs live (DOM-026, closed): run 41257033038 of `ingest-live.yml`, the chain's first run on 986bbda, read OpenINTEL's three newly registered topics from their earliest retained offsets and pushed 36 verified segments and 36 raw lane objects to `obs`. The backlog drained in 21 runs: from run 41270746595 on, each source is under 1200 s behind. The first day packs are `names:domains-d-20261025` to `names:domains-d-20261028`, each with `facts.json`, and `feed:feed-d-20261025` to `feed:feed-d-20261028`. In `feed:feed-d-20261028` each of the 113,603 domains whose certificate is over 7 days old is suspect. The packages `obs`, `state`, `names` and `feed` are public and read with no credential.
- The chain runs every 30 minutes (ruling 27, DOM-024): `config/clock.json` sets `interval_min` to 30 in place of DOM-003's 10, the job `chain` of `ingest-live.yml` holds a sleep of 30 minutes, and its backstop cron has a slot at 7 and 37 minutes past the hour. The adapters' windows stay 10 minutes, so a day's segments, raw lane objects and records are the same, and the moves of `state` and the promotions fall to a third, about 48 a day. The newest window a caller reads is up to about 30 minutes and a run old [E], and a live tier faster than the chain comes later, from the operator. Ruling 26 keeps the route documents and the consumer contract (DOM-059, DOM-060) last. Deployed by the push: the queued successor was created on the commit before and sleeps to a 10-minute boundary, and the first run created on the commit sleeps to a 30-minute one (DOM-024's Waiting line).
- The step `due` of the chain opens tee in its own shell (DOM-023): on the runner, `$!` was unset after a process substitution on `node`'s own line, so every run of `ingest-live.yml` from 02:40Z concluded failure, though the chain, the dispatch and the ingest ran.
- The chain dispatches the scheduled workflows when due (DOM-023, partial): GitHub started the crons of `compact-daily.yml` and `ref-refresh.yml` 5 h 42 min to 6 h 10 min late in the 3 runs read, and the weekly, monthly and yearly crons have not fired yet, so the job `chain` of `ingest-live.yml` dispatches each of the five 20 minutes or more after its cron's instant when no run of it exists since that instant. The crons stay, and start the runs when the chain is off.

## 2026-10-31

- The first adapter, `oi-nrd` (DOM-026, partial): OpenINTEL's three newly registered topics as the sources `oi-nrd`, `oi-nrd-fqdn` and `oi-nrd-confirmed`, in the kafka lane of `config/lanes.json`. `packages/adapter` gains a TCP door for adapters (`ctx.connect`, with TCP recordings, their replay and a tap), the pinned list in the context (`ctx.psl`), a sandbox for an adapter's contract tests, and the shared Kafka client; the protocol and snappy decoders move there from the probe. A segment of `oi-nrd` carries the certificate ages of its events in a new layer `facts.json` (`docs/format.md` section 19), which the hour and day builds read, so a domain with an old certificate is `suspect`. Kafka members of the raw lane name their topic, partition and offsets. No WebSocket fallback is built. No deploy: the first chain run on the pushed commit is the live run, and DOM-026's Waiting line names what closes it.
- The clock decided (DOM-003): `scripts/measure/clock-verdict.mjs` derives the verdict from the three 48-hour results, and `config/clock.json` records `actions-chain`, the self-dispatch chain, at 10 minutes. `docs/clock.md` gives the numbers. The Worker hot tier (DOM-025) is not built: an Actions clock passes first.

## 2026-10-30

- The clocks measured over 48 hours (DOM-001, DOM-002): a self-dispatch chain of Actions runs and the probe Worker's minute cron both pass the freshness rule, a p90 gap of at most 15 min and a largest gap of at most 60 min. GitHub's `*/5` schedule fails it, with 10 runs in 48 hours. The schedule and its keepalive are disabled, and the probe runs no cron.
- The probe's Worker measurements closed (DOM-005, DOM-007, DOM-008), DOM-005 and DOM-007 from colo KTM, DOM-008's colo not read: a decode of 4,096 names costs at most 2 ms of CPU at p99, Range reads hold 100 requests a second cold and warm with no 429, and a Kafka fetch from a Worker holds 16 MiB a call. The pack format keeps its defaults, and R2 stays a cache.
- The ingest skeleton (DOM-024, partial): `packages/state`, the CLIs of `scripts/ingest/` and `scripts/state/`, `config/lanes.json` and the workflow `ingest-live.yml`. Each lane runs its adapters, verifies and pushes their segments and raw lane objects to `obs`, and proposes a cursor. One job in the group `root-writer` advances the cursors, builds the closed hours' `feed` packs, moves `state:latest` and `ledger-delta` only from the digest it read, and the promotion adds the packs `state` owes that keep the root's live set. Nothing of it has run on GitHub: it waits on DOM-003's clock and a first adapter.
- Compaction (DOM-023, partial): `packages/compact`, the CLIs of `scripts/compact/` and the workflows `compact-daily.yml` to `compact-yearly.yml`. They merge the packs of an hour, a day, a week, a month or a year into one pack of the tier above, which replaces them in the root; nothing is deleted from GHCR. The day job builds the `feed` day pack by the exact join and the ledger filter, and a rebuilt pack takes the tag suffix `-rN` (ruling 25). No deploy, and no compaction has run on GitHub yet: the root holds no pack to compact until THC's backfill (DOM-029).
- The names tiles measured over 24 hours (DOM-011, closed in commit 60accca): a reliable set of 12 shards, Sycamore, Willow, Tuscolo and Gouda from 2026h2 to 2027h2. THC's day holds 91% to 94% of their names and Kafka about half, so the tiles are a source of their own. No deploy.

## 2026-10-29

- `root:latest` in `ghcr.io/pkgforge-dev/domains.pkgforge.dev/root`, the one object every reader reads first, written by `root-promote.yml` alone and read with no credential. It holds `root_seq` 1 and no pack yet (DOM-020).
- The feed packs: new domains and names in a window, read in time order from a second copy of each pack sorted by `first_seen`, so a page of the 1,000 newest rows of a day reads 2 blocks (DOM-022).
- The `ref` package with the Public Suffix List, the CT log list and `sources.json`, refreshed daily and read with no credential (DOM-019). The source registry, the DPK1 pack format and its verifier, and the domain ledger (DOM-016, DOM-017, DOM-018, DOM-021).

## 2026-10-28

- The measurement probe `domains-probe` on workers.dev, with its bucket (DOM-061). It serves no caller: it measures the cron clock and, next, Kafka, Range reads from GHCR and decode CPU from a Worker.
- The workspace, `ci.yml`, the type check, and the workflow policy check as gate steps (DOM-013, DOM-014). The names package: normalisation, the Public Suffix List and reversed keys (DOM-015).
- Measured on runners: Kafka's four topics carry 10.7 GB a day; THC's 54 daily dumps hold about 1.40 billion distinct names; THC's monthly file holds no CNAME targets; GHCR takes 4 GiB pushes with the job's own token and reads them anonymously (DOM-004, DOM-006, DOM-009, DOM-010).

## 2026-10-27

- The skeleton: the router, the methodology and conventions, the record guard, the gate, the text and secret sweeps, and the commit hook, copied from the sibling repository and adapted. Record: `TODO/PROGRESS.md`. No deploy.
