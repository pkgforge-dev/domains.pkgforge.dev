#!/usr/bin/env python3
"""Compare DNS Coffee's embedded 90-day history (a saved copy of https://dns.coffee/feeds)
with the ISC dated files.  No key: the history is a JSON literal inside the public page.

Usage: python -I dnscoffee_vs_isc.py <feeds.html> <isc_dir> [YYYY-MM-DD ...]
<isc_dir> holds files named isc_<DD>.json.gz (domaindata.<date>.json.gz saved under that name).
"""
import gzip, json, re, sys, os

html = open(sys.argv[1], encoding='utf8').read()
m = re.search(r'var history = (\{.*?\});', html, re.S)
h = json.loads(m.group(1))
new = dict(zip(h['dates'], h['new']))
old = dict(zip(h['dates'], h['old']))
print(f'DNS Coffee history: {h["dates"][0]}..{h["dates"][-1]} ({len(h["dates"])} days); mean new/day={sum(h["new"])/len(h["new"]):.0f}')
isc_dir = sys.argv[2]
days = sys.argv[3:] or sorted(new)[-9:]
print('date        dnscoffee_new  isc_rows  isc_com  ratio(isc/dc)')
for d in days:
    p = os.path.join(isc_dir, 'isc_' + d[8:] + '.json.gz')
    if not os.path.exists(p):
        print(d, new.get(d), '-'); continue
    rows = json.load(gzip.open(p, 'rt', encoding='utf8'))
    com = sum(1 for r in rows if r['domainname'].endswith('.com'))
    print(f'{d}  {new.get(d, 0):>12}  {len(rows):>8}  {com:>7}  {len(rows)/new[d]:.3f}')
