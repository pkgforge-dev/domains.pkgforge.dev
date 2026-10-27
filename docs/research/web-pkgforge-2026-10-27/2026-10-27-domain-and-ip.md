> web.pkgforge.dev@40c120cb5d6b2cf4080baedd4de773cdca325fef docs/research/2026-10-27-domain-and-ip.md
> The source repository is private: no reader of this project can open it, and this copy is the record.
> This copy is the working tree of that repository on 2026-10-27, which holds 8 lines that HEAD does not: the paragraph in section 7 that begins "The CT names index and the newly registered domains moved to a project of their own".

# The domain and ip services: sources and design, measured 2026-10-27

For the operator, who asked on 2026-10-27 for two public services: first
`domain.web.pkgforge.dev`, answering a domain's category (NSFW above all),
TLS, DNS, registration and the caller's own `whoami`, so that the wifi
dashboard (the operator's wifi dashboard project, a separate repository) can drop its own category
lists and use ours; then, the same day, `ip.web.pkgforge.dev`, with the old
`ip.pkgforge.dev` and `ip.ajam.dev` rebound to it ("do not care about
breaking legacy clients"), a proper IP reputation lookup ("almost all
alternatives are ad-riddled paid ones"), and answers that stay true behind
several uplinks. He also asked whether ip.thc.org and certstream run servers
for data Cloudflare already gives away.

Twelve research agents (Sonnet 5.5) measured the sources; the lead read the
wifi project, wrote and deployed the proof of concept `poc/domain/` on
`test-domain.web.pkgforge.dev`, drove it from the edge, and wrote this
synthesis. Each agent's full report is in
`docs/research/2026-10-27-domain-and-ip/` (one file each, kept as returned),
with the shared corpus (`corpus/`), the PoC's edge answers (`edge/`) and the
agents' scripts (`instruments/`). The entries that build both services are
`TODO/domain.md` and `TODO/ip.md`.

## 0. What this report did not establish

Read before the recommendations.

- **No measurement on the wifi project's own traffic.** Its domain list is in
  its D1, which this project does not read. Coverage is measured on a shared
  corpus: 200 Tranco domains (50 in each of four rank strata) and 150
  labelled domains from public lists (40 adult from v2fly `category-porn`, 40
  gambling and 30 malware from BlockList Project, 40 phishing from
  OpenPhish). The labels are list entries, not ground truth; a source's recall
  on them is its overlap with those lists. 25% of the adult and 43% of the
  malware labels no longer resolve.
- **One machine, one day, one colo.** Edge numbers are from colo KTM; local
  numbers from the operator's Windows machine, which sits on a four-WAN LAN
  whose egress changes per connection (§13). Latencies are orders of
  magnitude, not service levels.
- **Cloudflare Intel was measured through the `cf` CLI** (about 1.1 s of
  start-up a call), never from a Worker. Its documented quota (100 calls a
  month on Free) is enforced: after about 150 research calls the account
  answered every Intel call with 403 `[10403] intel.api_domain_limit
  exceeded` (the reputation agent at 03:36Z, the lead at 04:07Z). The
  research spent this account's Intel quota for the period; when it resets
  is not known.
- **No category or reputation source was checked against a human judgement.**
  Where sources disagree, nothing here says which is right.
- **The agents' numbers are their own** unless a section says the lead re-ran
  them; each carries its command in its report.
- **Undocumented signals.** Cloudflare's EDE 16 and 17 on 1.1.1.2 and 1.1.1.3,
  AdGuard's block-page addresses, RethinkDNS's list API and the token-chain
  idea rest on measurement, not on a published contract.
- **Not measured, and decisive for one entry each**: whether Cloudflare's
  GraphQL DNS analytics expose each query's source address on our zone (the
  route to resolver identification without our own server, §14); whether our
  zone accepts proxied records with `ipv4_only` / `ipv6_only` (single-family
  hostnames, §13); Workers CPU per route of either service.
- **Assume more remain.** First readings corrected the same day: the PoC's
  WHOIS referral (IANA answers `whois:` for a TLD, not `refer:`); the "flaky"
  archive test, which was an agent killing every `workerd.exe` on the machine
  (§10); and one agent's advice to read `cf-connecting-ip`, which this zone
  strips (§10).

## 1. The answer in two minutes

| question | answer | evidence |
| --- | --- | --- |
| Is there a categorizer better than Radar? | Yes: Cloudflare Intel's domain bulk endpoint, up to about 1,150 names a call, categorising 82% of Tranco's 100k to 1M stratum and 96 to 100% of the rest. Radar's per-domain ranking names categories for the ordered top 100 only. | §4 |
| Is the NSFW trick real? | Yes, and it is one query: `family.cloudflare-dns.com` answers `0.0.0.0` with EDE 17 for adult and EDE 16 for a security threat; it agreed with Intel on 279 of 280 names. It never names gambling. | §4, §5 |
| What names gambling? | Lists: HaGeZi's gambling list (33 of 33 live labels), RethinkDNS's keyless list lookup (91%), Mullvad's family resolver (97%, but its public DoH is announced to end on 2026-11-02). Intel 24%; no Cloudflare resolver. | §5, §6 |
| What do the free lists give? | A union of about ten (UT1, HaGeZi, OISD, BlockList Project, Curlie, v2fly, phishing feeds): 8.79 M keys after canonicalising, 70 to 105 MB as hashed shards; 87 of 200 Tranco names get a category. Three adult lists agree on 2.7% of their union. | §6 |
| What does the wifi dashboard gain? | Today 8% of its asked domains get a Radar category and 44% of its top domains a list category; Intel gives 80 to 85% of the same kind of long-tail name, in the ids Radar already uses. | §3, §4 |
| Are thc and certstream redundant with Cloudflare? | No. Radar's CT API is aggregates only; nobody publishes CT names per domain or in bulk for free. THC taps certstream as its discovery feed for a daily batch (corrected in §7: the `pub.ajam.dev` dataset its older script names is retired and answers 404). | §7 |
| Can a Worker read a certificate chain? | Yes, two ways, from the edge: the repository's TLS 1.3 client, and a TLS 1.2 hello whose chain arrives in the clear with no cryptography (github.com in 347 ms; an expired chain reported where the 1.3 client refuses). Neither reaches a Cloudflare-fronted host. | §8 |
| WHOIS from a Worker? | Yes: `connect()` to port 43 works at the edge (`.com` 644 ms). 233 of 1,437 TLDs have no RDAP, `.de`, `.io`, `.jp` and `.ch` among them. | §8 |
| What do ip.pkgforge.dev and ip.ajam.dev serve? | Two old Workers on one codebase in this account: `request.cf` echoed in seven formats; about 7,000 real requests in 30 days against about 237,000 scanner probes; `ip.pkgforge.dev/json` is this project's own canonical fetch example. | §11 |
| Is "what is my IP" one answer? | No. On the operator's four-WAN LAN every fresh connection leaves by another uplink, each family on its own; eight popular services asked within 30 s gave four addresses. A `cf.tlsClientRandom` hash is a connection id; a signed token can join N probes with no store. | §13 |
| Where does IP reputation come from free? | From dated list files, not APIs: AbuseIPDB's 100%-confidence list mirrored keyless, StopForumSpam, ISC, ipsum, blocklist.de, CINS, Spamhaus DROP, Tor, and FFraud's 1.57 M (a superset, so agreement counts families); plus what an address is (cloud, VPN, relay, scanner): 4 MB of ranges, 22.5 MB with FFraud. Keyless per-address APIs exhaust on a shared Worker egress. | §12 |
| What is cheap? | Hashed name shards and IP range tables in R2, read through the Cache API (which stores on `*.web.pkgforge.dev`, measured), held by the isolate; live calls only for what nothing else knows; bulk routes for many names a call; `/cdn-cgi/trace` is served by Cloudflare's edge on our hosts without invoking the Worker. | §8, §10, §16 |
| What does nobody else give away? | A category or reputation verdict with every source named, a bulk lookup and a downloadable index, one dossier per domain or address with provenance per field, and a whoami that says which connection it describes. | §9, §16 |
## 2. Conditions

| | |
| --- | --- |
| date | 2026-10-27, 01:51Z to about 04:30Z |
| machine | the operator's Windows 11 machine, Node 26.7.0, on a LAN with four uplinks balanced per connection (§13) |
| edge | `web-test-domain` on `test-domain.web.pkgforge.dev`, colo KTM; versions `2dc334a1` (commit ca10ffb) and `2d148263` (commit cfa7d17) |
| Cloudflare | account `2a97c8f2…` on the Free plan with Workers Paid, through the operator's authenticated `cf` CLI 1.0.0-beta.20, read-only calls only (about 219 for Intel and Radar, 45 for CT, 55 for the ip hostnames, 21 for reputation), no 429 until the Intel quota ran out (§4) |
| corpus | `docs/research/2026-10-27-domain-and-ip/corpus/tranco-strata.csv` (Tranco list `GQ3QK`, seeded sample) and `docs/research/2026-10-27-domain-and-ip/corpus/labelled.csv`; built by the lead before any agent ran, so every source is scored on the same names |
| agents | twelve, Sonnet 5.5, read-only, each report a file in `docs/research/2026-10-27-domain-and-ip/`: Cloudflare's surfaces (`cf-intel.md`), filtering resolvers (`dns-filters.md`), open lists (`lists.md`), CT and THC (`ct.md`), live lookups from a Worker (`live.md`), the landscape (`landscape.md`), the old ip hostnames (`ip-pkgforge.md`), checkip and IP Security Analyzer (`checkip-analyzer.md`), preflight (`preflight.md`), addr.tools (`addrtools.md`), IP reputation (`reputation.md`), multi-WAN (`multiwan.md`). Seven returned their reports as text (the harness refused two writes; five were asked to); the lead saved them, the wording kept |

## 3. The wifi project's categorizer

Read at its commit `fe15357`, read-only; its paths are cited `wifi:<path>`.

| part | file | what it does |
| --- | --- | --- |
| the index | `wifi:packages/core/src/categories.ts` | per category, a sorted flat `Uint32Array` of hash pairs: FNV-1a 32 and MurmurHash3 x86 32 with seed `0x9747b28c`, of each listed domain. A host matches when it or a parent is in a set; a site's override of the nearest parent wins. Bytes: magic `WFCI`, a JSON header, the sets |
| the lists | `parseList`, `parseV2fly` | plain domains, hosts lines, `*.d`, `\|\|d^`, v2fly `domain:`, `full:` and `include:` with `@attr` filters; `regexp:` and `keyword:` are dropped |
| the build | `wifi:apps/dash/src/categories-build.ts` | a Workflow with one step per category, because the whole set peaked at 839 MiB in one process; the v2fly tarball pinned by commit |
| the pins | `wifi:scripts/categories/pin.mjs` | moves each GitHub list to its newest commit only after printing the diff; a move of more than half needs `--lurch-ok` |
| the outside facts | `wifi:apps/dash/src/domain-facts.ts`, `radar.ts`, `resolver.ts` | Radar `/ranking/domain/{d}` and 1.1.1.2 over DoH, 20 domains a 10-minute tick, raw answers kept in R2, asked again after 30 days |

Its own measurement (its WD-124, closed 2026-10-13), over one site's top 500
domains of 2026-10-05 to 10-11: Radar asked 274, **categorized 22 (8%)**,
ranked 250; the site's own index categorized 221 of 500 (44%); 1.1.1.2
blocked 5. Its outside sources are a popularity source and a malware flag;
its lists cover under half its traffic.

What it needs from this service: a category for a host or a parent, in one
taxonomy it can map its per-site categories onto, with the source that said
so; many names per call (its clock asks about 2,880 a day, its views
hundreds at once); or the index itself, to look up locally. Keeping its hash
pair lets its `categoriesOf` read our shards with a small change.

## 4. Cloudflare's own sources

Full report: `docs/research/2026-10-27-domain-and-ip/cf-intel.md`.

**Intel domain bulk** (`GET /accounts/{id}/intel/domain/bulk?domain=…`,
token permission Intel Read) answered 1,150 domains in one call in 7.4 s and
1,000 in 8.0 s; 1,500 failed with HTTP 431 at 27 KB of query string, so the
cap is URL length, about 20 KB (500 a call is comfortable). A single
`intel/domain` call took 2.7 to 7.5 s through the CLI. Answers are in request
order, one per input. The input is not normalised: `PORNHUB.COM`, a trailing
dot, a scheme or a port answer nothing, and an IDN must be punycode.

| group (n) | category or security risk |
| --- | --- |
| Tranco 1 to 1k (50) | 96% |
| Tranco 1k to 10k (50) | 98% |
| Tranco 10k to 100k (50) | 100% |
| Tranco 100k to 1M (50) | 82%; 86% on 1,500 more long-tail names |
| adult labels (40; 28 live) | right category 25 (62.5%); 24 of 28 live (86%) |
| gambling labels (40; 33 live) | 8 (20%); 30 have no answer at all |
| phishing labels (40) | 32 (80%), in `risk_type`, not `content_categories` |
| malware labels (30; 11 live) | 5 (17%) |

Subdomains inherit (`inherited_content_categories`): `gist.github.com` reads
Technology from github.com, `cdn.pornhub.com` Pornography; a host on a
private suffix (`x.pages.dev`, `x.github.io`) inherits from the hosting
domain unless Cloudflare categorised it. `resolution_history` covers the
last day or two, a "was it queried lately" signal.

**The taxonomy** is Cloudflare Gateway's: 34 parent and 131 child categories,
165 ids (`cf zero-trust gateway categories list`). Radar's ranking categories
use the same ids (wikipedia.org: 90 Education and 189 Reference in both). The
security children of parent 21 (Phishing 131, Malware 117, Command and
Control 80, Scam 191, ...) and the risks of parent 32 (New Domains 169, Newly
Seen 177, Parked 128) sit beside the content categories. A parent and a child
can share a name (Adult Themes 2 and 67): key on ids.

**Radar `/ranking/domain`** names categories for the ordered top 100 only:
of 11 domains asked, wikipedia.org alone. The weekly ranking bucket datasets
(`cf radar datasets get ranking_top_1000000`: 14.7 MB, 1,000,004 lines, 2.9 s)
replace per-domain Radar calls for popularity. Radar's data carries a stated
CC BY-NC 4.0 licence.

**1.1.1.2 and 1.1.1.3** carry Intel's binary verdicts: of 70 phishing and
malware labels, the 38 that 1.1.1.2 blocks are exactly the 38 Intel marks as
a security threat; of 40 adult labels, the 25 that 1.1.1.3 filters are
exactly Intel's 25 adult ones; over 280 adult, gambling and Tranco names the
two disagree once. Neither blocks gambling.

**Nothing per-domain** in Radar CT, bots, robots.txt, search or AI-crawler
data: they take no hostname. URL Scanner has a scan for 1 of 12 corpus
domains. Intel WHOIS is port-43 WHOIS that failed or was partial on 7 of 17
domains. Intel passive DNS is IP to domains in a 7-day window.

**Limits** (read from developers.cloudflare.com): 1,200 API requests in 5
minutes per user, shared with the operator's other projects (the wifi
dashboard's Radar client among them); 200 a second per IP; Intel's own
monthly quota of 100 calls on Free, Pro and Business and 2,500 on
Enterprise, counted per call, not per domain. The quota is enforced: about
150 Intel calls into the morning the account began answering 403
`[10403] intel.api_domain_limit exceeded` (measured 03:36Z and 04:07Z), so
a bulk call of 900 names is worth spending and a single lookup is not.

## 5. Filtering resolvers and the list lookup

Full report: `docs/research/2026-10-27-domain-and-ip/dns-filters.md` (14,700 DoH queries at
most 5 a second per provider, no 429).

**One query names the category.** `family.cloudflare-dns.com` answers
`0.0.0.0` with EDE 17 ("Filtered") for adult and EDE 16 ("Censored") for a
security threat: 35 and 38 of 350 domains, with no disagreement against the
1.1.1.1 / .2 / .3 comparison, the same codes 12 minutes later, and the same
codes from the edge PoC. Cloudflare does not document the codes. Others name
the category in the answer: OpenDNS FamilyShield's block page (146.112.61.106
adult, .107 malware, .108 phishing, .105 botnet, documented), AdGuard
family's (94.140.14.35 adult, .33 security, measured), CIRA family's EDE
text ("Adult Content / Malware / Phishing Blocked").

