#!/usr/bin/env python3
"""Daily ISC counts per TLD (mean of the 7 UTC days 2026-10-20..26) against ICANN registry reports
(net adds per day of June 2026, the latest month ICANN had published) for chosen TLDs.
Usage: python -I isc_vs_registry.py <isc_dir> <mrr_dir> <tld> [<tld> ...]
  isc_dir:  isc_<DD>.json.gz ; mrr_dir: <tld>-202606.csv (com: com-transactions-202606.csv)
"""
import collections, csv, gzip, json, os, sys
isc_dir, mrr_dir, tlds = sys.argv[1], sys.argv[2], sys.argv[3:]
days = [f'{d:02d}' for d in range(20, 27)]
per = {t: [] for t in tlds}
for d in days:
    c = collections.Counter(r['domainname'].rsplit('.', 1)[-1] for r in json.load(gzip.open(os.path.join(isc_dir, f'isc_{d}.json.gz'), 'rt', encoding='utf8')))
    for t in tlds:
        per[t].append(c[t])
def adds(t):
    p = os.path.join(mrr_dir, f'{t}-202606.csv')
    if not os.path.exists(p):
        p = os.path.join(mrr_dir, f'{t}-transactions-202606.csv')
    rows = [r for r in csv.DictReader(open(p, encoding='utf8', errors='replace')) if r['registrar-name'].strip().lower() != 'totals']
    return sum(int(r[k] or 0) for r in rows for k in r if k and k.startswith('net-adds-')) / 30
print('tld      isc_mean/day  isc_min  isc_max   icann_jun_net_adds/day  ratio(isc_mean/icann)')
tot_i = tot_r = 0
for t in tlds:
    m = sum(per[t]) / len(days); r = adds(t)
    tot_i += m; tot_r += r
    print(f'.{t:7s} {m:12.0f} {min(per[t]):8d} {max(per[t]):8d} {r:16.0f} {m/r:14.2f}')
print(f'sum      {tot_i:12.0f} {"":8s} {"":8s} {tot_r:16.0f} {tot_i/tot_r:14.2f}')
