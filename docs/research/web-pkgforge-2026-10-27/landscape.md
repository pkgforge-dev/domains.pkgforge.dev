> web.pkgforge.dev@40c120cb5d6b2cf4080baedd4de773cdca325fef docs/research/2026-10-27-domain-and-ip/landscape.md
> The source repository is private: no reader of this project can open it, and this copy is the record.

# domain.web.pkgforge.dev: the landscape and the gap

Research date: 2026-10-27 (UTC, 02:00 to 02:30). Read-only: no cloud resource created, no git repository written, no account or key obtained, no secret file read.
Raw probe outputs (bodies and headers) were kept in the research session's scratch directory, one `<probe>.body` and `<probe>.hdr` per call, with the probe helper script and the downloaded third-party lists kept apart in their own subdirectory; none of them is in this repository, and every probe is a public URL the text names.

## 0. Conventions

- **M** = MEASURED on 2026-10-27 by one `curl` (or one short script); the probe name in backticks is the file in `out\`; time is curl `time_total` from this machine (Windows, one consumer ISP), so it is an order of magnitude, not an SLA.
- **R** = READ on 2026-10-27 through our own `read.web.pkgforge.dev` / `search.web.pkgforge.dev`; the URL is named.
- "not measured" is said where it applies. No legal or terms analysis anywhere; "licence label" means the string the publisher prints, nothing more.
- This sandbox blocked raw outbound TCP (`WinError 10013`), so AXFR (port 53) and crt.sh's public Postgres (port 5432) were **not measured**; only HTTP(S) was.
- Context: the repo already holds `poc/domain/` (a Worker POC measuring 19 DoH resolvers as a filter signal, DNS, RDAP, TLS 1.3 client, crt.sh and Cert Spotter, Tranco). The gap list in section 6 is written against that: it favours things that need an index, not another live probe.

## 1. Headline findings

1. **Live probing is commodity and everyone is rate limited because of it.** Most keyless domain APIs found either cap per IP (10/hour to 1,000/day) or is slow (crt.sh 22 to 26 s per query, dnsai 5.5 s), because they probe upstream per request. The escape is precomputed indices served from the edge.
2. **The closest direct competitor is `issued.live`**: keyless `GET https://issued.live/<domain>.json`, 1.5 s, 1,000 requests/day per client address, corpus 495,772,690 domains (M `issued_stats`). It gives registered/expires, TLS cert, IP, first cert seen. It has **no category, no rank, no mail posture, no tech**; reverse IP, batch, pattern search, newly-registered feed and DNS bulk are paid ($99 to $199/month, R https://issued.live/developers).
3. **Category is the biggest open hole.** The one keyless-by-design category API found (`sitecategory.com`, 100/day, "99.4M categorised domains") does not resolve: `api.sitecategory.com` returns NXDOMAIN via Google DoH (M `sc_session`, DoH Status 3). Cloudflare Radar categories need a token (M `cfradar` 400 code 9106). The free category data exists only as files, and the files disagree: of 5,101,669 distinct domains in three free adult lists, only 138,725 (2.7%) are in all three (M, `untrusted\lists`). Per-source attribution is the product.
4. **Registration age has a coverage hole**: 233 of 1,437 root-zone TLDs have no RDAP service in IANA's bootstrap, including 175 of 248 ccTLDs (.de .jp .cn .ru .it .es .ch .se .dk .be .at .io .co .me .us ...). `rdap.org` returns 404 for them (M `rdap_denic.de`, `rdap_nic.io`, `rdap_google.co.jp`); networkcalc's whois returns all nulls for `denic.de` (M `networkcalc_de`); issued.live returns `registered: null` for `denic.de` (M `iss_denic.de`).
5. **A keyless firehose of newly registered domains already exists** but is a WebSocket: `wss://zonestream.openintel.nl/ws/newly_registered_domain`, 84 messages in 20 s (about 4.2/s, about 363,000/day) (M `ws.mjs`). I found nobody wrapping it as plain JSON/NDJSON.
6. **OpenINTEL's public S3 bucket is keyless, Range-capable and holds daily full-zone DNS Parquet for .se .fr .ch .nu .sk .ee .li .gov plus daily Tranco/CrUX/Majestic/Radar/Umbrella top lists** (M `oi_*`, `oi_range` HTTP 206). It is rarely exposed as an API. gTLDs (.com/.net/.org) are not in the open set.
7. **Agent-facing domain APIs exist but are narrow.** A handful ship `llms.txt`/OpenAPI/MCP keyless (dotsweep, issued.live, dnsai, DC5 whois, dnsbin.ca) and every one covers DNS/WHOIS/availability/CT; none covers category, popularity, parked, or per-field provenance.

## 2. API catalogue (probed today)

Columns: keyless = answered a request with no key, header or account; quota is what the response headers or the docs said; latency is M unless stated.

### 2.1 Registration, DNS, mail, hosting

