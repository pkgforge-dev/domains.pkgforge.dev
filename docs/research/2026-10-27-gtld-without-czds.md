# gTLD data without CZDS

Research of 2026-10-27, 09:26 to about 11:00 UTC. Question: can the data ICANN's Centralized Zone Data Service
(CZDS) gives (gTLD zone contents, and so newly registered and removed gTLD domains) be had with no account, login,
API key or token? This file states what each source does technically. It carries no legal or terms analysis.

Evidence tags. MEASURED names the command or script and the UTC time. READ names the URL. INFERRED marks a
conclusion drawn from measurements, with the measurements named. All times are 2026-10-27 UTC unless a date is given.
Scripts are in `2026-10-27-gtld-without-czds/scripts/`; each one named below can be re-run on the same inputs.

## 0. Answer first

**Short answer.** The part of CZDS that matters to this project, the daily list of names newly entering gTLD zones, is
available with no credential, because ISC's `domaindata` files carry it. Two independent keyless detectors (ISC's
zone-derived feed and OpenINTEL's CT-derived Zonestream) agree on 88 to 94% of names. What is not available keyless is the
full zone (178 million `.com` names), the removed (dropped) names, and nameserver changes.

### 0.1 Credential-free sources worth ingesting for gTLDs, ranked

| rank | source | what it adds over the current set |
| --- | --- | --- |
| 1 | ISC `domaindata.<date>.json.gz`, already planned as `isc-new` | The dated archive runs from 2025-10-26, 366 daily files (the plan says five are kept). Back-fill it, not only the rolling files. It is gTLD-only and zone-shaped: 463 to 514 TLDs a day, no ccTLD, 242,596 to 489,341 rows a day. INFERRED to be a zone diff (section 2.1 A). It needs a non-default User-Agent (`Python-urllib` gets 403). |
| 2 | OpenINTEL Zonestream `newly_registered_domain` and `confirmed_newly_registered_domain`, already planned | Hours, not days: median 1.8 h from the RDAP registration time to the stream event (n=21). It carries 88 to 94% of ISC's names, but about 23% of its own events have no ISC entry on or after their day (two days with a full window; 0 of 40 such non-`.com` events were new by RDAP), so it needs the ISC or RDAP join. |
| 3 | RDAP, already planned as `rdap` | 116 of 116 answers carried a registration event. It is the only keyless way to turn a claim into a registration date, and it is needed most for non-`.com` TLDs (section 3). |
| 4 | DNS Coffee public feed page `https://dns.coffee/feeds` | A control total, not names: 90 days of daily new, removed and moved counts, and a "truly new" count, in the public page. ISC's rows are 0.905 to 0.963 of its new count on 16 of 18 days. The only keyless source of removal counts. Fragile (page script, signed token). |
| 5 | `cisagov/dotgov-data` `current-full.csv` | The complete `.gov` list, 16,953 rows, with a git commit every day, so each day's adds are a diff. OpenINTEL's open zone Parquet has `.gov` too (about 10 MB a day since 2017-05-01), which is heavier. |
| 6 | `flotwig/zone-walks` | Daily full lists for about 25 small gTLDs and a few IDN gTLDs by NSEC walking, with a daily commit. Partial: `.lol` has 214,544 names against 1,126,763 in the registry report. |
| 7 | Mirrors, as fallback only: `hagezi/nrd`, `cenk/nrd`, Rankvance Free | Nothing new. hagezi holds 99.9 to 100% of ISC's names for 2026-10-20 to 10-25. Rankvance Free's 2026-10-26 file is 99.2% inside hagezi and is ISC's days D-2 and D-1. |
| 8 | Baselines, to tell "seen before" from new: Hugging Face `humbleworth/registered-domains` (255,097,510 names, 2025-07), Common Crawl domain web graph (134,979,706 domains) | Not new-registration sources. They answer "did this name exist earlier". |

Measured and **not** worth ingesting for new gTLD names: Tranco, Majestic, Umbrella, CrUX, Radar and OpenINTEL's top
lists (0.1% of Tranco's weekly entrants are in ISC's new list), the Common Crawl URL index (0 of 19 answered probes),
the Domains Project (stale since 2022-09-21).

### 0.2 Estimated coverage of newly registered gTLD domains without CZDS

| question | estimate | basis |
| --- | --- | --- |
| Share of the names that entered the gTLD zones on a day that ISC lists | **about 90%, range 85 to 100%** | ISC against DNS Coffee's zone-file-based daily "new" count (which also covers a few ccTLD zones ISC lacks): 0.905 to 0.963 on 16 of 18 days. ISC `.com` month sums against appraise.net's CZDS-based `.com` zone adds: 0.867 (June), 0.861 (September); by weekday average 0.92 to 1.04. |
| Share of a month's registry-recorded registrations | **about 100%, within plus or minus 15%** | Same month, June 2026: ISC rows over ICANN net adds are 1.10 for `.com` and 1.07 for the 15 TLDs measured (0.92 to 1.20 each), and ISC `.com` and `.net` rows are 95% real new registrations by RDAP (19 of 20). Section 2.5. |
| Share of ISC rows that are real new registrations | **95% for `.com` and `.net`** (19 of 20); **16 of 40 (40%) for non-`.com` names that CT did not see, and 0 of 5 for each of `.shop`, `.vip` and the CentralNic TLDs** (RDAP, section 3.2) | Zone-new includes names that returned to the zone. |
| Share of ISC names that the CT-based stream also carries | **88.3 to 94.1%** (lower bounds) | Section 2.4. |
| Share of Zonestream's own events that ISC lists on that day or later | 77.0% and 77.1% (10-22, 10-21) | Section 2.4. 0 of 40 non-`.com` events with no ISC match were new. |

