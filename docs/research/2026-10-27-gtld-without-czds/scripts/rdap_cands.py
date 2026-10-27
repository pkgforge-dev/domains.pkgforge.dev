#!/usr/bin/env python3
"""Build per-server RDAP candidate files (domain<TAB>source<TAB>claimed_date), seeded and stratified.

Usage: python -I rdap_cands.py <isc_26.json.gz> <zs_nrd_1026.tsv> <isc_dir> <outdir>
Verisign (com + net) gets 30: 5 in both ISC and Zonestream, 10 ISC-only, 10 Zonestream-only (not in any
ISC day 19..26), 5 .net from ISC.  Every other server gets 14 random ISC names of its TLDs.
"""
import gzip, json, os, random, sys
random.seed(20261027)
isc_gz, zs_tsv, isc_dir, outdir = sys.argv[1:5]
def reg(n):
    p = n.strip().lower().rstrip('.').split('.'); return '.'.join(p[-2:])
isc = [reg(r['domainname']) for r in json.load(gzip.open(isc_gz, 'rt', encoding='utf8'))]
isc_set = set(isc)
zs = {}
for l in open(zs_tsv, encoding='utf8'):
    p = l.rstrip('\n').split('\t')
    if len(p) >= 2: zs[reg(p[1])] = p[0]
allisc = set()
for d in range(19, 27):
    allisc |= {reg(r['domainname']) for r in json.load(gzip.open(os.path.join(isc_dir, f'isc_{d}.json.gz'), 'rt', encoding='utf8'))}
def pick(pool, n): return random.sample(sorted(pool), n)
com = lambda s: {x for x in s if x.endswith('.com')}
both = com(isc_set) & set(zs)
isc_only = com(isc_set) - set(zs)
zs_only = com(set(zs)) - allisc
rows = [(d, 'isc+zs', '2026-10-26') for d in pick(both, 5)]
rows += [(d, 'isc-only', '2026-10-26') for d in pick(isc_only, 10)]
rows += [(d, 'zs-only', 'zs:2026-10-26') for d in pick(zs_only, 10)]
rows += [(d, 'isc', '2026-10-26') for d in pick({x for x in isc_set if x.endswith('.net')}, 5)]
random.shuffle(rows)
def w(name, rs):
    with open(os.path.join(outdir, name), 'w', encoding='utf8') as f:
        for r in rs: f.write('\t'.join(r) + '\n')
w('verisign.tsv', rows)
groups = {'pir': ['org'], 'identity': ['info'], 'centralnic': ['xyz', 'cfd', 'sbs', 'bond', 'lol'], 'zdns': ['top'],
          'gmo': ['shop'], 'radix': ['online', 'site', 'store'], 'google': ['app', 'dev'], 'vip': ['vip']}
for g, tlds in groups.items():
    pool = {x for x in isc_set if x.rsplit('.', 1)[-1] in tlds}
    w(g + '.tsv', [(d, 'isc', '2026-10-26') for d in pick(pool, 14)])
print('written', sorted(os.listdir(outdir)))
