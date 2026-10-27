#!/usr/bin/env python3
"""Does the Common Crawl URL index of one crawl contain a sample of newly registered .com names?
Usage: python -I cc_index_coverage.py <nrd_list.txt> <crawl-id e.g. CC-MAIN-2026-43> <n> [seed]
One request per name to https://index.commoncrawl.org/<crawl>-index, 1.2 s apart, limit=1, no key.
Names are random .com registrable names (last two labels) from the list.
"""
import json, random, sys, time, urllib.request
path, crawl, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
random.seed(int(sys.argv[4]) if len(sys.argv) > 4 else 1)
names = sorted({'.'.join(l.strip().lower().split('.')[-2:]) for l in open(path, encoding='utf8') if l.strip() and not l.startswith('#') and l.strip().endswith('.com')})
pick = random.sample(names, n)
hit = answered = 0
for d in pick:
    url = f'https://index.commoncrawl.org/{crawl}-index?url={d}&matchType=domain&limit=1&output=json'
    for attempt in (1, 2):  # one retry: the public index server often answers 504 or drops the connection
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers={'User-Agent': 'pkgforge-research/1.0'}), timeout=45) as r:
                body = r.read().decode()
                ok = bool(body.strip())
                code = r.status
        except urllib.error.HTTPError as e:
            code = e.code; ok = False
        except Exception as e:
            code = type(e).__name__; ok = False
        if code in (200, 404):
            break
        time.sleep(3)
    answered += code in (200, 404)
    hit += ok
    print(d, code, 'IN_INDEX' if ok else '-', flush=True)
    time.sleep(1.2)
print(f'{crawl}: {hit}/{n} sampled names present in the index; {answered}/{n} requests answered 200 or 404')
