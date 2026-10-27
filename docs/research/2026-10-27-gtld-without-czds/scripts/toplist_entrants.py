#!/usr/bin/env python3
"""New entrants of a top list between two snapshots, and how many of them the zone-diff feed (ISC) calls new.
Usage: python -I toplist_entrants.py <old.csv> <new.csv> <isc_dir> <DD> [<DD> ...]
Lists are 'rank,domain' (Tranco) ; ISC files are isc_<DD>.json.gz.
"""
import collections, gzip, json, os, sys
def dom(l):
    return l.strip().split(',', 1)[1].lower() if ',' in l else l.strip().lower()
old = {dom(l) for l in open(sys.argv[1], encoding='utf8')}
new = {dom(l) for l in open(sys.argv[2], encoding='utf8')}
ent = new - old
tl = collections.Counter(d.rsplit('.', 1)[-1] for d in ent)
print(f'old={len(old)} new={len(new)} entrants={len(ent)} ({100*len(ent)/len(new):.1f}%)  top tlds: ' + ', '.join(f'.{k}={v}' for k, v in tl.most_common(6)))
isc = set()
for d in sys.argv[4:]:
    isc |= {r['domainname'].lower() for r in json.load(gzip.open(os.path.join(sys.argv[3], f'isc_{d}.json.gz'), 'rt', encoding='utf8'))}
hit = ent & isc
print(f'entrants that ISC lists as new on days {sys.argv[4]}..{sys.argv[-1]}: {len(hit)} ({100*len(hit)/len(ent):.1f}% of entrants)')
print('sample:', sorted(hit)[:8])
