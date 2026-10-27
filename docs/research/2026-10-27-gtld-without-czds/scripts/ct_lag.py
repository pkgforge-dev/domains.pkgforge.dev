#!/usr/bin/env python3
"""Hours from the RDAP registration time to the Zonestream NRD event time, for probed names the stream carried.
Usage: python -I ct_lag.py <verisign.jsonl> <zs_nrd_day.tsv> [<zs_nrd_day2.tsv>]
"""
import datetime, json, sys
reg = lambda n: '.'.join(n.strip().lower().rstrip('.').split('.')[-2:])
ev = {}
for p in sys.argv[2:]:
    for l in open(p, encoding='utf8'):
        t = l.rstrip('\n').split('\t')
        if len(t) >= 2:
            ev.setdefault(reg(t[1]), int(t[0]))
out = []
for l in open(sys.argv[1], encoding='utf8'):
    r = json.loads(l)
    if r['http'] == 200 and r.get('registration') and r['domain'] in ev and r['registration'][:10] >= '2026-10-24':
        rt = datetime.datetime.fromisoformat(r['registration'].replace('Z', '+00:00')).timestamp()
        out.append((round((ev[r['domain']] - rt) / 3600, 1), r['domain'], r['src']))
for o in sorted(out):
    print(o)
if out:
    h = sorted(o[0] for o in out)
    print(f'n={len(h)} median={h[len(h)//2]} h, min={h[0]}, max={h[-1]}')
