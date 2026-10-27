// scripts/todo/next.mjs — what can be worked on now: every entry that is not
// done, in waves derived from the `Depends on` lines. Wave 1 has no open
// dependency, though a blocked entry there still waits on its blocker and a
// waiting one on its time; wave n needs only waves before it, each entry the
// ones it names. Within a wave, P0 comes first. PROGRESS.md's "Start here next
// session" is written from this, and check 12 of scripts/todo/check.mjs refuses
// a work order that lists an entry before an open dependency. An entry with a
// `- **Waiting:** until <UTC>; …` line (docs/methodology/work-todo.md) is shown
// as waiting, or as due once that instant has passed.
//
//   node scripts/todo/next.mjs           the waves
//   node scripts/todo/next.mjs --json    machine-readable
// Exit: 0 printed · 1 the dependencies form a cycle (check 8 also fails).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { ID_PREFIX, parseRows, PRIORITIES, TODO_DIR } from './count.mjs';

const ID_RE = new RegExp(`\\b${ID_PREFIX}-\\d{3}\\b`, 'g');

// The waves of the pending entries. `pending` is [{id, priority}]; `deps` maps
// an id to the pending ids it needs. Returns {waves} or {cycle: [ids]}.
export function buildWaves(pending, deps) {
  const waves = [];
  const placed = new Set();
  while (placed.size < pending.length) {
    const wave = pending.filter((r) => !placed.has(r.id) && deps.get(r.id).every((d) => placed.has(d)));
    if (!wave.length) return { cycle: pending.filter((r) => !placed.has(r.id)).map((r) => r.id) };
    wave.sort((a, b) => PRIORITIES.indexOf(a.priority) - PRIORITIES.indexOf(b.priority) || a.id.localeCompare(b.id));
    for (const r of wave) placed.add(r.id);
    waves.push(wave);
  }
  return { waves };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const rows = parseRows(readFileSync(join(TODO_DIR, 'INDEX.md'), 'utf8'));
  const files = new Map();
  const section = (r) => {
    if (!files.has(r.file)) files.set(r.file, readFileSync(join(TODO_DIR, r.file), 'utf8'));
    const body = files.get(r.file);
    const at = body.search(new RegExp(`^## ${r.id}\\b`, 'm'));
    if (at === -1) return '';
    const after = body.slice(at);
    const end = after.slice(1).search(/^## /m);
    return end === -1 ? after : after.slice(0, end + 1);
  };

  // An entry that must wait for time: `- **Waiting:** until <ISO 8601 UTC>; <then>`.
  const waitingOf = (r) => {
    const line = section(r).match(/^- \*\*Waiting:\*\* until (\S+?);?\s(.*)$/m);
    if (!line) return null;
    const at = Date.parse(line[1]);
    if (Number.isNaN(at)) return { until: line[1], due: false, then: line[2], malformed: true };
    return { until: line[1], due: Date.now() >= at, then: line[2] };
  };

  // Each entry's title is its heading: `## DOM-NNN <dash or colon> <title>`.
  const titleOf = (r) => section(r).match(new RegExp(`^## ${r.id}\\s*[\\u2014\\u2013:-]+\\s*(.*)$`, 'm'))?.[1] ?? '(no title)';
  const pending = rows.filter((r) => r.status !== 'done');
  const isPending = new Set(pending.map((r) => r.id));
  const deps = new Map(
    pending.map((r) => {
      const line = section(r).match(/^- \*\*Depends on:\*\* (.*)$/m)?.[1] ?? '';
      return [r.id, [...new Set(line.match(ID_RE) ?? [])].filter((d) => d !== r.id && isPending.has(d))];
    }),
  );

  const built = buildWaves(pending, deps);
  if (built.cycle) {
    console.error(`cycle among: ${built.cycle.join(', ')}`);
    process.exit(1);
  }

  if (args.json) {
    console.log(
      JSON.stringify(
        built.waves.map((w) => w.map((r) => ({ id: r.id, priority: r.priority, status: r.status, item: titleOf(r), needs: deps.get(r.id), waiting: waitingOf(r) }))),
        null,
        2,
      ),
    );
    return;
  }
  built.waves.forEach((wave, i) => {
    console.log(i === 0 ? 'wave 1: no open dependency (a [blocked] entry waits on its blocker, a waiting one on its time):' : `wave ${i + 1}: each after the entries it needs:`);
    for (const r of wave) {
      const needs = deps.get(r.id);
      const w = waitingOf(r);
      const wait = !w ? '' : w.malformed ? `  (Waiting line unreadable: ${w.until})` : w.due ? `  (DUE since ${w.until}: ${w.then})` : `  (waiting until ${w.until})`;
      console.log(`  ${r.priority} ${r.id} ${r.status === 'open' ? '' : `[${r.status}] `}${titleOf(r)}${needs.length ? `  (needs ${needs.join(', ')})` : ''}${wait}`);
    }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
