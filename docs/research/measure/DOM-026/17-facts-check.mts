// DOM-026 Prove, read with no credential: the layers of names:domains-d-DAY, its
// facts.json parsed, and for keys whose oi-nrd facts hold a cert_age over 7 days,
// their rows in feed:feed-d-DAY (suspect, suspect-cert). Also a count over every
// key with facts: how many old-certificate keys are suspect in the feed.
// Usage: node docs/research/measure/DOM-026/17-facts-check.mts DAY
import { parseFacts } from '@domains/adapter';
import { ghcrReader } from '@domains/ghcr';
import { PackReader } from '@domains/pack';
import { FEED_SUSPECT, FEED_SUSPECT_CERT } from '../../../../packages/pack/src/codec.ts';

const day = process.argv[2];
const ymd = day.replaceAll('-', '');
const r = ghcrReader({ userAgent: 'domains.pkgforge.dev DOM-026 prove' });
const R = 'pkgforge-dev/domains.pkgforge.dev/';
const TITLE = 'org.opencontainers.image.title';
const WEEK = 7 * 86_400;

async function whole(repo: string, digest: string, size: number): Promise<Uint8Array> {
  const out = new Uint8Array(size);
  for (let at = 0; at < size; at += 16 << 20) {
    const end = Math.min(size, at + (16 << 20));
    const got = await r.readRange(repo, digest, at, end);
    out.set(got.bytes, at);
  }
  return out;
}

const dm = await r.getManifest(R + 'names', `domains-d-${ymd}`);
console.log(`names:domains-d-${ymd} ${dm.digest} layers:`);
for (const l of dm.json.layers ?? []) console.log(`  ${l.annotations?.[TITLE]} ${l.mediaType} ${l.size} ${l.digest.slice(0, 19)}`);
const fl = (dm.json.layers ?? []).find((l) => l.annotations?.[TITLE] === 'facts.json');
if (!fl) throw new Error('no facts.json layer');
const facts = parseFacts(await whole(R + 'names', fl.digest, fl.size));
console.log(`facts.json keys ${facts.size}`);

const fm = await r.getManifest(R + 'feed', `feed-d-${ymd}`);
const layer = (t: string) => (fm.json.layers ?? []).find((l) => l.annotations?.[TITLE] === t);
const idxL = layer('idx');
const partL = layer('part.000');
if (!idxL || !partL) throw new Error(`feed layers: ${(fm.json.layers ?? []).map((l) => l.annotations?.[TITLE]).join(' ')}`);
const idx = await whole(R + 'feed', idxL.digest, idxL.size);
const part = await whole(R + 'feed', partL.digest, partL.size);
const feed = await PackReader.open(idx, { read: async (_p: number, o: number, n: number) => part.subarray(o, o + n) });

const flagsOf = new Map<string, number>();
for await (const rec of feed.scan()) flagsOf.set((rec as { key: string }).key, (rec as { feedFlags: number }).feedFlags);
console.log(`feed rows ${flagsOf.size}`);
let old = 0, oldSuspect = 0, oldNoRow = 0, young = 0, youngSuspect = 0;
const samples: string[] = [];
for (const [key, bits] of facts) {
  const ages = [...bits.values()].map((f) => f.cert_age).filter((a): a is number => a !== undefined);
  if (ages.length === 0) continue;
  const minAge = Math.min(...ages);
  const ff = flagsOf.get(key);
  const row = ff === undefined ? null : { feedFlags: ff };
  if (minAge > WEEK) {
    old += 1;
    if (row === null) oldNoRow += 1;
    else if (row.feedFlags & FEED_SUSPECT && row.feedFlags & FEED_SUSPECT_CERT) {
      oldSuspect += 1;
      if (samples.length < 3) samples.push(`${key} cert_age ${minAge} s (${(minAge / 86_400).toFixed(1)} d) feed_flags ${row.feedFlags}`);
    }
  } else {
    young += 1;
    if (row && row.feedFlags & FEED_SUSPECT_CERT) youngSuspect += 1;
  }
}
console.log(`old (min cert_age > 7 d): ${old}, suspect with suspect-cert ${oldSuspect}, no feed row ${oldNoRow}`);
console.log(`young (min cert_age <= 7 d): ${young}, with suspect-cert ${youngSuspect}`);
for (const s of samples) console.log(`  sample ${s}`);