### 0.3 Recommendation

**Drop CZDS.** Keep it only as a later exception, and only if the operator wants one of three things this file shows
no keyless source gives: the names of removed (dropped) domains, full-zone snapshots (`.com` is 178 million names; ISC's
`.com` adds are 4.4 to 4.6 million a month, about 52 to 56 million a year), or the roughly 600 mostly tiny gTLDs that ISC never lists. None is in the
project's stated mission (newly registered and newly seen names). CZDS also costs 3 to 12 months of per-TLD approval and a
login, which the no-credential ruling excludes.

Two risks to carry. ISC is a single publisher whose provenance is not documented, so ISC is a dependency to monitor with
DNS Coffee's counts. And the 30-request RDAP limit of this research left the per-address limit of every registry
unmeasured (section 3.3).

## 1. What CZDS gives, and what of it is reachable keyless

| CZDS capability | keyless? | by what |
| --- | --- | --- |
| Names added to a gTLD zone each day | **yes, about 90%** | ISC dated files (rank 1); hagezi, cenk, Rankvance copy the same family |
| The moment of registration, to the hour | **partly** | Zonestream CT events (median 1.8 h), RDAP registration events |
| Names removed from a zone | **no** | DNS Coffee shows only counts (242,614 removed on 2026-10-27); `domains-monitor.com` has a removed list behind a login |
| Full zone snapshot of `.com`, `.net`, `.org`, the new gTLDs | **no** | OpenINTEL's gTLD zone data is closed (READ `https://openintel.nl/data/forward-dns/zone-based/`). Domains Project raw data needs a subscription. |
| Full list for `.gov`, `.arpa`, NSEC-walkable gTLDs | **yes** | `cisagov/dotgov-data`, root AXFR, `flotwig/zone-walks` |
| Nameserver changes ("moved") | **no** | DNS Coffee shows counts only |
| Zones registry by registry, outside CZDS | **no for gTLDs** | READ an ICANN presentation of 2022-11-15 (`https://www.icann.org/en/system/files/files/presentation-diversity-authoritative-ns-records-gtlds-15nov22-en.pdf`): outside CZDS only `.gov` (GitHub) and `.arpa` (AXFR) are open, and `.edu .int .mil .post` are missing. The open AXFR and list zones are ccTLDs: `.se .nu .ee .ch .li .sk .fr`. |

AXFR could not be tested from this machine: outbound TCP port 53 fails with `EACCES` to every address, including
`1.1.1.1` (MEASURED 2026-10-27T10:08Z, `scripts/axfr_probe.py`, and a Node `net.connect` to `192.5.6.30:53`,
`1.1.1.1:53`, `zonedata.iis.se:53`). The AXFR claims are therefore READ, not MEASURED.

## 2. Q1 and Q2: the candidates and the coverage

### 2.1 Candidate records

Format of each record: what it gives; TLD coverage, size, cadence; how far back; credential; sample actually fetched with
UTC time and command; failure mode.

#### A. ISC `domaindata` (rank 1)

- **Gives.** A list of domains newly seen in gTLD zones, as JSON rows `domainname`, `ip` (present on 25% to 33%),
  `firstseen` (a date), `score`.
- **Coverage, size, cadence.** gTLD only. Over eight days (2026-10-19 to 10-26) 463 to 514 TLDs a day, 578 in the union,
  no two-letter TLD, 24 IDN TLDs. Top 1 TLD holds 44.6% of names, top 10 hold 82.2%, top 100 hold 98.3%. Rows a day:
  242,596 (10-19), 418,062, 489,341, 467,547, 458,909, 340,972, 251,054, 250,940 (10-26). `.com` is 125,292 to 189,736 a
  day. The file for date D is complete the next morning; the file for the running UTC day is 55 bytes (HEAD
  `domaindata.2026-10-27.json.gz` at 10:33Z). `domaindata.json.gz` serves the last complete day.
- **Depth.** Dated files from 2025-10-26 (HTTP 200); 2025-10-25 answers 404. That is up to 366 files (25 sampled dates
  between then and now all answered 200, HEAD at 10:27 to 10:29Z; gaps were not enumerated). The five files of
  2025-10-26 to 10-30 are 13 to 17 MB gzipped, the later ones 1.8 to 3.9 MB, so the older layout differs (not decoded).
- **Credential.** None. The default `Python-urllib` User-Agent gets 403; `curl`'s default and `pkgforge-research/1.0` get
  200 (MEASURED 2026-10-27T10:31Z, `curl -A <agent> -o /dev/null -w "%{http_code}"`).
- **Sample.** MEASURED 2026-10-27T09:34:02Z: `curl -s -o isc_26.json.gz https://isc.sans.edu/feeds/domaindata.2026-10-26.json.gz`
  gave 2,320,810 B and 250,940 rows, `firstseen` all 2026-10-26, 466 TLDs, 136,580 `.com`, 13,207 `.top`, 9,806 `.shop`.
  Script `nrd_tld_dist.py`, `isc_tld_union.py`.
- **Failure mode.** A late or empty current-day file; a User-Agent block; no stated provenance. `firstseen` is the zone
  date, one to two days after the registration (19 of 19 Verisign samples registered 10-24 to 10-26: 14 at 1 day, 5 at 2
  days; the other registries 0 to 2 days). The set includes names that returned to the zone: DNS Coffee labels 34% of a day's "new" names as seen before
  (173,997 "truly new" of 263,379 on 2026-10-26).