Recall on live labels (overlap with the lists, not accuracy):

| | adult (28 live) | phishing (37) | malware (11) | gambling (33) |
| --- | --- | --- | --- | --- |
| Cloudflare 1.1.1.3 | 85.7% | 81.1% | 27.3% | 0% |
| OpenDNS FamilyShield | 82.1% | | | 0% |
| CIRA family | 85.7% | 91.9% | 45.5% | 0% |
| AdGuard family | 78.6% | 35% | | 0% |
| Control D p1 | | 100% | | 0% |
| DNS4EU | | 94.6% | 90.9% | 100% (child) |
| Mullvad family | 53.6% | | | 97% |
| RethinkDNS lists 185, 3, 4 | | | | 90.9% |

Cloudflare 1.1.1.3 and OpenDNS FamilyShield together reach 27 of 28 adult.
On the 200 Tranco names, 1.1.1.2, CIRA and Control D p1 flag none; 1.1.1.3
flags 10, nine of them corroborated by two or more other adult signals;
AdGuard family flags 23, most of them ad-tech.

**RethinkDNS's list lookup** (`https://max.rethinkdns.com/dntolist?dn=<d>`,
keyless, 350 of 350 answered, median 239 ms) names every one of 197
community blocklists holding the name, with its group and packs: adult,
gambling, social media, malware, phishing, scams, crypto, dating, piracy.
Read list ids, not packs: the "adult" pack carries ad-tech from StevenBlack.
It runs on one sponsored host on Fly.io: a dependency to treat as optional.

