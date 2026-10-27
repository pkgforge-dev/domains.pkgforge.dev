#!/usr/bin/env python3
"""Where do Zonestream NRD names of one day sit in the ISC dated files (same day, earlier days, never)?
Usage: python -I zs_vs_isc_days.py <zs.tsv> <isc_dir> <DD_of_zs_day> <DD> [<DD> ...]   (isc files isc_<DD>.json.gz)
"""
import gzip, json, os, sys, collections
def reg(n):
    p = n.strip().lower().rstrip('.').split('.')
    return '.'.join(p[-2:])
zs = {reg(l.split('\t')[1]) for l in open(sys.argv[1], encoding='utf8') if '\t' in l}
day = sys.argv[3]; days = sys.argv[4:]
isc = {d: {reg(r['domainname']) for r in json.load(gzip.open(os.path.join(sys.argv[2], f'isc_{d}.json.gz'), 'rt', encoding='utf8'))} for d in days}
for label, filt in (('all gTLD', lambda n: True), ('.com', lambda n: n.endswith('.com')), ('non-.com', lambda n: not n.endswith('.com'))):
    Z = {n for n in zs if filt(n) and not (len(n.rsplit('.',1)[-1]) == 2)}
    c = collections.Counter()
    for n in Z:
        where = [d for d in days if n in isc[d]]
        if not where: c['not in any ISC day'] += 1
        elif day in where: c['ISC same day'] += 1
        elif min(where) < day: c['ISC earlier day only'] += 1
        else: c['ISC later day only'] += 1
    print(f'{label}: zs names={len(Z)}  ' + '; '.join(f'{k}={v} ({100*v/len(Z):.1f}%)' for k, v in c.most_common()))
