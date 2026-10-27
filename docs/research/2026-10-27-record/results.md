# Read-only measurements made while writing the record

Date: 2026-10-27, 08:21Z to 08:34Z. The commands are in the entries that use them. The three scripts in `scripts/` are the ones that ran.
Downloaded data was put in empty scratch directories and deleted. Nothing was written to any other repository, and no cloud resource was created.

## THC monthly database (DOM-010)

`HEAD` at 2026-10-27T08:21:52Z, `https://huggingface.co/buckets/IP-THC-ORG/Datasets/resolve/2026/10/rdns-sept.csv.gz?download=true`:
302 to a signed CDN URL, then `content-length: 37046639482`, `accept-ranges: bytes`, `Last-Modified: Fri, 02 Oct 2026 16:25:18 GMT`.

Bucket listing at 2026-10-27T08:25:12Z (`GET https://huggingface.co/api/buckets/IP-THC-ORG/Datasets/tree?recursive=true`):

| Path | Bytes |
| --- | --- |
| `2026/10/rdns-sept.csv.gz` | 37,046,639,482 |
| `2026/10/rdns-sept.parquet.gz` | 53,171,863,868 |
| `2026/9/rdns-aug.csv.gz` | 36,029,717,282 |
| `2026/9/rdns-aug.parquet.gz` | 52,525,961,595 |

`thc-monthly-head.sh` at 2026-10-27T08:21:59Z: status 206, 1,048,576 B in 2.96 s. Its measurements, as the commands printed them:

```text
lines: 72834
field counts: fields=2 72835
lines with a colon (IPv6): 4467
first IPv6 line: 5486:2a00:c00:f060:1::204,staging.ext.login-sg.isso.intranet.db.com
lines whose first field is neither IPv4 nor IPv6: 0
lines containing cname: 46
distinct addresses: 41973
most repeated address: 4993 190.0.0.1
```

The 46 `cname` lines are host names such as `42.0.6.177,8717a2e7.yunai.tech.cname.edgenextcname.com`.
`awk` counts one record more than `wc -l` because the last line is cut by the 3,000,000 byte limit.
The page's 252 GB for 6.36 billion records is 39.6 B a record. The sample is 41.2 B a line.

## Names tiles (DOM-011)

`tiles-probe.mjs` at 2026-10-27T08:23:41Z to 08:24:07Z: tile 0 and the last full tile of each usable log, with the default Node User-Agent.

```text
Let's Encrypt Sycamore2026h2 | size=1043271183 | cp=200/1753ms | tile0=200/76288B | tail=4075277:200/52669B/931ms
Let's Encrypt Sycamore2027h1 | size=799539339 | cp=200/349ms | tile0=200/76288B | tail=3123199:200/35523B/946ms
Let's Encrypt Sycamore2027h2 | size=20341 | cp=200/938ms | tile0=200/76288B | tail=78:200/75319B/1037ms
Let's Encrypt Willow2026h2 | size=1000688499 | cp=200/962ms | tile0=200/75776B | tail=3908938:200/53803B/856ms
Let's Encrypt Willow2027h1 | size=794328834 | cp=200/294ms | tile0=200/75776B | tail=3102846:200/47701B/870ms
Let's Encrypt Willow2027h2 | size=20361 | cp=200/297ms | tile0=200/75776B | tail=78:200/75061B/837ms
Geomys Tuscolo2026h2 | size=1020996491 | cp=200/513ms | tile0=200/74427B | tail=3988266:429/48B/164ms
Geomys Tuscolo2027h1 | size=368652882 | cp=200/547ms | tile0=200/74752B | tail=1440049:429/48B/178ms
Geomys Tuscolo2027h2 | size=86256 | cp=200/526ms | tile0=429/48B | tail=335:429/48B/174ms
IPng Networks Halloumi2026h2a | size=1271010032 | cp=200/3773ms | tile0=404/146B | tail=4964881:404/146B/273ms
IPng Networks Halloumi2027h1 | size=276308178 | cp=200/957ms | tile0=404/146B | tail=1079327:404/146B/216ms
IPng Networks Halloumi2027h2 | size=20175 | cp=200/1070ms | tile0=404/146B | tail=77:404/146B/315ms
IPng Networks Gouda2026h2 | size=1231385663 | cp=200/885ms | tile0=404/19B | tail=4810099:200/42348B/224ms
IPng Networks Gouda2027h1 | size=236785796 | cp=200/1060ms | tile0=404/19B | tail=924943:200/33815B/233ms
IPng Networks Gouda2027h2 | size=20396 | cp=200/871ms | tile0=404/19B | tail=78:200/74588B/248ms
GoDaddy Aquamarine2027h1 | size=145036086 | cp=200/692ms | tile0=200/27693B | tail=566546:200/27135B/284ms
```

