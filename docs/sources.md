# Sources

One row per source. This file says what a source returns, how often, how it fails, how its rows are labelled,
and which entry builds its adapter. It states no licence and no terms. Provenance is the publisher, the URL and the fetch time.
They are stored in the annotations of every segment (`docs/architecture.md` §3.7).
Every source's raw bytes are kept always (ruling 5 of `TODO/RULES.md`): the file as a layer of its segment, or the raw lane of `docs/architecture.md` §3.4 for the Kafka record batches and the names-tile bodies.

Evidence tags are the same as in `docs/architecture.md`: MEASURED names the command and the UTC time, READ names the URL or the file.
Times are UTC. "Design A" and "design B" are the two research files in `docs/research/`.

The first table is the registry of sources that carry a bit in the source mask. A test in DOM-016 reads the first cell of each row.
That cell holds the source id in backticks. Do not put a backticked id in the first cell of any other table.

## Sources with a bit

Labels: F is the family, K the kind, B the basis, P the precision.

| Source | Bit | What it gives | Cadence | Failure mode and handling | Labels | Entry |
| --- | --- | --- | --- | --- | --- | --- |
| `thc-ct` | 0 | THC's daily CT names. About 32.5 million distinct names a day after normalisation, from 38.5 million lines of which 24.7% are wildcards (MEASURED 2026-10-27, design A M5). Files on `https://cs2.ip.thc.org/<date>.txt.gz` and in the Hugging Face bucket `IP-THC-ORG/Daily-Cerstream-Dumps` (54 files, 35,765,972,194 B at 2026-10-27T08:25:12Z). | One file a day, about 00:04 UTC the next day (the 2026-10-26 file had `Last-Modified` 2026-10-27T00:04:12Z and 319,917,410 B). | A file is late or missing (2026-10-04 and 2026-10-09 are missing). The volume shifts (September 843 to 986 MB a day; October 984 and 957 MB on 10-01 and 10-02, 445 MB on 10-03, then 77 to 340 MB a day from 10-05; MEASURED 2026-10-27T09:34:52Z). A bucket path is `<year>/<month without a leading zero>/<date>.txt.gz`, so `2026/9/` holds September only. The host moves (`cs1` answers 302 to `cs2`). The file is not bytewise sorted and 0.57% of its lines carry upper case. Handling: hourly retry to 06:00, then the bucket. A day under 40% of the 7-day median of accepted days is quarantined, and 3 consecutive such days reset the baseline (`docs/architecture.md` §5.8). | F `ct`, K `ct_name`, B `ct-first`, P day | DOM-029 (measured by DOM-009) |
| `oi-nrd` | 1 | OpenINTEL Zonestream topic `newly_registered_domain`: a registrable domain whose first certificate appeared. Kafka `kafka.zonestream.openintel.nl:9092`, plain and anonymous. 422,192 messages in 24 h, 5,691,031 retained, about 11.6 days (MEASURED 2026-10-27T05:30:36Z, design A M6). | Continuous. The adapter reads at the chain interval. | The port changes (9091 timed out) or the broker stops. Handling: WebSocket `wss://zonestream.openintel.nl/ws/<topic>` for live data with no replay, then a gap record. An event with a certificate older than 7 days is `suspect`: 38% of events had such a certificate. | F `ct`, K `claimed_new`, B `nrd-ct`, P second | DOM-026 (measured by DOM-004) |
| `oi-nrd-fqdn` | 2 | Topic `newly_registered_fqdn`: the same event at name level. 342,310 messages in 24 h. | As `oi-nrd`. | As `oi-nrd`. | F `ct`, K `claimed_new`, B `nrd-ct`, P second | DOM-026 |
| `oi-nrd-confirmed` | 3 | Topic `confirmed_newly_registered_domain`: adds `confidence` 1 to 10, the closeness of the CT first appearance to the RDAP registration date. 235,327 messages in 24 h. About 9% of a sample are zone rows (`ct_name: "zone_data"`, `cert_index: -1`). | As `oi-nrd`. | As `oi-nrd`. | F `registry+ct`, K `registered_claim`, B `nrd-ct+rdap` or `zone`, P second | DOM-026 |
| `oi-cs` | 4 | Topic `certstream_domains`: CT names with the log, `seen`, and `sld_list`. 72,699,511 messages in 24 h, about 326 B of JSON each, retained about 25 to 27 hours. Only 15 log sources appear, from DigiCert, Sectigo, TrustAsia and Google. No Let's Encrypt, Geomys or IPng log is in it (MEASURED 2026-10-27, design A M6, M8). | As `oi-nrd`. | The same as `oi-nrd`, and a gap over 25 hours is lost. Handling: consume at least hourly. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-036 (measured by DOM-004) |
| `ct-le` | 5 | Names tiles of the Let's Encrypt logs Sycamore and Willow. About 35.5 million entries a day for the 2026h2 and 2027h1 shards (design A M10). Each tile holds 256 entries. | Polled. About 2.3 tiles a second for the reliable set of all operators. | A shard rolls over. Handling: follow the CT log list, re-read daily. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-037 (measured by DOM-011) |
| `ct-geomys` | 6 | Names tiles of the Geomys logs Tuscolo. About 15.2 million entries a day (design A M10). Host `*.skylight.geomys.org`. | Polled. | The host answers 429 and the header `Skylight-Rate-Limited` to a client with no email address in its User-Agent. A User-Agent with an address got 4 of 4 answers of 200 (MEASURED 2026-10-27T08:24:26Z). Handling: a contact address in every User-Agent. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-037 |
| `ct-ipng` | 7 | Names tiles of the IPng log Gouda, about 8.2 million entries a day. Gouda serves names tiles from a first served tile onward: tile 366,929 of 4,810,099 for Gouda2026h2 and tile 100,748 of 924,943 for Gouda2027h1 (MEASURED 2026-10-27T08:24:45Z). Halloumi answered 404 for tile 0 and the last full tile (MEASURED 2026-10-27T08:23:41Z). | Polled. | A 404 is a state, not an error. Handling: a per-run probe of the first served tile and the last full tile. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-037 |
| `isc-new` | 8 | ISC's new-domain feed `https://isc.sans.edu/feeds/domaindata.json.gz` and dated `domaindata.<date>.json.gz`. 250,940 domains for 2026-10-26, about 2.3 MB gzipped. Fields: `domainname`, `ip` (present for about 32%), `firstseen`, `score`. Five dated files are kept. | Hourly. The dated file for 2026-10-26 had `Last-Modified` 2026-10-27T07:41:32Z. The file of the current day was 55 B (MEASURED 2026-10-27T08:22:56Z). | The file stays unchanged or is late. Its own text says the domains "may not be new, but new to us". Handling: conditional GET on the ETag, `late` after 6 hours. | F `isc`, K `claimed_new`, B `nrd-list`, P day | DOM-027 (measured by DOM-012) |
| `whoisds` | 9 | WhoisDS's free daily file, a sample of exactly 70,000 domains. Path `https://www.whoisds.com/whois-database/newly-registered-domains/<base64 of YYYY-MM-DD.zip>/nrd`. 566,869 B for 2026-10-26 (MEASURED 2026-10-27T08:23:18Z). | Daily, one day late: the file dated D matches ISC's day D-1 (79.8% and 66.2% in two pairs, design B M6). | The current day's URL answers 200 with no body. Handling: the adapter dates a file D-1. | F `whoisds`, K `claimed_new`, B `nrd-list`, P day | DOM-028 (measured by DOM-012) |
| `cenk-nrd` | 10 | `cenk/nrd`, built from WhoisDS. Files `nrd-last-{10,20,30,45,60}-days.txt`. The 10-day file has 699,321 lines (11.6 MB). | Daily on GitHub. | The copy on `dl.cenk.app` was five days stale on 2026-10-27 (Cloudflare `HIT`, `Last-Modified` 2026-10-22). Handling: read raw GitHub only. Unicode names are converted to punycode. | F `whoisds`, K `claimed_new`, B `nrd-list`, P day | DOM-028 |
| `hagezi-nrd` | 11 | `hagezi/nrd` `domains/nrd7.txt` and its siblings `nrd14-8`, `nrd21-15`, `nrd28-22`, `nrd35-29`. 2,773,880 lines for 7 days, about 396,000 a day (47,794,272 B). | Daily. The header carries `Last modified` and `Expires: 8 hours`. | The list may include subdomains. Its base data come from Stamus Labs and "can sometimes lag a few days". Handling: reduce to registrable domains and record the lag. | F `stamus`, K `claimed_new`, B `nrd-list`, P day | DOM-028 |
| `oi-zone` | 12 | OpenINTEL daily full-zone Parquet on `https://object.openintel.nl/openintel-public`, prefix `fdns/basis=zonefile/source=<tld>/`. TLDs: `.se .fr .ch .nu .sk .ee .li .gov`. A day holds 2.5 GB for `.se`, 4.1 GB for `.fr`, 2.7 GB for `.ch` (READ `docs/research/web-pkgforge-2026-10-27/landscape.md`). Range reads work (206). | Daily. | S3 availability. Handling: skip the day and read the next. | F `registry`, K `zone_add`, B `zone`, P day | DOM-047 |
| `sk-nic` | 13 | The `.sk` registry list `https://sk-nic.sk/subory/domains.txt`: 493,544 live domains with registrar, holder, name servers and expiry (47,797,077 B, generated 2026-10-26). | Daily. | The list moves. | F `registry`, K `zone_add`, B `zone`, P day | DOM-048 |
| `oi-zonediff` | 14 | Zonestream `zone_diff` for `.cd .ch .ee .fj .gp .li .mp .mw .ni .nu .sl .se`. | Live. | It sent 0 messages in 23 minutes (MEASURED 2026-10-27T05:17:32Z to 05:40:34Z, design A M7). Handling: probe first; build only if it speaks. | F `registry`, K `zone_add`, B `zone`, P second | DOM-049 |
| `dotgov` | 15 | The complete `.gov` list from `cisagov/dotgov-data`, diffed daily. | Daily (a commit a day). | The repository moves or stops. | F `registry`, K `zone_add`, B `zone-list`, P day | DOM-051 |
| `zone-walks` | 21 | Daily NSEC walks of about 25 small gTLDs from `flotwig/zone-walks`; partial (`.lol` is 19% of its registry total). | Daily. | Walks stop or shrink. | F `nsec-walk`, K `zone_add`, B `zone-walk`, P day, `partial: true` | DOM-051 |
| `dnscoffee-counts` | none | DNS Coffee's daily gTLD counts (new, removed, moved); a monitor of ISC's coverage, no names. | Daily. | The page's script or token changes. | not a source of records; `coverage.json` only | DOM-051 |
| `rdap` | 16 | Registration events from RDAP, by sampling. Verisign `https://rdap.verisign.com/com/v1/domain/<name>` answered in 0.36 s with 3,026 B. IANA's bootstrap lists 1,204 TLDs with RDAP and 233 without (READ `docs/research/web-pkgforge-2026-10-27/landscape.md`). | Daily, 200 samples. | Many registries have no RDAP, among them 175 of 248 ccTLDs. The Google Registry answered 429 in earlier research. | F `registry`, K `registered_claim`, B `rdap`, P second | DOM-050 |
| `ct-godaddy` | 17 | Names tiles of the GoDaddy log Aquamarine. Tile 0 and the last full tile of `aquamarine2027h1` answered 200 (MEASURED 2026-10-27T08:23:41Z). About 0.65 million entries a day. | Reserved. | Design A saw 404 at its tail at 05:26Z. DOM-011 probes the full tile and the partial tile separately. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-037 adds it if DOM-011 finds stable tiles |
| `vps-ct` | 18 | A future VPS ingester. | Reserved. | See `docs/architecture.md` §5.7. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-057 |
| `oi-measure` | 19 | Topic `newly_issued_certificates_measurements`: DNS answers and addresses for each new certificate name. 166,477,316 messages in 24 h, about 780 B each, in a binary format nobody has decoded. | Continuous. | The format is unknown. | F `dns`, K `dns`, B `dns-resolved`, P second | DOM-058 |
| `crtsh` | 20 | crt.sh names, for gap-fill and validation only. The JSON route took 1 to 108 s. The public Postgres refused most connections (READ `docs/research/web-pkgforge-2026-10-27/ct.md` §3). | Daily sample, in Actions. | Slow and unreliable. It never serves a request. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-052 |