**Out:** Mullvad's public DoH is announced to end on 2026-11-02; dns0.eu shut
in 2025-10; UltraDNS and Comodo have no DoH; NextDNS needs a profile; Control
D has no free per-category path beyond `p0` to `p3` and `family`; Spamhaus
DBL and SURBL refuse public resolvers (DBL answers 127.255.255.254, "query via
public resolver"), so a "clean" from them over DoH means nothing.

**From the edge** (`poc/domain`, 60 names, 20 resolvers each, KTM): every
resolver answered a Worker's `fetch()`; Cloudflare's own in 62 to 129 ms
median, the rest 182 to 665 ms, with a few 3 s timeouts on CleanBrowsing,
Control D and OpenDNS. Quad9 answered HTTP 505 to local workerd and 200 at
the edge; Mullvad dropped the connection locally and answered at the edge.

## 6. Open category lists and popularity datasets

Full report: `docs/research/2026-10-27-domain-and-ip/lists.md` (downloads
measured, quality sampled, the union built and benchmarked).

- **No single list is enough; the usable set is a union of about ten.** UT1
  (5.18 M names over 66 categories, daily tarball, stated licence CC BY-SA
  4.0), HaGeZi (2.94 M over 25 files, 41 commits in 60 days, GPL-3.0), OISD
  (`nsfw` 477,900, hourly), BlockList Project (4.91 M, but its lists last
  changed in July 2026), Curlie (1.97 M hosts in 16 topic roots, file dated
  2026-02-02), v2fly (39,721 names in all, `category-porn` 6,522, no gambling
  list), StevenBlack and Sinfonietta extensions, and the phishing feeds
  (Phishing Army 4-hourly, OpenPhish 12-hourly, PhishTank, Phishing.Database,
  CERT.pl).
- **Defects that set the build's rules**: 83% of UT1 `adult` sits under 294
  shared-host roots (3.63 M `blogspot.<cc>` variants of 63,789 blogs);
  Bon-Appetit's porn list holds `blogspot.com` (Tranco 94) and `b-cdn.net`;
  PhishTank lists `google.com`; BlockList Project's malware list is 35%
  NXDOMAIN and ad-tech-laden; ScamSniffer and MetaMask are 75 to 85% dead.
  URLhaus and ThreatFox now need an abuse.ch key; Spamhaus DBL and SURBL
  refuse public DoH.
- **The union's size**: 13.58 M keys as downloaded; 8.79 M after
  canonicalising `blogspot.<cc>` and dropping entries a listed parent covers
  (70 MB at 8 bytes a key, 105 MB at 12); 5.21 M without the mass-malware
  lists. 256 shards of about 412 KB, or 4,096 of 26 KB. A binary search over
  a shard measured 115 ns in Node (not workerd).
- **Coverage on the corpus**: 87 of 200 Tranco names get any category from
  the whole union (42 of the top 1k, 3 of 100k to 1M); the other 113 are
  infrastructure, news, government and corporate sites no list names.
  Non-circular coverage of live labels: adult 22 of 28 (BlockList Project
  alone 21), gambling 33 of 33 (HaGeZi, which holds about 95% of BlockList
  Project's), malware 4 of 11, phishing 37 of 37 only through aggregators
  that include OpenPhish (a feed not derived from it reaches 2 of 37).
- **The build rules it implies**: match an exact name first and a parent only
  for entries whose list means "this name and below"; match tenants of shared
  hosts (blogspot, tumblr, github.io, pages.dev, vercel.app) by their own
  name, never the host's; keep Tranco's top names out of adult, gambling,
  phishing and malware at build time; refresh phishing every 12 hours or
  faster and the rest daily; leave out BlockList Project's malware list and
  the Ultimate Hosts Blacklist.
- **Popularity**: Tranco is the composite baseline (1 M, daily, 9.7 MB);
  Umbrella is published (75% subdomains); CrUX gives rank buckets; Radar
  weekly buckets; Open PageRank 10 M names; Common Crawl's ranks 2.5 and 4.8
  GB. Wikidata's official-website property found an item for 10 of the 40
  popular names no list named.
- **Why the wifi dashboard's index looks limited**: it reads v2fly, which is
  small by design (0.5% of the names the adult lists hold) and has no
  gambling list; BlockList Project's lists, if those are its sources, last
  changed in July; and domain-level hashing of tenant-heavy lists either flags
  all of Blogspot or inflates the set 3.5 times.

## 7. CT, certstream and ip.thc.org

Full report: `docs/research/2026-10-27-domain-and-ip/ct.md`.

The CT names index and the newly registered domains moved to a project of
their own on 2026-10-27 (`TODO/RULES.md` §5): `pkgforge-dev/domains.pkgforge.dev`. Its own research there
corrects parts of this section. OpenINTEL's newly-registered topic carries
about 422,000 messages a day by its Kafka offsets (the WebSocket sample in
`landscape.md` gave about 363,000), and its Kafka broker answers
without credentials on port 9092. `cs2.ip.thc.org` now serves `.txt.gz`.
Not every IPng or GoDaddy log serves names tiles.

**The operator's question, answered.** Cloudflare does not give this away.
Radar's Certificate Transparency API has seven endpoints, and none takes a
domain: CA shares, log lists and counts (34.1 M unique certificates and 222.8
M log entries on 2026-10-26), nothing per name. `ct.cloudflare.com` and
Merkle Town redirect to Radar. Cloudflare's own logs are Nimbus (RFC 6962,
readable) and the Raio static logs built on Azul, which Radar lists as
rejected and whose checkpoint redirects. Intel's passive DNS is IP to names
in a 7-day window. So THC's tap is not redundant with Cloudflare.

**Why THC taps certstream 24x7**: its pipeline is a daily batch (the dump is
cut at 00:05 UTC, imported two days later at 04:01 UTC, names resolved with
massdns for a handful of TLDs only), so the tap is not for real-time
freshness. CT logs can only be read in order, and nobody publishes the names
in bulk for free; the tap is THC's discovery feed. Its
`certstream-server-go` is byte-identical to the upstream it forks. Its first
stage downloads `pub.ajam.dev/datasets/certstream/Temp/<date>.7z`, the
operator's own dataset, and the operator's archived
`pkgforge-security/CertStream-Domains` says THC "stepped up to overtake &
expand the data".

**Correction, measured 2026-10-27T04:44Z.** The `pub.ajam.dev` line is in
THC's older script (`sstable-migrator`,
`utils/daily_upload_download/certstream_download/daily_certstream_download.sh:34`,
added 2024-07-21); the URL now answers a 301 to the operator's Hugging Face
dataset `Azathothas/temp`, where the path answers 404, so that stage fails
today. THC's current script (`daily_subdomain_upload.sh:15,17`, 2025-03)
downloads THC's own daily dumps from `cs1.ip.thc.org` and `cs2.ip.thc.org`,
which its certstream-server-go fork writes by polling every CT log
continuously (`GetSTH`, then batches of 256 from the last index). The
operator's service is retired and feeds nothing. CT logs push nothing: a
"certstream" is a poller of every log re-broadcast as a WebSocket, and a
log keeps every entry for its shard's life, so a reader can also catch up
from its last index on a schedule; what the continuous poll buys is
freshness in seconds and a steady request rate under the logs' limits.

