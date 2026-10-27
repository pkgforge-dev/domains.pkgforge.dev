#!/usr/bin/env python3
"""Ratios of ISC month sums (output of isc_month_sum.py) to ICANN monthly registry net adds of the same month.
Usage: python -I isc_month_ratios.py <month_sums.json> <YYYY-MM> <mrr_dir> <tld> [<tld> ...]
  mrr_dir holds <tld>-<YYYYMM>.csv (the ICANN <tld>-transactions-<YYYYMM>-en.csv reports, renamed).
Prints per-TLD ratio and the ratio of the sums.
"""
import csv, json, os, sys
sums, ym, mrr, tlds = json.load(open(sys.argv[1])), sys.argv[2], sys.argv[3], sys.argv[4:]
v = sums[ym]
tot_i = tot_r = 0
for t in tlds:
    p = os.path.join(mrr, f'{t}-{ym.replace("-", "")}.csv')
    rows = [r for r in csv.DictReader(open(p, encoding='utf8', errors='replace')) if r['registrar-name'].strip().lower() != 'totals']
    ref = sum(int(r[k] or 0) for r in rows for k in r if k and k.startswith('net-adds-'))
    isc = v['per_tld'].get(t, 0)
    tot_i += isc; tot_r += ref
    print(f'.{t:8s} isc={isc:9d} icann_net_adds={ref:9d} ratio={isc/ref:.2f}')
print(f'sum      isc={tot_i} icann={tot_r} ratio={tot_i/tot_r:.3f}')
