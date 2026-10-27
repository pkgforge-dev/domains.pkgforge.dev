#!/usr/bin/env python3
"""Second candidate set for the non-Verisign RDAP servers: 14 per server, stratified and seeded.
  5 isc-only : in ISC 2026-10-26, not in the Zonestream NRD names of 10-25 or 10-26
  5 zs-only  : in Zonestream NRD of 2026-10-22, not in any ISC file 10-19..10-26
  4 both     : in Zonestream NRD of 2026-10-22 and in an ISC file of 10-22..10-24
Usage: python -I rdap_cands2.py <isc_dir> <zs_dir> <outdir>
"""
import gzip, json, os, random, sys
random.seed(20261028)
isc_dir, zs_dir, outdir = sys.argv[1:4]
reg = lambda n: '.'.join(n.strip().lower().rstrip('.').split('.')[-2:])
isc = {d: {reg(r['domainname']) for r in json.load(gzip.open(os.path.join(isc_dir, f'isc_{d}.json.gz'), 'rt', encoding='utf8'))} for d in range(19, 27)}
zs = lambda f: {reg(l.split('\t')[1]) for l in open(os.path.join(zs_dir, f), encoding='utf8') if '\t' in l}
z22, z25, z26 = zs('nrd_1022.tsv'), zs('nrd_1025.tsv'), zs('nrd_1026.tsv')
allisc = set().union(*isc.values())
groups = {'pir': ['org'], 'identity': ['info'], 'centralnic': ['xyz', 'cfd', 'sbs', 'bond', 'lol'], 'zdns': ['top'],
          'gmo': ['shop'], 'radix': ['online', 'site', 'store'], 'google': ['app', 'dev'], 'vip': ['vip']}
for g, tl in groups.items():
    f = lambda s: {x for x in s if x.rsplit('.', 1)[-1] in tl}
    iso = sorted(f(isc[26]) - z25 - z26); zso = sorted(f(z22) - allisc); both = sorted(f(z22) & (isc[22] | isc[23] | isc[24]))
    rows = [(d, 'isc-only', 'isc:2026-10-26') for d in random.sample(iso, min(5, len(iso)))]
    rows += [(d, 'zs-only', 'zs:2026-10-22') for d in random.sample(zso, min(5, len(zso)))]
    rows += [(d, 'both', 'zs:2026-10-22') for d in random.sample(both, min(4, len(both)))]
    random.shuffle(rows)
    open(os.path.join(outdir, g + '.tsv'), 'w', encoding='utf8').write(''.join('\t'.join(r) + '\n' for r in rows))
    print(g, len(rows), 'pools', len(iso), len(zso), len(both))