**What THC serves** (keyless, CORS `*`, 250-token bucket refilled at 0.5 a
second per address, `no-store`): reverse IP (`POST /api/v1/lookup`: 92,770
names on 1.1.1.1), subdomains (`/lookup/subdomains`: 4,294 for github.com, a
`last_seen_on` per name, updated daily), CNAME targets, and CSV downloads of
up to 50,000 rows; no certificate fields; IPv6 answers nothing. Bulk: a
monthly reverse-DNS dump (6.36 B records, 53.2 GB gzipped Parquet, not
range-readable) and daily CT name dumps (one sorted name list a day, 77 to
986 MB, 56 days kept). It filters cloud-provider spaces out: for github.com
it lacks 51 names crt.sh has, while holding 4,293 crt.sh does not.

**Certificates by name**: crt.sh answered 19 of 22 calls from the machine
(warm 1.2 to 18 s, a name's first call 85 to 108 s) and 502 twice to the edge
PoC; its public PostgreSQL accepted `guest` but refused 27 of 30 connections
at its pooler. Cert Spotter is keyless at 10 or 100 calls an hour per address
(two networks read two limits), unexpired issuances only. Google's CT search
is gone, Censys's free search closed on 2026-09-30, Merklemap and VirusTotal
need keys.

**Tailing CT ourselves**: 206 M entries a day across 82 logs (2,387 a
second); reading every entry is about 510 GB a day, a VPS's work. The Sunlight
"names tiles" of Let's Encrypt, Geomys and IPng (about 25 bytes an entry, no
issuer or dates) are about 55 M entries and 1.4 GB a day, within a one-minute
cron Worker's limits, but one log family is partial coverage (two Let's
Encrypt shards overlapped 74% in a 43 s window).