| Service | Keyless? | Quota seen | Fields returned | Latency | CORS | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| rdap.org (`rdaporg`) | yes | none seen; 302 cached `max-age=28800` | redirect to the registry; RDAP JSON `application/rdap+json` | 0.98 s incl. redirect | `*` | M. 404 `No RDAP service is available` for .de/.io/.co.jp |
| Verisign RDAP direct (`verisign_rdap`) | yes | none seen | handle, ldhName, events (registration/expiration/last changed), status, 8 nameservers, secureDNS, registrar entity | 0.36 s, 3,026 B | not recorded | M |
| IANA RDAP bootstrap `dns.json` | yes | static file | 1,204 TLDs with an RDAP service, publication 2026-10-22 | 0.38 s, 71,348 B | not recorded | M. 233 of 1,437 TLDs absent (section 4) |
| networkcalc.com (`networkcalc_dns`, `networkcalc_whois`) | yes | not measured | `/api/dns/lookup/<d>` A/CNAME/MX/NS/SOA with TTL; `/api/dns/whois/<d>` registrar, created, expiry, status, abuse | 0.87 s DNS, 1.27 s whois | `*` | M. whois all-null for denic.de, filled for nic.io |
| who-dat public instance (`whodat`) | yes | not measured | registrar, dates, ids, abuse, parsed WHOIS JSON (1.8 KB) | 0.81 s | `*` | M. Open-source; the public host is someone else's |
| lookup.icann.org (`icann_lookup`) | HTML UI only | n/a | gzip HTML | 2.57 s | n/a | M. No JSON API found |
| ipinfo.io (`ipinfo_ip`, `ipinfo_domains`) | IP: yes; domains: no | IP free quota not measured; `/domains/` 400 "API Access Token Required" | ip, hostname, city, region, country, loc, org (ASN), postal, timezone, anycast | 0.53 s | `*` | M |
| host.io (`hostio`) | no | free plan 1,000 requests/month then HTTP 429 (R https://support.host.io/hc/en-us/articles/33021412411922) | `/api/web/<d>` needs token (400) | 0.72 s | not recorded | M + R |
| ViewDNS.info (`viewdns`) | no | n/a | API 401 "Invalid API key"; web UI 403 to curl | 1.25 s | n/a | M |
| WhoisXML API (`whoisxml`) | no | 500 free credits one-time at signup (R https://brand-alert.whoisxmlapi.com/api/documentation/making-requests) | 401 `AUTHENTICATE_04` | 1.04 s | n/a | M + R |
| who.is / whois.com | web UI | not measured | no public API found | n/a | n/a | not measured |
| DNSlytics (`dnslytics`) | no/unknown | not measured | `api.dnslytics.net/v1/domain/...` returned 404 | 1.0 s | n/a | M (404 only) |
| DNSai (`dnsai_es`, `dnsai_dns`) | yes | **10 lookups/day per IP**, 100/day with free key, bulk = Enterprise (R https://dnsai.com/api/) | one object: A, AAAA, CAA, DKIM, DMARC (+policy, rua, ruf), SPF (+limit), MX, NS, SOA, TXT, DNSSEC, TLSA, "Technology Listed In DNS", ASN and location per A/MX, `assessment` | **5.47 s** / 5.73 s | `*` | M. Placeholders `"—"` for empty, multi-values joined with `\n` or `; ` inside strings (hard to parse). OpenAPI 3.1 22,471 B at `api.dnsai.com/openapi.json`; MCP at `mcp.dnsai.com/mcp` |
| DC5 whois MCP (`whois.dc5.tech/mcp`) | yes | not measured | MCP tools `lookup_target`, `check_mail_security`, `check_lookalike`, `list_data_sources`: registrar and dates, DNS, mail grade, network owner, geo, reputation, "compact text plus structured JSON" | not measured | n/a | R https://whois.dc5.tech/mcp. The REST path I guessed (`/api/github.com`) returned 404 (M `dc5_rest`) |
| dnsbin.ca (`dnsbin`) | yes | not measured | `/api/v1/report` guided diagnostic: `findings[]` with `level` and prose `message` | 2.55 s, 9,472 B | none | M. Findings are prose, not fields. Publishes `llms.txt` (R search result) |
| toolapi.org (`toolapi_dns`) | yes | "120 per minute" fair use (R playground page) | DNS: `{domain, record_type, found, records[], count}` | 1.21 s | none seen | M. OpenAPI 3.0.2, 27,160 B |
| opensystools.com (`opensys_dns`) | yes | **30/min and 1,500/day per IP** (M headers `RateLimit-Policy: "standard-minute";q=30;w=60, "standard-day";q=1500;w=86400`) | rcode, records with TTL, resolver, `timeMs`, dnssec | 1.73 s | `*` | M |
| ferntool.com (`ferntool`) | yes | "keep under about 1 request/second" (R) | IP validity, ASN, ISP, geo, timezones (dbip-lite + iptoasn) | 0.90 s | `*` | M |
| ip-api.com (`ipapi`) | yes, HTTP only | **45/min per IP** (M headers `X-Rl: 44`, `X-Ttl: 60`) | accepts a domain; country, region, city, zip, lat/lon, isp, org, as | 0.37 s | `*` | M |
| RIPEstat (`ripestat`, `ripestat_rev`) | yes | not measured | `dns-chain`, `reverse-dns-ip`, plus many data calls | 1.00 s / 0.92 s | not recorded | M |
| Team Cymru IP-to-ASN via DoH TXT (`cymru`) | yes | not measured | `36459 | 140.82.112.0/24 | US | arin | 2018-04-25` | 0.52 s | `*` | M |
| Cloudflare DoH `cloudflare-dns.com/dns-query` | yes | not measured | RFC 8484 JSON, EDE comments | 0.07 to 0.36 s | `*` | M (`doh_dbl`, `doh_cat.sh`) |
| Google DoH `dns.google/resolve` | yes | not measured | JSON, `Comment` names the upstream | 0.10 to 0.58 s | not recorded | M |

### 2.2 CT, subdomains, passive DNS, archive

| Service | Keyless? | Quota seen | Fields | Latency | CORS | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| crt.sh JSON (`crtsh`, `crt1..3`) | yes | none stated | `issuer_name`, `common_name`, `name_value` (newline-joined), `id`, `not_before`, `not_after`, `serial_number` | **22.6 s** single; **24.6, 24.8, 25.6 s** for three parallel queries (pkgforge.dev, wikipedia.org, example.com exclude=expired); 416,896 B for `q=github.com` (1,225 certs, 143 distinct names) | `*` | M. The flakiness evidence |
| Cert Spotter (`certspotter`, `cs2`) | yes | **`X-Ratelimit-Limit: 10`**; docs: "a limited number of unauthenticated queries per hour" (R https://sslmate.com/help/reference/ct_search_api_v1) | `id`, `dns_names[]`, `cert_sha256`, `not_before/after`, `revoked`; 70 issuances / 58 names for github.com | 1.92 s, 2.44 s | `*` | M + R |
| issued.live (`issued_gh`, `iss_*`, `issued_stats`, `issued_new`) | yes | **1,000/day per client address**, resets 00:00 UTC (R https://issued.live/developers) | `domain, registered, expires, ssl_expires, ssl_cert, ssl_issuer, ip, ip_observed_at, last_update, first_cert_seen, tracked, first_zone_seen`; `/api/stats`; `/api/feed` (latest CT names) | 1.0 to 1.5 s | not sent | M. `/api/v1/ip/<ip>` is 401 (Plus tier). `registered: null` for .de. `first_cert_seen` for wikipedia.org is 2026-09-25 (start of their observation, not a true first). Totals: 495,772,690 domains; 390,270,535 CT entries and 15,656,613 certs in 24 h. `llms.txt` and `.md` per domain exist |
| hackertarget.com (`hackertarget`, `ht_rev`, `ht_whois`) | partly | headers `X-API-Quota: 21`, `X-API-Count: 0` then `1` (meaning of the number is not documented in the response); `/whois/` answers "error valid key required" | `/hostsearch/` returns `host,ip` text, **51 rows** for github.com; `/reverseiplookup/` 7 hostnames for 140.82.112.3 | 1.27 s, 1.22 s | `*` | M. Plain text, not JSON |
| ip.thc.org (`thc`, `thc_sub`, `thc_json`) | yes | token bucket: "You can make 249 requests (Replenishes at 0.50/sec)" | `/<ip>` 100/13,321 entries for 8.8.8.8; `/sb/<domain>` 100/4,294 for github.com; cursor pagination via `Next Page`; `/cn/` for CNAMEs | 0.8 to 1.2 s | not recorded | M. Default output is ANSI-coloured text; `Accept: application/json` still returns `text/plain`. Another agent covers it in depth |
| Netlas anonymous (`netlas*`, `nl_1..6`) | works without a key on `app.netlas.io/api/...` | an anonymous daily cap exists: after about 9 calls on this IP one returned **429 `daily_request_limit_exceeded`**, the next call returned 200 again (inconsistent) | `/domains/` A, NS, MX, TXT, zone, level; `/whois_domains/`; `/host/<d>/` (316,952 B incl. CVE); `domains_count` `zone:com` = 1,362,851,238 (the index holds subdomain names such as `www.dr.github.com`, M `netlas2`, so this is not the registered-domain count) | 1.4 to 9.1 s | not recorded | M. Not documented as an API for anonymous callers; docs say Community plan = 50 requests/day with signup (R https://netlas.io/pricing/) |
| Robtex free API (`robtex_f`, `robtex_r`) | yes | **10 requests/hour per IP** (R https://robtex.com/en/api) | `/pdns_forward` records with `time_first`, `time_last`, `count` (first seen 2016-10-21 for github.com NS); `/pdns_reverse`; `/ipquery`, `/asquery` | 4.73 s, 0.96 s | not recorded | M + R |
| AlienVault OTX (`otx`) | general: yes | not measured | indicator general, sections list | 0.72 s; `passive_dns` **timed out at 40 s** | `*` | M |
| Wayback CDX (`wayback_cdx`) | yes | `X-RL: 0` header seen | `[timestamp, original, statuscode]` rows; earliest github.com capture 2008-05-14 | 1.47 s | not sent | M |
| Common Crawl index (`cc_cdx`, `cc_collinfo`) | yes | not stated | NDJSON: urlkey, timestamp, url, mime, status, digest, length, offset, filename, languages | **9.6 s** for `limit=1`; collinfo lists 129 crawls (latest CC-MAIN-2026-43) | `*` | M |
| SecurityTrails (`st`) | no | free tier 50 calls/month (R, third-party summary https://github.com/DevOpsMadDog/Fixops) | 401 | 1.52 s | n/a | M + R |
| DNSDumpster (`dnsdumpster`) | no | n/a | `{"error":"API key is missing"}` | 1.07 s | n/a | M |
| FullHunt, LeakIX (`fullhunt`, `leakix`) | no | n/a | 401 | 0.63 s, 0.84 s | n/a | M |
| Anubis `jldc.me` (`anubis`) | blocked | n/a | Cloudflare 403 challenge | 0.78 s | n/a | M |
| ThreatMiner (`threatminer`) | down | n/a | 522 | 20 s | n/a | M |
| BufferOver (`bufferover`) | gone | n/a | host does not resolve | n/a | n/a | M |
| RapidDNS (`rapiddns`) | HTML | n/a | HTML page only | 1.88 s | n/a | M (HEAD) |

### 2.3 IP-centric

| Service | Keyless? | Quota | Fields | Latency | CORS | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Shodan InternetDB (`internetdb`) | yes | `Cache-Control: public, max-age=432000` (5 days); no limit stated | `{cpes, hostnames, ip, ports, tags, vulns}`; 8.8.8.8 returned ports [53,443] and 2 hostnames | 0.48 s | `*` | M. thc listed 13,321 entries for the same IP, so InternetDB's reverse hostnames are thin |
| Censys legacy search (`censys`) | no | n/a | HTTP 403 `Censys Legacy Search was decommissioned on September 30, 2026` | 1.15 s | n/a | M |

### 2.4 Popularity

| Service | Keyless? | Quota | Fields | Latency | CORS | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| Tranco API (`tranco_gh`, `tranco_latest`) | yes | **1 query/second** (R https://tranco-list.eu/api_documentation, 429 above that) | `/api/ranks/domain/<d>`: array of `{date, rank}`; 36 daily entries for github.com (rank 33 on 2026-10-26, 29 on 2026-10-08) | 0.40 s | `*` | M + R. Combined Dowdall rank only; no per-provider ranks. Latest list GQ3QK, providers crux, farsight, majestic, radar, umbrella, window 2026-09-27 to 2026-10-26 |
| OpenPageRank (`opr`) | no | moved to openpagerank.keywordseverywhere.com; free key = 30,000 domains/month | 401 with migration message | 2.15 s | n/a | M |
| Cloudflare Radar API (`cfradar`) | no | free token | `/radar/ranking/domain/{d}` returns categories, bucket, rank, top_locations (R https://developers.cloudflare.com/api/resources/radar/subresources/ranking/); keyless call = 400 code 9106 | 0.31 s | n/a | M + R. Public Radar page 403 to curl (M `radar_pub`) |
| Majestic Million | file, yes | n/a | CSV columns `GlobalRank,TldRank,Domain,TLD,RefSubNets,RefIPs,IDN_Domain,IDN_TLD,PrevGlobalRank,PrevTldRank,PrevRefSubNets,PrevRefIPs` | 0.68 s HEAD | not recorded | M |

### 2.5 Reputation and category

| Service | Keyless? | Quota | What it says | Latency | Notes |
| --- | --- | --- | --- | --- | --- |
| Cloudflare family DoH (`family.cloudflare-dns.com`) | yes | not measured | `pornhub.com` -> `0.0.0.0` while `cloudflare-dns.com` -> 66.254.114.41 | 0.17 s | M `doh_cat.sh`. Adult plus malware block as a verdict |
| Cloudflare security DoH (`security.cloudflare-dns.com`) | yes | not measured | `malware.testcategory.com` and `phishing.testcategory.com` -> `0.0.0.0` with `Comment: ["EDE(16): Censored"]`; `internetbadguys.com` not blocked | 0.07 s | M |
| AdGuard family DoH (`family.adguard-dns.com/resolve`) | yes | not measured | `pornhub.com` -> 94.140.14.35 (block-page address) | 0.54 s | M |
| OpenDNS FamilyShield DoH | endpoint is not JSON | n/a | HTTP 400 "No valid query received" for the JSON form | 0.97 s | M. Wire format would be needed |
| CleanBrowsing DoH | my path was wrong | n/a | error `x014` | 1.1 s | M, inconclusive |
| Quad9 (`dns.quad9.net:5053`) | not measured | n/a | timed out from this sandbox | 15 s | not measured |
| Spamhaus DBL | DNS, **not usable over public resolvers** | free DQS needs a key (R https://www.spamhaus.org/resource-hub/dnsbl/using-our-public-mirrors-check-your-return-codes-now/) | via Cloudflare DoH: `dbltest.com.dbl.spamhaus.org` -> **127.255.255.254** (the code Spamhaus defines as "Query via public/open resolver"); via Google DoH: Status 3 with SOA `need.to.know.only` | 0.35 s | M + R |
| SURBL | DNS | free use refuses public resolvers per a client library README (R https://github.com/filipsalomonsson/surblclient) | via Google DoH: `test.surbl.org.multi.surbl.org` -> 127.0.0.254 (test point); `github.com.multi.surbl.org` -> NXDOMAIN. A listed real domain was not tested | 0.35 to 0.47 s | M. Whether a genuinely listed domain is refused via DoH: not measured |
| VirusTotal (`vt`) | no | public key 500/day, 4/min (R https://docs.rapid7.com/insightconnect/virustotal/) | 401 `X-Apikey header is missing` | 1.44 s | M + R |
| Google Safe Browsing (`gsb`) | no | free up to 10,000 requests/day (R https://apispine.com/google-safe-browsing/pricing) | 403 "callers without established identity" | 0.46 s | M + R |
| urlscan.io search (`urlscan`) | yes | **30/min per IP** (M headers `X-Rate-Limit-Limit: 30`, scope ip-address, concurrency 10) | `results[]` of scans: `page.domain, ip, country, server, asn`, `task.url`, `stats` | 0.82 s | M. Scan-derived, not a domain verdict |
| OpenPhish feed (`openphish`) | yes | n/a | `feed.txt`, 15,283 B (small community list) | 0.76 s HEAD | M |
| PhishTank data URL | not available | n/a | the data path returned a 404 image page | 1.4 s | M |
| URLhaus text download | old path gone | n/a | HTTP 410 on the old URL | 1.38 s | M. abuse.ch API wants an Auth-Key (not measured) |
| sitecategory.com API | **dark** | claimed 100/day, session token (R https://github.com/WebsiteCategorizer/sitecategory) | `api.sitecategory.com` and apex have no A record (NXDOMAIN / NODATA via Google DoH) | n/a | M. README claims 99.4M categorised domains |
| WhoisXML website categorization | preview signed-out only | paid | IAB category, "live, parked or unreachable" (R https://website-categorization.whoisxmlapi.com/lookup) | n/a | R |

### 2.6 Security posture

| Service | Keyless? | Quota | Fields | Latency | Notes |
| --- | --- | --- | --- | --- | --- |
| Mozilla Observatory v2 (`observatory2`) | yes: `POST /api/v2/scan?host=` | not stated | `{id, scanned_at, grade A+, score 115, status_code, tests_failed 1, tests_passed 11, tests_quantity 12, details_url}` | 3.06 s | M. First attempt returned Varnish 503 `No healthy IP available`; retry with `Content-Length: 0` worked. v1 host returned 502 |
| hstspreload.org (`hstspreload`) | yes | not stated | `/api/v2/status?domain=` -> `{name, status: preloaded, bulk, preloadedDomain}` | 1.39 s | M. Full list is a 10,614,168 B JSON in Chromium |
| SSL Labs v3 (`ssllabs_info`, `ssl_v3_an`) | yes from cache | `maxAssessments: 7`, `newAssessmentCoolOff: 1000` | `fromCache=on` returned READY with grade A+ per IP for github.com | 1.27 s info, 2.56 s analyze | M. v4 analyze: 400 "You must provide email header" (`ssl_v4_an`) |
| securityheaders.com (`secheaders`) | no | n/a | `x-grade: Please use an API Key` | 1.1 s | M |
| internet.nl batch (`internetnl`) | no | n/a | 401 | 0.99 s | M |
| MXToolbox (`mxtoolbox`) | no | n/a | 401 | 1.21 s | M |
| DMARC checkers (dmarcian, EasyDMARC, ...) | web tools | not measured | not measured | n/a | not measured |

### 2.7 Technology, availability, entity

| Service | Keyless? | Quota | Fields | Latency | Notes |
| --- | --- | --- | --- | --- | --- |
| BuiltWith free API (`builtwith`) | no | n/a | `API Key is incorrect` (HTTP 200 with error body) | 1.28 s | M |
| Wappalyzer API (`wapp`) | no | n/a | 403 | 1.16 s | M. Fingerprints exist open: `enthec/webappanalyzer` (licence label GPL-3.0, pushed 2026-10-19), `projectdiscovery/wappalyzergo` (MIT) (M `gh_wapp`, `gh_wapp2`) |
| BeaverCheck (`beaver_tech`) | yes | **30/min per IP** (M headers) | `/api/v2/tech?url=`: `stack_summary`, `technologies[]` with category, version, website | 1.19 s | M. `scanned_at` was 2026-05-10, so a cached scan 170 days old; summary called github.com "Amazon S3 CDN" |
| web-check.xyz | blocked | n/a | Vercel Security Checkpoint, HTTP 429 | 0.55 s | M |
| Crawlwise / Opentechalyzer / websiteauditor | claim keyless | demo quota / unknown | not measured | n/a | R (search results) |
| downforeveryoneorjustme (`isitdown`) | yes | not measured | `{isDown, statusCode, returnedUrl, lastChecked}` | 0.94 s | M. CORS limited to its own origin |
| dotsweep.com (`dotsweep_llms`) | yes | cached GET unmetered; `POST /check` up to 10 domains | availability + registration/renewal price across TLDs via RDAP, DNS prefilter; MCP at `/mcp`; `skill.md` | 0.54 s for `llms.txt` (21,681 B) | R https://dotsweep.com/llms.txt (the file itself, M). `/openapi.json` 404 |
| Wikidata SPARQL (`wikidata`, `wd_count`) | yes | not stated | domain -> entity: `wdt:P856` official website joined to label, description, inception, HQ; github.com -> Q364 "GitHub", inception 2007, HQ San Francisco | 1.82 s | M. **2,470,124** items carry an official website |
| internettimes.com | no | free key, 100 calls/day (R https://internettimes.com/api) | DNS, subdomain-enum (CT), cloud-region, audit | n/a | R |
| nettools.me MCP, nslookup.app MCP, WhoisJSON MCP, WhoisXML MCP (32 tools, key) | mixed | not measured | DNS, WHOIS, SSL, geo | n/a | R search results |

## 3. Bulk datasets that could seed an index

All sizes M (HEAD or listing on 2026-10-27) unless marked R. "Label" is the licence string the publisher prints.

| Dataset | What it holds | Size and cadence | How to fetch | Label | Notes |
| --- | --- | --- | --- | --- | --- |
| **OpenINTEL fDNS, zone based** | daily active DNS measurements, full zone, Parquet, fields A/AAAA/NS/MX/TXT/CNAME/DS/DNSKEY/... plus `country`, `as`, `ip_prefix` (R https://openintel.nl/data/dictionary/) | latest day: .se 2,536,134,732 B (3 objects, day 25), .fr 4,114,913,184 B (4), .ch 2,701,888,990 B (3, day 26), .nu 277,437,457 B, .sk 608,858,305 B, .ee 102,063,091 B, .li 49,771,499 B, .gov 10,007,362 B | S3 `https://object.openintel.nl/openintel-public`, prefix `fdns/basis=zonefile/source=<tld>/year=/month=/day=/`; ListObjectsV2 works unauthenticated; **HTTP 206 Range works** (`oi_range`: Parquet tail `PAR1`) | CC BY-NC-SA 4.0 (R https://www.openintel.nl/download/terms/) | gTLD zone data is not open (R CAIDA slide: "Show us your contract"). Sources also include `fed.us`, `gov`, `root` |
| **OpenINTEL fDNS, toplists** | same schema for the top lists | Tranco latest day 451,572,029 B (1 object) | `fdns/basis=toplist/source=<alexa|crux|majestic|radar|tranco|umbrella>/` | same | rarely exposed as an API |
| OpenINTEL ccTLD names from CT (R) | apex names for 307 ccTLDs from CT, weekly (Mondays), since Jan 2015 | not measured | https://openintel.nl/data/domain-lists/cctld-names/ | same | "provides no guarantee that the domain is actively delegated" |
| **OpenINTEL Zonestream** | live JSON: `newly_registered_domain`, `newly_registered_fqdn`, `zone_diff` (.cd .ch .ee .fj .gp .li .mp .mw .ni .nu .sl .se) | 84 messages in 20 s on `newly_registered_domain` | `wss://zonestream.openintel.nl/ws/<topic>`; Kafka `kafka.zonestream.openintel.nl:9091` (R https://openintel.nl/data/zonestream/) | same | keyless. Payload `{domain "x.com." (trailing dot), cert_index, ct_name, timestamp, submission_timestamp}` (M). Needs a long-lived connection |
| ICANN CZDS | gTLD zone files, daily | .com about 4.9 GB compressed (R HN thread, 2022), 4,201,149,204 B in a 2024 report (R gtld-tech list); .net about 456 MB compressed (R) | CZDS REST API needs a registered account and a per-TLD approval of 3 to 12 months (R https://portal.icann.org/servlet/servlet.FileDownload?file=00P6100000FPC9NEAX) | per-registry terms | a third-party table claiming "auto-approved 24 h" for .com is not trusted (inconsistent figures) |
| ccTLD open lists and AXFR (R) | .se and .nu via AXFR `zonedata.iis.se`; .ch and .li via AXFR `zonedata.switch.ch` with a published TSIG key; .ee via AXFR `zone.internet.ee`; .fr via AFNIC open data CSV; .sk list; others transferable (.cd .er .fj .gp .mw .sl ...) | AXFR not measured | see sources: https://internetstiftelsen.se/en/zone-data/, https://portal.switch.ch/pub/open-data/, https://www.internet.ee/domains/ee-zone-file, https://jpmens.net/2021/05/18/dns-open-zone-data/ | .ee: CC BY 4.0 | |
| .sk registry list (`sk_domains`) | **493,544 live domains** with registrar id, holder id, NS list and **expiry date**, generated 2026-10-26 | 47,797,077 B | plain HTTPS `https://sk-nic.sk/subory/domains.txt` | not printed | M. Same ccTLD is 2,719,592 in domains-project: that count is cumulative, not live |
| Root zone, TLD list, PSL | root zone 2,246,641 B (2026-10-26 22:03); 1,437 TLDs (version 2026102600); Public Suffix List 338,012 B (2026-10-22) | | `internic.net/domain/root.zone`, `data.iana.org/TLD/tlds-alpha-by-domain.txt`, `publicsuffix.org/list/public_suffix_list.dat` | | M |
| IANA RDAP bootstrap | 1,204 TLDs with RDAP | 71,348 B | `data.iana.org/rdap/dns.json` | | M |
| Chromium HSTS preload list | | 10,614,168 B | raw GitHub `transport_security_state_static.json` | | M |
| CT log list v3 | operators and logs; tiled (static-ct-api) logs: Google 6, Sectigo 8, Let's Encrypt 10, Geomys 10, IPng 10, Microsec 5, GoDaddy 5, HARICA 4, TrustAsia 1 | 62,375 B | `https://www.gstatic.com/ct/log_list/v3/log_list.json` | | M. Tiled logs serve plain HTTP tiles of 256 entries (R https://github.com/C2SP/C2SP/blob/main/static-ct-api.md) |
| Tranco top 1M | one combined list | `top-1m.csv.zip` 9,730,345 B, daily | `https://tranco-list.eu/top-1m.csv.zip`, `/download/<id>/1000000` | not measured | M |
| Majestic Million | with RefSubNets, RefIPs, previous rank | 80,357,552 B, updated 2026-10-26 | `downloads.majestic.com/majestic_million.csv` | not measured | M |
| Cisco Umbrella top 1M | | 12,896,344 B zip, 2026-10-27 01:12 | `s3-us-west-1.amazonaws.com/umbrella-static/top-1m.csv.zip` | not measured | M |
| CrUX top lists | monthly, origin level, rank magnitude only (1k, 10k, 100k, 1M) | `current.csv.gz` 8,790,815 B | raw GitHub `zakird/crux-top-lists` | not measured | M for size; magnitude buckets R https://developer.chrome.com/docs/crux/bigquery |
| Common Crawl web graph | host-level and domain-level PageRank-style ranks | release `cc-main-2026-aug-sep-oct`: `domain-ranks.txt.gz` 2,544,184,794 B, `host-ranks.txt.gz` 4,805,334,849 B; domain graph 135.0 M nodes, 1.8 B edges (R) | `data.commoncrawl.org/projects/hyperlinkgraph/...` | not measured | quarterly; this is the only long-tail popularity signal found (135 M domains) |
| Common Crawl index | per-URL CDX | 129 crawls | `index.commoncrawl.org` | | M (9.6 s for one row) |
| **UT1 blacklists** | **75 category directories** (`porn` is byte-identical to `adult`), 5,908,686 category-domain rows, **5,219,095 distinct domains**: adult 4,599,279; malware 246,132; phishing 245,713; redirector 132,323; gambling 69,608; shopping 36,968; games 33,741; cryptojacking 11,490; dating 10,549; bank 6,646; social_networks 715 ... | 26,483,396 B tar.gz, updated 2026-10-26 21:50 | `https://dsi.ut-capitole.fr/blacklists/download/blacklists.tar.gz` | tarball ships `cc-by-sa-4-0.pdf` | M |
| BlockList Project porn | hosts format | 26,095,053 B; header `Entries: 953,393`; last modified 2026-07-18 | raw GitHub `blocklistproject/Lists/master/porn.txt` | header `License: MIT` | M |
| OISD nsfw | wildcard domains | 8,484,218 B; header `Entries: 477904`, 477,905 distinct lines counted; version 202610270137 | `https://nsfw.oisd.nl/domainswild2` | not measured | M |
| StevenBlack porn hosts | hosts | 4,223,629 B | raw GitHub alternates/porn | | M |
| Phishing Army, OpenPhish | phishing lists | OpenPhish 15,283 B | | | M (HEAD) |
| **domains-project** (`tb0hdan/domains`) | 1,766,025,618 names across 1,522 TLD kinds; .com 702,681,019, .net 345,922,534, .jp 67,168,816, .de 67,007,985 | Git LFS, xz; 4.6 GB for 1.7 B (R) | GitHub | | M (`dp_stats`). Counts are cumulative crawl output, not live registrations (the .sk comparison above: 2,719,592 vs 493,544 live) |
| NRD lists | WhoisDS free daily list, re-published by `cenk/nrd` (last 10 to 60 days) | not measured | `dl.cenk.app/nrd/...` | | R https://github.com/cenk/nrd. A WhoisFreaks daily sample of about 1,000 gTLD domains exists (R) |
| Rapid7 Sonar | FDNS/RDNS | closed to public access in Feb 2022; the AWS registry copy is marked deprecated | | | R https://www.rapid7.com/blog/post/2022/02/10/evolving-how-we-share-rapid7-research-data-2/ |
| Wikidata | 2,470,124 items with official website | live SPARQL | `query.wikidata.org/sparql` | not measured | M |
| Cloudflare Radar datasets | domain rankings, categories | | `GET /radar/datasets/{alias}` needs a token | | R, keyed |

## 4. Coverage measurements worth keeping

- **RDAP gap (M, computed from `data.iana.org/rdap/dns.json` and `tlds-alpha-by-domain.txt`, files `out\r.txt`, `out\a.txt`):** 1,437 TLDs in the root zone list, 1,204 with RDAP, 233 without; of 248 two-letter ccTLDs, 175 without. The non-IDN TLDs with no RDAP entry (the `comm` output, verbatim): ac ae af ag al am ao aq arpa at aw ax az ba bb bd be bf bg bi bj bn bo bs bt bv bw by bz cd cf cg ch ci ck cl cn co cu cw cy de dj dk dm do dz edu ee eg er es et eu fk ga gb ge gf gg gh gi gl gm gn gp gq gr gt gu gw hk hm hr hu ie il im io iq ir it je jm jo jp kh ki km kn kp kw kz la lc li lk lr ls lt lu lv ma mc md me mh mil mk mm mn mo mp mq mr mt mv mw mx my mz nc ne ni np nr nu nz om pa pe pf ph pk pr ps pt py qa ro rs ru sa sb se sh sj sk sl sm so st su sv sx sy sz tc td tg tj tk tl tm tn tr tt ug us uy va vc ve vn vu ws za zw (plus the IDN TLDs). Present in the bootstrap: uk br fr nl pl au ca no fi cz in kr tw tv ai cc. Note that the seven open-zone ccTLDs (.se .nu .ch .li .ee .sk and, in the AXFR group, .cd) are all in the "no RDAP" list, so registration dates for them can only come from the zone data or WHOIS.
- **Adult-list disagreement (M, `untrusted\lists`):** UT1 adult 4,599,279; BlockList Project porn 953,393 (all lines `0.0.0.0 <name>`, no duplicates; the file also has one blank line); OISD nsfw 477,905; BP and UT1 overlap 586,181; OISD and BP overlap 339,515; OISD and UT1 overlap 141,938; union 5,101,669; **in all three 138,725 (2.7%)**. Spot check: pornhub.com, xvideos.com, xnxx.com, onlyfans.com, redtube.com are in all three; reddit.com and tumblr.com in none.
- **Live vs cumulative registrations (M):** .sk live list 493,544 vs domains-project 2,719,592 (5.5x).
- **Filter DoH as a category signal (M):** one query, 0.07 to 0.54 s, three resolvers answered consistently with block semantics (0.0.0.0 or a block page IP); public resolvers (Cloudflare plain, Google) answered the real address. Spamhaus and SURBL need an attributable resolver, so they cannot ride on a public DoH.

## 5. The agent-facing angle

What exists keyless, JSON, CORS, with agent-readable docs (all M today unless marked):

| Service | Agent surface | What it covers | What it lacks |
| --- | --- | --- | --- |
| issued.live | `llms.txt` (6,141 B), per-domain `.md`, JSON by suffix/Accept/UA, 1,000/day/IP | registered, expires, TLS cert, IP, first cert seen, DNS | category, rank, mail posture, tech; reverse IP and batch are paid |
| dotsweep.com | `llms.txt` (21,681 B), `skill.md`, MCP `/mcp`, POST batch of 10 | availability and price across TLDs, RDAP | nothing about a domain's content, rank or category |
| DNSai | OpenAPI 3.1 (22,471 B), MCP `mcp.dnsai.com/mcp`, REST | DNS, SPF, DKIM, DMARC, WHOIS, email gateway, "technology listed in DNS" | 10 lookups/day per IP; 5.5 s; one domain per request (bulk = Enterprise); no rank/category/CT |
| DC5 whois | MCP `whois.dc5.tech/mcp`, server card | registrar and dates, DNS, mail security grade, network owner, geo, reputation (local lists) | R only; REST not found |
| dnsbin.ca | `llms.txt`, JSON | DNS report as prose findings | no structured fields |
| toolapi.org, opensystools.com, ferntool.com | OpenAPI (toolapi) | DNS/IP basics | no joins |
| BeaverCheck | JSON, docs, batch, history | tech and audit | 30/min/IP; cached scan 170 days old in the sample |

MCP servers for whois/DNS and what they wrap (R, search results of 2026-10-27; none re-measured):

- `cyanheads/whois-mcp-server`: RDAP plus DNS-over-HTTPS, no key.
- `BUZDOLAPCI/dns-intel`: RDAP, DNS, CT search.
- `cyanheads/attack-surface-mcp-server`: CT, DNS, TLS, HTTP, RDAP, optional Shodan.
- `nekiyRichie/recon-mcp`: CT subdomains (crt.sh), DNS, host exposure.
- `r0bin2u/dns-mcp`: `dns.google` DoH, `rdap.org`, `ip-api.com` (45/min).
- `palimpsest-labs/dns-whois-mcp`: DNS, WHOIS, with computed `age_days`.
- `estevecastells/domscan-mcp`: DNS, WHOIS/RDAP, SSL, more (keyed).
- WhoisXML MCP: 32 tools (keyed). nettools.me MCP: 30 tools. nslookup.app MCP, WhoisJSON MCP, Jezweb network tools.

Pattern: the agent tools are thin wrappers over crt.sh, rdap.org, DoH and ip-api. They inherit those upstreams' latency (crt.sh 22 to 26 s) and caps (ip-api 45/min), and none returns category, rank, parked or a per-field source. What an agent usually wants for a domain, judging by these tool lists: is it real and how old, who runs its DNS/mail/hosting, is it safe, is it popular, what is it (category), what are its subdomains, and does its email setup pass.

## 6. The gap: ten things, ranked

Ranking rule: (a) evidence that no free keyless API answers it today, or only in text/HTML/ANSI or behind a tight cap; (b) it can be computed on a cron from open data and served as an indexed lookup (so no per-caller limit and near-zero marginal cost); (c) how often an agent needs it. Cost lines are estimates derived from the sizes above, not measurements. "Runner" means a job outside the Workers request path (the project forbids Containers, Sandboxes and Durable Objects on a request path or as the clock).

Summary table:

| Rank | Answer | Main data source | Index size / cadence (estimate) | Why nobody has it free |
| --- | --- | --- | --- | --- |
| 1 | category verdict with per-source attribution and consensus | UT1, BlockList Project, OISD, DoH filters | tens of MB, daily | only files; the keyless API found is dark; 2.7% three-way agreement |
| 2 | one dossier with per-field provenance and timing | the POC legs plus items 1, 3, 5 | edge cache | joins exist only partially, slow (5.5 s) or capped (10/day) |
| 3 | popularity from several lists plus the long tail | Tranco, Majestic, Umbrella, CrUX, Common Crawl ranks | a few hundred MB, daily/quarterly | Tranco API is combined-only at 1/s; others keyed or raw files |
| 4 | bulk lookup and a compact downloadable index | items 1, 3, 5 | one versioned file | bulk is Pro/Enterprise everywhere; only bare name lists are free |
| 5 | domain age and first-seen incl. 233 non-RDAP TLDs | RDAP, zone files, CT, Wayback, Common Crawl | cached lookups; daily zone diffs | rdap.org 404 and all-null whois for .de/.io/.jp |
| 6 | new and dropped domains per day as JSON | Zonestream, zone diffs, open ccTLD lists | about 363k names/day on the stream | WebSocket/Kafka only; Pro tier elsewhere |
| 7 | parked / for-sale / dormant | NS patterns, A records, a bounded fetch | small | only paid or inside unrelated repos |
| 8 | subdomains from CT, indexed and cached | CT tiles, crt.sh, Cert Spotter, thc | heavy if full; sampled is cheap | crt.sh 22 to 26 s; 10/hour; 50-row caps; ANSI text |
| 9 | DNS history and reverse index (NS/MX/IP) | OpenINTEL Parquet | change log only; daily runner | keyed, Plus tier, 10/hour, or raw Parquet |
| 10 | domain to entity and the DNS-derived provider stack | Wikidata, DNS, fingerprint tables | small | nobody wraps Wikidata as REST; tech APIs keyed or stale |

### 1. A category verdict with per-source attribution and a consensus score

- Answers: `{adult: {verdict, sources: [{id, listed, as_of}], consensus 0..1}, malware: ..., phishing: ..., gambling: ...}` and a plain "blocked by" list from live filter DoH (Cloudflare family and security, AdGuard family, plus the 19 resolvers in the POC).
- Sources: UT1 (75 categories, 5,219,095 distinct domains, 26.5 MB), BlockList Project porn (953,393), OISD nsfw (477,904), StevenBlack porn, OpenPhish and Phishing Army for phishing, the DoH filters as a live cross-check, Wikidata for the entity (item 10).
- Cost: about 60 MB of pulls per day; a sorted/hashed index of about 5 M adult plus 0.5 M malware/phishing names is tens of MB; stored in R2/KV; a daily cron. Per lookup: one KV read plus up to three DoH calls at 0.07 to 0.5 s.
- Evidence nobody offers it: the only keyless category API found is dark (NXDOMAIN, M); Radar needs a token (M 400 code 9106); WhoisXML category is paid; the free data are files, and they disagree (138,725 of 5,101,669 in all three, M). The disagreement is itself the value: a single boolean would hide it.

### 2. One JSON dossier with per-field provenance and timing

- Answers: rdap + dns + mail posture + cert/CT + rank + category + ASN/host + age, each field carrying `{source, observed_at, ms}` and an error object instead of a silent null.
- Sources: the POC's routes plus items 1, 3 and 5.
- Cost: live legs are cheap (DoH 0.07 to 0.5 s, RDAP 0.4 s); cache per domain at the edge.
- Evidence: issued.live joins registration, cert, IP only; dnsai joins DNS/mail but at 5.5 s and 10/day; DC5 is MCP text; dnsbin is prose; none carries rank, category or per-field provenance. Individual legs are commodity, the join and the provenance are not.

### 3. Popularity from several lists in one call, with the long tail

- Answers: `{tranco: {rank, history[36]}, majestic: {rank, ref_subnets, ref_ips, prev}, umbrella: {rank}, crux: {bucket: 1k|10k|100k|1M}, cc_domain_rank: {rank, of: 135.0M}}`, plus `popularity_class` for domains in none of the top million.
- Sources: Tranco API or list (9.7 MB), Majestic (80.4 MB), Umbrella (12.9 MB), CrUX (8.8 MB), Common Crawl domain ranks (2.5 GB gz, stream and keep top 10 M).
- Cost: about 110 MB per day plus 2.5 GB per quarter on a runner; the index is a few hundred MB; reads are KV.
- Evidence: Tranco's keyless API returns only the combined rank and is capped at 1 query/second (R, M); Majestic and Radar APIs are keyed; CrUX needs BigQuery; Common Crawl ranks are a 2.5 GB file; nobody exposes per-list rank or the 135 M-domain long tail.

### 4. Bulk lookup and a downloadable compact index

- Answers: `POST /bulk` with up to a few hundred domains returning rank, category bits, age, DNS summary; and `GET /index/latest` as one versioned file (sorted keys, bit flags, rank) a client can use offline.
- Sources: items 1, 3, 5.
- Cost: R2 holds the file; egress is the operator's choice of host; the bulk endpoint is KV reads.
- Evidence: Tranco is single-domain at 1/s (R); dotsweep batches 10 availability checks; issued.live batch is Pro $199/month; dnsai bulk is Enterprise; WhoisXML bulk is paid (R). domains-project is the only huge file (1.77 B names, git LFS, no attributes, cumulative not live). No joined small index exists.

### 5. Domain age and first-seen, triangulated, including TLDs without RDAP

- Answers: `{registered, basis: rdap|zone|whois|ct|wayback, confidence, first_seen: {zone, cert, wayback, commoncrawl}}`.
- Sources: RDAP for 1,204 TLDs; for the 233 without, open zone data (.se .nu .ch .li .ee via AXFR, .fr open data, .sk list with expiry dates (M), OpenINTEL zone Parquet for delegation first-seen), WHOIS over port 43 where a Worker can `connect()` (platform behaviour not measured here), CT first certificate, Wayback CDX first capture (M 1.47 s), Common Crawl first capture.
- Cost: lookups cached; zone-derived first-seen needs a daily diff on a runner (.ch 2.7 GB/day, .se 2.5 GB/day in Parquet; Range reads work, M).
- Evidence: rdap.org 404 for .de/.io/.co.jp (M); networkcalc all-null for denic.de (M); issued.live `registered: null` for .de and its `first_cert_seen` is the start of its own observation, not truth (M); free domain-age checkers such as ToolsPivot use RDAP plus Wayback only (R https://toolspivot.com/pt/domain-age-checker).

### 6. Newly registered and dropped domains per day, as plain JSON

- Answers: `GET /new?date=2026-10-27&tld=se` NDJSON with `{domain, first_seen_basis: zone|ct, ...}`; for open-zone ccTLDs a true registry delta (adds and drops); for all TLDs, CT first-cert as a proxy, labelled as such.
- Sources: OpenINTEL Zonestream (keyless WebSocket, 84 msg/20 s, M), OpenINTEL `zone_diff` for 12 ccTLDs, daily diffs of the open zone files, WhoisDS free lists (R).
- Cost: low for the data, but the stream needs a persistent consumer (runner or VPS), not a Worker. About 363,000 names/day at the measured rate.
- Evidence: Zonestream is WebSocket/Kafka only, FQDNs with trailing dots, CT-derived; WhoisDS is zip files (R); issued.live's newly-registered feed is the Pro tier at $199/month (R); CZDS needs accounts and approvals.

### 7. Parked, for-sale and dormant verdict

- Answers: `{parked: true|false|unknown, basis: ns-pattern|a-record|page, provider}`; also "registered but no delegation", "redirect-only".
- Sources: NS patterns (Sedo, ParkingCrew, Bodis, ...) from zone data and OpenINTEL, the A record against known parking addresses, a bounded fetch of the landing page through our own `fetch`.
- Cost: low; the NS-pattern leg is an index lookup.
- Evidence: only paid APIs mention it (WhoisXML categorization "live, parked or unreachable"; CompleteDNS history) (R); open-source work exists as papers and one parking scanner in an unrelated repo (R). No free keyless API found.

### 8. Subdomains from CT, indexed and cached, without crt.sh's latency

- Answers: `GET /subdomains/<d>` paginated, each name with `first_seen`, `last_seen`, `via`.
- Sources: CT static tiles (59 tiled logs listed in the Chrome log list, states not filtered, M), crt.sh and Cert Spotter as read-through fallbacks, ip.thc.org as a cross-source (4,294 subdomains for github.com, M), OpenINTEL `newly_registered_fqdn`.
- Cost: **full CT ingest is heavy**: issued.live reports 390,270,535 entries per 24 h (M), about 1.5 M tile fetches per day at 256 entries per tile (estimate). Sampling by Tranco top-N plus on-demand read-through with permanent cache is the cheap path.
- Evidence: crt.sh 22.6 s and 24.6 to 25.6 s under three parallel queries (M); Cert Spotter 10 queries/hour (M header); hackertarget 51 rows cap (M); Robtex 10/hour (R); thc is ANSI text on a 0.5/s bucket (M); Netlas anonymous cap hit within about 9 calls (M).

### 9. DNS history and reverse index (domains on this NS, MX or IP) from open measurements

- Answers: `GET /dns-history/<d>` (what NS/MX/A/TXT on which dates, changes only) for the Tranco/CrUX top lists and every .se .ch .fr .nu .sk .ee .li domain; `GET /reverse/ns/<host>`, `/reverse/mx/<host>`, `/reverse/ip/<ip>` over the same population.
- Sources: OpenINTEL Parquet (Tranco day 451.6 MB; .se 2.5 GB, .fr 4.1 GB, .ch 2.7 GB per day, M), with `country`, `as`, `ip_prefix` already attached (R dictionary).
- Cost: ETL on a runner reading Parquet with Range requests (M 206); store the change log only.
- Evidence: reverse IP is keyed at ViewDNS (M 401), Plus-tier at issued.live (M 401), 10/hour at Robtex (R), 7 rows at hackertarget for 140.82.112.3 (M); InternetDB returns 2 hostnames for 8.8.8.8 where thc lists 13,321 (M); history is SecurityTrails at 50 calls/month (R) or raw Parquet. Honest limit: no .com/.net/.org zone data in the open set, so reverse coverage is top lists plus seven ccTLDs.

### 10. Domain to entity (Wikidata) and the DNS-derived provider stack

- Answers: `{entity: {qid, label, description, inception, hq, instance_of}}` for the 2,470,124 Wikidata items that have an official website; and `{dns: ..., mail: ..., hosting: ..., saas: [...]}` from NS, MX, CNAME and TXT verification tokens (the Netlas sample shows `shopify-verification-code`, `stripe-verification` in `txt`, M).
- Sources: Wikidata SPARQL or a periodic dump slice (M 1.82 s), DNS from the POC, fingerprint tables from `wappalyzergo` (MIT label) or `webappanalyzer` (GPL-3.0 label).
- Cost: low; Wikidata slice is a small index.
- Evidence: nobody wraps domain-to-Wikidata-entity as REST; DNSai has "Technology Listed In DNS" but 10/day and 5.5 s (M); BuiltWith and Wappalyzer are keyed (M 200-with-error, 403); BeaverCheck serves a 170-day-old scan (M); web-check is bot-walled (M 429).

### What looked like a gap and is not

- Single-domain rank: Tranco is keyless, 0.40 s, CORS `*` (M).
- IP to ports/CVEs: Shodan InternetDB is keyless, 0.48 s (M).
- TLS grade: SSL Labs v3 from cache and Mozilla Observatory v2 are keyless (M), although Observatory failed once with a 503.
- HSTS preload status: keyless (M).
- Domain availability with price: dotsweep (R plus M llms.txt).
- A single RDAP record for a TLD with RDAP: Verisign and rdap.org are fast (0.36 s, 0.98 s).
- Email posture for one domain at low volume: DNSai and DC5 (but rate limited / MCP only).

## 7. Cautions that change the plan

- Zonestream is a persistent connection; the project's rules put the clock on a cron, so item 6 needs either a runner outside Workers or the weekly ccTLD-names lists and zone-file diffs instead of the stream.
- OpenINTEL's open set carries a label of CC BY-NC-SA 4.0; the operator decides what that means for a public index. Not analysed here.
- Spamhaus DBL and SURBL cannot be asked over a public DoH (R, M): a real verdict needs an attributable resolver or a DQS key. Do not report "clean" for a refused query; the POC's rule 11 (never report a capability a path did not use) applies directly.
- The filter-DoH signals are block semantics, not categories: Cloudflare family means adult or malware; the response alone does not say which.
- Several keyless services are fragile: Observatory 503, ThreatMiner 522, BufferOver gone, Anubis behind a challenge, sitecategory dark, domainsdb now requires a key (M `domainsdb`: HTTP 401 "Anonymous access is disabled", where it was keyless before), OpenPageRank moved to a new key regime, Censys legacy search shut on 2026-09-30. A dossier must treat every upstream as optional and say so per field.

## 8. Not measured

- AXFR and Postgres (port blocked in this sandbox); .fr AFNIC file (its link changes each time); CZDS (needs an account, none made); ipinfo free quota; networkcalc quota; who.is and whois.com; DMARC checker sites; Quad9 and CleanBrowsing and OpenDNS DoH with the right wire format; SURBL on a genuinely listed domain; crt.sh's flakiness over time (one sample day, four calls); the rate limits of rdap.org, Tranco beyond 1/s, urlscan beyond the header, Cloudflare DoH; how the BP set de-duplicates against its header count.

## Appendix A. Probe log (selected; all on 2026-10-27 UTC)

Helper: `m.sh <name> <url> [curl args]` writes `out\<name>.body` and `.hdr`; Tranco and others were plain GETs.

| Probe | URL (abbreviated) | Result |
| --- | --- | --- |
| `tranco_gh` | `tranco-list.eu/api/ranks/domain/github.com` | 200, 0.40 s, 36 `{date,rank}`; ACAO `*` |
| `internetdb` | `internetdb.shodan.io/8.8.8.8` | 200, 0.48 s, `{"cpes":[],"hostnames":["dns.google","direct.suntory.co.jp"],"ip":"8.8.8.8","ports":[53,443],"tags":[],"vulns":[]}` |
| `domainsdb` | `api.domainsdb.info/v1/domains/search?domain=github&zone=com` | 401 `Anonymous access is disabled` |
| `hstspreload` | `hstspreload.org/api/v2/status?domain=github.com` | 200, 1.39 s, `{"name":"github.com","status":"preloaded","bulk":true,...}` |
| `hackertarget` | `api.hackertarget.com/hostsearch/?q=github.com` | 200, 1.27 s, 51 rows; `X-API-Quota: 21` |
| `rdaporg` | `rdap.org/domain/github.com` | 302 to `rdap.verisign.com/com/v1/domain/github.com`; 200 after follow, 0.98 s |
| `crtsh` | `crt.sh/?q=github.com&output=json` | 200, **22.6 s**, 416,896 B |
| `crt1..3` | `crt.sh/?q=%25.pkgforge.dev`, `%25.wikipedia.org`, `%25.example.com&exclude=expired` | 200 each, 25.6 s, 24.8 s, 24.6 s |
| `observatory2` | `POST observatory-api.mdn.mozilla.net/api/v2/scan?host=github.com` | first try 503; retry 200, 3.06 s, grade A+ score 115 |
| `ssl_v3_an` | `api.ssllabs.com/api/v3/analyze?host=github.com&fromCache=on` | 200, 2.56 s, READY, grade A+ |
| `certspotter` | `api.certspotter.com/v1/issuances?domain=github.com&include_subdomains=true&expand=dns_names` | 200, 1.92 s, 70 issuances, `X-Ratelimit-Limit: 10` |
| `urlscan` | `urlscan.io/api/v1/search/?q=domain:github.com&size=2` | 200, 0.82 s, `X-Rate-Limit-Limit: 30` (minute, ip-address) |
| `issued_gh` | `issued.live/github.com.json` | 200, 1.5 s, 381 B; `Cache-Control: public, max-age=60, s-maxage=300` |
| `issued_stats` | `issued.live/api/stats` | `domains: 495,772,690`, `entries_24h: 390,270,535` |
| `iss_denic.de` | `issued.live/denic.de.json` | `registered: null`, `first_cert_seen: 2026-09-07` |
| `rdap_denic.de` | `rdap.org/domain/denic.de` | 404 `No RDAP service is available for this resource` |
| `sc_session` | `api.sitecategory.com/api/session` | curl 6, host does not resolve; Google DoH Status 3 |
| `netlas` / `nl_5` | `app.netlas.io/api/domains/?q=domain:github.com` | 200 keyless; later 429 `daily_request_limit_exceeded` |
| `dnsai_es` | `api.dnsai.com/v1/email-security/github.com` | 200, 5.47 s, 14,369 B |
| `thc` | `ip.thc.org/8.8.8.8` | 200, 0.81 s, "Entries: 100/13321", bucket 249 at 0.50/s |
| `doh_cat.sh` | family.cloudflare-dns.com vs cloudflare-dns.com | `0.0.0.0` vs `66.254.114.41` for pornhub.com |
| `doh_dbl` | `cloudflare-dns.com/dns-query?name=dbltest.com.dbl.spamhaus.org` | 127.255.255.254 |
| `oi_s3_*`, `s3sum.py` | `object.openintel.nl/openintel-public?list-type=2&prefix=...` | listings and sizes in section 3 |
| `oi_range` | Range `-8` on a Parquet object | 206, `Content-Range: bytes 49771491-49771498/49771499`, bytes `PAR1` |
| `ws.mjs` | `wss://zonestream.openintel.nl/ws/newly_registered_domain` | open in 1.5 s; 84 messages in 20 s; sample `{"domain":"kooigoed.com.","cert_index":167897527,"ct_name":"Google Argon2027h1","timestamp":1793066730,...}` |
| `wikidata`, `wd_count` | `query.wikidata.org/sparql` | 1.82 s entity for github.com; count 2,470,124 |
| `dp_stats` | raw `tb0hdan/domains/master/STATS.md` | `Total domains in dataset: 1,766,025,618` |
| `sk_domains` | `sk-nic.sk/subory/domains.txt` | 47,797,077 B; 493,544 data rows; generated 26.10.2026 |
| UT1, BP, OISD | see section 3 | counts and overlaps in section 4 |

Scripts kept in `...\landscape\`: `m.sh` (measure), `r.sh` (read via our service), `s.sh` (search via our service), `doh_cat.sh`, `s3sum.py` (OpenINTEL partition sizing), `ws.mjs` (WebSocket sampler), `axfr_probe.py` (failed: socket blocked).
