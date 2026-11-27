// DOM-029 instrument 27, copied from the session scratchpad (mutate-s3.mjs) as it ran on 2026-11-02T04:42Z.
// The question: whether each guard of adapters/thc-ct/src can fail a test (stage 3 mutation pass).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import { fileURLToPath } from 'node:url';
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/27-mutate-s3.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Scratch mutation pass of adapters/thc-ct/src (stage 3 of DOM-029). Each
// mutant replaces one text that occurs exactly once, runs the named test file
// under node --test, and counts as killed only when a test FAILS (a line
// starting with the cross mark and a failing-tests summary), never on a crash
// alone. Every file is restored from the bytes read first, checked byte-equal.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const A = join(ROOT, 'adapters/thc-ct');
const T = join(A, 'test/thc-ct.test.ts');
const S = join(A, 'test/sorter.test.ts');
const M = [
  ['pass encoding ignored', 'src/pass.ts', 'if (encoding !== null && encoding.trim().toLowerCase() !== "identity") {', 'if (false) {', T],
  ['pass content-length ignored', 'src/pass.ts', 'Number(declared.trim()) !== c.bytes)', 'false)', T],
  ['pass short body kept', 'src/pass.ts', 'if (total !== c.bytes || block !== null)', 'if (false)', T],
  ['pass format threshold off', 'src/pass.ts', 'share > limits.refusedFault', 'share > 2', T],
  ['pass empty kept', 'src/pass.ts', 'if (kept === 0) throw', 'if (false) throw', T],
  ['pass size unchecked', 'src/pass.ts', 'if (c.bytes > limits.maxFileBytes)', 'if (false)', T],
  ['pass wildcard flag lost', 'src/pass.ts', 'n.wild ? FLAG_WILDCARD : FLAG_EXACT', 'FLAG_EXACT', T],
  ['pass timeout as host fault', 'src/pass.ts', 'if (isTimeout(err)) throw new HostFault(c.host, "timeout", `GET ${c.url} found', 'if (false) throw new HostFault(c.host, "timeout", `GET ${c.url} found', T],
  ['pass no identity encoding asked', 'src/pass.ts', '"accept-encoding": "identity" }, signal', '"accept-encoding": "gzip" }, signal', T],
  ['pass format before empty swapped', 'src/pass.ts', 'if (nonEmpty > 0 && share > limits.refusedFault)', 'if (kept > 0 && nonEmpty > 0 && share > limits.refusedFault)', T],
  ['lines CR not stripped', 'src/lines.ts', '=== 13) {', '=== 14) {', T],
  ['lines last line dropped', 'src/lines.ts', 'if (last.length > 0) {', 'if (false) {', T],
  ['lines empty not counted', 'src/lines.ts', 'counts.empty += 1;', '', T],
  ['sorter OR across runs lost', 'src/sorter.ts', 'flags |= heap[0]!.flags[heap[0]!.at]!;', 'flags = heap[0]!.flags[heap[0]!.at]!;', S],
  ['sorter OR within a run lost', 'src/sorter.ts', 'm.set(key, was === undefined ? flags : was | flags);', 'm.set(key, flags);', S],
  ['sorter equal keys not folded', 'src/sorter.ts', 'while (heap.length > 0 && heap[0]!.key === key) {', 'while (false) {', S],
  ['sorter last run not sealed', 'src/sorter.ts', 'if (this.gathering.size > 0) this.seal();', '', S],
  ['day domains keyed by name', 'src/day.ts', 'regs.add(key(reg), 0);', 'regs.add(k, 0);', T],
  ['day sources at the next day', 'src/day.ts', 'Object.freeze({ bit: BIT, first: d, last: d })', 'Object.freeze({ bit: BIT, first: d, last: d + 1 })', T],
  ['day url dropped', 'src/day.ts', '    url: c.url,\n', '', T],
  ['day unfinished skipped', 'src/day.ts', 'if (budget.gets <= 0) return { kind: "unfinished", faults };', 'if (budget.gets <= 0) continue;', T],
  ['day cursorAfter unmoved', 'src/day.ts', 'cursorAfter: { day: nextDay(day) },', 'cursorAfter: { day },', T],
  ['locate live order reversed', 'src/locate.ts', 'return [() => this.cs2(day), () => this.hf(day)];', 'return [() => this.hf(day), () => this.cs2(day)];', T],
  ['locate backfill order reversed', 'src/locate.ts', 'return [() => this.hf(day), () => this.cs2(day)];', 'return [() => this.cs2(day), () => this.hf(day)];', T],
  ['locate listing failure absent', 'src/locate.ts', 'if (err instanceof HostFault) return { fault: err };', 'if (err instanceof HostFault) return { absent: "hf", detail: err.message };', T],
  ['locate 404 a fault', 'src/locate.ts', 'if (res.status === 404) return { absent: "cs2"', 'if (res.status === 405) return { absent: "cs2"', T],
  ['locate path from the date', 'src/locate.ts', 'url: `${this.hosts.resolve}${e.path}?download=true`', 'url: `${this.hosts.resolve}${day.slice(0, 4)}/${Number(day.slice(5, 7))}/${day}.txt.gz?download=true`', T],
  ['locate off-origin link followed', 'src/locate.ts', 'if (u.origin !== origin) throw', 'if (false) throw', T],
  ['locate day twice kept', 'src/locate.ts', 'if (was !== undefined) throw bad', 'if (false) throw bad', T],
  ['locate pages unbounded', 'src/locate.ts', 'if (page > limits.maxListingPages) throw', 'if (false) throw', T],
  ['index late boundary', 'src/index.ts', 'if (nowMs < lateAt(day, limits)) break;', 'if (nowMs <= lateAt(day, limits)) break;', T],
  ['index gap boundary next', 'src/index.ts', '      if (nowMs >= gapAt(day, limits)) {\n        declare(day, o);\n        next = nextDay(day);', '      if (nowMs > gapAt(day, limits)) {\n        declare(day, o);\n        next = nextDay(day);', T],
  ['index gap boundary open', 'src/index.ts', 'else if (nowMs >= gapAt(day, limits)) {', 'else if (nowMs > gapAt(day, limits)) {', T],
  ['index budget ignored', 'src/index.ts', 'files < limits.maxFilesPerRun && budget.gets > 0', 'files < limits.maxFilesPerRun', T],
  ['index files per run ignored', 'src/index.ts', 'files < limits.maxFilesPerRun && budget.gets > 0', 'budget.gets > 0', T],
  ['index written open day kept', 'src/index.ts', 'if (o.kind === "written") open.splice(open.indexOf(day), 1);', 'if (o.kind === "written") void 0;', T],
  ['index faulted next goes on', 'src/index.ts', 'if (nowMs < lateAt(day, limits)) break;', 'if (nowMs < lateAt(day, limits)) { next = nextDay(day); continue; }', T],
  ['index backfill gap boundary', 'src/index.ts', '      if (nowMs >= gapAt(day, limits)) {\n        gaps.push', '      if (nowMs > gapAt(day, limits)) {\n        gaps.push', T],
  ['index host fault stat lost', 'src/index.ts', 'for (const f of o.faults) this.hostFaults.set', 'for (const f of []) this.hostFaults.set', T],
  ['index open-full guard off', 'src/index.ts', 'if (open.length >= limits.maxOpen) {', 'if (false) {', T],
  ['cursor null starts today', 'src/cursor.ts', 'return { next: nextDay(today(now), -1), open: [] };', 'return { next: today(now), open: [] };', T],
  ['cursor open order unchecked', 'src/cursor.ts', 'if (i > 0 && d <= (open[i - 1] as string)) throw', 'if (false) throw', T],
  ['cursor maxOpen unchecked', 'src/cursor.ts', 'if (open.length > limits.maxOpen) throw', 'if (false) throw', T],
];