## 8. Live lookups from a Worker, measured at the edge

Full report: `docs/research/2026-10-27-domain-and-ip/live.md`. The proof of concept
`poc/domain/` (README there) answers one question: what each live source
says of a domain, and how long it takes, asked from a Worker. Driven from
KTM on 2026-10-27 at 02:50Z:

| domain | DNS, 13 queries | RDAP | WHOIS port 43 | TLS 1.3 client | TLS 1.2 hello | Tranco |
| --- | --- | --- | --- | --- | --- | --- |
| github.com | 142 ms | 1,182 ms | 644 ms, Verisign | 351 ms, verified | 347 ms (connect 250), verified | 1,329 ms, rank 29 |
| wikipedia.org | 854 ms | 1,809 ms | 1,460 ms, PIR | 972 ms, verified | 1,041 ms, verified | 896 ms, rank 30 |
| example.com | 51 ms | 1,404 ms | 565 ms, Verisign | refused by the platform in 8 ms | refused in 9 ms | 382 ms, rank 172 |
| pkgforge.dev | 43 ms, DNSSEC AD | HTTP 429 (Google Registry), then 312 ms | none: `.dev` has no WHOIS | refused in 55 ms | refused in 208 ms | 959 ms, unranked |

- **DNS** over `cloudflare-dns.com` JSON is fast from a Worker (43 to 142 ms
  for 13 parallel queries, one cold 854 ms). The agent measured 22 to 50 ms
  warm and 346 to 827 ms cold for 13 queries from the machine. A full mail
  posture with DKIM selector guessing is 54 subrequests, over the Free plan's
  50; DKIM stays opt-in.
- **RDAP**: IANA's bootstrap (71 KB) names a server for 1,204 of 1,437 TLDs
  and 73 of 248 ccTLDs. `.de`, `.jp`, `.io`, `.ch`, `.se`, `.it`, `.es`,
  `.eu`, `.us`, `.me`, `.nz` are missing, yet `rdap.denic.de`, `rdap.nic.ch`
  and `rdap.nic.us` answer. Google Registry answered 429 to 13 of 30 burst
  requests from the machine and once to the edge. `.com` is thin: the
  registrar's RDAP is a second hop.
- **WHOIS on port 43 works from the edge** over `connect()`: IANA's server
  names the TLD's server (`whois:` for a TLD), which answers in 0.5 to 1.5 s.
  DENIC answers 31 bytes to a bare name (it wants `-T dn,ace <name>`); `.ch`
  answers a short refusal. This is the route for the 233 TLDs with no RDAP.
- **TLS, the new route**: a ClientHello offering TLS 1.2 alone draws the
  server's Certificate in the clear, so the chain is read and the socket
  closed before any key is agreed (`poc/domain/src/hello12.ts`). It reads
  TLS 1.2-only servers and invalid chains the TLS 1.3 client refuses
  (`expired.badssl.com`: "chain[0] expired at 2015-04-12"), and reports ALPN
  and an OCSP staple. The agent's Node prototype read 49 of 49 popular hosts
  this way. Its verdict is the chain's alone: no handshake completes, so
  nothing proves the server holds the key.
- **The repository's TLS 1.3 client** (`packages/egress/src/tls13/client.ts`)
  gives the chain, suite, group and certificate compression, but throws on an
  invalid chain; the PoC wraps the verifier to keep its report anyway. It
  offers no TLS 1.2 and no HelloRetryRequest.
- **Cloudflare-fronted hosts** (about one in five popular sites) are refused
  by `connect()` at the edge in under 60 ms (traps P-6, P-36). web-fetch
  reaches them through web-road's VPC binding, and only web-fetch may bind
  web-road (`scripts/check-road-binding.mjs`). What a visitor sees there is
  Cloudflare's edge certificate for the name.
- **CT from the edge**: crt.sh answered 502 twice (github.com in 1.4 s,
  pkgforge.dev in 0.2 s); Cert Spotter answered github.com with 70
  issuances (58 names) in 2.1 s and pkgforge.dev with 100 (32 names) in
  1.8 s. Its keyless limit read `X-Ratelimit-Limit: 100` from one network and
  `10` from another: a per-IP hourly budget that every Worker's egress shares.
- **whoami**: `request.cf` gives ASN, organisation, country, city, region,
  coordinates, timezone, colo, HTTP protocol, TLS version and cipher, client
  RTT and the ClientHello's length, random and cipher and extension hashes on
  this plan; JA3 and JA4 need Enterprise Bot Management. **The caller's
  address is not in `cf-connecting-ip` on this zone** (§10): the PoC reads
  `x-real-ip`.
- **Other**: the Chromium HSTS preload list is 10.6 MB of JSON (95,542
  entries, about 472 KB as a compressed name list); the Public Suffix List is
  338 KB (36 KB compressed); `new URL()` converts an IDN to punycode in
  workerd but does not validate labels; SSL Labs v3 is deprecated and v4
  needs an email header, and an assessment takes minutes.

## 9. The landscape and the gap

Full report: `docs/research/2026-10-27-domain-and-ip/landscape.md` (about 80 services and
datasets probed).

