#!/usr/bin/env python3
"""Sum the ISC dated files over whole months, per TLD, to compare with ICANN monthly registry reports
and with a zone-derived monthly count.  One GET per day; files are parsed in memory and not kept.
Usage: python -I isc_month_sum.py <out.json> <YYYY-MM> [<YYYY-MM> ...]
Output JSON: {"YYYY-MM": {"days": n, "rows": n, "per_tld": {"com": n, ...top 30...}, "daily_com": {...}}}
"""
import calendar, collections, gzip, io, json, sys, time, urllib.request
out = {}
for ym in sys.argv[2:]:
    y, m = map(int, ym.split('-'))
    per = collections.Counter(); rows = 0; days = 0; daily_com = {}
    for d in range(1, calendar.monthrange(y, m)[1] + 1):
        date = f'{y}-{m:02d}-{d:02d}'
        url = f'https://isc.sans.edu/feeds/domaindata.{date}.json.gz'
        try:
            req = urllib.request.Request(url, headers={'User-Agent': 'pkgforge-research/1.0'})
            data = urllib.request.urlopen(req, timeout=90).read()
        except Exception as e:
            print(date, 'ERR', type(e).__name__, flush=True)
            continue
        j = json.load(gzip.open(io.BytesIO(data), 'rt', encoding='utf8'))
        c = collections.Counter(r['domainname'].rsplit('.', 1)[-1] for r in j)
        per.update(c); rows += len(j); days += 1; daily_com[date] = c['com']
        print(date, len(j), c['com'], flush=True)
        time.sleep(0.3)
    out[ym] = {'days': days, 'rows': rows, 'per_tld': dict(per.most_common(30)), 'daily_com': daily_com}
json.dump(out, open(sys.argv[1], 'w'), indent=1)
print('done', {k: (v['days'], v['rows'], v['per_tld'].get('com')) for k, v in out.items()})
