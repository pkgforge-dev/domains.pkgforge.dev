#!/usr/bin/env python3
"""Per-TLD distribution of newly-registered-domain feeds.

Usage: python -I nrd_tld_dist.py <feed> <path> [<feed> <path> ...]
  feed: isc | whoisds | hagezi
Prints, per feed: rows, distinct registrable-ish names, gTLD share, top TLDs, .com count.
A "gTLD" here is any label that is not exactly two ASCII letters (ccTLDs) and not xn--.
Registrable name = last two labels for single-label TLDs; for a 2-letter ccTLD the
last two labels are kept too (good enough for a count; no PSL is used).
"""
import collections, gzip, io, json, sys, zipfile


def tld(name):
    return name.rsplit('.', 1)[-1].lower()


def is_cc(t):
    return len(t) == 2 and t.isalpha()


def read(feed, path):
    if feed == 'isc':
        rows = json.load(gzip.open(path, 'rt', encoding='utf8'))
        return [r['domainname'].lower() for r in rows], rows
    if feed == 'whoisds':
        z = zipfile.ZipFile(path)
        return [l.strip().lower() for l in z.read(z.namelist()[0]).decode().split('\n') if l.strip()], None
    if feed == 'hagezi':
        out = []
        for l in open(path, encoding='utf8', errors='replace'):
            if l.startswith('#'):
                continue
            l = l.strip().lower()
            if l:
                out.append(l)
        return out, None
    raise SystemExit('unknown feed ' + feed)


def reg(name):
    p = name.split('.')
    return '.'.join(p[-2:]) if len(p) >= 2 else name


def main(argv):
    for feed, path in zip(argv[0::2], argv[1::2]):
        names, raw = read(feed, path)
        regs = set(reg(n) for n in names)
        c = collections.Counter(tld(n) for n in regs)
        tot = sum(c.values())
        g = sum(v for k, v in c.items() if not is_cc(k))
        print(f'== {feed} {path.rsplit("/",1)[-1]}')
        print(f'rows={len(names)} distinct_regs={tot} gTLD={g} ({100*g/tot:.1f}%) ccTLD={tot-g} tlds={len(c)}')
        print('top: ' + ', '.join(f'.{k}={v}' for k, v in c.most_common(15)))
        if raw:
            fs = collections.Counter(r.get('firstseen') for r in raw)
            print('firstseen: ' + ', '.join(f'{k}={v}' for k, v in sorted(fs.items())[:8]))
            print('with_ip_pct: %.1f' % (100 * sum(1 for r in raw if r.get('ip')) / len(raw)))


if __name__ == '__main__':
    main(sys.argv[1:])