- **The nearest service is issued.live**: keyless JSON, 1,000 requests a day
  per address, 495.8 M domains, registration, expiry, certificate and address.
  No category, popularity, mail posture or technology; reverse IP, batch and
  its newly-registered feed are paid ($99 to $199 a month).
- **Category is the open hole.** The one keyless category API found
  (sitecategory.com) does not resolve. The free lists disagree: of 5,101,669
  distinct adult domains in UT1, BlockList Project and OISD, 138,725 (2.7%)
  are in all three. Per-source attribution is the product.
- **Live probing is commodity and everyone caps it**: crt.sh 22 to 26 s per
  query from the machine; Cert Spotter 10 or 100 an hour; hackertarget 51
  rows; Robtex 10 an hour; DNSai 10 a day at 5.5 s.
- **Rarely exposed, keyless, Range-readable**: OpenINTEL's S3 holds daily
  full-zone DNS Parquet for `.se .fr .ch .nu .sk .ee .li` and daily DNS of
  the Tranco, CrUX, Majestic, Radar and Umbrella top lists (stated licence CC
  BY-NC-SA 4.0); its Zonestream WebSocket carries about 363,000 newly
  registered domains a day.
- **Agent-facing domain APIs** (dotsweep, issued.live, DNSai, DC5, dnsbin)
  cover DNS, WHOIS, availability and CT; none covers category, popularity or
  a source per field.

The ranked gap: (1) a category verdict with per-source attribution; (2) one
dossier with provenance and timing per field; (3) popularity across several
lists into the long tail; (4) a bulk lookup and a downloadable index; (5)
registration age for the 233 TLDs RDAP misses; (6) new domains a day as
JSON; (7) parked or for-sale; (8) CT subdomains without crt.sh's latency;
(9) DNS history and reverse NS, MX and IP from OpenINTEL; (10) domain to
entity through Wikidata (2,470,124 items carry an official website).

## 10. Found outside the question

- **The zone removes the visitor's address from every Worker.** The managed
  transform `remove_visitor_ip_headers` is on for `pkgforge.dev`
  (`cf managed-transforms list`), so no Worker here sees `cf-connecting-ip`;
  `x-real-ip` arrives. Consequences, read in the code: IP_CAP keys every
  caller by ASN and colo (`packages/core/src/gate.ts:322`, `capKey`'s
  fallback), the cost cap the same (`packages/core/src/cost-cap.ts:159`), and
  the dashboard's failed sign-in throttle keys every caller as `"unknown"`
  (`apps/dash/src/app.ts:90`). Filed as its own entry (`TODO/observability.md`).
- **The Cache API stores on `*.web.pkgforge.dev`.** A put and a match in one
  request answered `stored: true` (`/cachecheck`, KTM). Trap P-42 was
  measured before the zone's cache rule exempted these hosts; every service
  still caches in D1 (`search_cache`), which issue #84 counts among the
  per-request writes.
- **The research spent the project account's Cloudflare Intel quota** for
  the period: about 150 read calls, then every Intel call answered 403
  `[10403] intel.api_domain_limit exceeded` (03:36Z, 04:07Z). The
  operator's own Security Center Investigate draws on the same quota.
- **The archive tests did not flake.** The gate failed twice on
  `apps/archive/test/archive.spec.ts` ("Worker exited unexpectedly"). The
  live-lookups agent had run `taskkill /F /IM workerd.exe` twice, which ends
  every workerd on the machine, the test pool's and the operator's own
  `wrangler dev` sessions among them. The gate passed with no change once it
  stopped. That agent also started an SSL Labs assessment of pkgforge.dev
  (grade B).

## 11. ip.pkgforge.dev and ip.ajam.dev today

Full report: `docs/research/2026-10-27-domain-and-ip/ip-pkgforge.md`.

- **Two Workers, one codebase, this account.** `ip.pkgforge.dev` is
  `ip-api-pkgforge` (deployed once, 2024-11-25; repository
  `pkgforge-dev/ip.pkgforge.dev`, archived); `ip.ajam.dev` is `ip-api` (last
  deployed 2024-06-05; `Azathothas/ip.ajam.dev`). Both are Workers Custom
  Domains with one proxied `AAAA 100::` record each; the zones `pkgforge.dev`
  and `ajam.dev` are both in account `2a97c8f2…`.
- **What they answer**: the caller's address and `request.cf`'s city,
  country, region, coordinates, organisation and timezone, plus a flag, the
  user agent and a readme link, as `/` (bare address), `/json` (11 keys in a
  fixed order), `/text`, `/csv`, `/xml`, `/yaml` and `/html`; every other
  path answers the bare address with 200. Nothing is escaped; every route
  logs the address. The address comes from `x-real-ip`, which is right on
  this zone (§10).
- **Use in 30 days** (sample-weighted, zone analytics): about 6,020 hits on
  the documented routes of `ip.pkgforge.dev` (5,601 of them `/json`) and 960
  on `ip.ajam.dev`, against about 135,600 and 101,500 scanner probes caught
  by the catch-all.
- **This project depends on it**: `https://ip.pkgforge.dev/json` is fetch's
  canonical example (`apps/fetch/src/docs.ts`), `watch.yml`'s plain-HTTP
  canary and a `scripts/parity.mjs` target; the blog and two gists use it.
  `/json`'s keys and their order are kept. Once the name is ours, fetch's
  guard refuses it as a sibling (`packages/egress/src/guard.ts:133`), so
  those uses move to an echo outside the project first (WEB-165).
- **Port 80 answers 200 with no redirect** on both (Always Use HTTPS is off
  on both zones), and both zones carry a rate-limit rule (`pkgforge.dev`'s
  "200req/Second" matches the exact path `/` on every host of the zone).

## 12. IP reputation

Full report: `docs/research/2026-10-27-domain-and-ip/reputation.md` (about
40 list files measured, the union built, 37 well-known addresses audited).

- **Free, keyless, headless reputation is a set of list files, not an API.**
  Per-address keyless APIs are capped per caller address and a Worker's
  egress shares the cap: proxycheck answered "100 queries exhausted" from a
  Worker; GreyNoise allows 25 a rolling week; ipapi.is dropped its flags
  from the anonymous tier on 2026-09-01. StopForumSpam's API (100,000 a day,
  stated non-commercial), FFraud's, Shodan InternetDB and OTX answered from a
  Worker.
