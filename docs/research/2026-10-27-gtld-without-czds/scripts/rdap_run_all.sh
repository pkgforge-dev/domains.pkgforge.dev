#!/bin/sh
# Run the bounded RDAP probe against the eight non-Verisign registry servers (14 requests each),
# one server per background process, so no server sees more than its own 14.
# Usage: sh rdap_run_all.sh <candidate_dir> <outdir> <path_to_rdap_probe.py>
C="$1"; O="$2"; P="$3"
run() { python -I "$P" --base "$2" --cands "$C/$1.tsv" --out "$O/$1.jsonl" --spaced 6 --burst 4 --cf 4 --delay 2 > "$O/$1.log" 2>&1 & }
run pir        "https://rdap.publicinterestregistry.org/rdap/domain/"
run identity   "https://rdap.identitydigital.services/rdap/domain/"
run centralnic "https://rdap.centralnic.com/{tld}/domain/"
run zdns       "https://rdap.zdnsgtld.com/top/domain/"
run gmo        "https://rdap.gmoregistry.net/rdap/domain/"
run radix      "https://rdap.radix.host/rdap/domain/"
run google     "https://pubapi.registry.google/rdap/domain/"
run vip        "https://rdap.nic.vip/domain/"
wait
