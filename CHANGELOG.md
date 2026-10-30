# Changelog

What shipped and when, newest first. Times are UTC.

## 2026-10-30

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
