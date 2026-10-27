#!/usr/bin/env python3
"""Where do the names of one Rankvance Free daily export sit in the ISC dated files, hagezi nrd7,
WhoisDS and the Zonestream NRD names of the same day?
Usage: python -I rankvance_overlap.py <rv.csv> <isc_dir> <hagezi_nrd7.txt> <whoisds_dir> <zs.tsv> <DD> [<DD> ...]
  isc_dir: isc_<DD>.json.gz ; whoisds_dir: whoisds_2026-10-<DD>.zip ; <DD> are the ISC days to test.
"""
import collections, csv, gzip, json, os, sys, zipfile
rv_path, isc_dir, hag, wdir, zs_path = sys.argv[1:6]
days = sys.argv[6:]
reg = lambda n: '.'.join(n.strip().lower().rstrip('.').split('.')[-2:])
rv = {reg(r['domain']) for r in csv.DictReader(open(rv_path, encoding='utf8'))}
c = collections.Counter(n.rsplit('.', 1)[-1] for n in rv)
cc = sum(v for k, v in c.items() if len(k) == 2 and k.isalpha())
print(f'rankvance: {len(rv)} distinct names; ccTLD {100*cc/len(rv):.1f}%; tlds {len(c)}; .com {c["com"]} ({100*c["com"]/len(rv):.1f}%); top ' + ', '.join(f'.{k}={v}' for k, v in c.most_common(8)))
rvg = {n for n in rv if not (len(n.rsplit('.', 1)[-1]) == 2)}
print('overlap of the gTLD part (%d names) with:' % len(rvg))
for d in days:
    I = {reg(r['domainname']) for r in json.load(gzip.open(os.path.join(isc_dir, f'isc_{d}.json.gz'), 'rt', encoding='utf8'))}
    print(f'  ISC day {d}: {len(rvg & I):7d} = {100*len(rvg & I)/len(rvg):5.1f}% of RV, {100*len(rvg & I)/len(I):5.1f}% of that ISC day')
H = {reg(l) for l in open(hag, encoding='utf8') if l.strip() and not l.startswith('#')}
print(f'  hagezi nrd7: {len(rvg & H)} = {100*len(rvg & H)/len(rvg):.1f}% of RV')
for d in days[-3:]:
    p = os.path.join(wdir, f'whoisds_2026-10-{d}.zip')
    if os.path.exists(p):
        z = zipfile.ZipFile(p); W = {reg(l) for l in z.read(z.namelist()[0]).decode().split('\n') if l.strip()}
        print(f'  WhoisDS file {d}: {len(rvg & W)} = {100*len(rvg & W)/len(W):.1f}% of that 70k file')
Z = {reg(l.split('\t')[1]) for l in open(zs_path, encoding='utf8') if '\t' in l}
print(f'  Zonestream NRD same day: {len(rvg & Z)} = {100*len(rvg & Z)/len(rvg):.1f}% of RV, {100*len(rvg & Z)/len(Z):.1f}% of ZS')