## Inputs without a bit

These feed a dataset that has no source mask, or are reference data, or only check other sources.

| Input | What it gives | Cadence | Failure mode and handling | Entry |
| --- | --- | --- | --- | --- |
| thc-rdns | THC's monthly reverse database: 6.36 billion `ip,name` records for September 2026, `rdns-sept.csv.gz` 37,046,639,482 B. It feeds the `rev` dataset. It has no CNAME targets (MEASURED 2026-10-27T08:21:59Z, first 1,048,576 compressed bytes). | Monthly, at the month's end. September was released 2026-10-04. | The slow host `dns.team-teso.net` did not answer a 1 MB Range read within 120 s. Handling: read the Hugging Face host. | DOM-042, DOM-043, DOM-045 |
| psl | The Public Suffix List, 338,012 B on 2026-10-27 (MEASURED, design A M4). | Daily check. | None that matters. Handling: pin by sha256 in the `ref` package. | DOM-015, DOM-019 |
| ctlogs | The CT log list `https://www.gstatic.com/ct/log_list/v3/log_list.json`, 62,375 B with `log_list_timestamp` 2026-10-26T13:45:16Z (MEASURED 2026-10-27T08:23:28Z). | Daily check. | None that matters. | DOM-019, DOM-037 |
| iana-rdap | IANA's RDAP bootstrap `https://data.iana.org/rdap/dns.json`, 71,348 B, published 2026-10-22. | Daily check. | None that matters. | DOM-050 |
| certspotter | Cert Spotter's keyless API: 10 requests an hour, unexpired issuances only. Validation only. | On demand, in Actions. | The limit is low. Handling: one sample a day. | DOM-052 |

