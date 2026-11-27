#!/usr/bin/env bash
# DOM-029 instrument 32, copied from the session scratchpad (s4-tests.sh) as it ran on 2026-11-02T08:57Z to 09:06Z.
# The question: whether the tests of each directory stage 4 touched pass, each exit code from its own process (stage 4).
# Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
# The report is docs/research/2026-11-01-thc-ct.md.
# The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
trap 'echo "conditions {\"instrument\":\"docs/research/2026-11-01-thc-ct/32-s4-tests.sh\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"node\":\"$(node --version)\",\"os\":\"$(uname -sr)\"}" >&2' EXIT
# Each touched directory's tests, each exit from its own process.
cd "$(dirname "$0")/../../.."
for d in scripts/ingest scripts/workflows scripts/compact scripts/state; do
  s=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  rc=0
  node scripts/test.mjs "$d" > "$TEMP/s4-$(echo "$d" | tr / -).txt" 2>&1 || rc=$?
  n=$(grep -E "^ℹ tests " "$TEMP/s4-$(echo "$d" | tr / -).txt" | awk '{print $3}')
  f=$(grep -E "^ℹ fail " "$TEMP/s4-$(echo "$d" | tr / -).txt" | awk '{print $3}')
  echo "$d exit $rc tests $n fail $f start $s end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
done
