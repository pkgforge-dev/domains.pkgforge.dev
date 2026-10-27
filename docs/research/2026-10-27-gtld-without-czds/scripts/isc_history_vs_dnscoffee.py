#!/usr/bin/env python3
"""Fetch ISC dated files (one request each) for chosen dates and compare their row counts with the
DNS Coffee 90-day 'new' history embedded in the public page (saved copy).
Usage: python -I isc_history_vs_dnscoffee.py <dnscoffee_feeds.html> <outdir> <YYYY-MM-DD> [<YYYY-MM-DD> ...]
"""
import gzip, json, os, re, sys, urllib.request
html = open(sys.argv[1], encoding='utf8').read()
h = json.loads(re.search(r'var history = (\{.*?\});', html, re.S).group(1))
new = dict(zip(h['dates'], h['new']))
print('date        isc_rows  isc_com  dnscoffee_new  ratio')
rs = []
for d in sys.argv[3:]:
    p = os.path.join(sys.argv[2], f'isc_{d}.json.gz')
    if not os.path.exists(p):
        req = urllib.request.Request(f'https://isc.sans.edu/feeds/domaindata.{d}.json.gz', headers={'User-Agent': 'pkgforge-research/1.0'})
        open(p, 'wb').write(urllib.request.urlopen(req, timeout=60).read())  # the default Python-urllib agent gets 403
    rows = json.load(gzip.open(p, 'rt', encoding='utf8'))
    com = sum(1 for r in rows if r['domainname'].endswith('.com'))
    r = len(rows) / new[d] if d in new else float('nan')
    rs.append(r)
    print(f'{d}  {len(rows):8d}  {com:7d}  {new.get(d, 0):13d}  {r:.3f}')
ok = [r for r in rs if r == r]
print(f'mean ratio {sum(ok)/len(ok):.3f} min {min(ok):.3f} max {max(ok):.3f} over {len(ok)} days')
