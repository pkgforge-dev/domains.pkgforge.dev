// DOM-026 instrument, copied from .tmp/dom026/review2/claim-audit/run3/win.mjs as it ran, with its import
// and output paths moved to docs/research/measure/DOM-026/. Run from the repository root.
// claim audit: re-read the two 20,000-message ranges of newly_registered_domain read-only
import { consumeRange, KafkaClient } from '../../../../scripts/measure/kafka-client.mjs';
const ranges = { newest: [173858847, 173878847], earliest: [170127254, 170147254] };
const client = await KafkaClient.connect({});
try {
  await client.apiVersions();
  for (const [label, [start, stop]] of Object.entries(ranges)) {
    const msgs = [];
    await consumeRange(client, { topic: 'newly_registered_domain', ranges: [{ partition: 0, start, stop }], fetchBytes: 8 << 20, onRecord: (r) => msgs.push(r) });
    const byJson = new Map(), byRec = new Map();
    const tlds = {};
    let zone = 0;
    for (const m of msgs) {
      const v = JSON.parse(m.value.toString('utf8'));
      const wj = Math.floor(v.timestamp / 600) * 600;
      byJson.set(wj, (byJson.get(wj) ?? 0) + 1);
      const wr = Math.floor(m.timestamp / 1000 / 600) * 600;
      byRec.set(wr, (byRec.get(wr) ?? 0) + 1);
      if (v.ct_name === 'zone_data') { zone++; const t = v.domain.replace(/\.$/, '').split('.').pop(); tlds[t] = (tlds[t] ?? 0) + 1; }
    }
    const first = msgs[0].timestamp / 1000, last = msgs[msgs.length - 1].timestamp / 1000;
    console.log(label, 'n', msgs.length, 'zone', zone, JSON.stringify(tlds), 'first', new Date(first * 1000).toISOString(), 'last', new Date(last * 1000).toISOString());
    const rec = [...byRec.entries()].sort((a, b) => a[0] - b[0]);
    console.log(' by record-time window:', rec.map(([w, c]) => `${new Date(w * 1000).toISOString().slice(11, 16)}=${c}`).join(' '));
    const js = [...byJson.entries()].sort((a, b) => a[0] - b[0]);
    console.log(' by json-time window  :', js.map(([w, c]) => `${new Date(w * 1000).toISOString().slice(11, 16)}=${c}`).join(' '));
  }
} finally { client.close(); }
