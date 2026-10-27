#!/usr/bin/env python3
"""Bounded RDAP probe of one registry server: registration dates plus rate-limit behaviour.

Usage:
  python -I rdap_probe.py --base <rdap base ending in /domain/; {tld} is replaced by the name's TLD> --cands <file> --out <jsonl>
        [--spaced N] [--burst N] [--cf N] [--delay S] [--cf-prefix URL]

  <file>: lines "domain<TAB>source<TAB>claimed_date" (claimed_date may be empty).
Requests are made in this order, one domain per request, never more than N_total in all:
  1. --spaced N   requests from this machine, --delay seconds apart
  2. --burst  N   requests from this machine, back to back (to see a limiter, if any)
  3. --cf     N   requests through a Cloudflare Worker fetch service (--cf-prefix), --delay apart,
                  to see the registry from Cloudflare's shared egress
The caller is responsible for keeping spaced+burst+cf <= 30 per server (the research rule).
Output: one JSON object per request (time, vantage, status, ms, limiter headers, dates).
"""
import argparse, json, sys, time, urllib.error, urllib.request
from datetime import datetime, timezone

HDRS = ('retry-after', 'x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-reset', 'ratelimit',
        'ratelimit-policy', 'ratelimit-limit', 'ratelimit-remaining', 'ratelimit-reset', 'x-web-egress',
        'x-web-provider', 'x-web-cache', 'server', 'x-envoy-upstream-service-time')


def one(url, vantage, domain, src, claimed):
    t0 = time.time()
    req = urllib.request.Request(url, headers={'Accept': 'application/rdap+json, application/json',
                                               'User-Agent': 'pkgforge-research/1.0'})
    status, body, hdrs = None, b'', {}
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            status, body, hdrs = r.status, r.read(), dict(r.headers.items())
    except urllib.error.HTTPError as e:
        status, body, hdrs = e.code, e.read(), dict(e.headers.items())
    except Exception as e:  # network error
        status, hdrs = 'ERR:' + type(e).__name__, {}
    ms = int((time.time() - t0) * 1000)
    out = {'t': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'), 'vantage': vantage, 'domain': domain,
           'src': src, 'claimed': claimed, 'http': status, 'ms': ms, 'bytes': len(body)}
    low = {k.lower(): v for k, v in hdrs.items()}
    out['hdr'] = {k: low[k] for k in HDRS if k in low}
    if status == 200:
        try:
            j = json.loads(body)
            ev = {e.get('eventAction'): e.get('eventDate') for e in j.get('events', [])}
            out['registration'] = ev.get('registration')
            out['expiration'] = ev.get('expiration')
            out['last_changed'] = ev.get('last changed')
            out['status'] = j.get('status')
        except Exception as e:
            out['parse_error'] = type(e).__name__
    else:
        out['snippet'] = body[:160].decode('utf8', 'replace')
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--base', required=True)
    ap.add_argument('--cands', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--spaced', type=int, default=0)
    ap.add_argument('--burst', type=int, default=0)
    ap.add_argument('--cf', type=int, default=0)
    ap.add_argument('--delay', type=float, default=1.5)
    ap.add_argument('--cf-prefix', default='https://fetch.web.pkgforge.dev/')
    a = ap.parse_args()
    total = a.spaced + a.burst + a.cf
    if total > 30:
        sys.exit('refusing: more than 30 requests for one server')
    cands = [l.rstrip('\n').split('\t') for l in open(a.cands, encoding='utf8') if l.strip()]
    cands = [(c + ['', ''])[:3] for c in cands][:total]
    if len(cands) < total:
        sys.exit(f'need {total} candidates, have {len(cands)}')
    plan = ['local-spaced'] * a.spaced + ['local-burst'] * a.burst + ['cf'] * a.cf
    with open(a.out, 'w', encoding='utf8') as f:
        for i, (vant, (dom, src, claimed)) in enumerate(zip(plan, cands)):
            url = a.base.replace('{tld}', dom.rsplit('.', 1)[-1]) + dom
            if vant == 'cf':
                url = a.cf_prefix + url
            rec = one(url, vant, dom, src, claimed)
            f.write(json.dumps(rec) + '\n'); f.flush()
            print(rec['t'], vant, dom, rec['http'], rec['ms'], rec.get('registration'), rec['hdr'].get('retry-after', ''))
            if i + 1 < len(plan) and not (vant == 'local-burst' and plan[i + 1] == 'local-burst'):
                time.sleep(a.delay)


if __name__ == '__main__':
    main()
