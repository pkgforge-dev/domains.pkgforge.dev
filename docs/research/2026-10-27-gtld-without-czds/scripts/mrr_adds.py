#!/usr/bin/env python3
"""Sum an ICANN monthly registry transactions report (<tld>-transactions-YYYYMM-en.csv).

Usage: python -I mrr_adds.py <csv> <days_in_month>
Prints total-domains, net adds (all terms), net renews, deletes in grace, per-day adds.
"""
import csv, sys

path, days = sys.argv[1], int(sys.argv[2])
rows = [r for r in csv.DictReader(open(path, encoding='utf8', errors='replace')) if r['registrar-name'].strip().lower() != 'totals']  # the report carries its own Totals row
def s(prefix):
    return sum(int(r[k] or 0) for r in rows for k in r if k and k.startswith(prefix))
tot = sum(int(r['total-domains'] or 0) for r in rows)
adds = s('net-adds-')
ren = s('net-renews-')
dgr = sum(int(r['deleted-domains-grace'] or 0) for r in rows)
dng = sum(int(r['deleted-domains-nograce'] or 0) for r in rows)
att = sum(int(r['attempted-adds'] or 0) for r in rows)
agp = sum(int(r['agp-exempted-domains'] or 0) for r in rows)
print(f'registrars={len(rows)} total_domains={tot}')
print(f'net_adds={adds} per_day={adds/days:.0f}  net_renews={ren}  deleted_grace={dgr} deleted_nograce={dng} agp_exempted={agp} attempted_adds={att}')
print(f'adds_if_grace_deletes_were_added_back={adds+dgr} per_day={(adds+dgr)/days:.0f}')
print('totals row excluded; rows = registrars')
top = sorted(rows, key=lambda r: -sum(int(r[k] or 0) for k in r if k and k.startswith('net-adds-')))[:5]
print('top registrars by adds:', [(r['registrar-name'][:28], sum(int(r[k] or 0) for k in r if k and k.startswith('net-adds-'))) for r in top])