- **Why it is zone-derived (INFERRED).** Zero ccTLDs in eight daily files; 463 to 514 TLDs; ISC rows are 0.905 to 0.963
  of DNS Coffee's zone-file-based "new" count on 16 of 18 days (eight days measured at 09:43Z, ten spread days at 10:31Z;
  `dnscoffee_vs_isc.py`, `isc_history_vs_dnscoffee.py`; the two other days, 2026-08-25 and 2026-09-20, are DNS Coffee
  gap days of 105,650 and 230,426 new); `.com` per weekday within 8% of appraise.net's CZDS-based weekday adds (section 2.3);
  hagezi holds ISC's days 10-20 to 10-25 at 99.9 to 100%.

#### B. OpenINTEL Zonestream (already planned)

- **Gives.** Kafka (anonymous plain listener) and WebSocket streams. `newly_registered_domain` carries domain, CT log,
  certificate index, event time, certificate submission time. `confirmed_newly_registered_domain` adds `confidence` 1 to
  10. READ `https://openintel.nl/data/zonestream/`: the names are extracted from CT logs for
  the TLDs the project covers, and `zone_diff` exists only for twelve ccTLDs.
- **Coverage, size, cadence.** 2026-10-26 UTC: 390,725 NRD messages (388,359 distinct, 503 TLDs, 99.0% gTLD, `.com`
  53.5%) and 222,150 confirmed messages (414 TLDs, 61.1% `.com`). 2026-10-25: 377,951. 2026-10-21 and 10-22: 577,017 and
  580,576 (`.xyz` 148,191 and 129,623). Confidence over a five-minute sample of 510: 1 to 4 for 70%, 5 to 10 for 30%.
  Live; the topics are retained about 11 days.
- **Credential.** None. The Kafka broker at port 9092 answered from this machine while TCP 53 was blocked.
- **Sample.** MEASURED 2026-10-27T09:40:07Z, `node scripts/zonestream_ws_sample.mjs newly_registered_domain 300 out.jsonl`:
  907 messages in 300 s, 100% gTLD (`scripts/zonestream_summary.py`). Day windows through Kafka at 09:47:06Z (10-25),
  09:48:44Z (10-26), 09:57:35Z (10-22 and 10-21) with `scripts/zonestream_kafka_window.mjs`.
- **Timeliness.** Median 1.8 h, minimum 0.0 h, maximum 44.8 h from the RDAP registration time to the stream event, for
  the 21 probed `.com` and `.net` names the stream carried (`scripts/ct_lag.py`, MEASURED 10:34:36Z). Thirteen of 21 were
  inside 4.5 h.
- **Failure mode.** 41% of events in the five-minute sample had a certificate more than 7 days old (median 107 s, p90
  143 days). The `zone_diff` WebSocket opened, errored and sent 0 messages in 300 s (09:40:07Z). A first Kafka
  `ListOffsets` request for the day of 2026-10-25 timed out at 30 s once, then answered on retry with a 150 s limit.

#### C. DNS Coffee public feed page

- **Gives.** The page `https://dns.coffee/feeds?date=<day>` carries, with no login, a 90-day history array of daily
  `new`, `old` (removed) and `moved` counts across the zones DNS Coffee indexes, the first 50 names of the day, and a
  second JSON the page's script loads (`{"truly_new": N}`).
- **Coverage, size, cadence.** 91 days, 2026-07-29 to 2026-10-27, mean 357,687 new a day. 2026-10-26: 263,379 new,
  173,997 truly new, 242,614 removed on 10-27, 480,240 moved on 10-27. Daily.
- **Credential.** The page needs none. The JSON URL carries a signed `token=<unix time>.<digest>` that the server writes
  into every anonymous page view; a script has to read it from the HTML. The full name lists are in an API that needs an
  `X-API-Key` (READ `https://api.dns.coffee/doc`, and 401 without a key, MEASURED 10:15:23Z). The documentation page
  shows a placeholder key; none was used.
