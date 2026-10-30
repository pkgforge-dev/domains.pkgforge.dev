# Architecture

The design in force for `domains.pkgforge.dev`. This file wins over every other document.
When another document disagrees, that document is the defect.

Evidence tags. MEASURED names the command and the UTC time. READ names the URL or the file.
[E] is an estimate and says what would replace it. "Design A" is
`docs/research/2026-10-27-design-a.md`. "Design B" is `docs/research/2026-10-27-design-b.md`.
Both keep their raw results beside them. `mirror@669ac72:<path>` names a file of `https://github.com/pkgforge-dev/mirror-archlinux` at commit `669ac725f8081445c164113f2ed092533de112e2`; read it at `https://raw.githubusercontent.com/pkgforge-dev/mirror-archlinux/669ac725f8081445c164113f2ed092533de112e2/<path>`. The rulings of the operator are in `TODO/RULES.md` §5.
This file never asks a ruled question again.

## 1. What it is

`domains.pkgforge.dev` publishes certificate transparency (CT) names, newly seen domains and
newly registered domains. It also serves reverse IP lookups from a mirror of THC's database.
The repository is `pkgforge-dev/domains.pkgforge.dev`. It is public and licensed 0BSD.
Every output is 0BSD. Domain names are public data.

GitHub Actions writes the data into GHCR. Cloudflare Workers read it and answer HTTP.
R2 is a cache. A reader that does not trust the Worker reads GHCR directly.

### Goals

1. Publish CT names and new domains from many feeds, with a reading of our own beside them.
2. Lose any one source and keep answering from the others. Every answer names the sources used and the sources that failed.
3. Be accurate by definition. `seen`, `claimed_new` and `registered` are separate words (§2).
4. Answer every query type that THC offers: reverse IP to names, subdomains, CNAME targets, bulk downloads and daily CT dumps.
5. Answer finer queries of our own. A window is 1 h, 6 h, 12 h, 1 d or N days. A query takes any suffix or parent domain. Every name has first and last seen per source.
6. Keep the data in GHCR, nothing in R2 but a cache of at most 5 GB, and serve from Workers.
7. Accept a VPS ingester as one more source, if a core source shuts down or a need appears.

### Non-goals

- No consumer key, account, quota or rate limit. Cost is bounded by caps on window, page and work, never by refusing a caller (§7.6).
- No VPS that reads whole CT logs. All CT logs hold about 510 GB a day (READ `docs/research/web-pkgforge-2026-10-27/ct.md` §4).
- No heavy regular expressions. Normalisation is a byte scan and a Public Suffix List (PSL) trie.
- No active DNS resolution. Forward and reverse DNS data come from mirrored sources only.
- No call to THC's live API from any route (§6).
- No legal or terms analysis. A document says what a source returns, how often, and how it fails.

### The operator's rulings, as constraints

| Constraint | Where it holds |
| --- | --- |
| Most data lives in GHCR. R2 holds at most 5 GB as a cache. Workers serve. | §4, §4.9 |
| Nothing is ever deleted from GHCR. Raw feeds are kept always, and raw segments stay beside every compacted tier. | §3.4, §4.7 |
| Actions writes with its own `GITHUB_TOKEN`. The first push of each package comes from a workflow. The operator deploys the Worker with a local wrangler login. No credential crosses between GitHub and Cloudflare. | §5.9, §12 |
| Reverse IP and CNAME answers come from THC's data mirrored in this project's GHCR. | §6 |
| The freshness clock is measured. GitHub Actions is the default. | §5.2 |
| No consumer is gated. | §7.6 |
| Outputs carry no licence field. Provenance is publisher, URL and fetch time. | §3.7 |

## 2. Definitions

| Term | Meaning |
| --- | --- |
| name | A host name. Lowercase, punycode, no trailing dot, letters, digits, hyphen, underscore and dots. A wildcard `*.x` is the name `x` with the flag `wild`. |
| suffix | The ICANN public suffix of a name, from the pinned PSL (`np`, `com.np`, `co.uk`, `xyz`). |
| registrable domain (`reg`) | The suffix plus one label. |
| site | The registrable domain computed with the PSL private section too. `x.github.io` has the site `x.github.io`. |
| key | The labels of a name in reverse order, joined with dots. `api.example.com.np` has the key `np.com.example.api`. Keys compare bytewise. |
| source | One producer of observations, with an id, a bit number (0 to 63), a family and a precision (§3.5). |
| family | What a source derives from: `ct`, `registry+ct`, `isc`, `whoisds`, `stamus`, `registry`, `nsec-walk`, `dns` (`FAMILIES` of `packages/adapter/src/types.ts`). `registry+ct` is a CT event that its publisher matched to a registry date (`oi-nrd-confirmed`). `nsec-walk` is a walk of a zone's NSEC records (`zone-walks`). Two sources of one family are not independent evidence. |
| observation | `(name, source, t_first, t_last)` with the source's precision. A merge takes the minimum of `t_first` and the maximum of `t_last`, so a merge is idempotent. |
| precision | `second` or `day`. It belongs to the source id. A day value is never shown as a time of day. |
| `seen` | The earliest evidence a source shows for a name or domain. CT sources use the certificate log time. A dump uses its UTC date. A list uses its own date, never the file date. |
| `first_seen`, `last_seen` | The minimum and maximum of `seen` over the segments we hold, per source and over all sources. `last_seen` is not a liveness claim. |
| `claimed_new` | A source says the domain is new. The claim keeps the source's own meaning. ISC says "new to us". |
| `registered` | A claim about a registry. It is stated only on zone, RDAP or OpenINTEL-confirmed evidence. CT evidence never makes it. |
| `new` (registrable) | The global `first_seen` of the domain falls inside the window. The corpus must show no earlier observation from any source. |
| `new` (name) | The same rule for a name. It is censored until the corpus holds one certificate renewal cycle (§9). |
| `corpus_since` | The first day the corpus covers, per dataset. Every answer states it. |
| `confidence` | `warming` while the corpus is younger than 90 days, else `full`. |
| `suspect` | An `oi-nrd` event whose certificate is older than 7 days, or a domain whose RDAP creation date is before 2026-01-01 (ruling 19). The default feed hides suspect events. |
| `provisional` | A newness verdict made by the hourly filter. The daily job makes it exact (§5.8). |
| `corroborated` | Two sources of different families first saw the domain within 48 h of each other. A day value stands for its whole day: two first sightings count when the two farthest instants of their intervals are at most 48 h apart. |
| segment | The pack one adapter writes for one window. A segment is immutable. |

The OpenINTEL newly registered stream means "first seen in a certificate", not a registration date.
In design B's RDAP check, 25 of 25 events with a fresh certificate were registered within a day.
In the same check, 0 of 25 events with a certificate older than 30 days were new (design B §2.4 item 5).
Of the events in a 180 s sample, 38% carried a certificate older than 30 days.

## 3. Data model

### 3.1 Normalisation

Every adapter runs the same function of the names package (entry DOM-015).

1. Lowercase ASCII. Convert IDN labels to punycode. The PSL's own IDN rules are converted the same way when the list is loaded, so a name under `公司.cn` splits under `xn--55qx5d.cn`.
2. Remove one trailing dot. Remove a leading `*.` and set `wild`.
3. Refuse a name with a byte outside `[a-z0-9_.-]`, a label over 63 bytes, a name over 253 bytes, an empty label, no dot, or a top-level label of digits only (`numeric-tld`: an address literal such as `192.0.2.1`; RFC 1123 section 2.1 makes the highest-level label alphabetic).
4. Refuse a name that is itself a public suffix.
5. Compute `suffix`, `reg` and `site` from the pinned PSL. The `ref` package holds the pinned list under the tag `psl-<sha12>`, the first 12 hex digits of its sha256 (DOM-019, `refTag` of `packages/ghcr/src/layout.ts`). That manifest's `dev.pkgforge.domains.sha256` annotation holds the whole sha256. A root names it in its `psl` field (§4.6), and a pack in its `dev.pkgforge.domains.psl` annotation (§4.2). `sources.json` holds no PSL field.

THC's dump of 2026-10-26 held 38,474,309 lines. Design A counted 0 refused lines under rule 3 as it then read and 4 refused lines under rule 4. DOM-009 counted distinct names of the same dump: 1,516 whose top-level label is all digits, under 256 distinct such labels, now refused under rule 3, and 2 that are themselves a suffix once the list's IDN rules are converted (MEASURED 2026-10-28T11:19Z, `docs/research/measure/DOM-009/local-2026-10-26.stat.json`). The dump is not bytewise sorted.
0.57% of its lines carry upper case (MEASURED 2026-10-27, design B §2.4 item 1, design A M5).
The ingester normalises and sorts the dump itself.

### 3.2 Keys

All sorted datasets sort by `key` (reversed labels). A suffix, a parent domain or a whole TLD is then one contiguous key range.
`np.com` is one range. `com.example` is one range. `np` is one range.
This holds for names and for the new-domain feed. Hash partitioning cannot answer "every name under `.np`" without reading every partition.

### 3.3 Datasets

| Dataset | Package | Key | Record | Size order |
| --- | --- | --- | --- | --- |
| `names` | `names` | reversed name | source mask, then per set bit `(first, last)`. Flag `wild`. | 10 B a name [E] |
| `domains` | `names` | reversed registrable domain | source mask, per set bit `(first, last)`, evidence list | 14 B a domain [E] |
| `feed` | `feed` | reversed registrable domain, one record a key | `first_seen`, source mask, basis bits, confidence, flags | about 2 to 7 MB a day [E] for the key copy, and about 4 to 14 MB with its time copy: 0.3 to 0.7 million rows a day (design B section 6.3, from its measurements M4 and M6) at the 6.1 to 9.3 B a row of a day pack's key copy, and a pack with its time copy 1.982 to 2.104 times its key copy (both MEASURED 2026-10-29 on bench packs, `docs/format.md` section 14.6). |
| `new-name` | `feed` | reversed name, one record a key | the same shape, name level | 250 MB a day [E], the key copy alone; about twice that with its time copy, as for `feed` |
| `rev` | `rev` | IP address (4 or 16 bytes, big endian) | the names that resolve to the address | measured by DOM-043 |

`first` and `last` are varints. The unit is the source's precision. Days since 2026-01-01 for a day source.
Seconds since 2026-01-01T00:00:00Z for a second source. A record never stores a count, so merges stay idempotent.

The `domains` dataset is the ledger. It holds one record per registrable domain, with per-source first and last seen.
It decides whether a domain is new. The `feed` dataset is a view of it, sorted for window queries.
A `feed` or `new-name` pack holds one record a key, and `first_seen` is a field of it, not part of the key. The same rows in `first_seen` order are the pack's optional time copy: a DPK1 pack of its own (dataset 6 for `feed`, 7 for `new-name`), keyed by `first_seen` and then the key, in the layers `time.idx` and `time.part.NNN` of the same manifest (`docs/format.md` section 14, DOM-022). A page in time order reads the time copy from the bound of its window until the page is full, so no Worker sorts a day pack.
A `feed` row stores `first_seen` in seconds and no precision. A reader reads the precision back from the row's sources (`rowPrecision` of `packages/feed`): the row is day-precision when one of its sources is a day source and `first_seen` is the start of a day, and its `first_seen` then stands for that whole day (§7.4). A row whose every source is a day source and whose `first_seen` is not the start of a day is refused.

An evidence entry is `(tier, basis, source, at, confidence)`.

| Tier | Basis | Meaning |
| --- | --- | --- |
| T1 | `zone`, `rdap` | A registry zone adds the domain, a zone diff adds it, or an RDAP registration event says so. A time is unsigned from 2026-01-01, so an RDAP creation date before it is not evidence: it sets `suspect` (ruling 19). |
| T2 | `nrd-list`, `nrd-ct+rdap` | A third party claims it. OpenINTEL's confirmed topic passes its own `confidence` (1 to 10) through unchanged. |
| T3 | `ct-first` | The first certificate in our corpus. It is a proxy. |

### 3.4 Observations and segments

An adapter emits one segment per window. A segment is a pack (§4.4) with one source and the observation fields.
Its OCI annotations name the source, the window, the cursors before and after, the count and the precision.
Raw data is kept always (ruling 5). Every source's bytes, as fetched, stay in GHCR beside the segment derived from them.

