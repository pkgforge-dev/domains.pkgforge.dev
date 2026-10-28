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
| family | What a source derives from: `ct`, `isc`, `whoisds`, `stamus`, `registry`, `dns`. Two sources of one family are not independent evidence. |
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
| `suspect` | An `oi-nrd` event whose certificate is older than 7 days. The default feed hides suspect events. |
| `provisional` | A newness verdict made by the hourly filter. The daily job makes it exact (§5.8). |
| `corroborated` | Two sources of different families saw the domain within 48 h of each other. |
| segment | The pack one adapter writes for one window. A segment is immutable. |

The OpenINTEL newly registered stream means "first seen in a certificate", not a registration date.
In design B's RDAP check, 25 of 25 events with a fresh certificate were registered within a day.
In the same check, 0 of 25 events with a certificate older than 30 days were new (design B §2.4 item 5).
Of the events in a 180 s sample, 38% carried a certificate older than 30 days.

## 3. Data model

### 3.1 Normalisation

Every adapter runs the same function of the names package (entry DOM-015).

1. Lowercase ASCII. Convert IDN labels to punycode.
2. Remove one trailing dot. Remove a leading `*.` and set `wild`.
3. Refuse a name with a byte outside `[a-z0-9_.-]`, a label over 63 bytes, a name over 253 bytes, an empty label, or no dot.
4. Refuse a name that is itself a public suffix.
5. Compute `suffix`, `reg` and `site` from the pinned PSL. The PSL's sha256 is in `sources.json` and in every root.

THC's dump of 2026-10-26 held 38,474,309 lines. It had 0 refused lines under rule 3 and 4 refused lines under rule 4. It is not bytewise sorted.
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
| `feed` | `feed` | reversed registrable domain, then `first_seen` | `first_seen`, source mask, basis bits, confidence, flags | 15 to 30 MB a day [E] |
| `new-name` | `feed` | reversed name, then `first_seen` | the same shape, name level | 250 MB a day [E] |
| `rev` | `rev` | IP address (4 or 16 bytes, big endian) | the names that resolve to the address | measured by DOM-043 |

`first` and `last` are varints. The unit is the source's precision. Days since 2026-01-01 for a day source.
Seconds since 2026-01-01T00:00:00Z for a second source. A record never stores a count, so merges stay idempotent.

The `domains` dataset is the ledger. It holds one record per registrable domain, with per-source first and last seen.
It decides whether a domain is new. The `feed` dataset is a view of it, sorted for window queries.

An evidence entry is `(tier, basis, source, at, confidence)`.

| Tier | Basis | Meaning |
| --- | --- | --- |
| T1 | `zone`, `rdap` | A registry zone adds the domain, a zone diff adds it, or an RDAP registration event says so. |
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
The size is estimated in §4.8 [E], and DOM-004 measures the bytes a day as the broker sends them.

### 3.5 The source registry

`sources.json` lives in the `ref` package and in every root. One entry per source id.

| Field | Meaning |
| --- | --- |
| `id`, `bit` | The id and its bit number. A bit is never reused. At most 64 sources. |
| `family` | See §2. |
| `datasets` | Which datasets the source feeds. |
| `precision` | `second` or `day`. A source whose precision changes gets a new id. |
| `kind` | `ct_name`, `claimed_new`, `registered_claim`, `zone_add`, `list`, `dns`. |
| `basis` | The evidence basis it writes (§3.3). |
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
| `names` | Tiers of `names` and `domains` | `<dataset>-<tier>-<span>`, for example `names-d-20261026` |
| `feed` | Tiers of `feed` and `new-name` | `feed-h-2026102608`, `feed-d-20261026` |
| `rev` | Packs of the reverse IP index | `rev-m-202609` |
| `dumps` | Bulk downloads for people and scripts | `names-20261026`, `new-20261026` |
| `state` | Cursors | `state` (guarded), `state-<date>` (write-once) |
| `ref` | The PSL, the CT log list, `sources.json` | `psl-<sha12>`, `ctlogs-<sha12>`, `sources-<sha12>` |

GHCR tags match `[A-Za-z0-9_][A-Za-z0-9._-]{0,127}` and resolve without regard to case. Every tag is lowercase.
A read of a pinned object uses a digest, never a tag. Only `root:latest`, `state` and the dated tags are read by tag.

### 4.2 Manifests

Every artifact is an OCI manifest with an `artifactType` of the form `application/vnd.pkgforge.domains.<kind>.v1`.

