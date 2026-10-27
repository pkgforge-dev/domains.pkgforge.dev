#!/usr/bin/env python3
"""Share of an ISC day's names that the Zonestream NRD stream also carried on the listed UTC days (a lower
bound on the CT-visible share of new zone entries, since earlier days are not in the window).
Usage: python -I ct_visible_share.py <isc.json.gz> <zs1.tsv> [<zs2.tsv> ...]
"""
import gzip, json, sys
reg = lambda n: '.'.join(n.strip().lower().rstrip('.').split('.')[-2:])
I = {reg(r['domainname']) for r in json.load(gzip.open(sys.argv[1], 'rt', encoding='utf8'))}
Z = set()
for p in sys.argv[2:]:
    Z |= {reg(l.split('\t')[1]) for l in open(p, encoding='utf8') if '\t' in l}
com = {n for n in I if n.endswith('.com')}
print(f'ISC names {len(I)}: in Zonestream days {100*len(I & Z)/len(I):.1f}%;  .com {len(com)}: {100*len(com & Z)/len(com):.1f}%;  non-.com {100*len((I-com) & Z)/len(I-com):.1f}%')
