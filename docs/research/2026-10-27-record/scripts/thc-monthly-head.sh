#!/bin/sh
# The read-only analysis of the first megabyte of THC's September 2026 monthly CSV, as run on 2026-10-27T08:21:59Z.
# usage: sh thc-monthly-head.sh EMPTY_DIR
# EMPTY_DIR must be a new, empty directory. The data is untrusted: the script only counts and prints, and never runs it.
set -eu
dir="$1"
cd "$dir"
curl -sSL -m 120 -r 0-1048575 -o head1m.csv.gz -w '%{http_code} %{size_download} %{time_total}s\n' \
  'https://huggingface.co/buckets/IP-THC-ORG/Datasets/resolve/2026/10/rdns-sept.csv.gz?download=true'
gzip -dc head1m.csv.gz 2>/dev/null | head -c 3000000 > head1m.csv || true
echo "lines: $(wc -l < head1m.csv)"
echo "field counts:"
awk -F, '{c[NF]++} END{for(k in c) print "  fields="k, c[k]}' head1m.csv
echo "lines with a colon (IPv6): $(grep -c ':' head1m.csv)"
echo "first IPv6 line: $(grep -n -m1 ':' head1m.csv)"
echo "lines whose first field is neither IPv4 nor IPv6: $(awk -F, '$1 !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$/ && $1 !~ /^[0-9a-f:]+$/' head1m.csv | wc -l)"
echo "lines containing cname: $(grep -ci cname head1m.csv)"
echo "distinct addresses: $(cut -d, -f1 head1m.csv | sort -u | wc -l)"
echo "most repeated address:"
cut -d, -f1 head1m.csv | sort | uniq -c | sort -rn | head -1
