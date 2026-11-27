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
B names one or more of the five bases of `docs/architecture.md` §3.3 (`zone`, `rdap`, `nrd-list`, `nrd-ct+rdap`, `ct-first`) joined by "or", or is none for a source that writes no newness evidence (§3.5).

| Source | Bit | What it gives | Cadence | Failure mode and handling | Labels | Entry |
| --- | --- | --- | --- | --- | --- | --- |
| `thc-ct` | 0 | THC's daily CT names. Two measured whole days yielded 32.55 and 36.00 million names, and 11.16 and 11.77 million registrable domains (`docs/research/2026-11-01-thc-ct.md` §3). The cs2 listing began at 2026-10-01 and the Hugging Face bucket `IP-THC-ORG/Daily-Cerstream-Dumps` held 60 files of 37,815,817,542 B from 2026-09-01 to 2026-11-01, with two days absent (recorded 2026-11-02T04:29:18Z). | One file per day, observed around 00:02 to 00:06 UTC on D+1. The bucket's `uploadedAt` followed `mtime` by about 8 to 34 s over 23 live uploads from 2026-10-08 to 10-31 (tracked listing, DOM-029). | The bucket's listed path can be in a different month from the file's date. The adapter verifies one host's full gzip before writing, and falls back to the other on a fault. The measured days had 0.53% to 0.57% upper-case lines and 0.0026% to 0.0040% refused lines. An unwritten day goes to `open` at D+1 06:00Z and becomes a gap at D+2 12:00Z, even if a candidate exists but is unreadable. An open day that faults twice can consume the run's GET budget. The gap fault records the last failure or absence; backfill can repair a gap while its segments fit the live set. A gap covered by a THC aggregate needs rebuilt overlapping packs. The 7-day relative band is 0.4 to 4 and resets on the third consecutive observation outside the same side. | F `ct`, K `ct_name`, B `ct-first`, P day | DOM-029 (measured by DOM-009) |
| `oi-nrd` | 1 | OpenINTEL Zonestream topic `newly_registered_domain`: a registrable domain whose first certificate appeared in CT, as OpenINTEL publishes the claim. Kafka `kafka.zonestream.openintel.nl:9092`, plain TCP, anonymous, one partition. 402,114 messages in 24 h and 3,751,353 retained, back to 2026-10-22T13:00:50Z (MEASURED 2026-10-31T05:05:34Z, `node scripts/measure/kafkaprobe.mjs`). A name ends in a dot, which normalisation removes; the key is the reversed registrable domain. The record's `seen` is the Kafka record time of the message in whole seconds, the moment OpenINTEL published the claim, not the certificate's log time. The certificate age, `timestamp` minus `submission_timestamp`, goes to the segment's `facts.json` (`docs/format.md` section 19): between a third and a half of the events carry a certificate older than 7 days, by sample: 51.1% of the newest 19,951 events with both times and 32.5% of the earliest 20,000 (MEASURED 2026-10-31T05:07Z, `02-sample.mjs` of `docs/research/measure/DOM-026/`). | Continuous. The adapter reads at the chain interval, 30 minutes (`config/clock.json`, ruling 27). It writes a window of 10 minutes, or the rest of an hour that ended an hour before the run (`docs/architecture.md` §5.4). | The broker stops or the port changes (9091 timed out): the fault `broker` fails the kafka leg, the cursor holds, and the next run replays from the stored offset. No WebSocket path is read: a WebSocket has no offsets, so its window cannot prove its coverage. A cursor below the earliest retained offset is the fault `retention-gap`, and the read resumes at the earliest offset. A batch that does not decode stops its topic before the batch on every run, until a code change reads it or the retention deletes it. Zone rows (`ct_name` `zone_data`, `cert_index` -1) carry no registration date and arrive in registry bursts (the broker section below); each is T2 `nrd-list`. An event with a certificate older than 7 days is `suspect`. The band `count` 0.5 to 2 is declared, and no check reads it yet for a `second` source (DOM-034). | F `ct`, K `claimed_new`, B `nrd-list`, P second | DOM-026 (measured by DOM-004) |
| `oi-nrd-fqdn` | 2 | Topic `newly_registered_fqdn`: the same events at name level. 301,013 messages in 24 h and 2,794,354 retained (MEASURED 2026-10-31T05:05:34Z). A name ends in no dot (0 of 20,000). The key is the reversed name, flagged exact, wildcard or both over its events. 48.6% of the newest 20,000 events and 30.4% of the earliest carried a certificate older than 7 days; its names segments carry no `facts.json`, since no feed reads names yet (DOM-041), and the raw lane keeps the ages. | As `oi-nrd`. | As `oi-nrd`. No zone row was in 20,000 messages. | F `ct`, K `claimed_new`, B `nrd-list`, P second | DOM-026 |
| `oi-nrd-confirmed` | 3 | Topic `confirmed_newly_registered_domain`: adds `confidence` 1 to 10, the closeness of the CT first appearance to the RDAP registration date (READ `https://openintel.nl/data/zonestream/`). 215,199 messages in 24 h and 1,831,581 retained (MEASURED 2026-10-31T05:05:34Z). It carries no `submission_timestamp`, so it has no certificate age and is never suspect by age. Zone rows are 33% of the newest 20,000 messages and 25.2% of the retained span, 95.4% of them with confidence 8 to 10 (the broker section below). Its events are OpenINTEL's CT events matched to RDAP: in the hour of 2026-10-22T14:00Z each of its 9,401 keys was also a key of `oi-nrd` (MEASURED 2026-10-31T16:01Z, `15-confirmed-subset.mjs` of `docs/research/measure/DOM-026/`), so its family is `ct`, as `oi-nrd`'s, and the two corroborate nothing between them. A row with a certificate (`cert_index` at or above 0) is T2 `nrd-ct+rdap` with its confidence. A zone row is T2 `nrd-list` and keeps its stated confidence: it carries no certificate, so its confidence is not a measure of how close CT and RDAP were. | As `oi-nrd`. | As `oi-nrd`. Its JSON `timestamp` steps back up to 25,556 s over the retained span, so windows are cut on the Kafka record time (the broker section below). | F `ct`, K `registered_claim`, B `nrd-list` or `nrd-ct+rdap`, P second | DOM-026 |
| `oi-cs` | 4 | Topic `certstream_domains`: CT names with the log, `seen`, and `sld_list`. 72,699,511 messages in 24 h, about 326 B of JSON each, retained about 25 to 27 hours. Only 15 log sources appear, from DigiCert, Sectigo, TrustAsia and Google. No Let's Encrypt, Geomys or IPng log is in it (MEASURED 2026-10-27, design A M6, M8). | As `oi-nrd`. | The same as `oi-nrd`, and a gap over 25 hours is lost. Handling: consume at least hourly. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-036 (measured by DOM-004) |
| `ct-le` | 5 | Names tiles of the Let's Encrypt logs Sycamore and Willow. About 35.5 million entries a day for the 2026h2 and 2027h1 shards (design A M10). Each tile holds 256 entries. | Polled. About 2.3 tiles a second for the reliable set of all operators. | A shard rolls over. Handling: follow the CT log list, re-read daily. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-037 (measured by DOM-011) |
| `ct-geomys` | 6 | Names tiles of the Geomys logs Tuscolo. About 15.2 million entries a day (design A M10). Host `*.skylight.geomys.org`. | Polled. | The host answers 429 and the header `Skylight-Rate-Limited` to a client with no email address in its User-Agent. A User-Agent with an address got 4 of 4 answers of 200 (MEASURED 2026-10-27T08:24:26Z). Handling: a contact address in every User-Agent. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-037 |
| `ct-ipng` | 7 | Names tiles of the IPng log Gouda, about 8.2 million entries a day. Gouda serves names tiles from a first served tile onward: tile 366,929 of 4,810,099 for Gouda2026h2 and tile 100,748 of 924,943 for Gouda2027h1 (MEASURED 2026-10-27T08:24:45Z). Halloumi answered 404 for tile 0 and the last full tile (MEASURED 2026-10-27T08:23:41Z). | Polled. | A 404 is a state, not an error. Handling: a per-run probe of the first served tile and the last full tile. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-037 |
| `isc-new` | 8 | ISC daily snapshots at `https://isc.sans.edu/feeds/domaindata.json.gz` and `domaindata.<date>.json.gz`. Rows carry `domainname` and the `firstseen` day. The day means new to ISC and supplies T2 list evidence. Optional metadata such as `ip` and `score` stays in the exact gzip. | Over seven sampled days, dated files became nonempty from 00:42 to 02:41 UTC on D+1. Latest-alias rewrites were 120.6 min apart at the median and 284.2 min at most (DOM-012). | Dated headers changed through D+4. Track validators per path and use SHA-256 for byte identity. A nonempty dated snapshot must have a single UTC `firstseen` day matching its path. Candidate alerts are a missing D at 04:00 UTC on D+1 and no alias rewrite for six hours. | F `isc`, K `claimed_new`, B `nrd-list`, P day | DOM-027 (measured by DOM-012) |
| `whoisds` | 9 | WhoisDS's free daily file, a sample of 70,000 domains. Path `https://www.whoisds.com/whois-database/newly-registered-domains/<base64 of YYYY-MM-DD.zip>/nrd`. | Seven dated paths first served nonempty responses 13:36 to 14:21 UTC on the path date (DOM-012). Two historical overlap comparisons align D with ISC's D-1. | The same ZIP entry identity can appear on two dated paths. Deduplicate by entry identity and keep the path date distinct from the list's data date. A candidate alert for no new identity is 15:30 UTC. ZIP entry timestamps lack a timezone. | F `whoisds`, K `claimed_new`, B `nrd-list`, P day | DOM-028 (measured by DOM-012) |
| `cenk-nrd` | 10 | `cenk/nrd`, built from WhoisDS. 699,321 lines (11.6 MB) in the sampled 10-day file. | Over six whole UTC days, the first daily commit was 14:02 UTC at the median and 16:52 UTC at the latest (DOM-012). | The copy on `dl.cenk.app` was five days stale on 2026-10-27. Read raw GitHub. A candidate alert for a missing daily publication is 18:00 UTC. | F `whoisds`, K `claimed_new`, B `nrd-list`, P day | DOM-028 |
| `hagezi-nrd` | 11 | `hagezi/nrd` `domains/nrd7.txt` and earlier rolling windows. The sampled file had 2,773,880 lines for 7 days (47,794,272 B). | Over six whole UTC days, the first daily commit was 07:39 UTC at the median and 07:52 UTC at the latest (DOM-012). | The list may include subdomains. Its Stamus Labs input can lag by a few days. Reduce to registrable domains and keep the source lag. A candidate alert for a missing daily publication is 09:00 UTC. | F `stamus`, K `claimed_new`, B `nrd-list`, P day | DOM-028 |
| `oi-zone` | 12 | OpenINTEL daily full-zone Parquet on `https://object.openintel.nl/openintel-public`, prefix `fdns/basis=zonefile/source=<tld>/`. TLDs: `.se .fr .ch .nu .sk .ee .li .gov`. A day holds 2.5 GB for `.se`, 4.1 GB for `.fr`, 2.7 GB for `.ch` (READ `docs/research/web-pkgforge-2026-10-27/landscape.md`). Range reads work (206). | Daily. | S3 availability. Handling: skip the day and read the next. | F `registry`, K `zone_add`, B `zone`, P day | DOM-047 |
| `sk-nic` | 13 | The `.sk` registry list `https://sk-nic.sk/subory/domains.txt`: 493,544 live domains with registrar, holder, name servers and expiry (47,797,077 B, generated 2026-10-26). | Daily. | The list moves. | F `registry`, K `zone_add`, B `zone`, P day | DOM-048 |
| `oi-zonediff` | 14 | Zonestream `zone_diff` for `.cd .ch .ee .fj .gp .li .mp .mw .ni .nu .sl .se`. | Live. | It sent 0 messages in 23 minutes (MEASURED 2026-10-27T05:17:32Z to 05:40:34Z, design A M7). Handling: probe first; build only if it speaks. | F `registry`, K `zone_add`, B `zone`, P second | DOM-049 |
| `dotgov` | 15 | The complete `.gov` list from `cisagov/dotgov-data`, diffed daily. | Daily (a commit a day). | The repository moves or stops. | F `registry`, K `zone_add`, B `zone`, P day | DOM-051 |
| `zone-walks` | 21 | Daily NSEC walks of about 25 small gTLDs from `flotwig/zone-walks`; partial (`.lol` is 19% of its registry total). | Daily. | Walks stop or shrink. | F `nsec-walk`, K `zone_add`, B `zone`, P day, `partial: true` | DOM-051 |
| `rdap` | 16 | Registration events from RDAP, by sampling. Verisign `https://rdap.verisign.com/com/v1/domain/<name>` answered in 0.36 s with 3,026 B. IANA's bootstrap lists 1,204 TLDs with RDAP and 233 without (READ `docs/research/web-pkgforge-2026-10-27/landscape.md`). | Daily, 200 samples. | Many registries have no RDAP, among them 175 of 248 ccTLDs. The Google Registry answered 429 in earlier research. | F `registry`, K `registered_claim`, B `rdap`, P second | DOM-050 |
| `ct-godaddy` | 17 | Names tiles of the GoDaddy log Aquamarine. Tile 0 and the last full tile of `aquamarine2027h1` answered 200 (MEASURED 2026-10-27T08:23:41Z). About 0.65 million entries a day. | Reserved. | Design A saw 404 at its tail at 05:26Z. DOM-011 probes the full tile and the partial tile separately. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-037 adds it if DOM-011 finds stable tiles |
| `vps-ct` | 18 | A future VPS ingester. | Reserved. | See `docs/architecture.md` §5.7. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-057 |
| `oi-measure` | 19 | Topic `newly_issued_certificates_measurements`: DNS answers and addresses for each new certificate name. 166,477,316 messages in 24 h, about 780 B each, in a binary format nobody has decoded. | Continuous. | The format is unknown. | F `dns`, K `dns`, B none, P second | DOM-058 |
| `crtsh` | 20 | crt.sh names, for gap-fill and validation only. The JSON route took 1 to 108 s. The public Postgres refused most connections (READ `docs/research/web-pkgforge-2026-10-27/ct.md` §3). | Daily sample, in Actions. | Slow and unreliable. It never serves a request. | F `ct`, K `ct_name`, B `ct-first`, P second | DOM-052 |

