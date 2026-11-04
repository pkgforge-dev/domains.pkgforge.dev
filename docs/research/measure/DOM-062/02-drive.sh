#!/usr/bin/env bash
# DOM-062 instrument: the drive of https://domains.pkgforge.dev/healthz with
# scripts/measure/edge-load.mjs, and its conditions (TODO/serve.md, DOM-062).
#
# Question: does anything between a scripted caller and the Worker refuse or
# challenge it, at 100 requests a second for 60 s (the entry's Prove), and at
# 250 requests a second for 20 s, which is above the 2,000 requests in 10 s of
# the zone's rate-limit rule `200req/Second`, so that rule fires on the run if
# its exclusion of the host does not hold?
#
# Run from any directory: bash docs/research/measure/DOM-062/02-drive.sh > docs/research/measure/DOM-062/02-drive.out 2>&1
# It writes 02-healthz-100rps.json and 02-healthz-250rps.json beside itself.
# Every exit is read from its own process. It prints no address of the caller.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../../../.." && pwd)
cd "$ROOT" || exit 2
D=docs/research/measure/DOM-062
H=https://domains.pkgforge.dev
DOH=https://cloudflare-dns.com/dns-query
T=$(mktemp -d)

echo "== conditions"
echo "start      $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "place      the operator's workstation (Windows 11), on its own network"
echo "os         $(uname -s -r)"
echo "node       $(node --version)"
curl --version > "$T/curl.txt"; echo "curl       $(head -n 1 "$T/curl.txt" | cut -d' ' -f1-2)"
echo "tree       $(git rev-parse --short=12 HEAD), with the uncommitted scripts/measure/edge-load.mjs of this change"
echo "resolver   DoH $DOH (curl --doh-url, and edge-load.mjs --doh)"
for rr in A AAAA; do
  curl -sS -H 'accept: application/dns-json' "$DOH?name=domains.pkgforge.dev&type=$rr" -o "$T/doh-$rr.json"; e=$?
  echo "doh $rr     exit $e: $(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((d.Answer||[]).map(a=>a.data).join(" "))' "$T/doh-$rr.json")"
done
node -e 'require("dns").lookup("domains.pkgforge.dev",{all:true},(e,a)=>console.log("system     "+(e?e.code:a.map(x=>x.address).join(" "))))'

healthz() {
  curl -sS --doh-url "$DOH" -D "$T/h.txt" -o "$T/h.json" -w '%{http_code}' "$H/healthz" > "$T/code.txt"; e=$?
  colo=$(grep -i '^cf-ray:' "$T/h.txt" | tr -d '\r' | sed 's/.*-//')
  echo "healthz    $(date -u +%Y-%m-%dT%H:%M:%SZ) curl exit $e http $(cat "$T/code.txt") colo $colo body $(tr -d '\n' < "$T/h.json")"
}
healthz

echo
echo "== 1: 100 requests a second for 60 s, warm (the Prove)"
echo "node scripts/measure/edge-load.mjs --url $H/healthz --rps 100 --seconds 60 --expect 200 --prefill 5 --doh $DOH --place operator --out docs/research/measure/DOM-062/02-healthz-100rps.json"
echo "at         $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/measure/edge-load.mjs --url "$H/healthz" --rps 100 --seconds 60 --expect 200 --prefill 5 --doh "$DOH" --place operator --out "$D/02-healthz-100rps.json"
echo "exit       $?"
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
echo "== 2: 250 requests a second for 20 s, warm, above the rule's 2,000 requests in 10 s"
echo "node scripts/measure/edge-load.mjs --url $H/healthz --rps 250 --seconds 20 --expect 200 --prefill 5 --doh $DOH --place operator --out docs/research/measure/DOM-062/02-healthz-250rps.json"
echo "at         $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/measure/edge-load.mjs --url "$H/healthz" --rps 250 --seconds 20 --expect 200 --prefill 5 --doh "$DOH" --place operator --out "$D/02-healthz-250rps.json"
echo "exit       $?"
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
healthz
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rm -rf "$T"
