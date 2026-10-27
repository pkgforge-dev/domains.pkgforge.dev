#!/usr/bin/env python3
"""Read the public DNS Coffee daily feed page and the JSON the page's own script loads.

Usage: python -I dnscoffee_feed_day.py <YYYY-MM-DD> <outdir> [<ip-for-dns.coffee>]
Step 1 GET https://dns.coffee/feeds?date=<day>  (public HTML; the page embeds a 90-day history array)
Step 2 GET the feeds/data URL that the page's script fetches. Its query carries a short-lived signed
       token that the server puts into every anonymous page view; no account or key is involved.
Writes page.html and data.json and prints the shape of the JSON. At most 2 requests per run.
"""
import json, re, subprocess, sys
day, out = sys.argv[1], sys.argv[2]
resolve = ['--resolve', f'dns.coffee:443:{sys.argv[3]}'] if len(sys.argv) > 3 else []
def get(url, dest, ref=None):
    cmd = ['curl', '-s', '-m', '40'] + resolve + (['-e', ref] if ref else []) + ['-o', dest, '-w', '%{http_code} %{size_download} %{content_type}', url]
    return subprocess.run(cmd, capture_output=True, text=True).stdout
print('page', get(f'https://dns.coffee/feeds?date={day}', f'{out}/page.html'))
t = open(f'{out}/page.html', encoding='utf8').read()
BS = chr(92)  # a literal backslash; the page holds the JSON escape for an ampersand
m = re.search(r'feeds/data.date=[0-9-]+' + re.escape(BS + 'u0026') + r'token=[^"]+', t)
if not m:
    sys.exit('no data URL in page')
u = m.group(0).replace(BS + 'u0026', '&')
print('data', get('https://dns.coffee/' + u, f'{out}/data.json', f'https://dns.coffee/feeds?date={day}'))
try:
    j = json.load(open(f'{out}/data.json', encoding='utf8'))
except Exception as e:
    sys.exit(f'not json: {e}')
def shape(x, d=0):
    if isinstance(x, dict):
        return {k: shape(v, d + 1) for k, v in list(x.items())[:12]}
    if isinstance(x, list):
        return [f'list[{len(x)}]', shape(x[0], d + 1) if x else None]
    return x if not isinstance(x, str) else x[:40]
print(json.dumps(shape(j), indent=1)[:2500])
