import fs from 'node:fs'; import zlib from 'node:zlib';
const iscC = {}; const isc = (d) => iscC[d] ??= new Set(JSON.parse(zlib.gunzipSync(fs.readFileSync(`dl_isc/${d}.json.gz`)).toString()).map(r => r.domainname));
const who = (d) => new Set(fs.readFileSync(`dl_whoisds/${d}.txt`, 'utf8').split('\n').filter(Boolean).map(s => s.toLowerCase()));
const inter = (a, b) => { let c = 0; for (const x of a) if (b.has(x)) c++; return c; };
for (const d of ['2026-10-26', '2026-10-25', '2026-10-24']) { const I = isc(d), W = who(d); console.log(d, 'ISC', I.size, 'WhoisDS', W.size, 'both', inter(I, W), 'WhoisDS in ISC same day', (inter(I, W) / W.size * 100).toFixed(1) + '%'); }
const W26 = who('2026-10-26'), W25 = who('2026-10-25');
console.log('W26 in ISC25', inter(W26, isc('2026-10-25')), 'W26 in ISC24', inter(W26, isc('2026-10-24')), 'W25 in ISC26', inter(W25, isc('2026-10-26')), 'W25 in ISC24', inter(W25, isc('2026-10-24')));
const zd = fs.readFileSync('oi/raw/newly_registered_domain.ndjson', 'utf8').split('\n').filter(Boolean).map(l => { const m = JSON.parse(JSON.parse(l).m); return { d: m.domain.replace(/\.$/, ''), ts: m.timestamp, sub: m.submission_timestamp }; });
const days = ['2026-10-26', '2026-10-25', '2026-10-24', '2026-10-21', '2026-10-20'];
const inAny = (z) => days.some(d => isc(d).has(z.d));
const old = zd.filter(z => z.ts - z.sub > 30 * 86400), fresh = zd.filter(z => z.ts - z.sub < 86400);
console.log('Zonestream sample', zd.length, 'in any ISC list (5 days)', zd.filter(inAny).length);
console.log(' old cert >30d:', old.length, 'in ISC', old.filter(inAny).length, '| fresh cert <1d:', fresh.length, 'in ISC', fresh.filter(inAny).length);
