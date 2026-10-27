#!/usr/bin/env python3
"""How many of each ISC day's names (all gTLD, and .com only) appear in a hagezi nrdN list?
Usage: python -I hagezi_lag.py <nrd7.txt> <isc_dir> <DD> [<DD> ...]   (isc_dir holds isc_<DD>.json.gz)
"""
import gzip, json, os, sys
def reg(n):
    p = n.strip().lower().rstrip('.').split('.')
    return '.'.join(p[-2:])
H = {reg(l) for l in open(sys.argv[1], encoding='utf8') if l.strip() and not l.startswith('#')}
print('hagezi distinct', len(H), ' .com', sum(1 for n in H if n.endswith('.com')))
print('isc_day  rows   in_hagezi%  com_rows com_in_hagezi%')
for d in sys.argv[3:]:
    rows = {reg(r['domainname']) for r in json.load(gzip.open(os.path.join(sys.argv[2], f'isc_{d}.json.gz'), 'rt', encoding='utf8'))}
    com = {n for n in rows if n.endswith('.com')}; non = rows - com
    print(f'{d}   {len(rows):7d}  {100*len(rows & H)/len(rows):5.1f}%   {len(com):7d}  {100*len(com & H)/max(1,len(com)):5.1f}%   non-com in {100*len(non & H)/max(1,len(non)):5.1f}%')