Geomys, 2026-10-27T08:24:26Z, the tail tile of Tuscolo2026h2, four requests with each User-Agent:

```text
UA curl/8                                    200, 429, 429, 429, and the header Skylight-Rate-Limited: Please add an email address to your User-Agent.
UA probe (contact: nobody@example.invalid)   200, 200, 200, 200, no header
Node fetch, its default User-Agent           200, with the header
```

`first-names-tile.mjs` at 2026-10-27T08:24:45Z, with a contact User-Agent:

```text
Gouda2026h2 {"firstServedTile":366929,"tail":4810099,"servedTiles":4443171,"entriesServed":1137451776,"probes":22}
Gouda2027h1 {"firstServedTile":100748,"tail":924943,"servedTiles":824196,"entriesServed":210994176,"probes":19}
```

## ISC and WhoisDS (DOM-012)

At 2026-10-27T08:22:56Z, `curl -sSI`:

```text
isc.sans.edu/feeds/domaindata.json.gz              200  Content-Length 2320810  Last-Modified Tue, 27 Oct 2026 07:41:32 GMT
isc.sans.edu/feeds/domaindata.2026-10-26.json.gz   200  Content-Length 2320810  Last-Modified Tue, 27 Oct 2026 07:41:32 GMT
isc.sans.edu/feeds/domaindata.2026-10-27.json.gz   200  Content-Length 55
```

At 2026-10-27T08:23:18Z, `curl -sSIL` of `https://www.whoisds.com/whois-database/newly-registered-domains/<base64 of DATE.zip>/nrd`:

```text
2026-10-27  200  Content-Length 0       text/html
2026-10-26  200  Content-Length 566869  application/octet-stream
2026-10-25  200  Content-Length 593216  application/octet-stream
```

## THC daily listing (DOM-009)

At 2026-10-27T08:22:56Z, `curl -sS https://cs2.ip.thc.org/`: `2026-10-26.txt.gz` 27-Oct-2026 00:04, 319917410 B. `2026-10-25.txt.gz` 26-Oct-2026 00:05, 302517087 B. `2026-10-24.txt.gz` 25-Oct-2026 00:04, 292241187 B.
The Hugging Face bucket `IP-THC-ORG/Daily-Cerstream-Dumps` at 2026-10-27T08:25:12Z: 54 files, 35,765,972,194 B.

## The repositories (DOM-006, DOM-014)

- `gh issue list --repo pkgforge-dev/mirror-archlinux --state all --search visibility --json number,title,state --limit 20` at 2026-10-27T08:22:42Z answered `[]`.
- `gh repo view pkgforge-dev/domains.pkgforge.dev --json isEmpty,visibility,url` at 2026-10-27T08:22:42Z: public, empty.
- `gh api orgs/pkgforge-dev --jq '{plan:.plan.name, public_repos:.public_repos}'` at 2026-10-27T08:22:51Z: `{"plan":"free","public_repos":628}`.
- An anonymous read of `https://ghcr.io/v2/pkgforge-dev/mirror-archlinux/x86_64/core/manifests/latest` with `Authorization: Bearer QQ==` at 2026-10-27T08:22:46Z: 200, 1,598 B.
- `gh api repos/pkgforge-dev/domains.pkgforge.dev/actions/permissions` and `.../actions/permissions/workflow` at 2026-10-27T08:34:25Z: Actions enabled, all actions allowed, `default_workflow_permissions` `write`, `can_approve_pull_request_reviews` `true`. The same read for mirror-archlinux: `read` and `false`.