| Kind | Layers (by title) |
| --- | --- |
| `pack` | `part.000`, `part.001`, and so on (blocks, at most 1 GiB each), `idx` (the sparse index), optional `txt.gz` (a plain sorted bulk file). Day packs of `feed` also carry `tidx` (the row order by `first_seen`) and `summary.json` (new registrable domains per suffix and source). |
| `segment` | the same as `pack`, and optional `raw` (the file as fetched) |
| `root` | `root.json`, `sources.json`, `coverage.json` |
| `state` | `state.json` |
| `rawchunk` | `chunk.000` and up, each at most 4 GiB, for the THC monthly CSV |
| `raw` | the raw lane (§3.4): `raw.000` and up, each at most 1 GiB, the bytes as received (Kafka record batches or gzip tile bodies, concatenated), and `members.json`, one entry per member with its offsets, length and sha256 |

Annotations on every manifest: `org.opencontainers.image.source`, `.created`, `.title`, and `dev.pkgforge.domains.*`
for `schema`, `dataset`, `tier`, `span.start`, `span.end`, `count`, `bytes`, `psl`, `run`, `source` and `sha256`.
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
| Pushes | 2,000 requests a minute per token, 10 GB a layer, 10 minutes an upload, 34 MB/s (READ `mirror@669ac72:docs/measurements.md`) |

DOM-007 measures reads from a Worker. DOM-006 measures a push from a runner.

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
| `w` | one ISO week | the 7 day packs | the weekly compaction |
| `m` | one calendar month | the week packs | the monthly compaction |
| `y` | one year | the month packs | the yearly compaction |

The live set is the smallest set of packs that covers `[corpus_since, as_of]` with disjoint spans. The root lists the live set.
A query reads the live set. Its worst fan-out is 6 segments, 24 hours, 6 days, 4 weeks, 11 months and the years: about 50 packs for the `names` dataset.
Each pack costs at most two range reads. The `feed` dataset is small, so its fan-out is cheap.
Compaction replaces packs in the live set. It never deletes a pack from GHCR.

### 4.6 The root manifest

`root:latest` is an OCI manifest of kind `root`. Its layer `root.json` is the machine contract (§11). It holds:

- `format` (`domains.root.v1`), `root_seq` (an integer that only grows), `as_of`, `created`, and `previous` (the digest of the previous root).
- `corpus_since` per dataset, and `gaps` per source (for example the THC days 2026-10-04 and 2026-10-09).
- `psl` (the sha256 of the pinned list).
- `datasets`, with the live packs of each. Each pack has `repo`, `tag`, `tier`, `span`, `manifest` (digest), `pack` and `idx` (digest and size), `parts`, `count`, `key_min`, `key_max` and `sources`.
- Counts and the `through` time of each source.

The root is a few tens of KB. A Worker reads it once, then reads blobs by digest.

### 4.7 Write rules

⛔ Nothing is ever deleted from GHCR (ruling 5). No script calls the packages DELETE API, `oras manifest delete` or `crane delete`.
A static check refuses them (entry DOM-014).

1. **Write-once tags.** A tag that exists is never written again. A script reads the tag first. The same digest means skip. Another digest is a fault that stops the job.
   A file source that republishes other bytes gets a new tag with a new `sha12`.
2. **Forward-only root.** `root:latest` moves only after everything it names exists on GHCR and passed verification (§5.8).
   Promotion reads the live root just before the push. It refuses a root whose `as_of` or `root_seq` is not above the live one.
3. **One writer.** Every job that moves `root:latest` or `state` runs in the concurrency group `root-writer` with `queue: max` and no cancel.
   The job reads the live root, applies its additions and replacements, and pushes. Two writers never move the root at once.
   Jobs that run in parallel, such as the ingest lanes, write segments and cursor proposals only. The one `promote` job advances `state` and the root (§5.4).