- **Sample.** MEASURED 2026-10-27T09:41:12Z, `curl -s https://dns.coffee/feeds` (through the project's fetch Worker,
  because this machine's resolver returns 0.0.0.0 for the name); history array parsed by `scripts/dnscoffee_vs_isc.py`;
  the data JSON at 09:56:54Z by `scripts/dnscoffee_feed_day.py` (2 requests).
- **Failure mode.** Import gaps (2026-08-25 new 105,650, 2026-09-20 new 230,426); page script and token format are not a
  contract.

#### D. `cisagov/dotgov-data`

- **Gives.** `current-full.csv`, the full `.gov` list: 16,953 lines (MEASURED 10:07:36Z, `curl -s
  https://raw.githubusercontent.com/cisagov/dotgov-data/main/current-full.csv`, 1,445,696 B). Columns: domain, type,
  organisation, suborganisation, city, state, security contact. Commits on 2026-10-25 and 10-26 ("Update zone file").
- **Depth, credential.** The git history. None. OpenINTEL also publishes `.gov` and `.fed.us` zone Parquet openly, daily
  since 2017-05-01, latest `day=26` written 2026-10-27T02:26Z, about 10 MB (MEASURED 10:29:55Z, S3 listing of
  `fdns/basis=zonefile/source=gov/`).

#### E. `flotwig/zone-walks`

- **Gives.** NSEC zone walks, one text file per TLD, daily (commit 2026-10-27T03:40:16Z). About 55 TLDs; gTLDs among
  them: `lol` 214,544, `gdn` 81,025, `pics` 58,495, `mom` 49,002, `christmas` 19,666, `game`, `audio`, `hosting`, `ruhr`,
  `desi`, `diet`, `flowers`, `guitars`, `auto`, `car`, `cars`, `amazon`, `shell`, `wed` and IDN gTLDs; ccTLDs include
  `ch` 2,528,344, `nu`, `ee`, `li`, `se` (9,302). Total 3,578,939 names.
- **Check against the registry.** Registry totals for June 2026 (ICANN reports): `lol` 1,126,763 (walk finds 19%),
  `pics` 114,308 (51%), `mom` 84,879 (58%), `christmas` 15,851 (124%), `game` 8,391 (77%), `audio` 5,974 (81%), `hosting`
  2,731 (87%), `gdn` 11,315 (716%). So the lists are partial or padded. MEASURED 10:24:18Z and 10:24:32Z.
- **Credential.** None.
- **Sample.** MEASURED 10:24:57Z, `curl -s -r 0-399 https://raw.githubusercontent.com/flotwig/zone-walks/master/lists/lol.txt`
  gave `0-0.lol`, `0-1z.lol`, `0-2f.lol` (sorted names, one a line).

#### F. Mirrors of the same family

- **hagezi/nrd.** `nrd7.txt`: 2,860,100 entries, 49,253,031 B, "Last modified 27 Oct 2026 07:06 UTC" (MEASURED
  09:34:02Z, `curl -s https://raw.githubusercontent.com/hagezi/nrd/main/domains/nrd7.txt`; siblings `nrd14-8`, `nrd21-15`,
  `nrd28-22`, `nrd35-29`, 40 to 56 MB each). It holds 99.9 to 100% of ISC's names for 10-20 to 10-25 and 0% of ISC's 10-26 `.com` names (non-`.com`
  100%): `.com` for the latest day arrives later (`scripts/hagezi_lag.py`, 09:53:04Z). Its base data is Stamus Labs, whose
  feed URL carries a licence code (READ Suricata source index `https://www.openinfosecfoundation.org/rules/index.yaml`,
  `stamus/nrd-*`, `%(secret-code)s`), so hagezi's copy is the only keyless form.
- **cenk/nrd, chrisjbawden/newly-registered-domains-tracker.** Built from WhoisDS (READ their READMEs).
- **Rankvance Free** `https://free.rankvance.com/newly-registered-domains/`. A 30-day index (2026-09-23 to 10-27); one CSV
  per date (`export.csv`) with no login, 2,000 names a page. The 2026-10-26 file has 432,122 rows (10,529,233 B,
  `curl -s https://free.rankvance.com/2026-10-26/export.csv` started 10:23:16Z, 409 s, because the server builds it on the
  fly: a 120 s limit cut it at 305,737 rows). Overlap (`scripts/rankvance_overlap.py`,
  10:30:21Z and 10:37:10Z): 2026-10-26 equals 72.6% of ISC's 10-24 plus 26.5% of ISC's 10-25 and is 99.2% inside hagezi;
  2026-10-22 equals 98.4% of ISC's 10-20 plus 38.7% of ISC's 10-21 and is 99.7% inside hagezi. So it is the same data,
  one to two days later. It is 99.2% gTLD (10-26) and 98.3% (10-22).
- **WhoisDS free file.** 70,000 lines; 2026-10-26 has 86.3% gTLD and 13.7% ccTLD by name count (57,103 and 9,039). Its
  ccTLD part is the one thing in this family ISC lacks. MEASURED 09:34:02Z, `curl -s
  https://www.whoisds.com/whois-database/newly-registered-domains/<base64 of 2026-10-26.zip>/nrd`, 566,869 B.
- **WhoisXML free sample.** `https://newly-registered-domains.whoisxmlapi.com/sample/nrd.2026-10-25.lite.daily.1000.csv`:
  1,000 names, all `added` (MEASURED 10:22:14Z). A sample, not a feed.

#### G. Full-name snapshots

- **Domains Project** (`tb0hdan/domains`, domainsproject.org). The GitHub `data/` directory was last committed
  2022-09-21 ("Cleanup russia"); `STATS.md` shows 1,766,025,618 names, `.com` 702,681,019 (INFERRED to count host names:
  the Hugging Face derivation below keeps 139,092,425 `.com` registered names). The raw and newer data is on `https://dataset.domainsproject.org`, which answers 401 with
  `WWW-Authenticate: Basic` (MEASURED 09:31:37Z, `curl -I https://dataset.domainsproject.org/`). The README says the raw
  data is for subscribers.
- **Hugging Face `humbleworth/registered-domains`.** `domains.txt` 4,310,624,710 B, 255,097,510 names, 1,274 TLDs, `.com`
  139,092,425; last modified 2025-07-12; derived from the Domains Project. MEASURED 09:30:31Z, `curl -s
  "https://huggingface.co/api/datasets/humbleworth/registered-domains?blobs=true"` and the README; the file itself
  answers 302 to a CDN and was not downloaded.
- **Common Crawl.** `projects/hyperlinkgraph/cc-main-2026-aug-sep-oct/domain/...domain-vertices.txt.gz` is 988,339,322 B,
  single gzip stream, last modified 2026-10-22; 134,979,706 domain nodes and 242,809,947 host nodes in the release
  (READ `cc-webgraph-statistics` `domain.tsv` and `host.tsv`, MEASURED 09:32:42Z). MEASURED 09:32:05Z, `curl -s -r
  0-4194303 .../cc-main-2026-jul-aug-sep/domain/cc-main-2026-jul-aug-sep-domain-vertices.txt.gz` (975,916,959 B) gave 644,147
  lines of `id`, reversed domain, host count, sorted by reversed name. A new release each month with a 3-month window since 2017.
  The URL index server `index.commoncrawl.org`: of 30 probes for month-old `.com` NRD names, 19 answered and 0 were in
  `CC-MAIN-2026-43`; the other 11 were `RemoteDisconnected` or 504 (MEASURED 10:12 to 10:23Z,
  `scripts/cc_index_coverage.py`, plus an earlier run with 1 hit in 40 whose error count was not logged).
- **Hugging Face search.** Searches for `czds`, `zone files`, `newly registered`, `nrd`, `registered domains` found no
  zone-diff republication (MEASURED 10:25:05Z, `https://huggingface.co/api/datasets?search=`). `pkgforge-security/domains`
  holds certstream dumps from 2025-02-28 (the operator's own).

#### H. "Seen" lists

- **Tranco** list `GQ3QK` (2026-10-26): 1,000,000 rows; entrants since 2026-10-19: 50,395 (5.0%), of which 49 (0.1%) are
  in ISC's new lists for 10-19 to 10-26 (`scripts/toplist_entrants.py`, MEASURED 10:10:42Z). Its providers are CrUX,
  Farsight, Majestic, Radar and Umbrella.
- **Majestic** `majestic_million.csv` 80,361,653 B, modified 2026-10-27T06:00:23Z. **Umbrella** `top-1m.csv.zip` 12,896,344
  B, modified 01:12:47Z. **CrUX** `zakird/crux-top-lists` `current.csv.gz`: 1,000,000 origins, 8,790,815 B. All fetched
  09:32:53Z to 09:33:33Z.
- **Cloudflare Radar.** The API answers 401 code 9106 without a token (MEASURED 10:09:48Z). Its lists reach the project
  through Tranco and through OpenINTEL `fdns/basis=toplist/source=radar/` (451,618,977 B for 2026-10-01).
- **OpenINTEL's open datasets** (listing 09:28:09Z): `toplist` (alexa, crux, majestic, radar, tranco, umbrella) and
  `zonefile` (`ch ee fed.us fr gov li nu root se sk`). Its gTLD zone data (`.com .net .org .info .biz .asia .mobi .name`
  and about 1,200 new gTLDs, "from registries directly or through CZDS") is **closed** (READ
  `https://openintel.nl/data/forward-dns/zone-based/`).

#### I. Credential-gated, blocked or stopped (measured with at most one request each)

| source | outcome |
| --- | --- |
| DNS Coffee API `api.dns.coffee` | 401 without `X-API-Key` (10:15:23Z); 60 requests a minute per key (READ the doc) |
| zonefiles.io | stopped 2025-08-15 (READ `https://netapi.com/zonefiles-io-api/`); no A record (09:40:09Z) |
| NetAPI `zf-api`, allzonefiles.io | token and subscription (READ); NetAPI's free `compromised` feeds are not NRD |
| domains-monitor.com | the lists are on `https://domains-monitor.com/update/` (257,257 new and 275,673 removed on 2026-10-27), but each download URL answers 302 to `/auth/` (10:19:40Z) |
| whoisextractor.in | "Free Account Required" (READ) |
| domainsdb.info | 401 "API key required" (09:40:30Z) |
| SecurityTrails | 401 (09:40:30Z) |
| ViewDNS | 403 Cloudflare challenge (09:40:30Z) |
| nTLDStats | 403 "automated request detected" from this machine (09:40:30Z) |
| Stamus Labs NRD | licence code in the URL (READ) |
| appraise.net drop feed, API | login wall; API keys (READ) |
| issued.live | sign-in (READ) |
| `maaaaz/dnsdumps` | its own README says the zones are incomplete |

### 2.2 Quantities per TLD

ISC mean rows a day for 2026-10-20 to 10-26 against ICANN's June 2026 net adds a day (the latest month ICANN had
published, because registry reports are withheld three months; READ the `.com` report page). The periods differ, so
the ratios here mix growth with coverage; the same-month test is section 2.5. `scripts/isc_vs_registry.py`, MEASURED
10:17:17Z.

| TLD | ISC mean a day | ISC min to max | ICANN June net adds a day | ratio |
| --- | ---: | --- | ---: | ---: |
| .com | 167,928 | 136,580 to 189,736 | 132,347 | 1.27 |
| .net | 8,186 | 6,172 to 9,447 | 7,720 | 1.06 |
| .org | 9,054 | 7,039 to 10,683 | 8,746 | 1.04 |
| .info | 5,549 | 2,672 to 7,651 | 5,269 | 1.05 |
| .xyz | 78,478 | 5,354 to 144,680 | 31,617 | 2.48 |
| .top | 14,481 | 10,480 to 18,521 | 19,239 | 0.75 |
| .shop | 10,515 | 8,687 to 13,903 | 12,505 | 0.84 |
| .online | 9,488 | 6,595 to 14,060 | 7,705 | 1.23 |
| .site | 6,065 | 3,931 to 7,690 | 4,475 | 1.36 |
| .app | 5,377 | 0 to 11,521 | 4,007 | 1.34 |
| .store | 4,833 | 3,785 to 5,514 | 4,232 | 1.14 |
| .vip | 2,795 | 2,065 to 3,956 | 4,237 | 0.66 |
| .dev | 1,605 | 0 to 3,448 | 1,043 | 1.54 |
| .cfd | 1,814 | 1,202 to 2,494 | 1,790 | 1.01 |
| .sbs | 2,034 | 686 to 3,565 | 2,046 | 0.99 |
| sum of these | 330,489 | | 247,063 | 1.34 |

`.xyz` runs in bursts (87,918 to 144,680 on four days, 5,354 on 10-26). `.app` and `.dev` have days with 0 rows
(Google's registry; the zone for those days did not reach the feed). Month-sum check of June and September: section 2.5.

### 2.3 Reference counts, and what they say about ISC's recall

| reference | `.com` figure | `.net` |
| --- | ---: | ---: |
| ICANN June 2026 transaction report, net adds a day (script `mrr_adds.py`, 09:36:51Z) | 132,347 (3,970,406 a month; 170,253,825 domains) | 7,720 |
| Verisign Q2 2026: 12.7 million new `.com` and `.net` registrations, 91 days (READ `https://www.sec.gov/Archives/edgar/data/1014473/000101447326000026/q22026earningsrelease.htm`) | 139,560 for both | |
| Verisign Q3 2026: 13.1 million, 92 days (READ `https://webhosting.today/2026/10/23/verisign-record-13-1-million-new-com-and-net-names-as-growth-speeds-up/`) | 142,391 for both | |
| ICANN June `.com` plus `.net` | 140,067 for both | |

The ICANN figure for June (140,067) matches Verisign's Q2 daily mean (139,560) within 0.4%, so the registry reports are
a sound reference. ISC `.com` plus `.net` for 2026-10-20 to 10-26 is 176,114 a day, 1.24 to 1.26 times those references,
but the periods differ: ISC's own `.com` mean is 145,803 a day in June, 154,247 in September and 167,928 in the week of
10-20 (section 2.5), so most of that ratio is growth.

Zone adds are also not registrations. appraise.net compares the daily CZDS `.com` zone with the day before and counts
"new registrations and re-delegations" (READ `https://appraise.net/intel/com`, 10:18:36Z, with 228 days of history). Its
June 2026 zone adds are 5,045,412 against ICANN's 3,970,406 net adds: 1.271. Its weekday average of zone adds against
ISC's `.com` for the same weekday of 2026-10-20 to 10-26:

| weekday (ISC date) | appraise average | ISC | ISC over appraise |
| --- | ---: | ---: | ---: |
| Monday (10-26) | 136,391 | 136,580 | 1.00 |
| Tuesday (10-20) | 186,062 | 188,041 | 1.01 |
| Wednesday (10-21) | 191,750 | 175,947 | 0.92 |
| Thursday (10-22) | 191,130 | 189,736 | 0.99 |
| Friday (10-23) | 185,855 | 179,720 | 0.97 |
| Saturday (10-24) | 172,115 | 168,000 | 0.98 |
| Sunday (10-25) | 131,683 | 137,471 | 1.04 |

By weekday ISC is 92 to 104% of appraise's averages. The weekday averages cover 228 days, so they are not the same
period. The same-month test is in section 2.5, and it is less flattering: ISC is 0.86 to 0.87 of appraise's monthly zone
adds. The cause of the 13% gap was not measured; appraise counts every re-delegation and ISC states a name once, which
would give a gap of this sign (INFERRED).

### 2.4 Two independent detectors, and how they overlap

Sets of registrable names for one UTC day (`scripts/overlap.py`, `zs_vs_isc_days.py`, `ct_visible_share.py`, MEASURED
09:52 to 10:34Z):

| statement | value |
| --- | --- |
| ISC 10-22 names carried by Zonestream NRD of 10-21 or 10-22 | 94.1% (`.com` 94.9%) |
| ISC 10-26 names carried by Zonestream NRD of 10-25 or 10-26 | 88.3% (`.com` 92.5%) |
| ISC 10-21 names carried by Zonestream NRD of 10-21 or 10-22 | 60.5% (the 10-19 and 10-20 stream days were not read, so this is low by construction) |
| Zonestream NRD of 10-21 found in ISC, same or a later day (to 10-26) | 48.5% + 28.6% = 77.1% (`.com` 34.0 + 38.5 = 72.5%) |
| Zonestream NRD of 10-22 found in ISC, same or a later day | 49.0% + 28.0% = 77.0% (`.com` 38.1 + 37.0 = 75.1%) |
| Zonestream NRD of 10-21 or 10-22 not in any ISC file 10-19 to 10-26 | 19.8% to 21.8% (`.com` 24.9% to 27.4%) |

The two mechanisms are unrelated (zone delegation against certificate issuance), so agreement of this size says each is
near-complete for the names that have both a zone entry and a certificate. A Lincoln-Petersen estimate from the
`.com` pair gives 475,000 for 2026-10-26 (`isc` x `zs_nrd`), which is not a coverage figure: the names Zonestream carries
and ISC does not are mostly not new (section 3.2), so the independence assumption fails. The hagezi 7-day list overlaps
ISC's 10-26 `.com` names at 0 (the latest day is late), so it is not used.

`confirmed_newly_registered_domain` for 10-26 holds 222,149 names; 111,764 have confidence 5 or more. Against ISC's same
day, `.com` overlap is 35.0% overall and 66.8% at confidence 5 or more.

### 2.5 Same-month check: ISC month sums against ICANN and appraise

`scripts/isc_month_sum.py` read every ISC dated file of June 2026 and September 2026 (60 GETs, no errors, MEASURED
10:35 to 10:41Z). `scripts/isc_month_ratios.py` (10:42:13Z) took the ratios against the ICANN June transaction reports
(same month); appraise.net's monthly zone adds are READ from `https://appraise.net/intel/com`.

| scope | ISC rows | reference | ratio |
| --- | ---: | ---: | ---: |
| June 2026, all TLDs | 9,450,215 (30 days, 315,007 a day) | | |
| September 2026, all TLDs | 10,019,510 (30 days, 333,984 a day) | | |
| June `.com` against ICANN net adds | 4,374,093 | 3,970,406 | 1.10 |
| June `.com` against appraise.net zone adds | 4,374,093 | 5,045,412 | 0.867 |
| September `.com` against appraise.net zone adds | 4,627,412 | 5,377,285 | 0.861 |
| June, 15 TLDs together against ICANN net adds | 7,910,115 | 7,409,286 | 1.07 |

June, ISC rows over ICANN net adds by TLD: `.com` 1.10, `.net` 1.13, `.org` 1.08, `.info` 1.03, `.xyz` 1.02, `.top` 0.95,
`.shop` 1.00, `.online` 1.03, `.site` 1.01, `.app` 0.92, `.store` 1.11, `.vip` 1.20, `.dev` 1.10, `.cfd` 1.09, `.sbs`
1.08. A month of daily counts matches the registry's own count of adds within 10% for 11 of 15 TLDs and within 20% for
all 15, so the feed neither misses a large part of the registrations nor, in the sample, carries much beyond them. The
day-by-day `.com` range is 100,587 to 175,674 in June and 118,214 to 184,493 in September. September `.com` plus `.net`
is 162,772 a day against Verisign's Q3 mean of 142,391.

What this supports, and what it does not. It supports "ISC's list is about the size of the registry's adds, and a
CZDS-derived third party counts about 15% more zone adds". It does not show which names a given day is missing, because
the sets are not available to compare (the registry gives counts, not names).

## 3. Q3: can RDAP alone confirm registration dates?

### 3.1 What the registries returned

142 requests, at most 30 to any server (`scripts/rdap_probe.py`, `rdap_cands.py`, `rdap_cands2.py`, `rdap_run_all.sh`,
`rdap_summary.py`). Verisign: 14 requests spaced 1.5 s from this address, 6 back to back, 10 through the project's
fetch Worker on Cloudflare's egress (09:54:51 to 09:55:49Z). The other eight servers: 6 spaced 2 s, 4 back to back, 4
through the Worker, 14 each, run in parallel as eight processes (10:15:13 to 10:15:50Z).

| server (TLDs probed) | answers | registration event | 404 | other | median ms, this address | median ms, via Worker |
| --- | ---: | ---: | ---: | --- | ---: | ---: |
| `rdap.verisign.com` (`.com`, `.net`) | 30 | 28 | 2 | none | 482 | 626 |
| `rdap.publicinterestregistry.org` (`.org`) | 14 | 12 | 2 | none | 428 | 1,059 |
| `rdap.identitydigital.services` (`.info`) | 14 | 11 | 3 | none | 331 | 639 |
| `rdap.centralnic.com` (`.xyz .cfd .sbs .bond .lol`) | 14 | 12 | 2 | none | 614 | 1,532 |
| `rdap.zdnsgtld.com` (`.top`) | 14 | 10 | 4 | none | 624 | 1,952 |
| `rdap.gmoregistry.net` (`.shop`) | 14 | 11 | 2 | one 403 via Worker | 700 | 2,056 |
| `rdap.radix.host` (`.online .site .store`) | 14 | 11 | 3 | none | 808 | 540 |
| `pubapi.registry.google` (`.app .dev`) | 14 | 12 | 1 | one 429 via Worker | 465 | 1,208 |
| `rdap.nic.vip` (`.vip`) | 14 | 9 | 5 | none | 854 | 584 |

Every 200 answer (116 of 116) carried a `registration` event with second precision, plus `expiration` and `last
changed`. A 404 (24) means the name is not registered at that registry now, for example deleted inside the add grace period or
never a registrable name (INFERRED). Servers are those in IANA's bootstrap file (`https://data.iana.org/rdap/dns.json`, published 2026-10-22T23:00:04Z).

### 3.2 What RDAP says about the candidates

Window rule: a name is "new" if its RDAP registration date is 4 days before to 1 day after the claimed day.

| stratum | names | new | old | not found | error |
| --- | ---: | ---: | ---: | ---: | ---: |
| ISC `.com` or `.net`, in ISC and Zonestream (Verisign) | 5 | 5 | 0 | 0 | 0 |
| ISC `.net` (Verisign) | 5 | 5 | 0 | 0 | 0 |
| ISC `.com`, not in Zonestream (Verisign) | 10 | 9 | 1 | 0 | 0 |
| in ISC and Zonestream, non-`.com` (eight servers, 10-22) | 32 | 31 | 0 | 1 | 0 |
| ISC 10-26 only, non-`.com` (eight servers) | 40 | 16 | 24 | 0 | 0 |
| Zonestream 10-22 only, non-`.com`, in no ISC file 10-19 to 10-26 (eight servers) | 40 | **0** | 17 | 21 | 2 |
| Zonestream 10-26 only, `.com`, in no ISC file (Verisign) | 10 | 5 | 3 | 2 | 0 |

How to read it.

- **In both feeds: 36 of 37 new.** Precision of the pair is about 97%.
- **ISC `.com` and `.net`: 19 of 20 new** (95%, 95% interval about 75 to 99%). The one old name was registered 2020.
- **ISC alone in the noisy TLDs is weak.** In the ISC-only stratum by server: `.app .dev` 5 of 5, `.online .site .store` 5
  of 5, `.org` 4 of 5, `.top` 1 of 5, `.info` 1 of 5, and 0 of 5 for each of the CentralNic TLDs (`.xyz .cfd .sbs .bond
  .lol`), `.shop` and `.vip`. Names in zone
  feeds that CT never saw are often returned or recycled names. For those TLDs ISC is a candidate list and RDAP is the
  confirmation.
- **Zonestream alone does not give registrations.** 0 of 40 non-`.com` events with no ISC match were new. The five `.com`
  names counted new were registered on 2026-10-26 between 00:19 and 12:03 UTC, so their zone date is 10-27 and they cannot
  be in a 10-19 to 10-26 file; ISC's 10-27 file, which did not exist yet, will confirm it (INFERRED timing effect, not a
  miss).
- **Detection lag.** ISC dates a name 1 to 2 days after registration and the dated file is complete the morning after, so
  the name is visible roughly 30 to 56 hours after registration. Zonestream carries it a median 1.8 h after (section 2.1 B).

### 3.3 Rate limits

- **From this address.** No `429`, no `Retry-After`, no `x-ratelimit-*` or `ratelimit-*` header on any of the 100
  requests made from here (42 more went through the Worker); 4 to 6 back-to-back requests to one server passed on every
  server.
- **From Cloudflare's shared egress,** through the project's fetch Worker (the answer header `x-web-egress` names the
  path; `scripts/rdap_probe.py` records it): Verisign 10 of 10 plain `cf-fetch`; Identity Digital, Radix, ZDNS, `.vip` ok.
  CentralNic answered 403 to `cf-fetch` on 4 of 4 and succeeded on the Worker's `cf-sockets` path. GMO answered 403 on
  4 of 4 `cf-fetch` and succeeded 3 of 4 by `cf-vpc`, one final 403. PIR answered 429 on 3 of 4 and succeeded by
  `cf-vpc`. Google answered 429 on 3 of 4 `cf-fetch` requests, 2 recovered by `cf-sockets` and 1 stayed 429. So four of nine
  registries refuse a plain Cloudflare Workers `fetch` at four requests, and the project's transport ladder is what
  recovers most of them.
- **What was not measured.** A limit per address, because the research rule stops at 30 requests per server. Published
  numbers are READ and vary by registry: rdap.org 10 per 10 s, Norid 300 a day, ISNIC 50 per 30 min, LACNIC 10 a minute
  (`https://webpixie.io/blog/post/rdap-rate-limits-access-tiers`); Nominet 6 per 3 s and 1,000 a day
  (`https://nominet.uk/wp-content/uploads/2025/03/gTLD-Acceptable-Use-Policies-version-2.pdf`). Verisign publishes none
  (READ `https://apis.io/rate-limits/verisign/verisign-rate-limits/`).
- **Capacity.** RDAP alone cannot confirm a full day: 250,940 gTLD names a day at one request a second is 2.9 days of one
  address, and Cloudflare's egress is refused by four of nine registries. It can confirm a sample, or only the names CT
  did not corroborate in the noisy TLDs. Zonestream's `confirmed` topic (222,150 a day) already does part of the
  RDAP work, with `confidence` 1 to 10.

## 4. Other measurements worth keeping

- DNS Coffee's new count and ISC's rows move together over 80 days: ratio 0.941 to 0.963 on the 8 days of 2026-10-19 to
  10-26 (`scripts/dnscoffee_vs_isc.py`, 09:43:35Z) and 0.905 to 0.963 on 8 of 10 spread days from 2026-08-05 to 10-17
  (`scripts/isc_history_vs_dnscoffee.py`, 10:31:04Z; the other two days are DNS Coffee gaps).
- WhoisDS free files: 2026-10-24, 10-25, 10-26 are 557,776 B, 593,216 B, 566,869 B, 70,000 lines each (09:34:02Z).
  hagezi's 7-day list holds 99.1% (10-26 file) and 98.8% (10-25 file) of the gTLD part; the same-date overlap with ISC is
  0.1% (the date shift to ISC's days was not measured). The free sample is inside the hagezi family and is not a gTLD
  zone diff; its use is the 13.7% to 23.4% of ccTLD names.
- `maaaaz/dnsdumps` and Stamus Labs are not keyless.

## 5. Not measured

- AXFR of any zone (outbound TCP 53 blocked here).
- A limit per address for any registry RDAP server.
- Whether ISC's older files (2025-10-26 to 10-30, 13 to 17 MB) use another layout.
- The 2026-10-27 ISC file, which did not exist yet; it decides the five `.com` names of section 3.2.
- Common Crawl's columnar index and host graph file path (the guessed host path answered 404).
- DNS Coffee's per-TLD breakdown (only the all-zone totals are public).

## 6. Scripts

All in `2026-10-27-gtld-without-czds/scripts/`. They take paths as arguments and hold no credential.

| script | use |
| --- | --- |
| `nrd_tld_dist.py` | TLD mix of ISC, WhoisDS, hagezi files |
| `isc_tld_union.py`, `isc_vs_registry.py`, `isc_month_sum.py`, `isc_month_ratios.py`, `isc_history_vs_dnscoffee.py` | ISC counts against registry and DNS Coffee references |
| `mrr_adds.py` | adds from an ICANN transaction report |
| `zonestream_ws_sample.mjs`, `zonestream_kafka_window.mjs`, `zonestream_summary.py`, `zs_day_tlds.py` | Zonestream samples |
| `overlap.py`, `zs_vs_isc_days.py`, `hagezi_lag.py`, `ct_visible_share.py`, `ct_lag.py`, `rankvance_overlap.py` | set overlaps |
| `dnscoffee_vs_isc.py`, `dnscoffee_feed_day.py` | DNS Coffee history and day JSON |
| `rdap_probe.py`, `rdap_cands.py`, `rdap_cands2.py`, `rdap_run_all.sh`, `rdap_summary.py` | bounded RDAP probe |
| `toplist_entrants.py`, `cc_index_coverage.py` | seen-list checks |
| `axfr_probe.py` | AXFR attempt (could not be run here) |
