import fs from 'node:fs';
const zd = fs.readFileSync('oi/raw/newly_registered_domain.ndjson', 'utf8').split('\n').filter(Boolean).map(l => { const m = JSON.parse(JSON.parse(l).m); return { d: m.domain.replace(/\.$/, ''), ts: m.timestamp, sub: m.submission_timestamp, ct: m.ct_name }; });
const com = zd.filter(z => /\.(com|net)$/.test(z.d));
const old = com.filter(z => z.ts - z.sub > 30 * 86400).slice(0, 25), fresh = com.filter(z => z.ts - z.sub < 6 * 3600).slice(0, 25);
const out = [];
async function one(z, grp) {
  const tld = z.d.endsWith('.com') ? 'com' : 'net';
  try {
    const r = await fetch(`https://rdap.verisign.com/${tld}/v1/domain/${z.d}`, { headers: { accept: 'application/rdap+json' }, signal: AbortSignal.timeout(20000) });
    if (r.status !== 200) { out.push({ ...z, grp, status: r.status }); return; }
    const j = await r.json(); const reg = (j.events || []).find(e => e.eventAction === 'registration');
    out.push({ ...z, grp, status: 200, registration: reg && reg.eventDate });
  } catch (e) { out.push({ ...z, grp, status: 'err ' + e.message }); }
}
for (const z of old) { await one(z, 'old_cert'); await new Promise(r => setTimeout(r, 1200)); }
for (const z of fresh) { await one(z, 'fresh_cert'); await new Promise(r => setTimeout(r, 1200)); }
fs.writeFileSync('out/rdapval.json', JSON.stringify(out, null, 1));
for (const g of ['old_cert', 'fresh_cert']) {
  const rows = out.filter(o => o.grp === g);
  const ok = rows.filter(o => o.registration);
  const ageDays = ok.map(o => (o.ts * 1000 - Date.parse(o.registration)) / 86400000).sort((a, b) => a - b);
  console.log(g, 'asked', rows.length, 'with registration date', ok.length, 'statuses', JSON.stringify(rows.reduce((a, o) => (a[o.status] = (a[o.status] || 0) + 1, a), {})));
  if (ageDays.length) console.log('  age at emission (days): min', ageDays[0].toFixed(1), 'median', ageDays[ageDays.length >> 1].toFixed(1), 'max', ageDays[ageDays.length - 1].toFixed(1), '| <=2d', ageDays.filter(x => x <= 2).length, '| >30d', ageDays.filter(x => x > 30).length);
}
