// summarises out/rdapval.json (written by rdapval.mjs) without calling RDAP again
import fs from 'node:fs';
const out = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
for (const g of ['old_cert', 'fresh_cert']) {
  const rows = out.filter(o => o.grp === g), ok = rows.filter(o => o.registration);
  const age = ok.map(o => (o.ts * 1000 - Date.parse(o.registration)) / 86400000).sort((a, b) => a - b);
  console.log(g, 'asked', rows.length, 'with registration date', ok.length, 'statuses', JSON.stringify(rows.reduce((a, o) => (a[o.status] = (a[o.status] || 0) + 1, a), {})));
  if (age.length) console.log('  age at emission (days): min', age[0].toFixed(1), 'median', age[age.length >> 1].toFixed(1), 'max', age[age.length - 1].toFixed(1), '| <=2d', age.filter(x => x <= 2).length, '| >30d', age.filter(x => x > 30).length);
}