The complete 2026-10-15 THC gzip from cs2 and the Hugging Face bucket matched
at 76,999,576 B with the same SHA-256 on 2026-11-27. The recorded result covers
one day. See [the host comparison](research/2026-11-01-thc-ct/33-compare-hosts.out).

## ISC raw and indexed coverage

The raw archive is planned for the 67 UTC observation dates from 2025-10-26
through 2025-12-31 inclusive. It retains the publisher's exact gzip and a
member record with its actual date, source URL, byte count and SHA-256.
The archive command validated the first and last date directly against ISC
on 2026-11-27. A successful hosted archive and anonymous verification of
all dates are still pending. [DOM-027](../TODO/ingest.md#dom-027--isc-new-the-isc-new-domain-feed)

Indexed eligibility starts on 2026-01-01 under the existing DPK1 epoch.
A valid snapshot can produce T2, day-precision `nrd-list` evidence for its
normalized registrable domains. Its day is an ISC observation date.
The registry defines source bit 8. The live feeds lane and separate
indexed root coverage proof remain pending. The raw archive does not
contribute to indexed `corpus_since`, source `through`, or derived
coverage ratios. [DOM-051](../TODO/ingest.md#dom-051--gtlds-without-czds-iscs-year-of-dated-files-dns-coffees-daily-counts-gov-and-the-zone-walks)

### Verify a published ISC archive day

After the hosted run, copy the manifest digest and gzip SHA-256 from its
`public obs:TAG ... gzip sha256:...` line. From the checkout root, replace
`MANIFEST_DIGEST` and `GZIP_SHA256` below with those values. The manifest
digest includes its `sha256:` prefix. The gzip hash can include it.

```bash
node --input-type=module - 2025-10-26 MANIFEST_DIGEST GZIP_SHA256 <<'NODE'
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { repoOf } from '@domains/ghcr';
import { datedUrl } from './adapters/isc-new/src/index.ts';
import { anonymousReader } from './scripts/ghcr/check-public.mjs';
import { archiveTag } from './scripts/ingest/isc-archive.mjs';
import { readBlob } from './scripts/root/lib.mjs';
import { blobSource } from './scripts/verify-pack.mjs';

const [day, manifestDigest, gzip] = process.argv.slice(2);
const gzipHash = gzip.replace(/^sha256:/, '');
const reader = anonymousReader();
const repo = repoOf('obs');
const tag = archiveTag(day);
assert.equal((await reader.getManifest(repo, tag)).digest, manifestDigest);
const { digest, json } = await reader.getManifest(repo, manifestDigest);
assert.equal(digest, manifestDigest);
assert.equal(json.artifactType, 'application/vnd.pkgforge.domains.raw.v1');
assert.equal(json.layers.length, 2);
const [raw, index] = json.layers;
assert.equal(raw.annotations['org.opencontainers.image.title'], 'raw.000');
assert.equal(index.annotations['org.opencontainers.image.title'], 'members.json');
assert.equal(raw.digest, `sha256:${gzipHash}`);
const members = JSON.parse(Buffer.from(await readBlob(reader, repo, index)).toString('utf8'));
const start = `${day}T00:00:00Z`;
const end = new Date(Date.parse(start) + 86_400_000).toISOString().replace('.000Z', 'Z');
assert.equal(json.annotations['dev.pkgforge.domains.span.start'], start);
assert.equal(json.annotations['dev.pkgforge.domains.span.end'], end);
assert.equal(json.annotations['dev.pkgforge.domains.url'], datedUrl(day));
assert.deepEqual(members, {
  format: 'domains.raw-members.v1',
  source: 'isc-new',
  start,
  end,
  members: [{ day, url: datedUrl(day), offset: 0, length: raw.size, sha256: gzipHash }],
});
const bytes = blobSource(reader, repo, raw);
const hash = createHash('sha256');
for (let at = 0; at < raw.size; at += 8 * 1024 ** 2) {
  hash.update(await bytes.read(at, Math.min(8 * 1024 ** 2, raw.size - at)));
}
assert.equal(hash.digest('hex'), gzipHash);
console.log(`verified ${tag} ${digest} ${raw.digest}`);
NODE
```

`tags.mjs` inventories dates. The check above binds a published tag to
the workflow's manifest and gzip hashes and verifies both public layers.

## The Zonestream broker

The OpenINTEL sources with bits 1 to 4 and 19 read one Kafka broker, `kafka.zonestream.openintel.nl:9092`. Each MEASURED reading below ran on the operator's Windows 11 workstation, on 2026-10-28 or on 2026-10-31.
The fixtures below are broker answers that `node scripts/measure/kafka-record.mjs --data scripts/measure/fixtures/kafka` recorded at 2026-10-28T10:40:45Z, and `scripts/measure/kafka-protocol.mjs` decodes them.
DOM-004 reads the broker from a GitHub runner. Its result file records the topics, their 24-hour counts and the batches it reads, counted by codec.

- **Topics.** The broker lists 8 topics: the 6 of design A M6, `newly_registered_fqdn_measurements` and `newly_registered_domains_measurements` (MEASURED 2026-10-28T14:36:37Z, `node scripts/measure/kafka-offsets.mjs`). Each of these two topics has 4 partitions. Every other topic has 1 partition.
  No row of the table above reads the two topics. `node scripts/measure/kafka-offsets.mjs` writes the partitions and the 24-hour counts of every topic to `offsets.json` in its `--data` directory.
- **NRD batches.** In each of the three windows below, every batch has codec none and holds one record.
  `newly_registered_domain`: the fixture `scripts/measure/fixtures/kafka/fetch-v4-newly_registered_domain.bin` holds 75 batches of 210 to 230 B. They start at offset 172,679,348, which is 2,000 offsets before the newest offset in the fixture `scripts/measure/fixtures/kafka/list-offsets-v1.bin` (READ both fixtures).
  `newly_registered_fqdn`: the 51 newest batches were 207 to 231 B each (MEASURED 2026-10-28T14:36:17Z, `node scripts/measure/kafkafetch.mjs newly_registered_fqdn latest-50`).
  `confirmed_newly_registered_domain`: the 51 newest batches were 188 to 206 B each (MEASURED 2026-10-28T14:36:20Z, `node scripts/measure/kafkafetch.mjs confirmed_newly_registered_domain latest-50`).
- **NRD messages.** A message of each NRD topic is JSON that carries `ct_name` and `cert_index`. Each of the 75 messages of the `newly_registered_domain` fixture has the fields `domain`, `cert_index`, `ct_name`, `timestamp` and `submission_timestamp` (READ the fixture above).
  Design A's samples show `ct_name` and `cert_index` in `newly_registered_fqdn`, whose name field is `fqdn`, and in `confirmed_newly_registered_domain`, which carries `confidence` and no `submission_timestamp` (READ `docs/research/2026-10-27-design-a/kafka/offsets.json`).
  MEASURED 2026-10-31T05:07:04Z to 05:07:32Z, the newest and the earliest 20,000 messages of each NRD topic over `scripts/measure/kafka-client.mjs`: every batch has codec none and one record. `newly_registered_domain` and the confirmed topic end every name in a dot, and `newly_registered_fqdn` none. No message of the confirmed topic carries `submission_timestamp`. In `newly_registered_domain`, 49 of the newest 20,000 messages and 424 of the earliest lack it.
- **Retention.** The earliest message of each NRD topic moved by exactly 7 days of message time between 2026-10-28T15:00:19Z and 2026-10-31T05:05:34Z, to 2026-10-22T13:00:50Z, 13:00:54Z and 13:02:00Z (`node scripts/measure/kafkaprobe.mjs` at both times). So the broker deletes whole log segments of about 7 days, and the retention R lies in (6.08 d, 8.67 d]. A message is kept for at least R, and the retained span moves between R, just after a deletion, and R + 7 days, at most 15.67 days, just before one. This is READ from two readings, not from the broker's configuration, which a consumer cannot see. `retention` `P6D` in `adapters/oi-nrd/source.json` is the declared floor. The next deletion falls between 2026-11-04T15:00Z and 2026-11-07T05:05Z, and a reading then narrows R (DOM-034).
- **Zone rows.** A message with `ct_name` `zone_data` and `cert_index` -1 comes from a zone and holds no registration date. Both domain topics carry them; `newly_registered_fqdn` held none in 20,000. They arrive in registry bursts. Over the whole retained span they are 33.5% of `newly_registered_domain` (1,294,264 of 3,866,241 messages) and 25.2% of the confirmed topic (476,562 of 1,894,990), and up to 95.1% and 91.4% of an hour; 95.4% of the confirmed topic's zone rows state a confidence of 8 to 10 (MEASURED 2026-10-31T15:19Z to 15:22Z, `12-zone-share.mjs` of `docs/research/measure/DOM-026/`). The largest hour held 188,671 messages (2026-10-24T01:00Z), the largest 10-minute windows 146,634 and 141,785, and the largest minute 140,503, 99.9% of them `.com` zone rows, 6,597 in its busiest second (MEASURED 2026-10-31T05:47Z to 06:01Z, `07-hourly.mjs` to `10-burstmono.mjs` there). In a quiet hour a 10-minute window of `newly_registered_domain` held 1,300 to 2,047 messages, median 1,525: the 11 windows from 03:10Z to 05:00Z of 2026-10-31 that the newest 20,000 messages cover whole (`14-windows.mjs` there). Of the newest 20,000 messages, zone rows were 0.25% of `newly_registered_domain` (all `.ch`) and 33% of the confirmed topic; of the earliest 20,000 of `newly_registered_domain`, 2.1% (420 `.ch` and 4 `.li`).
- **The record time.** The Kafka record timestamp is the producer's CreateTime: the logAppendTime bit is clear in every batch read. It never steps back with the offset over the whole retained span of each NRD topic, 3,871,257, 2,929,669 and 1,897,742 messages (MEASURED 2026-10-31T15:40Z to 15:50Z, `13-record-time.mjs` of `docs/research/measure/DOM-026/`). It is at most 2.62 s after OpenINTEL's own `timestamp` in `newly_registered_domain` (p50 0.543 s) and 2.165 s in `newly_registered_fqdn`. The JSON `timestamp` of the confirmed topic is not monotone: it steps back 8,973 times in the newest 20,000, by up to 8,389 s, at the zone rows, and 831,422 times over the retained span, by up to 25,556 s below the largest before it (the same scan). So the adapter cuts windows on the record time.
- **The client id.** The broker accepts the contact string of ruling 11 (`USER_AGENT` of `scripts/lib/user-agent.mjs`, 111 bytes) as the Kafka client id: ApiVersions v0 and ListOffsets v1 answered (MEASURED 2026-10-31T05:13:34Z). The adapter sends `ctx.userAgent`.
- **The adapter's recording.** `adapters/oi-nrd/fixtures/broker.tcp.json` holds six exchanges with the broker, recorded at 2026-10-31T10:19:27Z to 10:20:10Z by `node adapters/oi-nrd/record.mjs --out adapters/oi-nrd/fixtures`: 100, 100 and 68 messages around the edge 10:20:00Z, and no zone row. `adapters/oi-nrd/fixtures/recorded.json` names the offsets and the client id.
- **`certstream_domains` batches are snappy compressed.** The fixture `scripts/measure/fixtures/kafka/fetch-v4-certstream_domains.bin` holds one batch of 214 records in 26,811 B (READ the fixture).
  Its payload uses the xerial framing of the Java producer, with the header bytes `82 53 4e 41 50 50 59 00`. The batch carries a producer id, which an idempotent producer sets.
  Each of the 55 batches that held the newest 5,000 offsets was snappy (MEASURED 2026-10-28T14:39:06Z, `node scripts/measure/kafkafetch.mjs certstream_domains latest-5000 1000000`).

## Inputs without a bit

These feed a dataset that has no source mask, or are reference data, or only check other sources.

| Input | What it gives | Cadence | Failure mode and handling | Entry |
| --- | --- | --- | --- | --- |
| thc-rdns | THC's monthly reverse database: 6.36 billion `ip,name` records for September 2026, `rdns-sept.csv.gz` 37,046,639,482 B. It feeds the `rev` dataset. It has no CNAME targets: every one of its 6,364,111,723 records has two fields and an address first (MEASURED 2026-10-28T15:53Z, the whole stream on a runner, DOM-010). A runner downloads it at 142 MB/s and parses it at 18.8 MB/s compressed. | Monthly, at the month's end. September was released 2026-10-04. | The slow host `dns.team-teso.net` did not answer a 1 MB Range read within 120 s. Handling: read the Hugging Face host. | DOM-042, DOM-043, DOM-045 |
| psl | The Public Suffix List, 338,012 B on 2026-10-27 (MEASURED, design A M4). | Daily check. | None that matters. Handling: pin by sha256 in the `ref` package. | DOM-015, DOM-019 |
| ctlogs | The CT log list `https://www.gstatic.com/ct/log_list/v3/log_list.json`, 62,375 B with `log_list_timestamp` 2026-10-26T13:45:16Z (MEASURED 2026-10-27T08:23:28Z). | Daily check. | None that matters. | DOM-019, DOM-037 |
| iana-rdap | IANA's RDAP bootstrap `https://data.iana.org/rdap/dns.json`, 71,348 B, published 2026-10-22. | Daily check. | None that matters. | DOM-050 |
| certspotter | Cert Spotter's keyless API: 10 requests an hour, unexpired issuances only. Validation only. | On demand, in Actions. | The limit is low. Handling: one sample a day. | DOM-052 |
| dnscoffee-counts | DNS Coffee's daily gTLD counts (new, removed, moved); a monitor of ISC's coverage, no names. It is not a source of records: it writes `coverage.json` only. | Daily. | The page's script or token changes. | DOM-051 |

## Dropped, and not ingested

| Candidate | Why it is out |
| --- | --- |
| certstream.calidog.io | It accepted a connection and sent 0 messages in 12 s (MEASURED 2026-10-27T06:15:45Z, design B M11). |
| certstream.dev | It documents self-hosted software and runs no public stream (design B M11). |
| Censys | The legacy API closed on 2026-09-30 and the free tier has no usable search (READ `ct.md` §3). |
| Merklemap, Facebook CT | A key or an app token is needed (READ `ct.md` §3). |
| xReverseLabs, DNS Coffee's names | A login or an API key is needed for their names (design B §3). DNS Coffee's daily counts need neither, and the monitor `dnscoffee-counts` above reads them (DOM-051). |
| shreshta-labs/newly-registered-domains, WhoisFreaks | Free samples of about 10,000 names (design A §3.1). |
| maaaaz/dnsdumps | Its own README calls the repository broken (design A §3.1). |
| dontcrash/NRD | A splitter of hagezi's lists (design A §3.1). |
| issued.live feed | A rolling sample of about 30 names a call, 1,000 requests a day (design B §3). |
| THC's live API | No route calls it (ruling 7 of `TODO/RULES.md` §5). |

Candidates for a later entry: `cbuijs/nrd` (windows of 1 to 30 days) and `networkhound/dot-in` (daily `.IN` snapshots), both from design A §3.1.

CZDS is not used (ruling 13): it needs a login, and `docs/research/2026-10-27-gtld-without-czds.md` measured that ISC's files carry about 90% of the names entering gTLD zones without one.
