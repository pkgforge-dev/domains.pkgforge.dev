#!/usr/bin/env python3
"""Summarise rdap_probe.py output files.
Usage: python -I rdap_summary.py <jsonl> [<jsonl> ...]
Per file: statuses by vantage, latency, limiter headers seen, and, per source stratum, how many names
had an RDAP registration date within 4 days before the day the feed claimed them (new), earlier (old),
or were not found (404).  The claimed day is the date in the 'claimed' field (isc:/zs: prefix allowed).
"""
import collections, datetime, json, statistics, sys

def claimed_day(c):
    return datetime.date.fromisoformat(c.split(':')[-1])

tot = collections.defaultdict(collections.Counter)
for path in sys.argv[1:]:
    rows = [json.loads(l) for l in open(path, encoding='utf8') if l.strip()]
    print(f'== {path.rsplit("/",1)[-1]}  n={len(rows)}  {rows[0]["t"]}..{rows[-1]["t"]}')
    for v in ('local-spaced', 'local-burst', 'cf'):
        r = [x for x in rows if x['vantage'] == v]
        if not r:
            continue
        st = collections.Counter(str(x['http']) for x in r)
        ms = [x['ms'] for x in r]
        print(f'  {v:13s} n={len(r):2d} status={dict(st)} ms median={statistics.median(ms):.0f} max={max(ms)}')
    hdrs = collections.Counter()
    for x in rows:
        for k, val in x['hdr'].items():
            if k.startswith(('x-ratelimit', 'ratelimit', 'retry-after')):
                hdrs[f'{k}={val}'] += 1
    print('  limiter headers:', dict(hdrs) if hdrs else 'none seen')
    by = collections.defaultdict(collections.Counter)
    for x in rows:
        reg = x.get('registration')
        if x['http'] == 404:
            k = 'not-found'
        elif x['http'] != 200:
            k = f'http-{x["http"]}'
        elif reg is None:
            k = 'no-registration-event'
        else:
            age = (claimed_day(x['claimed']) - datetime.date.fromisoformat(reg[:10])).days
            k = 'new(<=4d)' if -1 <= age <= 4 else 'old'
        by[x['src']][k] += 1
        tot[x['src']][k] += 1
    for s, c in sorted(by.items()):
        print(f'  src={s:9s} n={sum(c.values()):2d} ' + ', '.join(f'{k}={v}' for k, v in c.most_common()))
print('== all files')
for s, c in sorted(tot.items()):
    n = sum(c.values())
    print(f'  src={s:9s} n={n:3d} ' + ', '.join(f'{k}={v}' for k, v in c.most_common()))