- **The lists that hold up**, each dated: AbuseIPDB's 100%-confidence list,
  mirrored keyless in 1-day to 365-day windows (`borestad/blocklist-abuseipdb`:
  45,932 for a day, 129,765 for 30); StopForumSpam (hourly, IPv6 as /64
  bases); ISC threatintel (labels with first and last seen); ipsum (with a
  count of the lists behind each address); blocklist.de (about 30-minute
  refresh); CINS; Spamhaus DROP (with SBL ids) and ASN-DROP; DShield; the
  Tor exit lists. None hit any of 37 well-known addresses.
- **FFraud** (`FFraud-com/ip-fraud-database`, stated MIT): 1,566,061 IPv4
  and 25,700 IPv6 "confirmed abusive", refreshed every 30 minutes, 99.2%
  kept after 14 days. It holds 97 to 99.8% of CINS, StopForumSpam 30-day,
  AbuseIPDB 30-day and the Tor exits, so agreement is counted by independent
  family, not by list; its "c2" label is corroborated for 2.3% of 627,486.
- **What to leave out**: Edgewatch (lists 1.1.1.1 and GitHub, never expires),
  bitwire (15.4% bogon), FireHOL level1 as a whole (holds the fullbogons),
  Feodo and SSLBL (empty or deprecated), Spamhaus over public DoH (refused).
  Cloudflare Intel's `ips` answered 403 `intel.api_domain_limit exceeded`.
- **What an address is matters as much**: cloud provider, region and service
  from AWS, GCP, Azure, Oracle, DigitalOcean and Linode; VPN (X4BNet, Mullvad);
  Apple Private Relay and Cloudflare's egress (shared, so never "bad" by
  address alone); crawlers, research scanners, public resolvers; bogons. That
  classification layer is 57,048 segments, 0.65 MiB.
- **Sizes**: the classification layer with nine reputation sources is 4.08
  MiB as 12-byte range segments; with FFraud 22.5 MiB (3.97 MiB gzipped).
- **The verdict**: what the address is (`kinds`), whether it is shared, each
  source's signal with its family, window and date, the sources checked that
  do not list it, the number of independent families, and a label from
  written rules: never a score. IPv6 reputation keyed on the /64.

## 13. One connection's view: multi-WAN

Full report: `docs/research/2026-10-27-domain-and-ip/multiwan.md`; the
preflight report shows the same from another angle.

- **The operator's LAN has four uplinks** (the wifi project's CG-NET,
  DishHome, VIA NET, WorldLink: AS141767, 139922, 45650, 17501), balanced
  per session, each behind carrier NAT, IPv6 through NAT66. 92 fresh
  connections per family to the PoC landed on all four (about a quarter
  each); 12 requests on one kept-alive connection stayed on one address.
  IPv4 and IPv6 are separate choices: the same instant gave AS141767 over
  IPv4 and AS17501 over IPv6, Hetauda and Butwāl. Eight popular whoami
  services asked within 30 s gave four addresses; `ip.pkgforge.dev` and
  `ip.ajam.dev` gave two different ones seconds apart.
- **Tools pick the family**: curl chose IPv6 in 9 of 10, PowerShell IPv4 in
  10 of 10, Chrome IPv6 over HTTP/2 and IPv4 over HTTP/3. Three popular
  services have no AAAA and can only show the IPv4 view.
- **What a Worker sees**: `cf.tlsClientRandom` is the same for every request
  on one connection and new on every connection, over HTTP/3 too: a
  connection id. `httpProtocol` names the transport; `clientTcpRtt` is 0
  over QUIC. All 13 Cloudflare ports answered the Worker; none pinned a WAN.
  Client `X-Real-IP` and `X-Forwarded-For` are overwritten, a client
  `CF-Connecting-IP` draws a 403, `Forwarded` and `X-Client-IP` arrive
  untouched (never read them).
- **What it cannot see**: the physical uplink, UDP other than QUIC, the DNS
  path (every UDP/53 whoami here returned one upstream address, likely
  interception), carrier NAT (only hints: a pool-style organisation name, a
  `dynamic` PTR, a changing address).
- **Single-family hostnames**: Cloudflare's DNS record API has
  `settings.ipv4_only` and `settings.ipv6_only` for proxied records (read);
  `ipv4.icanhazip.com` and `api4.ipify.org` work that way (measured).
  Whether our zone takes them, and whether a Custom Domain's record can, is
  not measured.
- **The design that follows**: every answer states it is one connection's
  view and names the connection, family and transport; family hostnames;
  fan-out probes with a stop rule (about 21 fresh connections find 4 equal
  uplinks with 99% probability); a signed token chain (HMAC, no store) that
  joins N probes into one verdict (`single-path`, `balanced(k)`,
  `family-split`, `unstable`); scripts a router or CI runs, with
  `curl --interface` to name an uplink.
- **For the wifi project**: a Cloudflare-fronted echo cannot be its exit
  echo (a tunnel-bound Worker reads a Cloudflare address), so it keeps its
  off-Cloudflare exit echoes; ours serves its LAN clients, tenants and CI.

## 14. What else the ip tools offer, and what needs our own DNS server

Full reports: `addrtools.md`, `checkip-analyzer.md`, `preflight.md` in
`docs/research/2026-10-27-domain-and-ip/`.

- **addr.tools** is one Go DNS server and nginx: 9 of its 21 capabilities can
  be served from a Worker alone (the echo in its formats, DNS to JSON, RDAP
  for names and addresses, forward-confirmed PTR, range labels, a DNSSEC check
  of the resolvers we ask), 7 need an authoritative DNS server of our own
  (resolver identification, DNS leak and EDNS/ECS tests, an ACME dns-01
  helper, dynamic DNS), 3 are browser-only, STUN is not worth it. Cloudflare
  DNS answers stored records only; a Worker sees only the HTTP request, never
  the caller's resolver: every DNS "whoami" asked over DoH from a Worker
  answers the Worker's or the DoH provider's address.
- **Three routes to resolver identification**: our own authoritative server
  on a VPS, delegated from `pkgforge.dev` as addr.tools does (a fixed cost
  and a new kind of machine); dnscheck.tools's public authoritative zone and
  WebSocket watcher, relayed (measured working; a dependency on one hobby
  host pair); or Cloudflare's GraphQL `dnsAnalyticsAdaptive` on our own zone,
  if it exposes each query's source address soon enough (read: per-query
  records on the Free plan, a source-IP dimension in the dashboard; not
  measured: the lead's `cf` CLI cannot send GraphQL, and no token with Zone
  Analytics Read was used).
