#!/usr/bin/env python3
"""TLD mix of a Zonestream day file written by zonestream_kafka_window.mjs.  Usage: python -I zs_day_tlds.py <tsv> [<tsv> ...]"""
import collections, sys
for p in sys.argv[1:]:
    rows = [l.rstrip('\n').split('\t') for l in open(p, encoding='utf8') if '\t' in l]
    d = [r[1] for r in rows]
    c = collections.Counter(x.rsplit('.', 1)[-1] for x in d)
    cc = sum(v for k, v in c.items() if len(k) == 2 and k.isalpha())
    print(f'{p.rsplit("/",1)[-1]}: messages={len(d)} distinct={len(set(d))} tlds={len(c)} ccTLD={cc} ({100*cc/len(d):.2f}%) .com={c["com"]} ({100*c["com"]/len(d):.1f}%) top: ' + ', '.join(f'.{k}={v}' for k, v in c.most_common(6)))
