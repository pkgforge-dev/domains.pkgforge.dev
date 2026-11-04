#!/usr/bin/env bash
# DOM-062 instrument: the drive of https://domains.pkgforge.dev/healthz with
# scripts/measure/edge-load.mjs, and its conditions (TODO/serve.md, DOM-062).
#
# Question: as 02-drive.sh asks, with every request from one source address.
# 02-drive.sh's 250 requests a second went out over both of the caller's
# families (2,923 over IPv6 and 2,077 over IPv4, 02-healthz-250rps.json), so
# no one source address passed 2,000 requests in 10 s, and the rule
# `200req/Second` counts per source address and colo. This drive passes
# --family 4: the 100 requests a second for 60 s of the Prove, then 300 requests
# a second for 30 s, 3,000 in each 10 s from one IPv4 address, 1.5 times the
# rule's 2,000. The rule fires on that run if its exclusion of the host does
# not hold.
#
# Run from any directory: bash docs/research/measure/DOM-062/03-drive.sh > docs/research/measure/DOM-062/03-drive.out 2>&1
# It writes 03-healthz-100rps-ipv4.json and 03-healthz-300rps-ipv4.json beside itself.
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
echo "resolver   DoH $DOH (curl -4 --doh-url, and edge-load.mjs --doh --family 4)"
for rr in A AAAA; do
  curl -sS -H 'accept: application/dns-json' "$DOH?name=domains.pkgforge.dev&type=$rr" -o "$T/doh-$rr.json"; e=$?
  echo "doh $rr     exit $e: $(node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log((d.Answer||[]).map(a=>a.data).join(" "))' "$T/doh-$rr.json")"
done
node -e 'require("dns").lookup("domains.pkgforge.dev",{all:true},(e,a)=>console.log("system     "+(e?e.code:a.map(x=>x.address).join(" "))))'

healthz() {
  curl -4 -sS --doh-url "$DOH" -D "$T/h.txt" -o "$T/h.json" -w '%{http_code}' "$H/healthz" > "$T/code.txt"; e=$?
  colo=$(grep -i '^cf-ray:' "$T/h.txt" | tr -d '\r' | sed 's/.*-//')
  echo "healthz    $(date -u +%Y-%m-%dT%H:%M:%SZ) curl exit $e http $(cat "$T/code.txt") colo $colo body $(tr -d '\n' < "$T/h.json")"
}
healthz

echo
echo "== 1: 100 requests a second for 60 s, warm, IPv4 (the Prove)"
echo "node scripts/measure/edge-load.mjs --url $H/healthz --rps 100 --seconds 60 --expect 200 --prefill 5 --doh $DOH --family 4 --place operator --out docs/research/measure/DOM-062/03-healthz-100rps-ipv4.json"
echo "at         $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/measure/edge-load.mjs --url "$H/healthz" --rps 100 --seconds 60 --expect 200 --prefill 5 --doh "$DOH" --family 4 --place operator --out "$D/03-healthz-100rps-ipv4.json"
echo "exit       $?"
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
echo "== 2: 300 requests a second for 30 s, warm, IPv4: 3,000 in each 10 s, above the rule's 2,000"
echo "node scripts/measure/edge-load.mjs --url $H/healthz --rps 300 --seconds 30 --expect 200 --prefill 5 --doh $DOH --family 4 --place operator --out docs/research/measure/DOM-062/03-healthz-300rps-ipv4.json"
echo "at         $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/measure/edge-load.mjs --url "$H/healthz" --rps 300 --seconds 30 --expect 200 --prefill 5 --doh "$DOH" --family 4 --place operator --out "$D/03-healthz-300rps-ipv4.json"
echo "exit       $?"
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
healthz
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rm -rf "$T"
