> web.pkgforge.dev@40c120cb5d6b2cf4080baedd4de773cdca325fef docs/research/2026-10-27-domain-and-ip/ct.md
> The source repository is private: no reader of this project can open it, and this copy is the record.

# Certificate Transparency, certstream and ip.thc.org, measured 2026-10-27

The CT research agent's report, as it returned it: the harness refused its
own file write, so the lead saved its answer here, the wording kept, the
first person made third and dashes spelled out. Tags: [M] measured 2026-10-27 (UTC), [R] read, [I] the agent's
inference. About 45 `cf` calls, no cloud resource created, no repository
written. Its scripts and raw outputs were in the session's scratch directory,
one subdirectory per source (`thc`, `gh`, `cf`, `cfct`, `src`, `sth`), and are
not in this repository.

## 1. THC (ip.thc.org)

**Routes.** [M] [R] The request schemas are not in the static HTML. The agent decoded them from the page chunks. All routes are under `https://ip.thc.org/api/v1`, with no key and CORS `*`.

| Route | Returns | Page size |
|---|---|---|
| `POST /lookup` (`ip_address` as IP or CIDR) | domains with apex, ASN, org, country; no timestamp | 100 |
| `POST /lookup/subdomains` (`domain`) | `{domain, last_seen_on}` | 100 |
| `POST /lookup/cnames` (`target_domain`) | names whose CNAME points at the target | 100 |
| `GET /download`, `/subdomains/download`, `/cnames/download` | CSV | up to 50,000 rows |
| CLI views `/<ip>`, `/sb/<d>`, `/cn/<d>` | ANSI text; need a `curl` User-Agent | 100 |

- Pagination is a Cassandra `page_state` token only.
- There is no forward domain-to-IP route and no certificate data (no issuer, dates or fingerprint).
- IPv6 returns 0 rows with `count_unavailable`.

**Measured calls (3 each).**
- Reverse IP: 1.1.1.1 gave 92,770 rows; 8.8.8.8 gave 45,606; 140.82.112.3 gave 19; 89.58.57.239 gave 15.
- Subdomains: github.com gave 4,294; pkgforge.dev 39; phrack.org 12.
- CNAMEs: github.com 89; pkgforge.dev 0; phrack.org 1.
- Latency: JSON calls took 0.73 to 1.1 s; CSV took 1.0 to 2.4 s (50,000 rows, 3.4 MB).
- It works from Worker egress through our `fetch.web`.
- Responses are `Cache-Control: no-store`, so a Worker has to cache them itself.

**Rate limit.** [M] A token bucket per client IP: 250 capacity, refilling 0.5/s (about 43,200 requests/day). Headers `X-Ratelimit-*` show it. A 40-call parallel burst dropped `Remaining` to 237. No 429 was seen. Contention when many Workers share egress IPs is not measured.

**Freshness.** [M] [R]
- pkgforge.dev names had `last_seen_on` = 2026-10-26 when queried on 10-27, so the subdomain table updates daily.
- The migrator imports the 2-day-old CT dump at 04:01 UTC, so a new certificate name should appear about 2 to 3 days later [I].
- For github.com, 3,931 of 4,294 names were last seen in 2024-12 (the initial import).

**Quality against CT.** [M]
- THC held every crt.sh name for pkgforge.dev (29 of 29, plus 10 extras) and phrack.org (10 of 10, plus 2).
- For github.com, THC has 4,293 names and crt.sh 118; only 67 are in both. THC lacks 51 real CT names (for example `camo.`, `cla.`, `codespaces.github.com`).
- The cause is its `unwanted-domains` regex filter (cloud-provider and machine-generated spaces such as `cloudflaressl.com`, `amazonaws.com`) and its non-CT sources.

**Bulk data.** [M] [R]
- Monthly reverse-DNS dump: September 2026, released 10-04, 6.36 billion records.
  - `rdns-sept.parquet.gz` is 53.2 GB compressed (75 GB uncompressed per the page).
  - `rdns-sept.csv.gz` is 37.0 GB compressed (252 GB uncompressed per the page).
  - Both are on `dns.team-teso.net` (behind Cloudflare) and on a Hugging Face bucket.
  - It is gzip over parquet, so it is not range-readable.
  - That works out to 8.4 bytes per record.
- There is no bulk dump of the subdomain or CNAME tables.
- Daily CT name dumps: `cs2.ip.thc.org` and the Hugging Face bucket `Daily-Cerstream-Dumps`, 54 files, 35.8 GB (2026-09-01 to 10-26; 10-04 and 10-09 are missing).
  - September ran 843 to 986 MB/day; October fell to 77 to 340 MB/day. The cause is unknown.
  - Format: sorted text, one lowercase name per line, wildcards kept, no certificate metadata.
  - Estimated 27 million (10-26) to 69 million (09-15) names/day, extrapolated from 4 MB samples (plus or minus 40%) [I].

