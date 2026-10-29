# TODO

Every entry, one row each, sorted by id. An entry lives in the category file
its row links to, and closes there with its Prove command run and its output
recorded.

**The work order is not here.** [PROGRESS.md](PROGRESS.md)'s "Start here next
session" is the only one. This file carries the list, the counts, and the
argument behind the order.

How this repository is worked on: [RULES.md](RULES.md). The counts are derived
from the rows: `node scripts/todo/count.mjs` writes them, and
`node scripts/todo/check.mjs` fails the gate when a row, an entry or a count
disagrees.

## Priority

- **P0** breaks correctness, loses data, or takes a service down.
- **P1** a required capability does not exist or does not work.
- **P2** worth doing; nothing is wrong without it.
- **P3** worth recording so it is not rediscovered.

## Effort

S is under a day, M a few days, L a week. XL is longer and almost always two
entries pretending to be one.

## Status

`open`, `partial`, `blocked`, `done`. There is no `wontfix` and no `deferred`: a
blocked entry names its blocker and what would unblock it.
A bold **`done`** row closed with its Prove command run and its output
recorded; a plain `done` row closed on an operator ruling, with the ruling
recorded.

## Ordering

The argument behind the work order. The order itself respects the
`Depends on` lines: `node scripts/todo/next.mjs` derives the waves, and the
record guard refuses an order that lists an entry before an open dependency.

1. **Measure first (DOM-001 to DOM-012, and DOM-061).** Every size, speed and
   clock figure in `docs/architecture.md` is an estimate until its measurement
   runs. Three of them take days of wall time: the two clocks (DOM-001, DOM-002,
   48 hours each) and the publication times (DOM-012, 7 days). Start those first
   and build beside them. The clock verdict (DOM-003) gates the ingest workflow
   skeleton (DOM-024). The Worker measurements (DOM-005, DOM-007, DOM-008) need a
   deployed probe Worker and the operator's wrangler login. Deploying it is a
   step of its own (DOM-061, minutes), so they wait for that deploy and not for
   DOM-002's 48 hours of ticks. Until the operator has done that deploy, the
   Worker measurements and DOM-002 cannot start, and the build goes on without
   them: the workspace and CI, the workflow policy, the names package, the source
   registry, the pack format, the GHCR tool, the root and the ledger
   (`TODO/PROGRESS.md`, "Start here next session").
2. **Foundation before any adapter (DOM-013 to DOM-016).** The workspace and
   its workerd harness (DOM-013) wait for no measurement: its own smoke Worker
   proves that `deflate-raw` exists under the pinned date, and DOM-008 measures
   its CPU on Cloudflare later. The workflow policy check (DOM-014) precedes
   every workflow that writes to GHCR. The names package (DOM-015) and the source
   registry (DOM-016) are what every adapter and every pack imports.
3. **The format and the registry of truth before any publish (DOM-017 to
   DOM-020).** A pack (DOM-017) and its verifier (DOM-018) come first; the pack's
   header names its codec and block size, so DOM-008's verdict changes a default
   and not the layout, and DOM-017 does not wait for it. The GHCR
   packages and the push tool (DOM-019) follow. The root (DOM-020) is the only
   thing a reader trusts, so nothing publishes before it works.
4. **The new-domain feed is the first product (DOM-021 to DOM-035).** The
   operator asked for it first. The ledger (DOM-021) decides what is new. The
   feed packs (DOM-022) and compaction (DOM-023) make it queryable. The adapters
   follow in the order of their freshness: OpenINTEL's claims (DOM-026), ISC
   (DOM-027), the lists (DOM-028), then THC's daily dump (DOM-029), which is
   the largest and seeds the ledger's horizon of 2026-09-01. The Worker
   (DOM-030), `/v1/new` (DOM-032) and the dossier (DOM-033) give an operator
   checkpoint: queries for `.com.np`, `.com` and `co.uk` over windows of 1 h to
   7 d. The R2 cache (DOM-031) is an optimisation and does not block the
   checkpoint. The watchdogs (DOM-034) and the coverage table (DOM-035) keep it
   honest. The conditional Worker hot tier (DOM-025) is built only when DOM-003
   says so.
5. **Names second (DOM-036 to DOM-041).** Names need the same machinery at ten
   times the volume. The Kafka names (DOM-036) and the tiles (DOM-037) feed the
   names dataset (DOM-038), which the subdomain routes (DOM-039) and the dumps
   (DOM-040) read. Name-level newness (DOM-041) comes last because it is
   censored for about 200 days.
