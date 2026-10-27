// usage: node actions_history.mjs <runs.json> [cronKind: q15 | h3]
// analyses a `runs?event=schedule` listing of a GitHub workflow: count, gaps between scheduled runs, conclusions
import fs from 'node:fs';
const [f, kind] = process.argv.slice(2);
const j = JSON.parse(fs.readFileSync(f, 'utf8'));
const rs = j.workflow_runs.map(r => ({ c: new Date(r.created_at), concl: r.conclusion })).sort((a, b) => a.c - b.c);
const gaps = []; for (let i = 1; i < rs.length; i++) gaps.push((rs[i].c - rs[i - 1].c) / 60000); gaps.sort((a, b) => a - b);
const days = (rs[rs.length - 1].c - rs[0].c) / 86400000;
const perDay = kind === 'q15' ? 96 : 8;
const conc = {}; rs.forEach(r => conc[r.concl] = (conc[r.concl] || 0) + 1);
console.log(f, 'total_count', j.total_count, 'returned', rs.length, 'span_days', days.toFixed(2), 'expected_runs', Math.round(days * perDay));
console.log(' first', rs[0].c.toISOString(), 'last', rs[rs.length - 1].c.toISOString());
console.log(' gap minutes: min', gaps[0].toFixed(1), 'median', gaps[gaps.length >> 1].toFixed(1), 'p90', gaps[Math.floor(gaps.length * .9)].toFixed(1), 'max', gaps[gaps.length - 1].toFixed(1));
console.log(' conclusions', JSON.stringify(conc));
