#!/usr/bin/env python3
"""Summarise a Zonestream WebSocket sample (JSON lines): rate, gTLD share, TLD top, cert age.
Usage: python -I zonestream_summary.py <jsonl> <seconds_sampled>
"""
import collections, json, sys

path, secs = sys.argv[1], float(sys.argv[2])
rows = []
for l in open(path, encoding='utf8'):
    l = l.strip()
    if l:
        try:
            rows.append(json.loads(l))
        except Exception:
            pass
n = len(rows)
doms = [r.get('domain', '').rstrip('.').lower() for r in rows if r.get('domain')]
tlds = collections.Counter(d.rsplit('.', 1)[-1] for d in doms)
g = sum(v for k, v in tlds.items() if not (len(k) == 2 and k.isalpha()))
print(f'messages={n} per_s={n/secs:.2f} per_day={n/secs*86400:.0f} distinct={len(set(doms))}')
if doms:
    print(f'gTLD share={100*g/len(doms):.1f}%  .com={tlds.get("com",0)} ({100*tlds.get("com",0)/len(doms):.1f}%)')
    print('top:', ', '.join(f'.{k}={v}' for k, v in tlds.most_common(12)))
ages = [r['timestamp'] - r['submission_timestamp'] for r in rows if 'submission_timestamp' in r and 'timestamp' in r]
if ages:
    ages.sort()
    print(f'cert age at event (s): median={ages[len(ages)//2]:.0f} p10={ages[len(ages)//10]:.0f} p90={ages[9*len(ages)//10]:.0f}; >7d={100*sum(1 for a in ages if a>7*86400)/len(ages):.0f}%')
if rows:
    print('keys:', sorted(rows[0].keys()))
    conf = [r.get('confidence') for r in rows if 'confidence' in r]
    if conf:
        print('confidence dist:', sorted(collections.Counter(conf).items()))
    zone = sum(1 for r in rows if r.get('ct_name') == 'zone_data')
    if zone:
        print(f'zone_data rows={zone} ({100*zone/n:.1f}%)')
