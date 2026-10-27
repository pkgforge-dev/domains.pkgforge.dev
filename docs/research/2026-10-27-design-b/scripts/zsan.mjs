import fs from 'node:fs';
for (const f of process.argv.slice(2)) {
  const L = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  console.log('==', f, L.length);
  const ms = L.map(x => JSON.parse(x.m));
  console.log('sample', JSON.stringify(ms.slice(0, 3)));
  console.log('keys', [...new Set(ms.flatMap(m => Object.keys(m)))].join(','));
  const k = ms[0].domain !== undefined ? 'domain' : 'fqdn';
  const names = ms.map(m => m[k]);
  console.log('distinct', new Set(names).size, 'of', names.length, 'bytes/msg', (L.reduce((a, x) => a + x.m.length, 0) / L.length).toFixed(0));
  const tld = {};
  for (const n of names) { const p = n.replace(/\.$/, '').split('.'); const t = p[p.length - 1]; tld[t] = (tld[t] || 0) + 1; }
  console.log('tld top', Object.entries(tld).sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e.join(':')).join(' '), 'ntlds', Object.keys(tld).length);
  const lag = ms.map((m, i) => L[i].rx / 1000 - m.timestamp).filter(x => isFinite(x)).sort((a, b) => a - b);
  console.log('rx - timestamp (s): min', lag[0]?.toFixed(0), 'median', lag[lag.length >> 1]?.toFixed(0), 'p90', lag[Math.floor(lag.length * .9)]?.toFixed(0), 'max', lag[lag.length - 1]?.toFixed(0));
  const lag2 = ms.map((m, i) => m.submission_timestamp ? L[i].rx / 1000 - m.submission_timestamp : NaN).filter(isFinite).sort((a, b) => a - b);
  if (lag2.length) console.log('rx - submission_timestamp (s): min', lag2[0].toFixed(0), 'median', lag2[lag2.length >> 1].toFixed(0), 'max', lag2[lag2.length - 1].toFixed(0));
  const logs = {}; for (const m of ms) logs[m.ct_name] = (logs[m.ct_name] || 0) + 1;
  console.log('ct_name', JSON.stringify(Object.entries(logs).sort((a, b) => b[1] - a[1]).slice(0, 8)));
  console.log('trailing dot', names.filter(n => n.endsWith('.')).length, 'wildcard', names.filter(n => n.startsWith('*')).length, 'idn', names.filter(n => n.includes('xn--')).length);
}
