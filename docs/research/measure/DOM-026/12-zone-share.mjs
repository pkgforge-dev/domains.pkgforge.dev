// DOM-026 instrument, copied from .tmp/dom026/review2/claim-audit/run3/zscan.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// claim audit (run3): the share of zone rows over the whole retained span of one topic, read-only.
// usage: node zscan.mjs TOPIC OUT.json
import { writeFileSync } from 'node:fs';
import { KafkaClient, fetchRecords } from '../../../../scripts/measure/kafka-client.mjs';
import { EARLIEST, LATEST } from '../../../../scripts/measure/kafka-protocol.mjs';
const [topic, outFile] = process.argv.slice(2);
const c = await KafkaClient.connect({ clientId: 'domains.pkgforge.dev review (read-only)' });
await c.apiVersions();
const at = async (ts) => (await c.listOffsets([{ topic, partitions: [{ partition: 0, timestamp: ts }] }]))[0].partitions[0].offset;
const first = await at(EARLIEST), last = await at(LATEST);
let off = first, got = 0, zone = 0, zoneIdxNeg = 0, errors = 0;
const hours = new Map(), tld = {}, conf = {}, confAll = {};
const t0 = Date.now();
while (off < last) {
  const f = await fetchRecords(c, topic, 0, off, 8 << 20);
  if (f.records.length === 0) break;
  for (const r of f.records) {
    if (r.offset >= last) break;
    got++;
    let v;
    try { v = JSON.parse(r.value.toString('utf8')); } catch { errors++; continue; }
    const hr = Math.floor(r.timestamp / 3600000) * 3600;
    let h = hours.get(hr); if (!h) { h = { n: 0, z: 0 }; hours.set(hr, h); }
    h.n++;
    if (v.confidence !== undefined) confAll[v.confidence] = (confAll[v.confidence] ?? 0) + 1;
    if (v.ct_name === 'zone_data') {
      zone++; h.z++;
      if (v.cert_index === -1) zoneIdxNeg++;
      const t = String(v.domain).replace(/\.$/, '').split('.').at(-1);
      tld[t] = (tld[t] ?? 0) + 1;
      if (v.confidence !== undefined) conf[v.confidence] = (conf[v.confidence] ?? 0) + 1;
    }
  }
  off = f.records.at(-1).offset + 1;
}
c.close();
const hl = [...hours.entries()].sort((a, b) => a[0] - b[0]).map(([t, h]) => ({ t: new Date(t * 1000).toISOString(), n: h.n, z: h.z, s: +(h.z / h.n).toFixed(4) }));
const maxShare = hl.reduce((a, b) => (b.s > a.s ? b : a), hl[0]);
const out = { topic, first, last, got, zone, zoneIdxNeg, errors, share: +(zone / got).toFixed(4), maxHourShare: maxShare, tldTop: Object.entries(tld).sort((a, b) => b[1] - a[1]).slice(0, 8), zoneConfidence: conf, allConfidence: confAll, secs: (Date.now() - t0) / 1000, at: new Date().toISOString(), hours: hl };
writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ ...out, hours: undefined }));
