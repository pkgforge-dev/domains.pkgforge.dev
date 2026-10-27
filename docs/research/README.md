# Research

Dated evidence. A research file says what was measured or read on one day. It is not the design.
The design in force is `docs/architecture.md`, and it wins when a research file disagrees.
The operator's rulings of 2026-10-27 in `TODO/RULES.md` §5 overturn parts of both designs.

Evidence tags in these files: `[Mn]` MEASURED, `[R...]` READ, `[E]` or `[I]` an estimate.
Every number in an entry names the file and section it comes from.

## Files

| File | What it is | Use it for |
| --- | --- | --- |
| `2026-10-27-design-a.md` | Design A: an independent design with its own measurements. Hash-partitioned log-structured index, five GHCR packages, Actions as the only writer. | The Kafka topic table (§3.1), THC per-day statistics (§3.1), names-tile rates and window reads (§3.1), cross-source coverage (§3.1, M8 and M9), the evidence index (§14). |
| `2026-10-27-design-b.md` | Design B: a second independent design. Reversed-label keys, `deflate-raw` blocks, a Cloudflare cron hot tier, an RDAP check. Four cross-references corrected on 2026-10-27 (see its header). | Block density (§2.4 item 3, M10), the RDAP check (M5), the ISC and WhoisDS findings (M6), GitHub schedule gaps (M8), GHCR read bursts (M7), the ledger idea (§5.2). |
| `2026-10-27-designs.md` | The two designs side by side: where they agree, where they split, what decided each split, and the corrections both made to older research. | The reasons behind `docs/architecture.md`. |
| `2026-10-27-record/results.md` | The read-only measurements made while the record was written: THC's monthly CSV (columns, no CNAME), names-tile availability and Geomys's User-Agent rule, IPng's first served tile, ISC and WhoisDS headers, the repository settings. Its three scripts are in `2026-10-27-record/scripts/`. | The MEASURED rows of DOM-006, DOM-010, DOM-011, DOM-012 and DOM-014. |
| `web-pkgforge-2026-10-27/2026-10-27-domain-and-ip.md` | A copy of the synthesis of the operator's other repository (the whole file, working tree at its commit). Its §7 is the CT part. | The wider landscape. Read §7 first. |
| `web-pkgforge-2026-10-27/ct.md` | A copy of the CT research report: THC's routes and rate limit, CT volumes, names-tile sizes, crt.sh and Cert Spotter behaviour. | THC's API shapes (§1), the cost of reading CT (§4), the sources that fail (§3). |
| `web-pkgforge-2026-10-27/landscape.md` | A copy of the landscape report: OpenINTEL's S3 layout, zone files, the `.sk` list, RDAP coverage and many other services. | Zone and RDAP sources (rows for OpenINTEL, CZDS, `.sk`, RDAP). |
| `reference/ghcr.ts` | A copy of a working anonymous GHCR reader in TypeScript. It does not build here. DOM-019 ports it. | The token flow and the tag paging. |

Each copied file starts with a provenance line: `web.pkgforge.dev@<commit> <path>`.
That repository is private, so no reader of this project can open it. The copy is the record, and the copies stand alone.

A copy keeps the words of its source. Where this repository later measured a figure again, the architecture and the entries hold the newer value, and the copy is not edited: `web-pkgforge-2026-10-27/ct.md` §1 gives THC's October volume as 77 to 340 MB a day, and the listing of 2026-10-27T09:34:52Z shows that only the days from 2026-10-05 fall in that range (`docs/architecture.md` §5.8).

## Scripts and small results

The downloaded dumps, the sorted derivatives and the raw feed samples were not kept. Each is a public URL named in the design that used it.
The scripts below are small Node scripts. Copy one when an entry names it. They read untrusted data, so run them on a file you downloaded into an empty directory.

### Design A

Path `2026-10-27-design-a/`.

