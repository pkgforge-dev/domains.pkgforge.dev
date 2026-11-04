#!/usr/bin/env bash
# DOM-062 instrument: the drive of https://domains.pkgforge.dev/healthz with
# scripts/measure/edge-load.mjs over one HTTP/2 connection, and its conditions
# (TODO/serve.md, DOM-062).
#
# Question: does anything between a scripted caller and the Worker refuse or
# challenge it, when every request leaves from one source address: at 100
# requests a second for 60 s (the entry's Prove), and at 300 requests a second
# for 30 s, 3,000 in each 10 s, 1.5 times the 2,000 in 10 s per source address
# and colo of the zone's rate-limit rule `200req/Second`? That rule fires on
# the second run if its exclusion of the host does not hold.
#
# Why one HTTP/2 connection: the caller's network gives each new connection one
# of several public addresses (step 0 counts them, and prints no address), so
# 02-drive.sh and 03-drive.sh, over pools of HTTP/1.1 connections, could not
# hold their requests to one source address. One connection keeps one.
#
# Run from any directory: bash docs/research/measure/DOM-062/05-drive.sh > docs/research/measure/DOM-062/05-drive.out 2>&1
# It writes 05-healthz-100rps-h2.json and 05-healthz-300rps-h2.json beside itself.
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
echo "== 0: the caller's IPv4 source addresses, over 20 new connections"
echo "curl -4 $H/cdn-cgi/trace, 20 times; each ip= line is read, and only the count of distinct values and their order as labels A, B, ... are printed"
fails=0
for i in $(seq 1 20); do
  curl -4 -sS --doh-url "$DOH" "$H/cdn-cgi/trace" -o "$T/trace-$i.txt" || fails=$((fails + 1))
done
echo "failed     $fails of 20"
for i in $(seq 1 20); do grep -h '^ip=' "$T/trace-$i.txt"; done > "$T/ips.txt"
node -e 'const l=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n");const m=new Map();const s=l.map(x=>{if(!m.has(x))m.set(x,String.fromCharCode(65+m.size));return m.get(x)});console.log("labels     "+s.join("")+" ("+l.length+" read, "+m.size+" distinct)")' "$T/ips.txt"
rm -f "$T"/trace-*.txt "$T/ips.txt"

echo
echo "== 1: 100 requests a second for 60 s, warm, IPv4, one HTTP/2 connection (the Prove)"
echo "node scripts/measure/edge-load.mjs --url $H/healthz --rps 100 --seconds 60 --expect 200 --prefill 5 --doh $DOH --family 4 --h2 --place operator --out docs/research/measure/DOM-062/05-healthz-100rps-h2.json"
echo "at         $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/measure/edge-load.mjs --url "$H/healthz" --rps 100 --seconds 60 --expect 200 --prefill 5 --doh "$DOH" --family 4 --h2 --place operator --out "$D/05-healthz-100rps-h2.json"
echo "exit       $?"
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
echo "== 2: 300 requests a second for 30 s, warm, IPv4, one HTTP/2 connection: 3,000 in each 10 s, above the rule's 2,000"
echo "node scripts/measure/edge-load.mjs --url $H/healthz --rps 300 --seconds 30 --expect 200 --prefill 5 --doh $DOH --family 4 --h2 --place operator --out docs/research/measure/DOM-062/05-healthz-300rps-h2.json"
echo "at         $(date -u +%Y-%m-%dT%H:%M:%SZ)"
node scripts/measure/edge-load.mjs --url "$H/healthz" --rps 300 --seconds 30 --expect 200 --prefill 5 --doh "$DOH" --family 4 --h2 --place operator --out "$D/05-healthz-300rps-h2.json"
echo "exit       $?"
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"

echo
healthz
echo "end        $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rm -rf "$T"
