# Changelog

What shipped and when, newest first. Times are UTC.

## 2026-10-31

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