| File | What it does |
| --- | --- |
| `scripts/kafka-conn.mjs` | TCP test of ports 9091, 9092, 9093 and 443 on `kafka.zonestream.openintel.nl` |
| `scripts/kafka-probe.mjs` | Minimal Kafka protocol probe: ApiVersions, Metadata, ListOffsets |
| `scripts/kafka-offsets.mjs`, `scripts/kafka-sample.mjs`, `scripts/kafka-window.mjs` | Offsets, message samples and the 5-minute window read of Zonestream, with snappy |
| `scripts/snappy.mjs` | A snappy decoder for Kafka batches |
| `scripts/zs-sample.mjs` | Samples the Zonestream WebSocket topics |
| `scripts/ct-rates.mjs` | Polls every tiled CT log's checkpoint twice and probes for names tiles. It reads `ct/logs.json`, which is not kept: build it from the CT log list (DOM-011's `scripts/measure/ct-logs.mjs` does). The scripts that read `psl/psl.dat` (`thc-day.mjs`, `miss.mjs`) take the Public Suffix List downloaded from publicsuffix.org, as DOM-009 says; the scripts that write `kafka/` files write their own outputs there, and DOM-004 gives them a `--data DIR` flag. |
| `scripts/ct-window.mjs` | Reads the names tiles of one static CT log for a UTC window by binary search |
| `scripts/thc-day.mjs` | One THC daily dump: counts, distinct names, wildcard share, registrable domains, suffix histogram |
| `scripts/psl.mjs` | A minimal Public Suffix List matcher (ICANN section and the full list) |
| `scripts/f64cmp.mjs`, `scripts/union4.mjs`, `scripts/miss.mjs` | Set comparison of hashed name lists: overlap, four-day union, what one source misses |
| `kafka/offsets.json` | Offsets and counts per topic at 2026-10-27T05:30:36Z |
| `ct/rates.json` | Entry rates and names-tile probes per log |
| `out-thc/2026-10-23.stat.json` to `2026-10-26.stat.json` | THC per-day statistics |

### Design B

Path `2026-10-27-design-b/`.

| File | What it does |
| --- | --- |
| `scripts/kafkaprobe.mjs`, `scripts/kafkafetch.mjs` | Hand-rolled Kafka probe (ApiVersions, Metadata, ListOffsets at several times) and Fetch v4 |
| `scripts/zs.mjs`, `scripts/zsan.mjs`, `scripts/wsprobe.mjs` | Zonestream WebSocket sampler, its analysis, and a WebSocket probe |
| `scripts/thcstat.mjs`, `scripts/regdoms.mjs`, `scripts/groups.mjs`, `scripts/revlabel.mjs` | THC dump statistics, registrable domains, grouping, and the reversed-label transform |
| `scripts/blockenc.mjs` | A front-coded block encoder that measures bytes a name at 1,024, 4,096 and 16,384 names a block |
| `scripts/psl.mjs` | A PSL matcher (29 lines) |
| `scripts/iscan.mjs`, `scripts/agree1.mjs`, `scripts/agree2.mjs` | ISC feed analysis and cross-source agreement |
| `scripts/rdapval.mjs`, `scripts/rdapsum.mjs` | RDAP validation of Zonestream events and its summary |
| `scripts/actions_history.mjs`, `scripts/actions_queue.mjs` | GitHub Actions schedule gaps and job queue times from a run listing |
| `scripts/burstsum.sh`, `scripts/head.mjs` | Summary of a curl burst, and the first bytes of a gzip file |
| `results/` | The small outputs of those scripts: `thcstat_1026.json`, `regstats_25.json`, `regstats_26.json`, `thc_overlap.txt`, `groups.txt`, `blockenc_1024.json`, `blockenc_4096.json`, `blockenc_16384.json`, `kafkaprobe_0617Z.txt`, `zsan.txt`, `rdapval.json`, `rdapval_summary.txt`, `iscan.txt`, `agree1.txt`, `agree2.txt`, `actions_history.txt`, `actions_queue.txt`, `ghcr_burst.txt` |

## Where new measurements go

An entry that measures something writes its small result files under `docs/research/measure/<entry id>/`. It never keeps downloaded data.
