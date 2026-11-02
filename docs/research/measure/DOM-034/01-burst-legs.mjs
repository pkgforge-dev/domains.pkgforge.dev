// DOM-034 instrument, copied from .tmp/dom063/legs.mjs as it ran on 2026-11-02T01:32:25Z. Run from the
// repository root: node docs/research/measure/DOM-034/01-burst-legs.mjs 2026-11-01T12:00:00Z
// Lists ingest-live runs created from a given instant with the start of each
// job, read-only, and prints the gaps between successive ingest-leg starts.
import { execFileSync } from 'node:child_process'

const repo = 'pkgforge-dev/domains.pkgforge.dev'
const from = process.argv[2] ?? '2026-11-01T12:00:00Z'
const gh = (args) => JSON.parse(execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 1 << 26 }))
const runs = gh(['run', 'list', '--repo', repo, '--workflow', 'ingest-live.yml', '--limit', '80', '--json', 'databaseId,event,headSha,createdAt,status,conclusion'])
  .filter((r) => r.createdAt >= from)
  .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
const legs = []
for (const r of runs) {
  const jobs = gh(['api', `repos/${repo}/actions/runs/${r.databaseId}/attempts/1/jobs`]).jobs
  const pick = (p) => jobs.find((j) => j.name.startsWith(p))
  const ingest = pick('ingest')
  const chain = pick('chain')
  console.log(`${r.databaseId} ${r.event} ${r.headSha.slice(0, 7)} created ${r.createdAt} ${r.status}/${r.conclusion ?? '-'} chain ${chain?.started_at ?? '-'} ingest ${ingest?.started_at ?? '-'}..${ingest?.completed_at ?? '-'}`)
  if (ingest?.started_at) legs.push([r.databaseId, ingest.started_at])
}
legs.sort((a, b) => a[1].localeCompare(b[1]))
let max = 0
for (let i = 1; i < legs.length; i++) {
  const gap = (Date.parse(legs[i][1]) - Date.parse(legs[i - 1][1])) / 60000
  if (gap > max) max = gap
  console.log(`gap ${legs[i - 1][0]} -> ${legs[i][0]} ${gap.toFixed(2)} min`)
}
console.log(`legs ${legs.length} max_gap_min ${max.toFixed(2)}`)