**The raw lane.** Where a source is a file up to 1 GB (THC's daily dump, ISC, WhoisDS, the NRD lists), the segment's manifest keeps the file as fetched in its `raw` layer.
Two sources are streams, and their raw bytes go to the raw lane of the `obs` package, the tags `raw-<source>.<window start>.<window end>`, written before the segment that names them:

- **Kafka.** The record batches of each fetch, exactly as the broker returned them, with a members index of topic, partition, base offset, last offset, byte offset and length. The batches of `certstream_domains` are snappy compressed. In every window read of the three NRD topics, a batch has codec none and one record. `docs/sources.md`, "The Zonestream broker", names each window and its command. The batches are not stored as JSON: the decoded JSON of `certstream_domains` is 24 GB a day (MEASURED 2026-10-27, design A §3.1), and its compressed batches are a fraction of it.
- **Names tiles.** The gzip body of each tile as the log's host sent it (`Accept-Encoding: gzip`), with a members index of log, tile number, byte offset, length and sha256.

A raw lane object uses the manifest kind `raw` (§4.2). It is never read by the Worker. It is the copy that lets a later change of an extractor re-read a stream that its publisher has expired, such as the Kafka topic's 26 hours.
The size is in §4.8, from DOM-004's reading of the bytes a day as the broker sends them.

### 3.5 The source registry

`sources.json` lives in the `ref` package and in every root. One entry per source id.

| Field | Meaning |
| --- | --- |
| `id`, `bit` | The id and its bit number. A bit is never reused. At most 64 sources. |
| `family` | See §2. |
| `datasets` | Which datasets the source feeds. |
| `precision` | `second` or `day`. A source whose precision changes gets a new id. |
| `kind` | `ct_name`, `claimed_new`, `registered_claim`, `zone_add`, `list`, `dns`. |
| `basis` | The evidence bases it writes, each one of the five of §3.3. A source that writes no newness evidence (`oi-measure`) lists none. |
| `cadence`, `band` | How often it runs, and the expected volume band for the volume check (§5.8). |
| `urls`, `fetched` | The publisher URLs and the fetch time. This is the provenance. |
| `status`, `through` | `through` is the time through which the source is complete, written by the promotion job from the segments it lists. `status` is `ok`, `late` or `down`: the Worker derives it at read time from `through`, the source's `cadence` and the clock, so it never goes stale in the root. The hourly status workflow reads the same numbers through the Worker (§5.3). |

### 3.6 Per-source granularity

CT names tiles are one source per log operator: `ct-le`, `ct-geomys`, `ct-ipng`. The log is a field of the segment's statistics, not of a record.
This keeps the source bits under 64 and lets the coverage table compare logs.

### 3.7 Provenance

A record's provenance is the source id and the segment tag. A segment's annotations carry the publisher, the URL and the fetch time.
No record carries a licence field. No document states a source's terms.

## 4. Storage

GHCR is the only copy of the truth. Every pack is write-once. The root moves forward only.
R2 is a cache. Everything in R2 can be rebuilt from GHCR.

### 4.1 Packages

The namespace is `ghcr.io/pkgforge-dev/domains.pkgforge.dev/`. This is the repository's own name, as `mirror-archlinux` does it.
Packages are created by the first push of a workflow. They need no manual step (§4.7, ruling 6).

| Package | Holds | Tags |
| --- | --- | --- |
| `root` | The root manifest | `latest` (moves forward), `r-<UTC timestamp>` (write-once history) |
| `obs` | Segments, and the raw bytes they came from: the raw files, the raw lane of Kafka batches and names-tile bodies (§3.4), and the THC monthly raw chunks | `<source>.<window start>.<window end>` and `<source>.<date>.<sha12>` for files; `raw-<source>.<window start>.<window end>` for the raw lane |
| `names` | Tiers of `names` and `domains` | `<dataset>-<tier>-<span>`, for example `names-d-20261026`; a rebuild of the span adds `-rN`, N from 2, for example `names-d-20261026-r2` (§4.7 rule 2) |
| `feed` | Tiers of `feed` and `new-name` | `feed-h-2026102608`, `feed-d-20261026`, and `-rN` after it for a rebuild (§4.7 rule 2) |
| `rev` | Packs of the reverse IP index | `rev-m-202609`, and `-rN` after it for a rebuild (§4.7 rule 2) |
| `dumps` | Bulk downloads for people and scripts | `names-20261026`, `new-20261026` |
| `state` | Cursors, and the provisional filter with its delta (`docs/format.md` section 15) | `state` (guarded), `state-<date>` (write-once), `ledger-filter-YYYYMMDD` (write-once: the filter through the end of that day; `ledgerFilterTag` of `packages/ghcr`), `ledger-delta` (moves, under the `state` guard of DOM-024; `LEDGER_DELTA_TAG` of `packages/ghcr`) |
| `ref` | The PSL, the CT log list, `sources.json` | `psl-<sha12>`, `ctlogs-<sha12>`, `sources-<sha12>` |

GHCR tags match `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}` and resolve without regard to case. Every tag is lowercase.
A read of a pinned object uses a digest, never a tag. Only `root:latest`, `state`, `ledger-delta` and the dated tags are read by tag.

### 4.2 Manifests

Every artifact is an OCI manifest with an `artifactType` of the form `application/vnd.pkgforge.domains.<kind>.v1`. `ARTIFACT_KINDS` of `packages/ghcr/src/layout.ts` lists the seven kinds, and `artifactType` builds the type.

| Kind | Layers (by title) |
| --- | --- |
| `pack` | `part.000`, `part.001`, and so on (blocks, at most 1 GiB each), `idx` (the sparse index), optional `txt.gz` (a plain sorted bulk file). A pack of `feed` or `new-name` may carry its time copy, `time.idx` and `time.part.000` and up (the same rows in `first_seen` order, `docs/format.md` section 14), and day packs of `feed` carry `summary.json` (new registrable domains per suffix and source). |
| `segment` | the same as `pack`, and optional `raw` (the file as fetched) |
| `root` | `root.json`, `sources.json`, `coverage.json` |
| `state` | `state.json` |
| `rawchunk` | `chunk.000` and up, each at most 4 GiB, for the THC monthly CSV |
| `raw` | the raw lane (§3.4): `raw.000` and up, each at most 1 GiB, the bytes as received (Kafka record batches or gzip tile bodies, concatenated), and `members.json`, one entry per member with its offsets, length and sha256 |
| `ref` | one object of the `ref` package (§4.1): one layer, the file as fetched or as committed, titled `public_suffix_list.dat`, `log_list.json` or `sources.json` (`KINDS` of `scripts/ghcr/ref-inputs.mjs`) |

Each layer carries `org.opencontainers.image.title`, its file name. The push tool `scripts/ghcr/push.mjs` sets `org.opencontainers.image.source` and `org.opencontainers.image.created` on every manifest.
`created` is the end of the window, or a `ref` file's own time, never the push time. The caller passes every other annotation, each a key under `dev.pkgforge.domains.`.

- Every manifest carries `run`, the id of the workflow run that pushed it.
- A `pack` or `segment` manifest also carries `schema`, `dataset`, `tier`, `span.start`, `span.end`, `count`, `bytes`, `psl`, `source`, `writer` and `sha256`. `source` is one id, or several separated by commas. When it names one id, the manifest also carries `precision`, `day` or `second` (`VERIFY_ANNOTATIONS` of `packages/pack/src/verify.ts`). `docs/format.md` section 8 states the values of `dataset`, `count`, `bytes`, `sha256` and `writer`.
- A quarantined segment also carries `quarantine`, with the value `1` (§5.8).
- A `ref` manifest carries `sha256`, `bytes` and `url` (`.github/workflows/ref-refresh.yml`). `sha256` is the sha256 of the file, which is also the digest of its one layer. `url` names where the bytes came from.

A blob is scoped to its repository, so the root records the repository next to every digest.

### 4.3 Reading GHCR

A reader sends `Authorization: Bearer QQ==` first. GHCR accepts that token for a public package.
If GHCR answers 401 or 403, the reader asks the anonymous token endpoint for a pull token and tries once more.
A blob request answers 307 to a signed URL on `pkg-containers.githubusercontent.com`. That URL needs no credential and supports `Range`.
READ `docs/research/reference/ghcr.ts` and `mirror@669ac72:docs/worker.md` ("GHCR tokens").

| Measurement | Value |
| --- | --- |
| Manifest GET, 300 of 300 at concurrency 50 | median 0.45 s, p95 0.53 s (MEASURED 2026-10-27, design B M7) |
| Signed URL life | about 7 to 8.7 minutes (design A M11, design B M7) |
| Range read of 64 KB from 25 MB | 0.94 s from Nepal, 206 (design A M11) |
| Range read through an unoptimised Worker route | 1.5 to 3.0 s (design A M11, design B M7) |
| Pushes | 2,000 requests a minute per token, 10 GB a layer, 10 minutes an upload (READ `mirror@669ac72:docs/measurements.md`) |
| Push speed from a runner | 63.5 to 121.4 MB/s, MB being 10^6 B: four pushes of one layer of random bytes, 1,536 MiB or 4,096 MiB (MEASURED 2026-10-28, DOM-006, runs 40714201294 and 40716636421, `docs/research/measure/DOM-006/`) |

DOM-007 measures reads from a Worker.

### 4.4 The pack format

A pack stores sorted records in blocks. It has a sparse index. Its identifier is `DPK1`. `docs/format.md` is created by DOM-017 and states every byte.

| Part | Content |
| --- | --- |
| Records | Sorted by key. Each record stores the shared-prefix length with the previous key, the suffix length with flags, the suffix bytes, then the dataset's fields. |
| Block | 4,096 records by default. The index header states the number, so a reader never assumes it. A block is compressed with `deflate-raw`. The part header names the codec (`deflate-raw` is codec 1, `gzip` codec 2), so a measurement that prefers another block size or codec changes a default of the writer and no byte of the layout. |
| Part | A run of blocks, at most 1 GiB. Parts are disjoint and ordered by key. A pack has one part or many. |
| `idx` layer | Two levels. The top level holds the first key of every 64th index page. The second level holds, per block, the first key, the part, the offset and the lengths. |

Why these choices.

- Reversed keys: §3.2.
- `deflate-raw`: Workers decode it natively with `DecompressionStream`. The measured density is 6.04 bytes a name at 4,096 names a block. Brotli level 9 and zstd level 12 are within 1.5% of it (design B §2.4 item 3, MEASURED 2026-10-27 06:27Z).
  Front coding alone costs 12.0 bytes a name. DOM-008 measures the decode CPU in workerd.
- 4,096 names a block: 6.04 B a name, 7,948 blocks for 32.5 million names. 1,024 names cost 6.26 B and 31,792 blocks. 16,384 names cost 5.93 B and 1,987 blocks.

A lookup reads the cached top index, one index page, and one block. A cold lookup costs at most two small range reads per pack.
A merge reads packs sequentially, merges by key with minimum and maximum, and writes a new pack. The same inputs give the same bytes. Compression parameters are fixed.

### 4.5 Tiers and the live set

A tier is a merge level. A pack of a higher tier covers the spans of the packs it replaces.

| Tier | Span | Built from | Built by |
| --- | --- | --- | --- |
| `seg` | one adapter window, 10 minutes or more | the source | the adapter |
| `h` | one UTC hour | the segments of the hour | the first live run after the hour closes |
| `d` | one UTC day | the 24 hour packs, and the THC day | the daily compaction |
| `w` | one ISO week inside one calendar month | the 7 day packs | the weekly compaction |
| `m` | one calendar month | the week packs, and the day packs of the weeks that cross its first or its last day | the monthly compaction |
| `y` | one year | the month packs | the yearly compaction |

The live set is the smallest set of packs that covers `[corpus_since, as_of]` with disjoint spans. The root lists the live set.
The one exception is in `names`, `domains` and `rev`: a segment may overlap a pack of other sources, as the THC day segment lies beside the hour packs of the live lanes until the daily compaction. `feed` and `new-name` have no exception. A window is read over disjoint packs (`planWindow` of `packages/feed`), and a source that arrives as one day segment enters them through the day pack.
A query reads the live set. A week that crosses the first of a month is never compacted, so the days of a month before its first Monday and the days of its last week stay day packs until the monthly compaction. The worst fan-out is then 6 segments, 24 hours, 12 days, 4 weeks, 11 months and the years: about 57 packs and one a year for the `names` dataset, by the rule of the table. The year 2026 of `names` is never built (the verdict `wait` below), so its four month packs stay live beside them: about 61 packs, and one a year from 2027.
Each pack costs at most two range reads. The `feed` dataset is small, so its fan-out is cheap.
Compaction replaces packs in the live set. It never deletes a pack from GHCR.

**The unit.** `packages/compact` (DOM-023) builds the tiers `d`, `w`, `m` and `y`. `planTier(root, dataset, tier, start)` reads the root's live set and gives one verdict for one unit:

| Verdict | When |
| --- | --- |
| `skip` | The unit is a week that crosses the first of a month. Or every day of the unit is a day the root's `gaps` names: no empty pack is written (ruling 24). Or every pack of a unit of `feed` or `new-name` is quarantined: no empty pack is written either, and the unit of the tier above replaces those packs. Or the unit lies wholly before the dataset's `corpus_since`: no pack covers it, and no pack of it is ever built (**Before `corpus_since`**, below). |
| `present` | A live pack of the tier, or of a higher tier, covers the unit. |
| `wait` | The packs of the tier below (`SLOT_TIERS`: `h` and segments for a day, `d` for a week, `w` and `d` for a month, `m` for a year) do not cover the unit. A span on a day that `gaps` names for any source is no missing span, whether no pack covers the day or some pack covers it in part, since ruling 24 has the root accept a hole whose every day `gaps` names (DOM-029 builds that in `packages/root`, which refuses every hole until then). A quarantined pack of `feed` or `new-name` covers its span as a pack of the tier below does. It is no input of any tier, and the output replaces it. So a week replaces the hour packs of a day whose every pack is quarantined, and does not wait on them. For a day, a source of its packs whose live packs end before the day ends is missing too: the hour packs it has yet to add would overlap the day pack. Only the days `gaps` names for that source excuse its tail. A gap of another source says nothing of this lane's clock. A span before the dataset's `corpus_since` is missing too, named as such, and a unit that starts before `corpus_since` and ends after it is never built (**Before `corpus_since`**, below). The verdict names each missing span and the packs of other tiers found there. |
| `ready` | The inputs, in the root's order, and every manifest the output replaces. |

**Before `corpus_since`.** A unit that starts before its dataset's `corpus_since` is never built (the Decision of DOM-023, ruling 20). The root derives `corpus_since` from the first span start of the dataset's packs (§4.6). So a pack that spanned the whole unit would move `corpus_since` back to the unit's start, a coverage no source gives (`AGENTS.md` absolute 11). A pack from `corpus_since` alone would not span its tier unit, and the live-set rule refuses it (§4.6). Such a unit that ends after `corpus_since` keeps the verdict `wait`, and its reason says that it is never built because it starts before `corpus_since`. A unit that lies wholly before `corpus_since` is `skip`.

The cost is bounded: the first partial unit of each tier stays at the tier below. For `names`, whose corpus starts at 2026-09-01, the year 2026 stays four month packs. The day 2026-09-01 and the month 2026-09 start at `corpus_since` and are built. The week from 2026-08-31 crosses the first of September, so it is `skip`, and the month 2026-09 takes its days 2026-09-01 to 2026-09-06. MEASURED 2026-10-30T04:11:42Z, `planTier` called by `node` on a synthetic root of the four month packs of `names` from 2026-09: the year 2026 is `wait`, with the reason that it is never built, and the year 2025 and that week are `skip`. The two tests of `packages/compact/test/plan.test.ts` whose names hold `corpus_since` hold both verdicts.

The exact join writes the day pack of `feed` (`buildFeedDay` of `packages/feed`, DOM-022). A merge of its hour packs does not, because the verdicts of the hour packs are provisional (section 5.8 step 5). The daily job takes from `planTier` the verdict and the manifests that the day pack replaces. `new-name` has no hour pack. It enters only through the exact day pack of DOM-041, whose Decision rules out a filter of names (the Decision of DOM-023, ruling 20), and `scripts/compact/hour.mjs` writes the hour pack of `feed` alone (READ its header).

`mergeSpan` builds every other unit. A live pack that crosses an edge of the unit is refused (`straddle`): no pack of the unit can replace it. A pack marked quarantined (its entry's `quarantine` field, ruling 23) is no input of `feed` or `new-name`, and the output still replaces it. In `names`, `domains` and `rev` it is an input.

**The merge.** `mergeSpan` is a streaming k-way merge (`mergeRecords` of `packages/pack`, with the rules of `docs/format.md` section 5.6). It holds one block of each input and one output block. A second pass, `checkMerged`, walks the output beside one cursor on each input: the output holds exactly the distinct keys of the inputs, and each record is the merge of the inputs' records of its key. It shares no code with `mergeRecords`. It calls the dataset codec's `codec.merge` and `codec.key`, which `mergeRecords` calls too, and compares two records by their bytes from `codec.encodeRecord`, which the writer calls (READ `packages/compact/src/check.ts` and `packages/pack/src/merge.ts`). So a defect in the codec's record rule passes both. The record rule is held by its own tests (READ `packages/pack/test/codec.test.ts`: per source the earliest first and the latest last, the flags ORed, and every merge idempotent, commutative and associative). Any difference refuses the output (`count`), with both counts and the first key that differs. A range job runs the same pass over its own part (`checkRange`). The pass reads the inputs' keys up to the key after the part's last. It starts at the part's first key, or at the start of the key space for part 0. Assembly holds each part's first key to the key after the last record of the part before it. So the checks of all parts cover the key space, with no key in two. A key that the merge drops before the first part, or between two parts, fails the check of one part.

**Ranges.** A large merge runs as an Actions matrix. `planRanges` cuts the key space at index page keys into ranges of about equal input bytes, the bytes before a cut being the compressed bytes of the input blocks whose first key is below it: the shards of mirror-archlinux, whose `SHARD_BYTES` is 536,870,912 (READ in the Premise of DOM-023, `TODO/storage.md`, from that repository's docs/design.md, "Shards"). The target is `DEFAULT_RANGE_BYTES`, 536,870,912 B, and a merge has at most `MAX_RANGES`, 256, ranges (section 5.1). The pack must also fit one manifest. A range owns at most one part, so a pack holds a part a key range and its `idx`, and with a time copy a part a time range and `time.idx`. `scripts/ghcr/push.mjs` pushes at most `MAX_LAYERS`, 256, layers, the largest count both push runs of DOM-006 accepted (READ its comment), and `packages/compact` holds the same number, which a test of `scripts/compact` holds equal to the push tool's. So `rangeCeiling` caps the ranges at 255, or 127 for a `feed` or `new-name` pack of tier `d` to `y`. The time copy is cut into no more ranges than the key copy, though by bytes it may want one more, since it is 0.982 to 1.104 of the key copy's bytes (`docs/format.md` section 14.6). `planFile`, the plan read back, and `packManifest` each refuse a pack of more layers. The ranged layout keeps the blocks of one writer byte for byte, because the format allows a short block only at the end of a pack (`docs/format.md` sections 2 and 6.5). A range owns the blocks whose first record falls in it, and writes them as one part of at most 1 GiB. The ranges that own a block take the part numbers 0, 1, 2 in key order. A range cannot know where its first block starts until the ranges before it are counted, since the merge folds the keys that two inputs share. So a matrix runs in two stages. Stage 1 counts the distinct keys of each range (`countRange`), and stage 2 writes each range's part from every range's count (`windowOf`, `writeRange`). `assembleRanges` builds the index of all parts. It refuses a range that is missing or given twice, parts out of order, a count that is not the count of its index, and two ranges that do not meet: each part's first key is the key after the last record of the part before it. `hashParts` reads every block back, holds it to its CRC-32, and computes the identity of `docs/format.md` section 8.

**The time copy.** A tier pack of `feed` or `new-name` carries its time copy (`docs/format.md` section 14). When no key is in two inputs, the merge moves no row, and the time copy is the k-way merge of the inputs' time copies by time key, by range like the key copy. The key copy's count tells the two cases apart: the merge's records equal the inputs' records exactly when no key is in two inputs. Otherwise `sortTimeCopy` sorts the merged rows in memory, at most `DEFAULT_SORT_ROWS`, 10,000,000 rows [E], and refuses more before it writes a byte. Both forms are held to the key copy by `timeBindFault` of `packages/pack`.

**The manifest and the tag.** `packManifest` builds the OCI manifest: its layers `part.NNN`, `idx`, for a time copy `time.part.NNN` and `time.idx`, then its `extra` layers, such as `summary.json` of a `feed` day pack, and the annotations of section 4.2. It builds the manifest of an hour pack too (tier `h`). It reads the manifest back through `packFromManifest` of `packages/root`, so the promotion's refusals happen before any push. `tagDecision` reads the tags of the package. A tag of the unit that is there means the unit is present, and a re-run writes nothing. A rebuild takes the next tag of the span, `-r2` and up (ruling 25), from `nextTierTag` of `packages/ghcr`.

**A re-run of a rebuild.** A re-run of a rebuild whose push landed first finds the build that holds its bytes, and writes nothing. The caller gives `tagDecision` the `dev.pkgforge.domains.sha256` it is about to write, and the same annotation of each build of the span. A build whose annotation equals it answers `present`, with that build's tag, the latest such build when two match. Only when no build matches does the rebuild write, under `nextTierTag`. A build that the tags list and the map of annotations lacks is a `usage` fault, so a caller cannot skip the read. MEASURED 2026-10-30T04:11:42Z, `tagDecision` called by `node` with the builds `names-d-20261026` and `names-d-20261026-r2`: a rebuild of the bytes of `-r2` answers `present` at `-r2`, and a rebuild of other bytes answers `write` at `-r3`. The test of `packages/compact/test/manifest.test.ts` whose name starts `tag: a rebuild whose sha256 a build already holds` holds this.

When a rebuild is asked and the span has builds, `assemble.mjs`, `hour.mjs` and `day.mjs` read each build's manifest with no credential, through the one helper `decideRebuild` of `scripts/compact/plan.mjs` (READ its `buildSha256s`). A build whose manifest GHCR does not give, or whose `dev.pkgforge.domains.sha256` is not 64 lowercase hex digits, is exit 1, never 4: the package lists the build, so the build is lost, or its package went private since. The tests of `scripts/compact/assemble.test.mjs`, `scripts/compact/hour.test.mjs` and `scripts/compact/day.test.mjs` whose names hold `rebuild` and `exit 1` plant a manifest GHCR does not give and one with no annotation, and the one of `assemble.test.mjs` plants an annotation in capitals too.

**The scripts.** `scripts/compact/plan.mjs` plans a unit from `root:latest` or a `root.json` file, and writes the plan and the matrix `{ "include": [{ "range": I }] }`. It exits 3 for `wait`. `scripts/compact/range.mjs` runs stage 1 (`count`), stage 2 (`write`), or both for every range in one process (`all`). It reads the inputs from files or from GHCR with no credential, writes each part to a new file with its digest and size, and checks each part with `checkRange`. `scripts/compact/assemble.mjs` assembles the parts, sorts the time copy when it must, and writes the index, `manifest.json` and `blobs.json`. With `--inputs`, it also runs `checkMerged` over the whole pack, which reads every input again. Without `--inputs`, the checks of the ranges hold the pack. If the package holds a build of the unit, it prints `present PACKAGE:TAG`, writes nothing and exits 0. Each script pushes nothing, and their headers state their exit codes. The job `assemble` pushes the layers that `blobs.json` names with `scripts/ghcr/push.mjs`, which builds the pushed manifest itself from those layers and the annotations of `manifest.json` (§5.3). Each checks its output paths before it reads anything: an output that is a directory where a file goes, a file where a directory goes, or under a directory that is not there, exits 2. A blob that the validated root, or the plan made from it, names and that GHCR does not give with no credential exits 1, never 4: the root was promoted only after each package read publicly (section 4.7 rule 7), so the pack is lost or its package went private since. Exit 4 is left to the root's own read. A test gives `range.mjs` a merge that drops the smallest key, and `range.mjs` exits 1 with `FAIL count`. A test gives `assemble.mjs --inputs` a part written again without one key, and it exits 1 the same way. Without `--inputs`, `assemble.mjs` holds the count both ways: a pack of exactly the inputs' records when a range says a key is in two inputs, or of more records than the inputs when none says so, exits 1 (READ `scripts/compact/range.test.mjs` and `scripts/compact/assemble.test.mjs`, the tests whose names hold `FAIL count`, `drops one input key` and `held both ways`). MEASURED 2026-10-30T09:30:53Z by `measure-compact.yml` (run 41032308505, `docs/research/measure/DOM-023/result.json`): one range of a `names` week, 7 synthetic day packs of 92,402,051 records in 577,765,791 B read from local files, took 82.71 s to `count` and 382.11 s to `write` on an `ubuntu-24.04` runner of 4 CPUs, at a peak RSS of 300,572 KiB and about 1.2 CPUs, and used 522,960,896 B of disk. The read from GHCR by range, a time copy and the sort of `sortTimeCopy` are not in it.

### 4.6 The root manifest

`root:latest` is an OCI manifest of kind `root`, at most 64 KiB, the Worker's cap. Its layers are `root.json`, `sources.json` and `coverage.json`, each `application/json`. Its layer `root.json` is the machine contract (§11). `validateRoot` of `packages/root` (DOM-020) holds its schema, and refuses a `format` it does not know. It holds:

- `format` (`domains.root.v1`), `root_seq` (a whole number from 1 that only grows), `as_of` (the latest span end of a live pack, or null when the root names none), `created` (when the promotion built it, to the second; the dated tag `r-<created>` of `rootTag` names it), and `previous` (the manifest digest of the root it replaced; null for the first root alone, `root_seq` 1).
- `psl`: the sha256 of the list pinned at promotion, the `dev.pkgforge.domains.sha256` annotation of the `ref` package's `psl-<sha12>` (held equal to that tag's one layer).
- `psl_live`: the sorted sha256 of every list a live pack was built under, read from each pack's `dev.pkgforge.domains.psl` (ruling 22). `psl` is in `psl_live` only once a pack is built under it. No compaction recomputes a pack under a new list: the plan steps of the compaction workflows hold a ready unit whose keys depend on the list and whose inputs carry more than one PSL hash (§5.3, "PSL lists"). So `psl_live` keeps naming the older lists. The recompute under one list is an open duty of DOM-023.
- `corpus_since` per dataset (the first span start of its packs), `gaps` per source (the days it is known to lack, carried forward, for example the THC days 2026-10-04 and 2026-10-09), `through` per source (the latest span end of a live pack that carries it), and `counts` per dataset (packs and records).
- `datasets`, with the live packs of each, in span order. Each pack has `repo`, `tag`, `tier` (`seg` for a segment, or `h` to `y`), `span` (`start`, `end`), `manifest` (digest), `pack` (`sha256`, the decoded identity, and `bytes`, from its annotations), `idx` and each of `parts` (digest and size), `count`, `key_min` and `key_max` (from its index head; null for a pack of no record), `sources` and `psl`. A pack of `feed` or `new-name` that carries a time copy (`docs/format.md` section 14) also has `time`: `{ "idx": { digest, size }, "parts": [{ digest, size }, ...] }`, its layers `time.idx` and `time.part.000` and up. A pack with no time copy has no `time` field, never a null one, and no pack of another dataset has one. `packFromManifest` takes the two layers both or neither, and holds the time index head to the pack: its dataset byte (6 for `feed`, 7 for `new-name`), its record count (the key index's), each part's size (the layer's), and the first `first_seen` of its key bounds no earlier than the span's start and the last before its end, the half of the bind `readFeed` holds before it reads a block of the copy. `validateRoot` holds the shape, each blob at least the header of its kind (64 B for the index, 16 B for a part), and `planWindow` of `packages/feed` reads it. A writer's `validateRoot` also refuses a pack of `feed` or `new-name` of tier `d`, `w`, `m` or `y` that holds records and lists no time copy, since `readFeed` would refuse every page over it; a reader's leaves that to `readFeed`, so one bad pack fails the pages over it and not the whole root. `pack.bytes` counts the key copy alone, as the annotations do.
- `withdrawn`: the manifests a rollback took out of the live set, each `{ "manifest": "sha256:...", "at": ... }`, where `at` is the `created` of the root that withdrew it, sorted by manifest, and `[]` in the first root. A rollback's new root lists the live root's entries, each with its own `at`, plus each manifest that the live root or a root between it and the target names and the target does not (at its own `created`), minus each manifest the target names. So a pack a compaction replaced after the target was live, which no live root names any more, is listed too. A root of that chain created more than 31 days before the rollback adds nothing: the run that first added a pack it names started before that root, past GitHub's 30 days of re-runs, and a newer root that names the pack adds it. Every root drops the entries whose `at` is more than 31 days before its `created`: GitHub re-runs a workflow run up to 30 days after its initial run (READ 2026-10-29T11:19:40Z, https://docs.github.com/en/actions/how-tos/manage-workflow-runs/re-run-workflows-and-jobs), and the day more is a margin. `validateRoot` holds its shape and order, each `at` no later than `created` and at most 31 days before it, and no manifest it lists among the live packs. A writer refuses a root without it.

Every derived field (`as_of`, `psl_live`, `corpus_since`, `through`, `counts`) is computed again from the packs by `validateRoot` and must be equal. A writer refuses a field or a dataset it does not know. A reader ignores them (§11), and then holds only the per-dataset fields of the datasets it knows.

The live-set rule of §4.5, as `validateRoot` holds it for each dataset. A compacted pack (`h` to `y`) spans exactly its tier unit, aligned, under the tag `tierTag` gives it, or that tag with `-rN` for a rebuild of the span (§4.7 rule 2, ruling 25). Two compacted packs never overlap. Two packs that share a source never overlap, so a merge that left a pack it replaced in the set is refused. In `names`, `domains` and `rev` a segment may overlap a pack of other sources: the THC day segment lies beside the hour packs of the live lanes until the daily compaction. That is the one exception to the disjoint spans of §4.5. In `feed` and `new-name` no two packs overlap, a segment neither (`SEGMENT_OVERLAP` of `packages/root`). The union of the spans is one interval from `corpus_since`. A hole is accepted only when every day of it is listed in `gaps`, and no empty pack is written for such a day (ruling 24); a hole that `gaps` does not name is refused as a missed promotion. Until DOM-029 changes `validateRoot` to hold that, every hole is refused. No manifest digest appears twice in a root.

`sources.json` (format `domains.root-sources.v1`) is the registry, `config/sources.json`, with each source's `through`, held equal to `root.json`, and its `fetched` time, given or carried from the previous root (§3.5). A live pack may carry only a source the registry holds. `coverage.json` is the coverage table of DOM-035. Until DOM-035 writes it, the layer holds the table's shape with nothing measured: `as_of` and `day` null, no pair, no gap.

The first promotion finds no `root:latest`: the root is `root_seq` 1, `previous` null, `as_of` null, with no dataset unless it adds packs, and `psl` the list it is given to pin. `layerBytes` writes each layer as compact JSON with one final newline: machines read it, whatever its spacing. `root.json` then holds about 0.73 KB for each pack entry of one part and three sources, about 97 B for each further part and about 115 B for each withdrawn entry: about 37 KB (36,742 B) for 50 packs of one dataset, fewer than the worst fan-out §4.5 gives for `names`, and about 182 KB (181,552 B) for 50 packs in each of the five datasets [E]. A time copy of one part adds 218 B to its pack's entry [E] (50 `feed` hour packs with one, less 50 without). Each is measured on synthetic entries with `node scripts/root/size.mjs` at 2026-10-29T14:34:49Z, and its test holds these figures; the first real roots replace them. The 64 KiB cap is the manifest's, not the layer's: `scripts/root/lib.mjs` reads a layer of up to 8 MiB. A Worker reads it once, then reads blobs by digest.

### 4.7 Write rules

⛔ Nothing is ever deleted from GHCR (ruling 5). No script calls the packages DELETE API, `oras manifest delete` or `crane delete`.
A static check refuses them (entry DOM-014).

1. **Write-once tags.** A tag that exists is never written again. A script reads the tag first. The same digest means skip. Another digest is a fault that stops the job.
   A file source that republishes other bytes gets a new tag with a new `sha12`.
2. **Forward-only root.** `root:latest` moves only after everything it names exists on GHCR, by an anonymous HEAD of each pack's manifest by digest. Verification (§5.8) is the duty of the job that wrote each pack, before it calls the promotion; `scripts/root/promote.mjs` holds each pack's manifest and index head to each other and does not check that the verification ran. It refuses a pack whose manifest carries `dev.pkgforge.domains.quarantine`: no field of the root would keep a quarantined segment out of `new`. Ruling 23 serves such a pack, never as new: DOM-029 adds a field to the pack entry that marks it quarantined and lifts the refusal. It builds the next root with `root_seq` the live one plus 1 and `previous` the live digest, and each replacement spans every pack it replaces and carries each of their sources.
   It reads `latest` with the job's token just before it pushes the root under its dated tag `r-<created>` (write-once, with `scripts/ghcr/push.mjs`), and again just before it moves `latest` with `oras tag`. Either read refuses the move, exit 1, when `latest` is not the root the run planned on, when the new `root_seq` is not above the live one, when the new root was created no later than the live one, or, outside a rollback, when the new root shrinks the live one: an `as_of` below it, a dataset's `corpus_since` later or gone, or a source's `through` earlier or gone.
   `as_of` may stay equal: a compaction replaces packs and does not extend the corpus. A rollback (`scripts/root/rollback.mjs`) is a new root with a higher `root_seq` that names the packs of an older root, so it may shrink the root, never lower `root_seq`. Its target must have been live once: it is on the chain of `previous` from `latest`, so a dated root that never became `latest` is refused.
   A rollback lists in `withdrawn` each pack it takes out, and each pack a root since the target named and a compaction replaced (§4.6), and every later root refuses an addition or a replacement whose manifest `withdrawn` lists, so a re-run of the promotion that first added such a pack cannot put it back. A withdrawn pack comes back through a rollback to a root that names it, or under its own digest once its entry leaves the list (§4.6). `buildRoot` does not refuse a pack of the same span under another manifest digest. The withdrawn pack keeps the tag its span gives, write-once (rule 1). So a rebuild of the span takes that tag with the suffix `-rN`, such as `names-d-20261026-r2`, then `-r3` (ruling 25). The first build carries no suffix. N is a whole number from 2 to 2^53 - 1 (`Number.MAX_SAFE_INTEGER`), with no leading zero. The same holds for any tier pack found bad after its push. In `packages/ghcr/src/layout.ts`, `tierTag` builds the suffix, `parseTierTag` reads it back, and `nextTierTag` gives the next free tag of a span from the package's tags. `checkTag` refuses a value that is not a string, and the suffix on a tag that is not a tier tag. `validatePack` of `packages/root` accepts a tier pack's tag only as its span's tag or that tag with `-rN`. `nextTierTag` names a tag for bytes that no build of the span holds. So a re-run of a rebuild whose push landed first finds the build that holds its bytes, by its annotation `dev.pkgforge.domains.sha256`, and writes nothing: `tagDecision` of `packages/compact` compares that annotation of each build with the value the run is about to write (§4.5, "A re-run of a rebuild"). A test of `packages/root/test/build.test.ts` withdraws `names-d-20261026` by a rollback, and a later promotion adds `names-d-20261026-r2` for the same span (MEASURED 2026-10-30T04:46:24Z, `node scripts/test.mjs packages/root` exits 0 with 55 tests).
   A refusal after the dated push leaves that dated root unreferenced, which is harmless. Then `latest` is read back as a consumer reads it, with no credential: its digest is the pushed one, and its `root.json` is the root built.
3. **One writer.** Every move of `root:latest` runs in `.github/workflows/root-promote.yml`, whose concurrency group is `root-writer` with `queue: max` and no cancel (ruling 18). A workflow whose job only calls it holds no group of its own, since a caller in `root-writer` would wait on the workflow it calls. That is assumed: no page read states it, and nothing has measured it. That two calls queue in the called file's group is MEASURED (2026-10-29T15:50Z, DOM-020): a caller of it with no group, dispatched twice, made runs 40905625954 and 40905643334, created 6 s apart, and the second call's promote job started at 15:50:58Z, 2 s after the first's ended at 15:50:56Z. Both ended `unchanged`. The caller was removed when DOM-020 closed. Rule 13 of `scripts/check-workflows.mjs` holds both. Every other job that moves `state` runs in `root-writer` itself.
   The job reads the live root, applies its additions and replacements, and pushes. Two writers never move the root at once.
   Jobs that run in parallel, such as the ingest lanes, write segments and cursor proposals only. The one `promote` job advances `state` and the root (§5.4).
4. **Re-run guard.** A re-run of an older run (`GITHUB_RUN_ATTEMPT` above 1) reads the live root first. It drops every addition and replacement that the live root already names, or supersedes with a pack of a higher tier whose span and sources cover it. It writes nothing when nothing is left to change.
   A re-run of a rollback writes nothing: it ends `unchanged` when the live root already names the target's datasets and gaps, and is refused otherwise, since promotions may have landed after the first attempt. A rollback is dispatched again, never re-run.
   A re-run after a rollback is refused by `withdrawn` (rule 2): a re-run whose addition or replacement a rollback took out exits 1 and writes nothing. A `GITHUB_RUN_ATTEMPT` that is not a whole number from 1, in digits alone, is exit 2 before anything is read.
5. **Rate limits.** A 429 from GHCR costs no attempt. The script pauses 20 to 60 seconds, with a total cap, then tries again.
6. **First push from a workflow.** A package first pushed from outside is not linked to the repository, and the workflow token can never write to it.
   Each package's first push comes from a workflow (READ `mirror@669ac72:docs/design.md`, "Running outside GitHub Actions").
7. **Anonymous-read check.** After each push of a new package, a job reads its manifest with no credential. A 401, 403 or 404 opens the issue `visibility-<package>`.
   `mirror-archlinux` has no `visibility-` issue in its whole history (MEASURED 2026-10-27, `gh issue list --repo pkgforge-dev/mirror-archlinux --state all --search visibility` returned none).
   A package created by `GITHUB_TOKEN` from a public repository reads anonymously (READ `mirror@669ac72:docs/measurements.md`, GHCR, 2026-10-14).

### 4.8 Sizes

| Item | Value |
| --- | --- |
| THC daily raw file | 319.9 MB for 2026-10-26 (MEASURED 2026-10-27, design A M3) |
| THC daily names pack | about 200 MB, from 32,554,702 distinct names at 6.04 B (design B M10) |
| THC monthly CSV, September | 37,046,639,482 B (MEASURED 2026-10-27T08:21:52Z, HEAD of the Hugging Face URL) |
| THC monthly CSV, August | 36,029,717,282 B (MEASURED 2026-10-27T08:25:12Z, bucket listing) |
| Raw lane, Kafka `certstream_domains` | 10.6 GB a day on the wire, 28.3 GB once decoded, a snappy ratio of 2.68 (MEASURED 2026-10-28T15:16Z, DOM-004, run 40714194235: 64,001,338 B for 536,533 messages, scaled to the 88,461,905 messages of the 24 hours before the run; `docs/research/measure/DOM-004/result.json`). The figure moves with the topic's 24-hour count. |
| Raw lane, the three NRD topics | 0.19 GB a day on the wire: 82.5 MB, 71.5 MB and 37.8 MB for `newly_registered_domain`, `newly_registered_fqdn` and `confirmed_newly_registered_domain`, one record a batch (MEASURED 2026-10-28T15:16Z, DOM-004, run 40714194235). |
| Raw lane, names tiles | about 1.4 GB a day (MEASURED, design A M10: 26.4 B an entry for 51.7 million entries a day) |
| GHCR growth a year | derived tiers with every tier kept: 1 to 2 TB [E]. The raw lane adds about 4.4 TB [E]: its two measured parts, 10.7 GB a day of Kafka batches (DOM-004) and 1.4 GB a day of names tiles (design A M10), are 12.1 GB a day, and the file sources add less than 1 GB a day. DOM-023 measures the derived growth. Raw data is kept always (ruling 5), so the total is about 5.4 to 6.4 TB a year [E]. |
| mirror-archlinux, for scale | 368.5 GiB on one organisation (READ `mirror@669ac72:docs/measurements.md`) |

### 4.9 R2

R2 holds a cache and a hot copy. It holds nothing else. R2 has no per-bucket size cap, so the Worker enforces the 5 GB limit itself.

| Prefix | Purpose | Budget |
| --- | --- | --- |
| `root/` | copies of the root and `sources.json` | 0.05 GB |
| `idx/` | indexes of live packs | 0.5 GB |
| `hot/` | the newest segments, hour packs and feed packs, copied from GHCR after each promotion | 0.8 GB |
| `blk/` | blocks by `digest/offset-length`, immutable, read through | 2.7 GB |
| headroom | | 0.45 GB |

The planned total is 4.5 GB. The Worker keeps a size counter and stops writing `blk/` objects at 4.3 GB. A scheduled job recomputes the counter from a listing.
A lifecycle rule expires `blk/` after 14 days and `hot/` after 7 days. The Cache API sits in front of R2.
R2 writes stay under 25,000 a day (class A) [E]. Only Workers write R2. Actions holds no Cloudflare credential.

## 5. Ingestion

### 5.1 Where each step runs

| Step | Runs on | Why |
| --- | --- | --- |
| Adapters: THC dump, Kafka, tiles, feeds | GitHub Actions | Free for public repositories. A runner has 4 vCPU, 16 GB RAM and a real network. Kafka needs a client with offsets. |
| Compaction and verification | Actions, with a matrix when a pack is large | A job lasts up to 6 h. A matrix has up to 256 jobs and 20 run at once for the organisation. |
| Root and state promotion | Actions, one job, group `root-writer` | One writer moves the root forward (§4.7). |
| Serving, caching, R2 housekeeping | Workers | They read only. They hold no secret. |
| Watchdog, status, keepalive | Actions, then the Worker shows the age | A Worker cannot dispatch a workflow without a token, and no credential crosses (ruling 6). |

READ for the Actions limits: standard runners are free on public repositories with 4 vCPU, 16 GB RAM and 14 GB SSD.
A job lasts at most 6 h and a matrix has at most 256 jobs. The free plan runs 20 jobs at once for the whole organisation.
`GITHUB_TOKEN` is limited to 1,000 REST requests an hour for each repository (design A §2.2, design B §2.2).
A runner holds about 87 GB free in practice and 120 GB after the mirror's `debloat-runner` script (READ `mirror@669ac72:docs/measurements.md`).

### 5.2 The clock

The clock is the thing that starts an ingest run. Ruling 8 requires a measurement. The design has three candidates.

| Clock | How it works | Evidence so far |
| --- | --- | --- |
| A. `schedule` | A cron line in a workflow. | GitHub delays and drops scheduled runs (READ events documentation). On `mirror-archlinux`, the `*/15` workflow ran 40 times in its last 300 runs, with a median gap of 233 min (p90 318, max 377). A re-measurement at 2026-10-27T09:14Z gave 67 runs, median 229 min, p90 314, max 443. The `17 */3` workflow had a median gap of 274 min with 10 dispatches among 37 runs. The hourly status workflow reached a 53 min median only with 90 dispatches. MEASURED 2026-10-27T06:33Z by the operator's agent. Design B measured the same: 66 scheduled runs in 10.1 days against about 970 expected, median 227 min, max 443 min (design B M8). |
| B. Self-dispatch chain | Each run starts the next with `gh workflow run`, using `GITHUB_TOKEN`. A concurrency group makes the next run wait until this one ends. | Once a run exists, its runner starts fast: median 2 s, p90 3 s, max 7 s over 250 jobs (design B M8). Dispatch runs queue like scheduled runs. DOM-001 measures the chain's gaps. |
| C. Cloudflare cron Worker | A Worker with a cron trigger reads the sources, writes a 72 h hot tier to R2, and the Actions jobs write the durable tiers. | Not measured. DOM-002 measures it with the probe Worker that DOM-061 deploys. |

The decision rule (DOM-003) reads 48 hours of gaps from each clock. The two thresholds below, a p90 of 15 minutes and a maximum of 60, were proposed from the freshness target, and the operator confirmed them on 2026-10-28 (ruling 17).

- Take the first of A, then B, whose p90 gap is at most 15 minutes and whose maximum gap is at most 60 minutes.
- If A and B both fail, build C (entry DOM-025). Actions then carries only the durable work: the THC daily job, compaction, verification and the root.
- If B passes, the watchdog (DOM-034) still restarts a broken chain, as `mirror-archlinux` does (§5.9).

GitHub Actions is the default. C is the alternative a design built only on Actions would not need. A hot tier written by a Worker lets a 1 h window stay fresh when Actions is late.
Under C, the hot tier carries what needs no ledger: OpenINTEL claims, ISC rows, and CT names with their log times. Newness verdicts stay `provisional` until the daily job (§5.8).
Kafka over a Worker `connect()` needs DOM-005 to pass. If it fails, the Kafka lane stays on Actions.

### 5.3 Schedules

All times are UTC. Minutes are off the top of the hour because GitHub delays the start of every hour. Durations are [E] until DOM-001 to DOM-012 replace them.

| Workflow | Trigger | Does | Run time [E] |
| --- | --- | --- | --- |
| `ingest-live.yml` | the chain (§5.2), with a backstop cron `7,22,37,52 * * * *` | Kafka topics, tile slices, conditional GETs of ISC and the lists. Writes segments. Builds the hour pack when an hour has closed. Promotes the root. | 3 to 6 min |
| `ingest-thc.yml` | `20 0 * * *`, then `20 1-6 * * *` until the day's file exists | Download, normalise, sort, encode, verify, push the day's segment | 10 to 30 min |
| `compact-daily.yml` | `35 1 * * *`, and dispatch with `day`, `rebuild` and `first-ledger` | Plan the day dispatched, or the last 7 days. Merge the hour packs and the segments of `names`, the THC day among them, into `d`. Build the `domains` day pack, the `feed` day pack by the exact join, and the ledger filter (`scripts/compact/day.mjs`). Verify, push, promote. The `new-name` day pack (DOM-041), the dumps (DOM-040) and the coverage table (DOM-035) come later. | 20 to 40 min |
| `compact-weekly.yml` | `50 3 * * 1`, and dispatch with `span` and `rebuild` | Plan the week dispatched, or the last 5 weeks. Merge 7 day packs into `w` for `names`, `domains`, `feed` and `new-name`. Skip a week that crosses the first of a month. | matrix |
| `compact-monthly.yml` | `50 4 1 * *`, and dispatch with `span` and `rebuild` | Plan the month dispatched, or the last 3 months. Merge the week packs, and the day packs of the weeks that cross the month's edges, into `m`. | matrix |
| `compact-yearly.yml` | `50 5 1 1 *`, and dispatch with `span` and `rebuild` | Plan the year dispatched, or the last 2 years. Merge month packs into `y`. | matrix |
| `rev-monthly.yml` | `30 6 * * *` | Compare THC's release listing with the last month built. Build when a new month exists. | 2 to 6 h |
| `ref-refresh.yml` | `13 5 * * *` | Refresh the PSL and the CT log list. Pin by sha256. | 1 min |
| `watchdog.yml` | `41 7 * * *` | Staleness, schedules, anomaly issues | 2 min |
| `status.yml` | `47 * * * *` | Start overdue workflows. Read the Worker's status and the sources' upstreams, and raise or clear `status-down` and `worker-down`. It publishes no file and pushes no branch: the Worker computes the status from the root. | 2 min |
| `ci.yml` | push, pull request | The gate | 5 min |
| `worker.yml` | push to `main` that changes the Worker | The Worker's tests. It never deploys. | 3 min |

Total runner time is 100 to 420 minutes a day [E] (design B §10: 105 min; design A §5.2: 6 to 7 h).
It is free on a public repository. It shares the organisation's 20 concurrent jobs with `mirror-archlinux` and every other repository.

**The compaction workflows** (DOM-023). The four files run the same jobs (READ `.github/workflows/compact-daily.yml` and `compact-weekly.yml`, whose headers name each job).

| Job | Does | Grants |
| --- | --- | --- |
| `plan` | Runs on `main` alone. Reads `root:latest` once with no credential, and pins its digest and its PSL. Runs `scripts/compact/plan.mjs` for each dataset and each unit. Holds a ready unit of `domains` or `feed` whose inputs were built under more than one PSL list (in `compact-daily.yml`, a `domains` day with the `feed` of the day): it prints `held` and a warning, and gives the unit no leg. Writes the matrices: one leg per range, at most 256 legs in a run. | `contents: read` |
| `count`, `compact` | Run the two stages of `scripts/compact/range.mjs`, at most 6 jobs at once. Read the inputs from GHCR with no credential. Push nothing. | `contents: read` |
| `day` (daily) | For each day whose `domains` unit is ready, or live with a `feed` unit to build: reads the live ledger of the package `state` with no credential, then runs `scripts/compact/day.mjs --day DAY` on the pinned root. A `state` that reads and holds no `ledger-filter-` tag is the first ledger. A `state` that does not read with no credential fails the leg, unless the run was dispatched with `first-ledger`. Pushes nothing. | `contents: read` |
| `assemble` | One job a unit, on `main` alone. Builds the pack (`scripts/compact/assemble.mjs`), or takes the day pack that `day.mjs` wrote. A `names` or `new-name` unit whose inputs were built under several PSL lists takes the list the root pins (`--psl`). Verifies the local files with `scripts/verify-pack.mjs --require dataset,length,count,sha256,psl,sources,precision`, and `time` for a `feed` or `new-name` pack that holds records. Pushes the pack with `scripts/ghcr/push.mjs` under its write-once tag. Writes the replacement, each replaced pack named in its own package. | `contents: read`, `packages: write` |
| `push` (daily) | Runs after `assemble`, in the group `root-writer`, on `main` alone. Pushes a day's `ledger-filter-YYYYMMDD` to `state`, written once, when the day's `domains` pack verified and pushed in the run or was live before it. | `contents: read`, `packages: write` |
| `promote` | Only calls `root-promote.yml` with the replacements and additions of the units that pushed or were found present. Holds no group (ruling 18). | `contents: read`, `packages: write` |

A scheduled run plans the last units of its tier that have closed, so a unit of a dropped run is taken by a later run. A unit that is not whole waits, and the run stays green. On the empty corpus every unit waits or is skipped. MEASURED on the operator's machine, each `plan` step of the tree run alone under bash in its scheduled form, with the real scripts, against `root:latest` `sha256:bd69a39c1810eaa1c3b21dfa9de4c097a806a2372cb21ad648e9ef34a80eaeac` (`root_seq` 1, no pack, pinned PSL `1f96bae40adfc22ca2474d7c0099bbcfcb25aefd3e2547b5c2147c0dd2e3ebd9`). The step of `compact-weekly.yml`, 2026-10-30T02:45:46Z to 02:46:39Z, printed 16 `wait` and 4 `skip`. The step of `compact-daily.yml`, 02:46:47Z to 02:47:47Z, printed 21 `wait`. The step of `compact-monthly.yml`, 02:47:47Z to 02:48:23Z, printed 12 `wait`. The step of `compact-yearly.yml`, 02:48:23Z to 02:48:51Z, printed 8 `wait`. Each then printed `nothing to compact: no unit is ready` and exited 0.

**Late sources.** A day waits only on a source of its own packs whose live packs end before the day ends. `planTier` cannot see a source that has no pack in the day. So a day whose every hour pack comes from one lane and whose THC segment is not promoted yet is `ready` at 01:35, while `ingest-thc.yml` retries until 06:20, and the run builds the day's packs without THC. MEASURED 2026-10-30T04:02:48Z with `planTier` called by `node` on a synthetic root of the 24 hour packs of one day of `names` from `ct-le` alone, which `hours` of `packages/root/test/helpers.ts` builds: the day is `ready`, with 24 inputs. A rule of expected sources, under which a day waits on THC until the last retry of `ingest-thc.yml`, is an open duty of DOM-029. No code holds it.

A THC segment promoted after its day pack stays beside that pack in `names` and `domains` until the week, or the month for a week that crosses the first of a month, merges it. It never enters `feed`: the `feed` day pack is built once, by the join, and the week merges `feed` day packs. MEASURED 2026-10-30T02:44:50Z with `planTier` called by `node` on synthetic roots, whose packs `pack` of `packages/root/test/helpers.ts` builds: the day with its `names` day pack and a later THC segment is `present`, and the week takes the segment as an input. The month of October 2026 takes a later THC segment of 2026-10-27, a day of a week that crosses the month's end, as an input too. The workflow cannot build a live day again: `planTier` gives a live unit `present`, so the plan step keeps no unit for `rebuild` to take.

**PSL lists** (ruling 22). The keys of `names` and `new-name` do not depend on the PSL, so a unit of them whose inputs were built under several lists takes the list the root pins. The keys of `domains` and `feed` do depend on it, so `assemble.mjs` and `day.mjs` refuse their inputs built under two lists with exit 1 (`CompactError` `psl`): the recompute under one list is not built. So the plan step of the weekly, monthly and yearly workflows holds a ready unit of `domains` or `feed` whose inputs carry more than one PSL hash: it prints `held TAG` and a warning, gives the unit no leg, and exits 0 when no other unit faulted. The plan step of `compact-daily.yml` holds such a `domains` day, and the `feed` of the day with it, since `day.mjs` builds the `feed` day pack by the join under the one list of the `domains` inputs. Every unit above a held unit waits, as a week waits on a missing day pack. MEASURED 2026-10-30T02:44:51Z: `planTier` called by `node` on 7 synthetic day packs of `names`, three built under one list and four under another, gives `ready` with two lists in `psl`.

The four workflows share one concurrency group, `compact`, with `queue: max` and no cancel. So a monthly run plans against the root that the weekly run of the same morning promoted, and never replaces day packs that a week pack has replaced.

⚠ What is not done or not measured:

- The move of `ledger-delta` needs the `state` guard of DOM-024. Until it exists, that step of the job `push` fails the job.
- The recompute of `domains` and `feed` under one PSL list is an open duty of DOM-023. Until it is built, a move of the pinned list holds each `domains` and `feed` unit whose inputs mix two lists, and every unit above it (§4.6, §5.4).
- `scripts/ghcr/push.mjs` builds the manifest it pushes from the same layers and annotations. So the pushed digest is not the digest that `assemble.mjs` prints.
- `scripts/ghcr/push.mjs` reads each pushed pack back with no credential and exits 4 when it does not read, which fails the leg (§4.7 rule 7). Nothing raises the issue `visibility-<package>` until DOM-034.
- A year pack is read from the disk of one runner, and `scripts/ghcr/push.mjs` pushes all its layers in one copy of at most 600 s an attempt, 3 attempts in all (`ATTEMPT_S` of `scripts/ghcr/rate.mjs`; READ the header of `scripts/ghcr/push.mjs`). At the 63.5 to 121.4 MB/s that DOM-006 measured (§4.3), 600 s moves about 38 to 73 GB. The first yearly run, on 2027-01-01, builds nothing: the year 2026 of each dataset that has a corpus starts before its `corpus_since` (§4.5, "Before `corpus_since`"), and a dataset with no pack, such as `new-name` until DOM-041 builds it, has no `corpus_since` and waits on its month packs. The first year pack is 2027's, built on 2028-01-01. A year of THC names alone is about 72 to 84 GB at 6 to 7 GB a month [E] (design B section 6.4, in the Premise of DOM-023), above what the slowest push measured moves in one attempt. Whether a later attempt skips the blobs an earlier one uploaded is not measured.
- `measure-compact.yml` measured one range of about 0.58 GB of input from local files: about 7.8 minutes and under 300 MiB (§4.5, "The scripts"). At that rate a year of THC names, 72 to 84 GB [E], is about 125 to 145 ranges, 16 to 19 runner-hours, about 3 hours at a `max-parallel` of 6 [E]. The read from GHCR by range and the time copy are not measured.
- The guards of the four workflows' shell run under bash in `scripts/compact/workflows.test.mjs`, with doubles for `node` and `oras`. No compaction workflow has run on GitHub.

### 5.4 Idempotence, cursors and dedupe

- **Segment identity** is `(source, window, cursor_before, cursor_after)`. A re-run with the same inputs writes the same bytes, because records are sorted and compression is fixed.
  The tag exists with that digest, so the push is a no-op.
- **Cursors** live in the `state` package: the Kafka offset of each topic, the next tile index of each log with the tree size at the last read, the last THC day, and the ETags.
  The lanes of one run (Kafka, tiles, feeds) run in parallel. A lane pushes its segments and writes a cursor proposal `(source, before, after, tags)`. It never writes `state`.
  One `promote` job, in the concurrency group `root-writer` (§4.7 rule 3), advances the cursors: it keeps a proposal only if its segments exist and its `before` is the live cursor, pushes `state` once, last, and only when the live `state` is the one it read.
  If the `state` push fails, or a proposal is dropped, the next run reads the old cursor, regenerates the same segment, skips the existing tag, and advances.
- **Dedupe** is a property of the merge: minimum of first, maximum of last, union of sources. Order and retries do not change the result.
- **Within a source**, a name appears once per segment. A 5-minute Kafka window held 194,303 messages and 239,171 distinct names (MEASURED 2026-10-27, design A M8).
  Tiles hold about 1.3 names an entry (design A M10). Segment size follows distinct names.
- **Reference data** is pinned by sha256. A pack keeps the PSL it was built under, in its `dev.pkgforge.domains.psl`, and no code recomputes `suffix`, `reg` and `site` under a new list. The plan steps of the compaction workflows hold a ready unit whose keys depend on the list and whose inputs carry more than one PSL hash, and exit 0 when no other unit faulted (§5.3, "PSL lists"). The recompute under one list is an open duty of DOM-023.

### 5.5 Backfill

| Source | Reach |
| --- | --- |
| THC daily | 54 days from the Hugging Face bucket `IP-THC-ORG/Daily-Cerstream-Dumps`: 35,765,972,194 B (MEASURED 2026-10-27T08:25:12Z). The days 2026-10-04 and 2026-10-09 are missing. A file's path is `<year>/<month without a leading zero>/<date>.txt.gz`: `2026/9/` holds September only and October is `2026/10/`, so the adapter takes each path from the listing. DOM-029 runs a matrix of one day each and records the gaps. |
| THC monthly | August and September 2026 (DOM-042) |
| Kafka `certstream_domains` | about 25 to 27 hours (design A M6, design B M4) |
| Kafka NRD topics | about 11 to 13 days |
| Names tiles | any time since a shard began, by binary search on entry timestamps. 21 probes found a 5-minute window (design A M10). The first backfill is 7 days. |
| ISC | 5 dated files |
| WhoisDS, `cenk-nrd`, `hagezi-nrd` | the window each file carries |

The corpus horizon is the earliest backfilled day, 2026-09-01. Answers carry `confidence: warming` for 90 days after it.

### 5.6 The adapter contract

An adapter is a directory `adapters/<dir>/`. The ingest entries create the tree, one directory each (`AGENTS.md` section 6). `packages/adapter` (DOM-016) holds the contract.
A directory may hold several sources: DOM-026 puts three in `adapters/oi-nrd/`. The directory's name keeps the id grammar and need not be a source id. The directory holds:

1. `source.json`: `{ "format": "domains.source.v1", "sources": [...] }`, a list of one or more sources. Each source holds exactly `id`, `bit`, `family`, `datasets`, `precision`, `kind`, `basis`, `cadence`, `band`, `urls`, `retention`, `parser` and `failure_modes` (`SOURCE_FIELDS` of `packages/adapter/src/validate.ts`). `validateSourceFile` refuses any other field. It refuses `fetched`, `status` and `through` with the code `runtime-field`: a run writes them, or a reader derives them (§3.5).
2. A module with `run(cursor, ctx)`, which returns `{segments, cursor, stats, errors}`.
3. Fixtures of recorded answers and a test that runs the module against them.

Rules.

- An adapter writes segments. It never writes the root, `state` or another source's tag.
- A segment is deterministic and passes the verifier (§5.8) before it counts.
- A failed adapter fails alone. It never blocks another source or the root.
- The registry row in `sources.json` and the row in `docs/sources.md` are held equal by a test.
- To add a source: allocate a bit, write the adapter, add its failure-mode row. Nothing downstream changes.

### 5.7 A VPS later

A VPS ingester is one more adapter, for example `vps-ct`. It runs the same encoder and verifier and pushes segments.
GHCR accepts only classic tokens for pushes from outside Actions, and such a token can write every package of its owner (READ `mirror@669ac72:docs/design.md`, "Running outside GitHub Actions").
This project holds no token (ruling 6), so the VPS does not push. It is a pull model:

1. The VPS writes its segments to its own disk and serves them over HTTPS: a static directory with an `index.json` of tags, sizes and sha256, and no credential in either direction.
2. An Actions job fetches the segments it does not hold, checks every sha256, runs the verifier (§5.8), and pushes them with its own `GITHUB_TOKEN`, as it pushes a segment of any other source.
3. The first push of each package comes from a workflow, so each package is linked to the repository. The `promote` job lists the pulled segments in the root, and validates them again before they count.

The VPS therefore holds nothing that can write GHCR, and a compromised VPS can offer a segment that the verifier refuses and cannot move the root or `state`. Nothing in this project holds a secret (entry DOM-057).

### 5.8 Verification before promotion

This step adapts the mirror's verify step. A job fails when any check fails.

1. Decode the whole pack. Check bytewise key order, uniqueness, charset, label length, no upper case, and that counts match the annotations. The verifier (DOM-018) prints SKIP for a check with nothing to compare, so the job that writes a pack names the checks it needs with `--require` (with `time` for a pack that carries a time copy) before it calls the promotion, which does not check that it ran (section 4.7, rule 2).
2. Re-find 1,000 random keys with the reader module the Worker uses. One TypeScript module runs in Node and in workerd.
3. Compare volume with the median of the last 7 days that were not quarantined. A THC day under 40% of the median is quarantined: it is pushed with the annotation `dev.pkgforge.domains.quarantine` set to `1`, excluded from `new` computations, and an issue `anomaly-<source>` opens. Its names are still served in `names`, `domains` and `rev` (ruling 23, built by DOM-029).
   THC's volume fell to about a third in early October with no stated reason: 843 to 986 MB a day in September, 984 and 957 MB on 10-01 and 10-02, 445 MB on 10-03, and 77 to 340 MB a day from 10-05 (MEASURED 2026-10-27T09:34:52Z, `curl -sS 'https://huggingface.co/api/buckets/IP-THC-ORG/Daily-Cerstream-Dumps/tree?recursive=true'`, sizes summed per file).
   A baseline that never moves would quarantine every day after a lasting drop: all 21 observed days from 10-05 sit below the floor of 379 MB (40% of 947 MB).
   So the rule has a step change: 3 consecutive observed days below the floor reset the baseline to the median of those 3 days, and the third is accepted. A missing day neither counts nor breaks the run.
   The backfill, run in date order, quarantines 10-05 and 10-06, accepts 10-07 with a baseline of 294 MB, and quarantines 10-15 (77 MB against a median of 276 MB). `checkBand` (entry DOM-016) holds the rule.
4. Check the PSL hash and the source's `precision`.
5. For the hourly filter's `provisional` verdicts, the daily job recomputes `first_seen` exactly against the `domains` table and writes the corrections.
   Hot answers carry `provisional: true` until then.

A verification uses fixed charset and length rules. It uses no content regular expressions.

### 5.9 Workflow rules

Each rule is checked by DOM-014.

- Every workflow starts with `permissions: {}`. Each job grants the least it needs. A job that writes GHCR has `packages: write`. A job that opens an issue has `issues: write`. A job that dispatches or enables a workflow has `actions: write`. Only the jobs named in one table of the workflow check may hold one of the three (`scripts/check-workflows.mjs`, created by entry DOM-014, which lists the names). No job has `contents: write`: no workflow pushes a branch, so there is no status branch, and status is read through the Worker.
- A job that holds `packages: write` runs on `main` alone: its `if:` holds `github.ref == 'refs/heads/main'` as one operand of a top-level `&&`, with no top-level `||` (rule 3 of `scripts/check-workflows.mjs`, `onMainOnly`). A job that only calls `root-promote.yml` is exempt, since the called file's own job holds the grant and that test.
- Every `uses:` pins a commit. The runner is `ubuntu-24.04`.
- No workflow holds a Cloudflare credential. No workflow calls the packages DELETE API.
- Concurrency groups: `root-writer` (queue `max`, no cancel) for any job that moves the root or `state`; `ingest-<source>`; `compact`, the one group of the four compaction workflows (§5.3); `ci-` with a pull request's number, or the run id for any other event (READ `.github/workflows/ci.yml`).
- The workflows start each other when a run is overdue, with `dispatch-overdue`, and re-enable disabled workflows, with `keep-schedules-enabled`.
  Both are copied from `mirror-archlinux`. GitHub disables schedules after 60 days with no activity (READ events documentation).
- A watchdog raises `schedules-stopped` when a schedule stops, and `stale-<source>` when a source is late.

## 6. THC's data, mirrored

THC publishes two things. Both are mirrored. No route calls THC's live API.

- The daily CT dumps. `cs2.ip.thc.org` lists `<date>.txt.gz` from 2026-10-01. A file appears about 00:04 UTC the next day. The 2026-10-26 file was 319,917,410 B.
  The Hugging Face bucket holds the same bytes plus September. The adapter `thc-ct` reads cs2 first, then the bucket (DOM-029).
- The monthly database. THC publishes it at each month's end. September's was released 2026-10-04 with 6.36 billion records (READ `https://ip.thc.org/docs/bulk-data-access`, 2026-10-27; the page answers only a request with a browser User-Agent: `curl` with its default one got 404, MEASURED 2026-10-27T09:38:43Z).
  Gzipped Parquet needs full decompression before its footer can be read. Gzipped CSV streams on a runner. This project mirrors the CSV.

Where the monthly files live (READ the page above, MEASURED 2026-10-27).

| Host | URL | Notes |
| --- | --- | --- |
| Hugging Face (fast) | `https://huggingface.co/buckets/IP-THC-ORG/Datasets/resolve/2026/10/rdns-sept.csv.gz?download=true` | 302 to a signed CDN URL. 206 on Range. First 1 MiB in 2.96 s. |
| `dns.team-teso.net` (slow) | `https://dns.team-teso.net/2026/rdns-sept.csv.gz` | A 1 MB Range read did not answer within 120 s at 2026-10-27T08:03Z. |

Measured columns, from the first 1,048,576 compressed bytes of the September CSV (MEASURED 2026-10-27T08:21:59Z, `curl -r 0-1048575` then `gzip -dc`):

- 72,834 lines, every line with exactly two comma-separated fields: `ip,name`. There is no header.
- Both IPv4 and IPv6 addresses appear. The file is not sorted by address. One address carries several names (41,973 distinct addresses in 72,834 lines).
- No line has a third column, a record type or a CNAME target. Names that contain the text `cname` are host names that resolve to an address.
- The sample's average is 41.2 bytes a line. The page's 252 GB for 6.36 billion records gives 39.6 bytes a record, so the whole file has the same two-column shape.

So the monthly database holds reverse IP to names and holds no CNAME targets. DOM-010 confirmed it over the whole stream: all 6,364,111,723 records of the September file have exactly two fields and an address first (MEASURED 2026-10-28T15:53Z on a runner, run 40714223764, `docs/research/measure/DOM-010/result.json`).
Until a mirrored source holds CNAME targets, `GET /v1/cnames/{target}` answers 501 with the reason `unsupported-by-source` (§7.2). DOM-046 takes the first of them that DOM-058 (OpenINTEL's measurement topic) or DOM-047 (its zone Parquet) shows to carry CNAME records (ruling 10, `TODO/RULES.md` §5).

The mirror keeps the CSV as fetched: chunks of at most 4 GiB in package `obs`, each with a sha256, written once per month.
A job builds the `rev` packs from it (DOM-043): the keys are the address bytes, the values are the names. A query reads the newest month by default.

## 7. The API

One Worker serves `domains.pkgforge.dev`. The hostname is one level below the `pkgforge.dev` zone, so the zone's Universal certificate covers it.
The Worker reads and never writes GHCR. Its name is `domains-pkgforge-dev`. Its code lands in `apps/api/` with DOM-030.

### 7.1 Common rules

- Every route is `GET` unless it says otherwise. `HEAD` answers like `GET` with no body.
- JSON is the default. List routes accept `format=ndjson|csv|txt`.
- Every JSON answer has the shape below. Every error is `application/problem+json` with `status`, `title`, `detail`, `reason` and `see`.
- CORS: `access-control-allow-origin: *`. No credentials are ever allowed.

```json
{
  "data": [
    {
      "domain": "example.com.np",
      "first_seen": "2026-10-27T04:12:09Z",
      "first_seen_precision": "second",
      "last_seen": "2026-10-27T05:30:00Z",
      "registered": { "basis": "nrd-ct+rdap", "confidence": 3, "sources": ["oi-nrd-confirmed"] },
      "sources": {
        "oi-nrd": { "first": "2026-10-27T04:12:09Z", "last": "2026-10-27T05:30:00Z" },
        "thc-ct": { "first": "2026-10-27", "last": "2026-10-27" }
      },
      "flags": ["provisional"]
    }
  ],
  "meta": {
    "as_of": "2026-10-27T05:50:00Z",
    "root": "sha256:<digest>",
    "corpus_since": "2026-09-01",
    "confidence": "warming",
    "sources_used": ["oi-nrd", "thc-ct"],
    "sources_failed": [{ "source": "ct-geomys", "since": "2026-10-27T04:00:00Z", "error": "429" }],
    "tiers_read": ["h-2026102705", "d-20261026", "w-2026w43"],
    "partial": false,
    "next_cursor": null
  }
}
```

A day-precision value prints as a date. A second-precision value prints as a time.

Provenance headers say what answered, and nothing the path did not use.

| Header | Value |
| --- | --- |
| `x-domains-root` | the digest of the root the answer was computed from |
| `x-domains-as-of` | the root's `as_of` |
| `x-domains-tiers-read` | the number of packs read |
| `x-domains-sources-used` | the source ids that contributed |
| `x-domains-sources-failed` | the source ids that failed; absent when none |
| `x-domains-cache` | `hit` (Cache API), `r2`, `ghcr` or `mixed` |
| `x-domains-body` | `derived`, or `verbatim` for a dump served as stored |
| `x-domains-degraded` | `1`, only when an answer used stale data or lacked a source |

### 7.2 Routes

THC parity.

| Route | THC counterpart | Source |
| --- | --- | --- |
| `GET /v1/ip/{ip-or-cidr}` | `POST /lookup` | `rev` packs. Rows `{domain, apex_domain, tld}`. No organisation, country or ASN. |
| `GET /v1/subdomains/{domain}` | `POST /lookup/subdomains` | `names` tiers. Rows `{subdomain, last_seen_on, first_seen_on, sources}`. |
| `GET /v1/cnames/{target}` | `POST /lookup/cnames` | none yet. Answers 501 `unsupported-by-source` with the list of mirrored sources it checked. |
| `GET /v1/ip/...`, `/v1/subdomains/...` with `format=csv` | `GET /download`, `/subdomains/download` | the same, streamed. THC caps a file at 50,000 rows. Ours caps at 5,000,000. |
| `GET /v1/dumps/names/{date}.txt.gz` | `cs2.ip.thc.org/<date>.txt.gz` | the `dumps` package. 302 to the signed blob URL. Sorted, lowercase, wildcards kept. |
| `GET /v1/dumps/rdns/{month}` | the monthly files | 302 to the mirrored raw chunks' listing. |

Our own routes.

| Route | Purpose |
| --- | --- |
| `GET /v1/new` | New or newly registered registrable domains, or names |
| `GET /v1/names` | Names under a suffix or parent with first and last seen in a window |
| `GET /v1/domain/{reg}` | The dossier: first and last per source, evidence, recent names |
| `GET /v1/name/{fqdn}` | First and last per source |
| `POST /v1/lookup` | Up to 500 names or domains in one call |
| `GET /v1/dumps`, `/v1/dumps/{dataset}/{date}` | List and fetch bulk files |
| `GET /v1/suffixes?since=` | Counts per suffix for a window, from the daily summaries |
| `GET /v1/sources`, `/v1/status`, `/v1/coverage` | Source health, freshness, `corpus_since` and the cross-source table |
| `GET /v1/index/latest` | The root digest and the GHCR references, so a client can read with no Worker |
| `GET /healthz` | `{ok, version, root_age_s}`. `503` with `ok: false` when the root is older than 6 h. |
| `GET /`, `/llms.txt`, `/llms-full.txt`, `/openapi.json`, `/SKILL.md` | Generated documents (§7.7) |

### 7.3 `GET /v1/new`

| Parameter | Meaning |
| --- | --- |
| `since` | `1h`, `6h`, `12h`, `1d`, `Nd` (N at most 31), or an ISO 8601 time. Default `1d`. |
| `until` | An ISO 8601 time. Default: now. |
| `kind` | `registrable` (default) or `fqdn` |
| `suffix` | A public suffix: `np`, `com.np`, `co.uk`, `xyz`. One contiguous key range. For `kind=registrable` it keeps the domains whose suffix is exactly it, one label under it: `suffix=np` keeps `example.np` and leaves `example.com.np`, whose suffix is `com.np`. For `kind=fqdn` it keeps every name under it, and DOM-041 narrows that by the PSL. |
| `under` | Any parent: a TLD, a suffix, a registrable domain or a name. One contiguous key range. |
| `basis` | `any` (default), `seen`, `claimed`, `registered`, `zone`, `rdap`, `nrd-list`, `ct`. `any` and `seen` keep every row: each row of the feed is newly seen. `claimed` keeps a row with a basis of tier 1 or 2 (`zone`, `rdap`, `nrd-list`, `nrd-ct+rdap`), and `registered` one with a registry claim (`zone`, `rdap`, `nrd-ct+rdap`). `zone`, `rdap` and `nrd-list` keep a row with that basis, and `ct` one with `ct-first`. |
| `source` | One or more source ids. A row is kept when at least one of them carries it. |
| `min_confidence` | 1 to 10. It keeps the rows that a registry claim backs at least that strongly: a `zone` or `rdap` basis, which outranks every OpenINTEL level, or an `nrd-ct+rdap` basis whose stored OpenINTEL level is 1 to the value, level 1 being the closest to the RDAP date. Every other row is left out, a row of no stated level (0) among them. |
| `suspect` | `exclude` (default), `include`, `only` |
| `provisional` | `include` (default) or `exclude` |
| `order` | `first_seen.desc` (default) or `first_seen.asc` |
| `limit`, `cursor` | `limit` defaults to 1,000 and is at most 10,000. The cursor is opaque. |

A window is read from the live set. A window of 1 h to 12 h reads segments and hour packs.
A window of N days reads day packs, and week packs where a week is whole. `meta.tiers_read` lists them.
A pack of tier `d`, `w`, `m` or `y` is read through its time copy, from the bound of the window in `order`, and one without a time copy is refused; a segment or an hour pack may have none and is read from its key copy and a sort (`docs/format.md` section 14.4).
A page of 1,000 rows with no filter read 1 or 2 blocks of a day pack of 500,000 synthetic rows. A filter that drops most of the rows read costs their blocks too: `source=oi-nrd` on a window from 12:00, ascending, read the 49 blocks of the day's day-precision rows (§7.4) before its first row, 50 in all (MEASURED 2026-10-29T14:42:47Z, `docs/format.md` section 14.6). The block budget of §7.6 bounds such a page.

### 7.4 Time

`since` and `until` are UTC. `first_seen` is compared at its own precision: a day-precision row is inside a window when its day overlaps the window.
`meta.as_of` is the root's time. Each source's `through` time is in `/v1/sources`. A window that overlaps a `gap` of a source says so in `meta`.

### 7.5 Caching

| Object | Cache time |
| --- | --- |
| Blocks, indexes and pack manifests by digest | 1 year, immutable |
| `root:latest` | 30 s |
| Hour and segment packs of the current day | 60 s |
| Closed day, week and month packs | 1 year, immutable |
| Signed blob URLs | until the URL's `se` minus 120 s, at most 600 s |
| Query answers | the minimum of the cache times of their inputs |

The Cache API is per data centre. Single-flight per key inside one isolate. One query fans out over at most 6 concurrent subrequests.

### 7.6 Limits, and no gating

No route asks for a key, an account or a quota. No route limits a caller's rate. The limits below bound the work of one request.
They are design values. DOM-054 measures them and may change them.

| Limit | Value |
| --- | --- |
| Window by the API | at most 31 days. Longer ranges use dumps. |
| Rows in a JSON page | at most 10,000 |
| Rows in a streamed `csv`, `ndjson` or `txt` answer | at most 5,000,000 |
| Batch lookup | at most 500 keys |
| Packs read in one request | at most 60 |
| Blocks read in one request | at most 2,000. A broader query returns `partial: true` and a cursor. |

Cloudflare's own abuse controls still apply. The Worker never refuses a caller on the caller's identity.

### 7.7 Root documents

Every service of this family answers its root with generated documents. The Worker does the same. A registry of routes lives in one typed file beside the handlers.
A generator renders `llms.txt`, `llms-full.txt`, `openapi.json` and `SKILL.md` from that registry at build time.
The gate regenerates them and fails on a difference. A test fails when a handled route has no registry entry (entry DOM-059).
`/` answers a browser with a small HTML index and any other client with `llms.txt`.

## 8. Redundancy and failure

No source is complete. On the same 5 minutes of 2026-10-26, THC's day dump held 39.8% of the names in OpenINTEL's Kafka window.
That stream carried no Let's Encrypt, Geomys or IPng log. THC held 97.7% and 98.1% of the names of two Let's Encrypt shards (MEASURED 2026-10-27, design A M8, M9).
ISC's new domains of 2026-10-26 were in THC's 2026-10-26 dump at 25.5% and in its 2026-10-25 dump at 54.8% (design B M6).
The service answers from the union and publishes the coverage table daily.

| What fails | Detection | The service then | Recovery |
| --- | --- | --- | --- |
| THC cs2 | no file by 06:00 UTC | reads the Hugging Face bucket. If both fail, `thc-ct` is `late`; other sources answer. | The hourly retry. Backfill when it returns. Issue `stale-thc-ct` after 36 h. |
| THC volume shifts | under 40% of the 7-day median of accepted days | quarantines the day; it does not feed `new`. Three such days in a row reset the baseline (§5.8). | the operator decides; issue `anomaly-thc-ct` |
| OpenINTEL Kafka | no new offsets in 30 min | marks `oi-*` `late`; other sources answer | replay from the stored offset (about 11 to 13 days for the NRD topics, 25 to 27 hours for `certstream_domains`) |
| A names-tile log | 404 or 429 | other logs continue; the cursor holds | per-run availability probe; the log list refreshes daily |
| ISC, WhoisDS | no new file for 6 h | marks the source `late` | 5 days of ISC are re-readable |
| GHCR slow or down | a subrequest over 10 s | serves Cache API and R2; `x-domains-degraded: 1` | retry with the 429 rule |
| R2 down | R2 errors | reads GHCR | none |
| Cloudflare down | no answer | clients read GHCR through `root:latest` (§11) | none |
| Actions stops | the root's age; `watchdog` | the Worker serves the last root and shows its age. The Worker cannot dispatch a workflow. | `dispatch-overdue`, `keep-schedules-enabled`, issue `schedules-stopped` |
| A bad segment | the verifier | the segment is excluded and the tier is rebuilt without it | The root's `previous` digest allows rollback. |

A merge never removes a record from a promoted tier. A rollback is a new root that names older packs.

## 9. Accuracy

- CT-derived rows say `seen`, never `registered`.
- Feed rows keep the feed's own date. WhoisDS's file dated D matches ISC's day D-1 at 79.8% for one pair and 66.2% for another, and 0% for the same date (MEASURED 2026-10-27, design B M6).
  The adapter dates a WhoisDS file as D-1.
- An `oi-nrd` event with a certificate older than 7 days is `suspect`. So is a domain whose RDAP creation date is before 2026-01-01 (ruling 19).
- Name-level newness is censored. A daily THC dump holds the names of certificates issued that day. 86.6% of 2026-10-26's names were absent from the union of four earlier days (design B M2). Against every earlier day of THC's 54 daily dumps, each day from 2026-10-16 to 10-26 still carries 25% to 31% names never seen before (MEASURED 2026-10-28, DOM-009's novelty curve, `docs/research/measure/DOM-009/result.json`).
  A name recurs only at a renewal. Until the corpus holds one validity period (about 200 days [E]), `new` for names carries `censored: true`.
  Domain-level newness from feeds with their own history is not censored.
- `corroborated` needs two families. Lists derived from one another (hagezi from Stamus) count as one family.
- Machine-generated spaces hold many names: 25 registrable domains hold 35% of THC's names (design B M2). They stay in the index. A query pages through them.
- CT sees only domains that obtained a certificate. A domain registered and never certified is invisible to every CT-derived source.
- A validation sample runs daily. DOM-050 checks 200 random `claimed_new` rows against RDAP for the TLDs that have it. 233 of 1,437 root-zone TLDs have no RDAP, including 175 of 248 ccTLDs (READ `docs/research/web-pkgforge-2026-10-27/landscape.md`).
  `.np` has no RDAP and no open zone, so `.com.np` rows are T2 or T3.
- The coverage table (DOM-035) publishes the share of each source's names found in each other source's same-day set.

## 10. Cost

| Item | Per day | Basis |
| --- | --- | --- |
| Actions | $0. 100 to 420 runner-minutes [E] | public repositories are free |
| GHCR storage and egress | $0. 1.2 to 2 GB net new of derived data [E] and about 12 GB of raw lane (§4.8) | "currently free", with at least a month's notice before a change (READ GitHub's packages billing page via design A §2.2). Raw data is kept always (ruling 5). |
| Workers | $0 over the $5 monthly plan at 100,000 requests a day [E] | 10 million requests and 30 million CPU-ms are included |
| R2 | at most 5 GB at $0.015 per GB-month, about $0.075 a month | the cap |
| Inbound network on runners | THC 0.32 GB, Kafka 10.7 GB on the wire (MEASURED, DOM-004; 28.4 GB once decoded), tiles 1.4 GB | not billed |

## 11. The consumer contract

`web.pkgforge.dev`'s `domain` and `ip` services read this project. They read three things: the names index, the new-domain feed and the reverse lookups.
The contract has four parts. It states nothing about the consumer's internals.

**1. HTTP.** The routes of §7.2 and the parameters of §7.3 are the contract. `docs/consumer.md` is created by DOM-060. It lists them with an example for each.
A route is stable once listed in `stable.json` (created by DOM-060). A removal or rename needs a new path version.

**2. The root.** `ghcr.io/pkgforge-dev/domains.pkgforge.dev/root:latest` is readable anonymously. `GET /v1/index/latest` answers its digest.
`root.json` (§4.6) names every live pack by digest. A client that reads the root and the packs needs no Worker.

**3. The pack format.** `DPK1` (§4.4). The format document, created by DOM-017, states every byte. DOM-017 publishes test vectors. DOM-060 publishes a reference reader module that runs in Node and in workerd.

**4. Versioning.**

- Within `domains.root.v1`, `DPK1` and `/v1`, changes are additive. A reader ignores unknown fields and unknown layers.
- A breaking change gets a new `format` id and a new path (`/v2`). The old one stays served for at least 90 days.
- A reader checks `format` and `schema` and refuses a value it does not know.
- One logical question reads one root digest. The answer carries it in `x-domains-root`.

The consumer must honour `meta.confidence`, `censored`, `provisional`, `suspect` and `sources_failed`. It must not read a day-precision value as a time of day.
It must not assume that `last_seen` means the domain is live.

## 12. Cloud resources

Each resource is created by the entry named. The undo of each goes in `docs/resources.md`, in the same change.

| Resource | Created by | Undo |
| --- | --- | --- |
| Probe Worker `domains-probe` (on workers.dev) and R2 bucket `domains-probe`, temporary | DOM-061 | `wrangler delete`; delete the bucket. DOM-056 deletes both when DOM-002, DOM-005, DOM-007 and DOM-008 have closed. |
| Drill Worker `domains-drill` (on workers.dev) and R2 bucket `domains-drill`, temporary | DOM-053 | `wrangler delete`; delete the bucket. The drill deletes both when it ends. |
| Worker `domains-pkgforge-dev` and custom domain `domains.pkgforge.dev` on the `pkgforge.dev` zone | DOM-030 | `wrangler delete`; remove the custom domain |
| R2 bucket `domains-pkgforge-cache` with a lifecycle rule: the one cache bucket, at most 5 GB | DOM-031 | delete the bucket |
| Worker `domains-pkgforge-clock`, only if the clock verdict is C | DOM-025 | `wrangler delete` |
| GHCR packages of §4.1 | the first push of a workflow | none. Nothing is ever deleted (ruling 5). |

The `pkgforge.dev` zone's own Cloudflare account hosts the Worker, because a custom domain needs the zone in the same account.
`mirror-archlinux` deploys its Worker the same way, and its `worker/wrangler.toml` names that account in `account_id` (READ at commit `669ac725f8081445c164113f2ed092533de112e2`).
The operator deploys with a local wrangler login. CI deploys nothing.

## 13. Which entry builds what

| Part | Entries |
| --- | --- |
| Measurements | DOM-001 to DOM-012, and DOM-061 (the probe Worker they share) |
| Foundation: workspace, policy, names, adapter contract | DOM-013 to DOM-016 |
| Pack format, verification, GHCR, root, ledger, feed, compaction | DOM-017 to DOM-023 |
| The new-domain feed: adapters, Worker, routes, watchdogs | DOM-024 to DOM-035 |
| Names | DOM-036 to DOM-041 |
| THC mirror and reverse routes | DOM-042 to DOM-046 |
| Authority sources and validation | DOM-047 to DOM-052 |
| Hardening | DOM-053 to DOM-058 |
| Root documents and the consumer contract | DOM-059, DOM-060 |
