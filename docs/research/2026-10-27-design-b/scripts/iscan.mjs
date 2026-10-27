import fs from 'node:fs'; import zlib from 'node:zlib';
for (const f of process.argv.slice(2)) {
  const j = JSON.parse(zlib.gunzipSync(fs.readFileSync(f)).toString('utf8'));
  const fs_ = {}; const tld = {}; const sc = {}; let dots = {}; let ip0 = 0;
  for (const r of j) { fs_[r.firstseen] = (fs_[r.firstseen] || 0) + 1; const p = r.domainname.split('.'); tld[p[p.length - 1]] = (tld[p[p.length - 1]] || 0) + 1; sc[r.score + '|' + r.scorereason] = (sc[r.score + '|' + r.scorereason] || 0) + 1; dots[p.length] = (dots[p.length] || 0) + 1; if (!r.ip) ip0++; }
  console.log('==', f, 'records', j.length, 'keys', Object.keys(j[0]).join(','));
  console.log(' firstseen', JSON.stringify(Object.entries(fs_).sort()));
  console.log(' labels', JSON.stringify(dots));
  console.log(' tld top', Object.entries(tld).sort((a, b) => b[1] - a[1]).slice(0, 12).map(e => e.join(':')).join(' '), 'ntld', Object.keys(tld).length);
  console.log(' score', JSON.stringify(Object.entries(sc).sort((a, b) => b[1] - a[1]).slice(0, 6)), 'ip0', ip0);
}
