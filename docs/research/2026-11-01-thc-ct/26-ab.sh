#!/usr/bin/env bash
# DOM-029 instrument 26, copied from the session scratchpad (ab.sh) as it ran on 2026-11-02T04:51Z to 04:55Z.
# The question: whether runKeys 500,000 or 2,000,000 is faster over the same 3,000,000 lines (stage 3, S3-D20).
# The retained comparisons start both rounds with 2,000,000.
# The report is docs/research/2026-11-01-thc-ct.md.
# The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
trap 'echo "conditions {\"instrument\":\"docs/research/2026-11-01-thc-ct/26-ab.sh\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"node\":\"$(node --version)\",\"os\":\"$(uname -sr)\"}" >&2' EXIT
# Supply the path relative to the repository root, or an absolute path.
cd "$(dirname "$0")/../../.." || exit 2
S=docs/research/2026-11-01-thc-ct
head_file=${1:-.tmp/dom029/dl/head/2026-10-31.head.gz}
for round in 1 2; do
  for rk in 2000000 500000; do
    start=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    out=$(node --max-old-space-size=8192 "$S/25-bench-run.mjs" "$head_file" packages/names/test/fixtures/psl-2026-10-27.dat 3000000 "$rk")
    rc=$?
    if [ "$rc" -ne 0 ]; then
      printf '%s round %s runKeys %s exit %s\n' "$start" "$round" "$rk" "$rc" >&2
      exit "$rc"
    fi
    stats=$(node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s.trim().split('\n').at(-1));console.log(JSON.stringify({total_ms:j.total_ms,names_ms:j.names.ms,domains_ms:j.domains.ms,runs:j.stats.runs,rss:j.rss_mib}))})" <<< "$out") || exit $?
    printf '%s round %s runKeys %s %s\n' "$start" "$round" "$rk" "$stats"
  done
done