6. **THC's monthly database and the reverse routes (DOM-042 to DOM-046).** The
   mirror (DOM-042) and the packs (DOM-043) precede the routes (DOM-044). The
   monthly watcher (DOM-045) automates the next month. The CNAME source
   (DOM-046) is open and waits on the measurements of DOM-047 and DOM-058
   (ruling 10): THC's monthly file has no CNAME column, so the route answers
   `unsupported-by-source` until one of them shows CNAME records.
7. **Authority sources and validation (DOM-047 to DOM-052).** Zones and RDAP are
   the only evidence that may say `registered`. The gTLDs come from
   credential-free sources (DOM-051); CZDS is not used (ruling 13).
8. **Hardening (DOM-053 to DOM-058).** The R2 rebuild drill, the work caps, the
   failure drills, the runbooks, the external writer path and the measurement
   topic of OpenINTEL.
9. **Documents and the consumer contract last (DOM-059, DOM-060).** They
   describe every route, so every route exists first. A consumer can start on
   `/v1/new` from DOM-032 and read the root from DOM-020.

## Counts

**62 items. 42 open, 7 partial, 0 blocked, 13 done.**

| priority | open | partial | blocked | done | total |
| --- | --- | --- | --- | --- | --- |
| P0 | 0 | 0 | 0 | 0 | 0 |
| P1 | 24 | 7 | 0 | 13 | 44 |
| P2 | 15 | 0 | 0 | 0 | 15 |
| P3 | 3 | 0 | 0 | 0 | 3 |
| **All** | 42 | 7 | 0 | 13 | 62 |

## Entries