**Repos.** [R] [M]
- `sstable-migrator` is Java 8, 842 lines, and writes Cassandra 4.1.3 SSTables (keyspace `ferret`, tables `rdnsv4`, `subdomains`, `cnames`; single node, replication factor 1) that it bulk-loads with `sstableloader`.
- Daily pipeline: certstream dump, drop names seen in the last 25 days, apply the unwanted-domains filter, resolve with puredns/massdns at 1000 qps, then import.
  - That active resolution covers only the TLDs `.gov*`, `.ru`, `.ai`, `.de`, `.fr`, `.io` and `.in`.
  - Other inputs: Common Crawl index paths, MaxMind `.mmdb` files for geo/ASN enrichment, and ClickHouse notes.
- Hardware is not stated. The only hints are JVM heap flags of 6 to 8 GB and one separate "data" host.
- `messede-degod/certstream-server-go` is byte-identical to upstream `d-Rickyy-b/certstream-server-go` (GitHub compare: 0 ahead, 0 behind).
  - Upstream's README claims 250 to 300 certs/s, 40 MB RAM and 4 to 10% CPU on Oracle's free tier. That is an old figure.
  - The whole ecosystem logs about 2,400 entries/s (section 4).
- Context for the operator: THC's stage 1 downloads `pub.ajam.dev/datasets/certstream/Temp/<date>.7z`, which redirects to the Hugging Face dataset `Azathothas/temp`. The operator's archived `pkgforge-security/CertStream-Domains` says "THC has stepped up to overtake & expand the data". Worth asking what history the operator already holds.

**Why THC runs a 24x7 tap.**
- Evidence: CT is "one of the big data inputs" and also "where most of the rubbish comes from" (THC, Mastodon 2025-12-16). The tap is the discovery feed for new names, which are then resolved and imported. The daily dumps are cut at 00:05 UTC and published.
- Inference [I]: the pipeline is a daily batch, so the tap is not for real-time freshness. It exists because CT logs can only be read sequentially and nobody publishes free bulk names. THC's dumps give a ready-made sorted names feed with no per-domain index.

## 2. Cloudflare

- **Radar CT** [R] [M]: 7 endpoints (timeseries, summary, timeseries_groups, authorities, logs, plus `{ca_slug}` and `{log_slug}` detail). Filters are CA, log, TLD and so on; none takes a domain. It is aggregates only, with no per-domain certificate or subdomain search.
  - Unique certificates/day: 30 to 35 million (34.1 million on 10-26).
  - Log entries/day: 207 to 236 million (222.8 million on 10-26).
  - Share of unique certs by CA owner: Let's Encrypt 56%, Google Trust Services 21.5%, Amazon 7%, Sectigo 5%.
- **Cloudflare's own logs.** `ct.cloudflare.com` and Merkle Town 301-redirect to Radar. Nimbus (RFC 6962) is readable; its tree-size response is edge-cached for 3600 s, and `nimbus2026` holds 6.72 billion entries. The Raio logs are Cloudflare's static-ct-api logs built on Azul (an open-source Rust Worker plus R2 bucket). Radar lists them as REJECTED, and their checkpoint URL redirects to a Radar page, so no tiles are readable there.
- **CT monitoring for zones** [R]: email alerts for your own zones only.
- **Cloudflare Intel** (account token required) [M]: `cf intel domains get` returns content categories plus about 24 hours of resolver sightings (25 rows for github.com). Passive DNS by IP is limited to 7 days. WHOIS failed for `.dev`.

## 3. Sources for certificates and subdomains (github.com / pkgforge.dev / phrack.org)

| Source | Result |
|---|---|
| crt.sh JSON | Success on 19 of 22 calls from this machine and 2 of 3 via Worker egress. Failures: one 404 and two 502s. Warm calls took 1.2 to 18 s; first call on a domain took 85 to 108 s. Sizes 256 KB (835 certs), 89 KB, 420 KB (1,235 certs) |
| crt.sh PostgreSQL | TCP port 5432 reachable (183 ms); user `guest` accepted. Pooler error "max_client_conn" on about 27 of 30 attempts. Trivial queries took 15 to 29 s. The old `certificate_identity` table is superseded by a full-text index. A working full-text query returned 11 names for phrack.org and 32 for pkgforge.dev (19 to 20 s each) |
| Cert Spotter | Unauthenticated, 10 requests/hour, unexpired issuances only, 100 per page, 1 to 2.5 s. Full-domain index is paid ($100/month per domain) |
| HackerTarget | Keyless; host search returned 51, 34 and 9 rows (about 1.3 s). Quota header showed 21/day. Reverse IP capped at 499 rows (THC: 92,770) |
| RapidDNS | HTML scrape, 100 rows per page |
| subdomain.center | Keyless JSON (62, 23, 500 names); many names look synthetic (`www.<name>`): treat as unverified |
| urlscan | Keyless, but only a 30-day window |
| Wayback CDX | 29 to 61 s; yields URLs, not hosts (25 hosts for pkgforge.dev) |
| Common Crawl index | Timeouts (504) or 404; weak |
| Anubis | Moved to `jonlu.ca`; 403 Cloudflare challenge, also via Worker egress |
| OTX | Anonymous passive DNS returns 429; needs a key |
| Merklemap | 401; EUR 49/month for 100k requests |
| Censys | Legacy API decommissioned 2026-09-30; the free tier has no usable search |
| Google CT search | Endpoint returns 404 (discontinued 2022) |
| Facebook CT | Needs an app token |
| VirusTotal / SecurityTrails | Key needed (free: 500/day at 4/min; 50/month) |