4. **Re-run guard.** A re-run of an older run reads the live root first and writes nothing the live root already supersedes.
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
| Raw lane, Kafka `certstream_domains` | 6 to 12 GB a day [E]: 72.7 million messages of about 326 B is 24 GB of JSON, and a snappy ratio of 2 to 4 on JSON is assumed. DOM-004 records the real compressed bytes a day. |
| Raw lane, the three NRD topics | about 0.2 GB a day [E]: about 1 million messages a day (design A M6), one record a batch, at 188 to 231 B a batch (`docs/sources.md`, "The Zonestream broker"). DOM-004 records the real bytes a day. |
| Raw lane, names tiles | about 1.4 GB a day (MEASURED, design A M10: 26.4 B an entry for 51.7 million entries a day) |
| GHCR growth a year | derived tiers with every tier kept: 1 to 2 TB [E]. The raw lane adds 3 to 5 TB [E] (8 to 14 GB a day). DOM-023 measures the derived growth and DOM-004 the raw lane. Raw data is kept always (ruling 5), so the total is 4 to 7 TB a year [E]. |
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
| `compact-daily.yml` | `35 1 * * *` | Merge the hour packs and the THC day into `d`. Build the feed, the dumps and the coverage table. | 20 to 40 min |
| `compact-weekly.yml` | `50 3 * * 1` | Merge 7 day packs into `w` | matrix |
| `compact-monthly.yml` | `50 4 1 * *` | Merge week packs into `m` | matrix |
| `compact-yearly.yml` | `50 5 1 1 *` | Merge month packs into `y` | matrix |
| `rev-monthly.yml` | `30 6 * * *` | Compare THC's release listing with the last month built. Build when a new month exists. | 2 to 6 h |
| `ref-refresh.yml` | `13 5 * * *` | Refresh the PSL and the CT log list. Pin by sha256. | 1 min |
| `watchdog.yml` | `41 7 * * *` | Staleness, schedules, anomaly issues | 2 min |
| `status.yml` | `47 * * * *` | Start overdue workflows. Read the Worker's status and the sources' upstreams, and raise or clear `status-down` and `worker-down`. It publishes no file and pushes no branch: the Worker computes the status from the root. | 2 min |
| `ci.yml` | push, pull request | The gate | 5 min |
| `worker.yml` | push to `main` that changes the Worker | The Worker's tests. It never deploys. | 3 min |

Total runner time is 100 to 420 minutes a day [E] (design B §10: 105 min; design A §5.2: 6 to 7 h).
It is free on a public repository. It shares the organisation's 20 concurrent jobs with `mirror-archlinux` and every other repository.

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
- **Reference data** is pinned by sha256. A new PSL triggers a recompute of `suffix`, `reg` and `site` at the next compaction.

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

An adapter is a directory `adapters/<id>/`. The tree is created by DOM-016. It holds:

1. `source.json`: id, bit, family, datasets, precision, kind, basis, cadence, band, URLs, retention, parser.
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

1. Decode the whole pack. Check bytewise key order, uniqueness, charset, label length, no upper case, and that counts match the annotations.
2. Re-find 1,000 random keys with the reader module the Worker uses. One TypeScript module runs in Node and in workerd.
3. Compare volume with the median of the last 7 days that were not quarantined. A THC day under 40% of the median is quarantined: it is pushed under a `quarantine` annotation, excluded from `new` computations, and an issue `anomaly-<source>` opens.
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
- Every `uses:` pins a commit. The runner is `ubuntu-24.04`.
- No workflow holds a Cloudflare credential. No workflow calls the packages DELETE API.
- Concurrency groups: `root-writer` (queue `max`, no cancel) for any job that moves the root or `state`; `ingest-<source>`; `compact-<tier>`; `ci-<ref>`.
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

So the monthly database holds reverse IP to names and holds no CNAME targets. DOM-010 scans the whole stream on a runner to confirm this.
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
| `suffix` | A public suffix: `np`, `com.np`, `co.uk`, `xyz`. One contiguous key range. |
| `under` | Any parent: a TLD, a suffix, a registrable domain or a name. One contiguous key range. |
| `basis` | `any` (default), `seen`, `claimed`, `registered`, `zone`, `rdap`, `nrd-list`, `ct` |
| `source` | One or more source ids |
| `min_confidence` | 1 to 10, for `registered` rows |
| `suspect` | `exclude` (default), `include`, `only` |
| `provisional` | `include` (default) or `exclude` |
| `order` | `first_seen.desc` (default) or `first_seen.asc` |
| `limit`, `cursor` | `limit` defaults to 1,000 and is at most 10,000. The cursor is opaque. |

A window is read from the live set. A window of 1 h to 12 h reads segments and hour packs.
A window of N days reads day packs, and week packs where a week is whole. `meta.tiers_read` lists them.

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
- An `oi-nrd` event with a certificate older than 7 days is `suspect`.
- Name-level newness is censored. A daily THC dump holds the names of certificates issued that day. 86.6% of 2026-10-26's names were absent from the union of four earlier days (design B M2).
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
| GHCR storage and egress | $0. 1.2 to 2 GB net new of derived data and 8 to 14 GB of raw lane [E] | "currently free", with at least a month's notice before a change (READ GitHub's packages billing page via design A §2.2). Raw data is kept always (ruling 5). |
| Workers | $0 over the $5 monthly plan at 100,000 requests a day [E] | 10 million requests and 30 million CPU-ms are included |
| R2 | at most 5 GB at $0.015 per GB-month, about $0.075 a month | the cap |
| Inbound network on runners | THC 0.32 GB, Kafka 6 to 12 GB compressed [E] (24 GB once decoded), tiles 1.4 GB | not billed |

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