- **checkip and IP Security Analyzer** look up only the caller with their own
  data; their worth is `request.cf` (the Analyzer reads about 14 of its
  fields; nobody reads the RTT, delivery-rate and ClientHello fields), the
  "native vs broadcast" rule (geo country against the ASN's registry
  country), and lessons: substring keyword matching flags "Victoria Telecom"
  as Tor and every "Ltd" as corporate; keyless per-address APIs share their
  quotas across Cloudflare's egress addresses, one of which carries 4,531
  AbuseIPDB reports.
- **preflight** is a client-side checkup; for a Worker: the full `request.cf`
  echo, StopForumSpam (keyless, 100,000 a day stated, works from a Worker,
  hourly bulk dumps), three-state fields where unknown is never "safe".
- **`/cdn-cgi/trace` is answered by Cloudflare's edge on our own hostnames**:
  `test-domain.web.pkgforge.dev/cdn-cgi/trace` returned `text/plain` with the
  caller's address, colo, location, TLS and HTTP version, and the PoC
  Worker never answered it (measured by the lead, 03:27Z). Whether it is
  billed is not verified; it is not a Worker invocation.

## 15. Any address's facts from imported datasets

From `checkip-analyzer.md` §4 and `addrtools.md`, sizes measured:

| data | source | size | refresh | stated licence |
| --- | --- | --- | --- | --- |
| ASN, prefix, organisation, country | iptoasn `ip2asn-combined.tsv.gz` | 9.0 MB gz | hourly | PDDL v1.0 |
| country (and city) | DB-IP Lite | country/city 60 MB gz, ASN 5.2 MB gz | monthly | CC BY 4.0 |
| registry country, ASN names | RIR delegated stats, RIPE `asn.txt` | 4.3 MB, 6.2 MB | daily | not read |
| cloud provider, service, region | AWS (2.7 MB), GCP (116 KB), DigitalOcean (53 KB), Fastly, GitHub meta, Cloudflare (505 B), Oracle | small | hours to days | not read |
| Tor exits, v4 and v6 | Tor Project bulk list (1,229), Onionoo (1,218 v4, 931 v6) | 17 KB, 333 KB | hourly | not read |
| VPN, datacenter | X4BNet `lists_vpn` (10,945 and 44,622 CIDRs) | 180 KB, 698 KB | daily | MIT (README) |
| iCloud Private Relay | `mask-api.icloud.com/egress-ip-ranges.csv` | 12 MB | hourly | not read |
| bogons | Team Cymru fullbogons | 48 KB | daily | not read |
| reverse IP names | ip.thc.org (live, 250-token bucket) | 92,770 names on 1.1.1.1 | daily | n/a |

44,622 datacenter CIDRs compile to 357 KB as sorted u32 pairs, a lookup
about 98 ns (Node). RDAP for an address goes through IANA's `ipv4.json`,
`ipv6.json` and `asn.json` bootstraps; PTR over DoH, forward-confirmed.

## 16. The design this supports

Both services share one package and one store, so neither hardcodes what the
other needs:

- **`packages/netfacts`**, to be created by WEB-141: names and addresses (normalise, IDN, Public
  Suffix List, IPv4 and IPv6 parse and classify), DoH in JSON and wire form
  with EDE and the typed block signals, RDAP for names, addresses and ASNs,
  WHOIS on port 43 with per-server query forms, the TLS 1.2 hello and the TLS
  1.3 inspector, and the answer envelope: every fact with `source`, `at`,
  `ms`, or `{source, error}`; three-state flags where unknown is never clean.
- **One index store**: an R2 bucket holding versioned **name shards** (hash
  pair, 4,096 shards, one entry per name and source, exact or wildcard) and
  **range tables** (sorted, per source, sharded by the address's first byte),
  each with a manifest of pinned sources; built by each service's own cron a
  step a tick; read through the Cache API and the isolate; downloadable.
- **Layers**, never a paid call on the request path: the index; stored facts
  filled in bulk by the clock (Cloudflare Intel for domains); live signals
  only for what nothing else knows (the DoH typed signals, RethinkDNS,
  StopForumSpam, PTR), each cached per colo.
- **Two Workers**: `web-domain` on `domain.web.pkgforge.dev`; `web-ip` on
  `ip.web.pkgforge.dev`, `ip.pkgforge.dev` and `ip.ajam.dev`. The domain
  card reads the address facts of its A and AAAA records from the range
  tables directly, through the same package and bucket, not a service
  binding.
- **Verdicts with sources, never a score**: every category and reputation
  flag names each source, its list and its date.

The entries: `TODO/domain.md` WEB-141 to WEB-156, `TODO/ip.md` WEB-158 to
WEB-164, the zone's address header WEB-157 (`TODO/observability.md`) and the
rebind of the two old hostnames WEB-165 (`TODO/migration.md`).

## 17. The claims least sure of

- Intel's coverage on the wifi dashboard's real long tail: measured on Tranco
  strata and list labels, not on its traffic (WEB-154 measures it).
- That the typed DoH signals stay as measured: none is documented but
  OpenDNS's.
- That RethinkDNS answers fast from Workers: 239 ms median from the machine,
  1.0 to 3.5 s from the edge PoC.
- The Cert Spotter keyless limit: two networks read 10 and 100 an hour.
- That the Cache API keeps answers across requests on these hosts: one put
  and match within one request answered `stored: true`; cross-request reuse
  was not measured.
- That a cross-zone Custom Domain rebind (`ip.ajam.dev`) behaves as the
  `pkgforge.dev` rebinds did.

## 18. Reproduce

- The edge: `curl -s https://test-domain.web.pkgforge.dev/<domain>`, its
  routes in `poc/domain/README.md`; the 60-name filter run is
  `docs/research/2026-10-27-domain-and-ip/edge/filters-edge.json`.
- The corpus: `docs/research/2026-10-27-domain-and-ip/corpus/` (Tranco list
  `GQ3QK`, seeded sample; the labelled set from v2fly, BlockList Project and
  OpenPhish as of 2026-10-27).
- Each agent's commands are at the end of its report; its scripts are in
  `docs/research/2026-10-27-domain-and-ip/instruments/<agent>/`, run with
  paths as arguments. Raw downloads stayed in the session's scratch directory and
  are not kept: every one is a public URL the report names.
- Cloudflare's own surfaces: the `cf` commands in `cf-intel.md` §9 (read-only,
  the operator's login).