## 4. Tailing CT ourselves

**Volume.** [M] All 82 non-rejected logs in Chrome's list polled, 5 polls over 42 minutes, 410 of 410 successful. Excluding Nimbus, the total is **206 million entries/day (2,387/s)**: 111 million in static logs and 95 million in RFC 6962 logs. That matches Radar. The busy 2027h1 shards each add 11 to 16 million entries/day.

**Bytes per entry.** [M]
- Static data tile (256 entries): Let's Encrypt 172 to 181 KB gzipped (about 0.7 KB/entry); Google 330 to 530 KB uncompressed.
- Sunlight "names tile" (names, SCT timestamp and subject only, no issuer or dates; [R] spec): **6.2 to 7.1 KB per tile, about 25 bytes/entry**. Available on Let's Encrypt, Geomys, IPng Gouda, Microsec, GoDaddy and HARICA; not on Google, Sectigo or TrustAsia.
- RFC 6962 `get-entries`: 1.3 to 6.9 KB per entry, and Google logs return only 8 to 26 entries per call.
- Let's Encrypt names tiles carry 1.6 names per entry at about 29 bytes each. Geomys returned 429 after roughly 40 quick requests from this IP.

**Daily cost of reading everything.**
- All static data tiles: about 111 GB/day.
- All RFC 6962 logs: about 400 GB/day.
- Total about 510 GB/day (48 Mbit/s sustained).
- Names tiles of the Let's Encrypt, Geomys and IPng logs: about 55 million entries/day, 216k tiles/day, about 1.4 GB/day (2.5 tiles/s).

**Coverage.** [M] Sycamore and Willow (both Let's Encrypt) overlap only 74% in a 43 s window, so one log is not enough. The four-log union was not measured because Geomys rate-limited the agent.

**Workers.** [R] A paid cron Worker gets 15 min wall time, up to 10,000 subrequests per run, 6 concurrent outbound connections, 128 MB memory, and $0.30 per million requests plus $0.02 per million CPU-ms beyond the included amounts. Tailing about 216k names tiles/day is a small fraction of that. Estimated CPU is 13M ms/month, inside the 30M included [I]. The full firehose is not feasible in a Worker: Google's RFC 6962 logs alone would need about 1.4M requests/day each.

**Storage.** [I] Calibrating on THC's 8.4 bytes/record, a rolling-year names index of 1.6 to 4.2 billion distinct names is about 13 to 46 GB, or $0.20 to $0.70/month on R2 ($0.015/GB-month). D1 is unsuitable ($1 per million rows written).

## 5. Recommendation

**Sources to use**
- Subdomains: THC CSV route (one subrequest, about 1 s), unioned with crt.sh names, cached for 12 to 24 h.
- Reverse IP and CNAME targets: THC is the only free source with real volume.
- Certificates: crt.sh JSON with a hard timeout and stale-serve cache; Cert Spotter only as an emergency fallback.
- Avoid: the crt.sh PostgreSQL route (too unreliable), Google CT search, Facebook CT, Censys, Anubis, OTX.
- Category and 24-hour resolution history: add Cloudflare Intel later as a brokered key.
- Radar: use it only for ecosystem statistics.

**THC bulk data**
- Do not import the 53 GB reverse-DNS dump now. It is monthly-stale, not seekable, and needs an offline index build. Revisit above about 20k THC calls/day.
- Do import THC's daily CT name dumps: one gzipped file per day, 35.8 GB backfills 56 days, one cron fetch per day. That gives a per-domain names index, which nobody else exposes.

**Tailing CT ourselves**
- Names tiles only, and only as a later phase for same-day freshness: the Let's Encrypt shards plus Geomys and IPng, about 1.4 GB/day from a one-minute cron Worker.
- It gives names and first-seen only, with partial coverage.
- A full certificate tail is not worth it unless crt.sh becomes the bottleneck; it would need a VPS carrying about 510 GB/day.