| ID | Priority | Category | Status | Item |
| --- | --- | --- | --- | --- |
| [DOM-001](ops.md) | P1 | ops | partial | Measure the Actions clock: a schedule and a self-dispatch chain |
| [DOM-002](ops.md) | P1 | ops | partial | Measure the Cloudflare cron clock with a probe Worker that writes a hot tier to R2 |
| [DOM-003](ops.md) | P1 | ops | open | Decide the clock from the measurements |
| [DOM-004](ingest.md) | P1 | ingest | **done** | Measure Kafka from a GitHub runner |
| [DOM-005](ingest.md) | P1 | ingest | partial | Measure Kafka from a Worker connect() |
| [DOM-006](storage.md) | P1 | storage | **done** | Measure a 1.5 GB push from a runner and that a first push comes out public |
| [DOM-007](storage.md) | P1 | storage | partial | Measure Worker Range reads from GHCR: cold, warm, and 20, 50 and 100 requests a second |
| [DOM-008](storage.md) | P1 | storage | partial | Measure deflate-raw decode CPU in workerd |
| [DOM-009](ingest.md) | P1 | ingest | **done** | Measure the THC daily job and the 54-day backfill |
| [DOM-010](ingest.md) | P1 | ingest | **done** | Measure THC's monthly database: columns, CNAMEs and stream speed |
| [DOM-011](ingest.md) | P1 | ingest | partial | Measure names-tile availability per log, Geomys's window and the overlap |
| [DOM-012](ingest.md) | P1 | ingest | partial | Measure when ISC and WhoisDS publish |
| [DOM-013](foundation.md) | P1 | foundation | **done** | The workspace, the workerd test harness and CI |
| [DOM-014](foundation.md) | P1 | foundation | **done** | Workflow policy check and pinned installers |
| [DOM-015](foundation.md) | P1 | foundation | **done** | Names: normalisation, the Public Suffix List and reversed keys |
| [DOM-016](foundation.md) | P1 | foundation | **done** | The source registry and the adapter contract |
| [DOM-017](storage.md) | P1 | storage | **done** | The pack format: writer, reader, merge and sparse index |
| [DOM-018](storage.md) | P1 | storage | **done** | Verify a pack before it counts |
| [DOM-019](storage.md) | P1 | storage | **done** | GHCR packages, tags, the push tool and the anonymous-read check |
| [DOM-020](storage.md) | P1 | storage | open | The root manifest and its forward-only promotion |
| [DOM-021](storage.md) | P1 | storage | **done** | The domain table: exact first and last seen, and the provisional filter |
| [DOM-022](storage.md) | P1 | storage | open | The new-domain feed packs |
| [DOM-023](storage.md) | P1 | storage | open | Compaction: hour, day, week, month and year |
| [DOM-024](ingest.md) | P1 | ingest | open | The state cursors and the ingest workflow skeleton |
| [DOM-025](ops.md) | P2 | ops | open | The Worker hot tier, only if the clock verdict is a Worker |
| [DOM-026](ingest.md) | P1 | ingest | open | oi-nrd: OpenINTEL's newly registered topics |
| [DOM-027](ingest.md) | P1 | ingest | open | isc-new: the ISC new-domain feed |
| [DOM-028](ingest.md) | P2 | ingest | open | whoisds, cenk-nrd and hagezi-nrd: the daily lists |
| [DOM-029](ingest.md) | P1 | ingest | open | thc-ct: THC's daily dumps and the 54-day backfill |
| [DOM-030](serve.md) | P1 | serve | open | The Worker: custom domain, GHCR reads, root cache and healthz |
| [DOM-031](storage.md) | P1 | storage | open | The R2 cache with a 5 GB guard |
| [DOM-032](serve.md) | P1 | serve | open | GET /v1/new for registrable domains |
| [DOM-033](serve.md) | P1 | serve | open | /v1/domain, /v1/sources, /v1/status and /v1/coverage |
| [DOM-034](ops.md) | P1 | ops | open | Watchdogs: keepalive, overdue dispatch and issues |
| [DOM-035](ops.md) | P2 | ops | open | The coverage table and cross-source agreement |
| [DOM-036](ingest.md) | P1 | ingest | open | oi-cs: OpenINTEL's certstream names |
| [DOM-037](ingest.md) | P1 | ingest | open | ct-tiles: names tiles of Let's Encrypt, Geomys and IPng |
| [DOM-038](storage.md) | P1 | storage | open | The names dataset: tiers and source masks |
| [DOM-039](serve.md) | P1 | serve | open | Subdomains, name lookup, name listing and batch lookup |
| [DOM-040](serve.md) | P1 | serve | open | Bulk dumps: daily names and new-domain files |
| [DOM-041](storage.md) | P2 | storage | open | New-name packs and the censoring flag |
| [DOM-042](ingest.md) | P1 | ingest | open | Mirror THC's monthly database into GHCR |
| [DOM-043](storage.md) | P1 | storage | open | The reverse-IP packs |
| [DOM-044](serve.md) | P1 | serve | open | /v1/ip and /v1/cnames |
| [DOM-045](ingest.md) | P2 | ingest | open | The monthly watcher |
| [DOM-046](ingest.md) | P2 | ingest | open | A mirrored source of CNAME targets |
| [DOM-047](ingest.md) | P2 | ingest | open | oi-zone: OpenINTEL's open ccTLD zones |
| [DOM-048](ingest.md) | P2 | ingest | open | sk-nic: the .sk registry list |
| [DOM-049](ingest.md) | P3 | ingest | open | oi-zonediff: Zonestream zone diffs |
| [DOM-050](ops.md) | P2 | ops | open | RDAP sampling: check claimed_new rows against registries |
| [DOM-051](ingest.md) | P2 | ingest | open | gTLDs without CZDS: ISC's year of dated files, DNS Coffee's daily counts, .gov and the zone walks |
| [DOM-052](ingest.md) | P2 | ingest | open | crt.sh and Cert Spotter: validation and gap-fill off the hot path |
| [DOM-053](storage.md) | P2 | storage | open | Rebuild R2 from GHCR and serve with R2 empty |
| [DOM-054](serve.md) | P2 | serve | open | Work budget, caps and a 100 requests a second drive |
| [DOM-055](ops.md) | P2 | ops | open | Failure drills |
| [DOM-056](ops.md) | P2 | ops | open | Runbooks and the resource ledger |
| [DOM-057](ingest.md) | P3 | ingest | open | The external writer path for a VPS |
| [DOM-058](ingest.md) | P3 | ingest | open | OpenINTEL's measurement topic: decode and sample |
| [DOM-059](serve.md) | P1 | serve | open | The route registry and the root documents |
| [DOM-060](serve.md) | P1 | serve | open | The consumer contract and the reference reader |
| [DOM-061](ops.md) | P1 | ops | **done** | Deploy the probe Worker and its R2 bucket |
| [DOM-062](serve.md) | P1 | serve | open | Confirm that no rate-limit rule of the pkgforge.dev zone covers domains.pkgforge.dev |
