// usage: node actions_queue.mjs <run_ids.json> <dir with jobs_<id>.json>
// job queue time = started_at - created_at, grouped by the run's trigger event
import fs from 'node:fs';
const [idsFile, dir] = process.argv.slice(2);
const ids = JSON.parse(fs.readFileSync(idsFile, 'utf8')); const by = {};
for (const r of ids) { let j; try { j = JSON.parse(fs.readFileSync(`${dir}/jobs_${r.id}.json`, 'utf8')); } catch { continue; }
  for (const job of (j.jobs || [])) { if (!job.started_at || !job.created_at) continue; (by[r.ev] ||= []).push((Date.parse(job.started_at) - Date.parse(job.created_at)) / 1000); } }
for (const [k, v] of Object.entries(by)) { v.sort((a, b) => a - b); console.log(k, 'jobs', v.length, 'queue s: min', v[0], 'median', v[v.length >> 1], 'p90', v[Math.floor(v.length * .9)], 'max', v[v.length - 1]); }
