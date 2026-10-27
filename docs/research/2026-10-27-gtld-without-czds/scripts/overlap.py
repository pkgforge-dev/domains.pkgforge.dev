#!/usr/bin/env python3
"""Set overlaps between keyless newly-registered-domain feeds for one UTC day, overall and for .com.

Usage: python -I overlap.py <day-DD> <isc.json.gz> <zs_nrd.tsv> <zs_confirmed.tsv> <nrd7.txt> <whoisds.zip> [<whoisds_prev.zip>]
Names are reduced to their last two labels (all gTLD registrable names are two labels).
Prints |A|, |B|, |A&B|, |A&B|/|A|, |A&B|/|B| for each pair, then a capture-recapture (Lincoln-Petersen)
estimate N = |A||B|/|A&B| for the pairs (an under-estimate when the feeds share a bias).
"""
import collections, gzip, itertools, json, sys, zipfile

def reg(n):
    p = n.strip().lower().rstrip('.').split('.')
    return '.'.join(p[-2:]) if len(p) >= 2 else n

def is_g(n):
    t = n.rsplit('.', 1)[-1]
    return not (len(t) == 2 and t.isalpha())

day, isc, zs, conf, nrd7, who = sys.argv[1:7]
who_prev = sys.argv[7] if len(sys.argv) > 7 else None
S = {}
S['isc'] = {reg(r['domainname']) for r in json.load(gzip.open(isc, 'rt', encoding='utf8'))}
S['zs_nrd'] = {reg(l.split('\t')[1]) for l in open(zs, encoding='utf8') if '\t' in l}
rows = [l.rstrip('\n').split('\t') for l in open(conf, encoding='utf8') if '\t' in l]
S['zs_conf'] = {reg(r[1]) for r in rows}
S['zs_conf_c>=5'] = {reg(r[1]) for r in rows if len(r) > 2 and int(r[2]) >= 5}
S['hagezi7'] = {reg(l) for l in open(nrd7, encoding='utf8') if l.strip() and not l.startswith('#')}
for name, p in (('whoisds', who), ('whoisds_prev', who_prev)):
    if p:
        z = zipfile.ZipFile(p)
        S[name] = {reg(l) for l in z.read(z.namelist()[0]).decode().split('\n') if l.strip()}
for k in S:
    S[k] = {n for n in S[k] if is_g(n)}
print(f'-- day {day}: distinct gTLD registrable names per feed')
for k, v in S.items():
    c = sum(1 for n in v if n.endswith('.com'))
    print(f'{k:14s} n={len(v):8d}  .com={c:7d}')
def table(filt, title):
    print(f'-- overlaps {title}')
    ks = list(S)
    print('A (rows) vs B (cols): |A&B|/|A|')
    print(' ' * 14 + ''.join(f'{k:>14s}' for k in ks))
    for a in ks:
        A = {n for n in S[a] if filt(n)}
        print(f'{a:14s}' + ''.join(f'{(100*len(A & {n for n in S[b] if filt(n)})/max(1,len(A))):13.1f}%' for b in ks))
table(lambda n: True, 'all gTLD')
table(lambda n: n.endswith('.com'), '.com only')
print('-- Lincoln-Petersen N = |A||B|/|A&B| (.com only; independence assumed)')
for a, b in itertools.combinations(['isc', 'zs_nrd', 'zs_conf', 'hagezi7', 'whoisds'], 2):
    A = {n for n in S[a] if n.endswith('.com')}; B = {n for n in S[b] if n.endswith('.com')}
    if A and B and A & B:
        print(f'{a:8s} x {b:8s}  N_est={len(A)*len(B)/len(A & B):9.0f}   (|A|={len(A)} |B|={len(B)} |A&B|={len(A & B)})')
print('-- union sizes (.com): isc|zs_nrd =', len({n for n in S['isc'] | S['zs_nrd'] if n.endswith('.com')}),
      ' isc|zs_nrd|zs_conf =', len({n for n in S['isc'] | S['zs_nrd'] | S['zs_conf'] if n.endswith('.com')}))
