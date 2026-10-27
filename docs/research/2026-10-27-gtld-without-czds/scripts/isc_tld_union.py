#!/usr/bin/env python3
"""How many TLDs do the ISC dated files cover, and how concentrated are they?  Usage: python -I isc_tld_union.py <isc_dir> <DD> [<DD> ...]"""
import collections, gzip, json, os, sys
c = collections.Counter(); per_day = {}
for d in sys.argv[2:]:
    rows = json.load(gzip.open(os.path.join(sys.argv[1], f'isc_{d}.json.gz'), 'rt', encoding='utf8'))
    t = collections.Counter(r['domainname'].rsplit('.', 1)[-1] for r in rows)
    per_day[d] = len(t); c.update(t)
tot = sum(c.values())
print('tlds per day:', per_day)
print(f'union of TLDs over {len(per_day)} days: {len(c)}; names: {tot}')
top = c.most_common()
for k in (1, 5, 10, 25, 100):
    print(f'top {k:3d} TLDs hold {100*sum(v for _, v in top[:k])/tot:.1f}% of names')
cc = [k for k in c if len(k) == 2 and k.isalpha()]
print('two-letter (cc) TLDs present:', cc[:10], len(cc))
print('IDN (xn--) TLDs present:', sum(1 for k in c if k.startswith('xn--')))