## Dropped, and not ingested

| Candidate | Why it is out |
| --- | --- |
| certstream.calidog.io | It accepted a connection and sent 0 messages in 12 s (MEASURED 2026-10-27T06:15:45Z, design B M11). |
| certstream.dev | It documents self-hosted software and runs no public stream (design B M11). |
| Censys | The legacy API closed on 2026-09-30 and the free tier has no usable search (READ `ct.md` §3). |
| Merklemap, Facebook CT | A key or an app token is needed (READ `ct.md` §3). |
| xReverseLabs, DNS Coffee | A login or an API key is needed (design B §3). |
| shreshta-labs/newly-registered-domains, WhoisFreaks | Free samples of about 10,000 names (design A §3.1). |
| maaaaz/dnsdumps | Its own README calls the repository broken (design A §3.1). |
| dontcrash/NRD | A splitter of hagezi's lists (design A §3.1). |
| issued.live feed | A rolling sample of about 30 names a call, 1,000 requests a day (design B §3). |
| THC's live API | No route calls it (ruling 7 of `TODO/RULES.md` §5). |

Candidates for a later entry: `cbuijs/nrd` (windows of 1 to 30 days) and `networkhound/dot-in` (daily `.IN` snapshots), both from design A §3.1.

CZDS is not used (ruling 13): it needs a login, and `docs/research/2026-10-27-gtld-without-czds.md` measured that ISC's files carry about 90% of the names entering gTLD zones without one.
