#!/usr/bin/env bash
# DOM-030 instrument, copied from .tmp/dom030/prove.sh as it ran at 2026-11-02T07:58:41Z
# to 07:58:50Z, with this header added. Its output is 10-prove.out, byte for
# byte. The deploy before it printed 10-deploy.txt (TODO/serve.md, DOM-030).
# Run from any directory: it writes only to a directory of mktemp.
# .tmp/dom030/prove.sh, as it ran:
# DOM-030's Prove against the deployed Worker, read-only; each exit is read from
# its own process (curl's output goes to a file first, then jq reads it).
set -u
H=https://domains.pkgforge.dev
DOH="--doh-url https://cloudflare-dns.com/dns-query"
G=https://ghcr.io/v2/pkgforge-dev/domains.pkgforge.dev/root/manifests/latest
ACC='Accept: application/vnd.oci.image.manifest.v1+json'
T=$(mktemp -d)
echo "start $(date -u +%Y-%m-%dT%H:%M:%SZ)"

curl -sS $DOH "$H/healthz" -o "$T/h.json"; echo "1 curl healthz exit $?"
jq '{ok, version, root_age_s}' "$T/h.json"; echo "1 jq exit $?"

curl -sS $DOH -D "$T/i.h" "$H/v1/index/latest" -o "$T/i.json"; echo "2 curl index exit $?"
grep -i '^x-domains-root\|^access-control-allow-origin' "$T/i.h"; echo "2 grep exit $?"
echo "2 all x-domains headers:"; grep -i '^x-domains-\|^cache-control\|^content-type\|^HTTP/' "$T/i.h"

curl -sS -H 'Authorization: Bearer QQ==' -H "$ACC" "$G" -o "$T/m.json"; echo "3 curl ghcr manifest exit $?"
jq .artifactType "$T/m.json"; echo "3 jq exit $?"

# Line 4: the two reads in the same second.
curl -sS -D "$T/g.h" -o /dev/null -H 'Authorization: Bearer QQ==' -H "$ACC" "$G"; e1=$?
curl -sS $DOH "$H/v1/index/latest" -o "$T/i2.json"; e2=$?
echo "4 at $(date -u +%Y-%m-%dT%H:%M:%SZ) ghcr exit $e1 worker exit $e2"
grep -i '^docker-content-digest' "$T/g.h"; echo "4 grep exit $?"
jq -r .data.root "$T/i2.json"; echo "4 jq exit $?"
jq -r .data.root "$T/i.json"; echo "3 the route's data.root, read in step 2"

echo "5 POST healthz: $(curl -sS $DOH -o /dev/null -w '%{http_code}' -X POST "$H/healthz")"
echo "extra GET / : $(curl -sS $DOH -o /dev/null -w '%{http_code} %{content_type}' "$H/")"
echo "extra GET /nothing : $(curl -sS $DOH -o /dev/null -w '%{http_code}' "$H/nothing")"
echo "end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rm -rf "$T"
