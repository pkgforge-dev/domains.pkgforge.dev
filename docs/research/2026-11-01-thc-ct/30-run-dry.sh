#!/usr/bin/env bash
# DOM-029 instrument 30, copied from .tmp/dom029/dry/run-dry.sh as it ran on 2026-11-02T07:58:51Z to 09:29:56Z.
# The question: whether a backfill leg of 2026-10-26 and the live run with a null cursor write and verify both segments of a real day, with no push, and what each costs (stage 4).
# Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
# The report is docs/research/2026-11-01-thc-ct.md.
# The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
trap 'echo "conditions {\"instrument\":\"docs/research/2026-11-01-thc-ct/30-run-dry.sh\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"node\":\"$(node --version)\",\"os\":\"$(uname -sr)\"}" >&2' EXIT
# The dry run of DOM-029 stage 4: a backfill leg of 2026-10-26 under the plan's
# state and list, then the live run (cursor null), each with --no-push and no
# REGISTRY_TOKEN, each through the measuring wrapper, each exit from its own process.
set -u
cd "$(dirname "$0")/../../.."
W="docs/research/2026-11-01-thc-ct/29-measure-run.mjs"
unset REGISTRY_TOKEN
echo "bf start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rc=0
node --max-old-space-size=8192 "$W" scripts/ingest/run.mjs .tmp/dom029/dry/bf.measure.json --adapter thc-ct --out .tmp/dom029/dry/bf --psl .tmp/dom029/dry/plan/psl-1f96bae40adf.dat --state .tmp/dom029/dry/plan/state.json --from 2026-10-26T00:00:00Z --to 2026-10-27T00:00:00Z --run 1 --no-push > .tmp/dom029/dry/bf.out 2> .tmp/dom029/dry/bf.err || rc=$?
echo "bf exit $rc end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "live start $(date -u +%Y-%m-%dT%H:%M:%SZ)"
rc=0
node --max-old-space-size=8192 "$W" scripts/ingest/run.mjs .tmp/dom029/dry/live.measure.json --adapter thc-ct --out .tmp/dom029/dry/live --psl root --run 1 --no-push > .tmp/dom029/dry/live.out 2> .tmp/dom029/dry/live.err || rc=$?
echo "live exit $rc end $(date -u +%Y-%m-%dT%H:%M:%SZ)"