const only = process.env.ONLY ? new RegExp(process.env.ONLY) : null;
let killed = 0;
const survivors = [];
for (const [name, file, from, to, test] of M) {
  if (only !== null && !only.test(name)) continue;
  const path = join(A, file);
  const original = readFileSync(path);
  const text = original.toString('utf8');
  const at = text.indexOf(from);
  if (at === -1 || text.indexOf(from, at + 1) !== -1) {
    console.log(`SKIP ${name}: the text occurs ${at === -1 ? 0 : 'more than one'} time(s)`);
    survivors.push(`${name} (not applied)`);
    continue;
  }
  writeFileSync(path, text.slice(0, at) + to + text.slice(at + from.length));
  const r = spawnSync(process.execPath, ['--test', test], { cwd: ROOT, encoding: 'utf8', timeout: 300_000 });
  writeFileSync(path, original);
  if (!readFileSync(path).equals(original)) throw new Error(`${file} not restored`);
  const out = `${r.stdout}\n${r.stderr}`;
  const failed = r.status !== 0 && /^\u2716 /m.test(out) && /failing tests/.test(out);
  const first = (out.match(/^\u2716 (.*)$/m) ?? [])[1] ?? '';
  console.log(`${failed ? 'KILLED' : 'SURVIVED'} ${name} (exit ${r.status}) ${failed ? `by: ${first.slice(0, 110)}` : ''}`);
  if (failed) killed += 1;
  else survivors.push(name);
}
console.log(`killed ${killed}; survivors: ${survivors.length === 0 ? 'none' : survivors.join('; ')}`);
process.exitCode = survivors.length === 0 ? 0 : 1;
