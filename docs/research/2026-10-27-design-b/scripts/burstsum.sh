#!/bin/sh
# usage: burstsum.sh <file of "<http_code> <seconds>" lines> <label>
awk -v L="$2" '{c[$1]++; t[NR]=$2} END{for(k in c) printf "%s status %s: %d\n",L,k,c[k]; n=asort(t); printf "%s latency s: min %.2f med %.2f p95 %.2f max %.2f\n", L, t[1], t[int(n/2)], t[int(n*.95)], t[n]}' "$1"
