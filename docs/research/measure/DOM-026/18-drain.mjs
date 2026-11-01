// Follows the drain of DOM-026: for each completed ingest-live run created at or after SINCE,
// reads its log once (gh, read-only) and appends one JSON line to .tmp/dom026/drain.jsonl:
// run, sha, conclusion, the kafka leg's start and end, the segment and verdict counts,
// and behind_s of each source from the stats line. Exits 0 once a run has every behind_s
// under 1200, 3 after MAX hours. Usage: node docs/research/measure/DOM-026/18-drain.mjs SINCE_ISO [MAX_HOURS].
// 18-drain.jsonl beside it is a copy of the .tmp/dom026/drain.jsonl that the run of
// 2026-11-01 wrote: 21 runs, created 2026-11-01T00:30:19Z to 03:50:25Z.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const REPO = 'pkgforge-dev/domains.pkgforge.dev';
const OUT = '.tmp/dom026/drain.jsonl';
const since = process.argv[2];
const maxMs = Number(process.argv[3] ?? 6) * 3600_000;
const t0 = Date.now();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const gh = (args) => spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 512 << 20 });
const seen = new Set(existsSync(OUT) ? readFileSync(OUT, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).run) : []);

for (;;) {
  const l = gh(['run', 'list', '--repo', REPO, '--workflow', 'ingest-live.yml', '--limit', '20', '--json', 'databaseId,headSha,status,conclusion,createdAt']);
  if (l.status === 0) {
    const runs = JSON.parse(l.stdout).filter((r) => r.createdAt >= since && r.status === 'completed' && !seen.has(r.databaseId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    for (const r of runs) {
      const v = gh(['run', 'view', String(r.databaseId), '--repo', REPO, '--json', 'jobs']);
      const jobs = v.status === 0 ? JSON.parse(v.stdout).jobs : [];
      const leg = jobs.find((j) => j.name.startsWith('ingest'));
      const log = gh(['run', 'view', String(r.databaseId), '--repo', REPO, '--log']);
      const text = log.status === 0 ? log.stdout : '';
      const statsLine = text.split('\n').find((x) => /\tstats oi-nrd \{/.test(x) || / stats oi-nrd \{/.test(x));
      let stats = null;
      if (statsLine) stats = JSON.parse(statsLine.slice(statsLine.indexOf('{')));
      const segs = (text.match(/ segment obs:/g) ?? []).length;
      const ok = (text.match(/ segment obs:.* verdict ok/g) ?? []).length;
      const faults = text.split('\n').filter((x) => / fault /.test(x) && !/echo/.test(x)).length;
      const behind = stats ? Object.fromEntries(Object.entries(stats).filter(([k]) => k.endsWith('.behind_s'))) : null;
      const row = { run: r.databaseId, sha: r.headSha.slice(0, 7), created: r.createdAt, conclusion: r.conclusion, leg: leg ? { conclusion: leg.conclusion, start: leg.startedAt, end: leg.completedAt } : null, segments: segs, ok, faults, behind, messages: stats ? Object.fromEntries(Object.entries(stats).filter(([k]) => k.endsWith('.messages'))) : null };
      appendFileSync(OUT, `${JSON.stringify(row)}\n`);
      seen.add(r.databaseId);
      console.log(`${new Date().toISOString()} ${JSON.stringify(row)}`);
      if (behind && Object.keys(behind).length === 3 && Object.values(behind).every((b) => b < 1200)) process.exit(0);
    }
  } else console.log(`${new Date().toISOString()} gh exited ${l.status}`);
  if (Date.now() - t0 > maxMs) process.exit(3);
  await sleep(120_000);
}
