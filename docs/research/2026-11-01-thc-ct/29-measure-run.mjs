// DOM-029 instrument 29, copied from the session scratchpad (measure-run.mjs) as it ran on 2026-11-02T07:58Z to 09:29Z.
// The question: what wall time, CPU time, peak RSS and sampled peak heap one run of scripts/ingest/run.mjs takes (the stage 4 dry run).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/29-measure-run.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// Runs one script's main in this process and records its wall time and the
// process's peak resident set (process.resourceUsage().maxRSS, KiB) to a file.
// Usage: node [--max-old-space-size=N] measure-run.mjs SCRIPT OUT.json ARG...
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
const [script, out, ...argv] = process.argv.slice(2);
const { main } = await import(pathToFileURL(script).href);
const t0 = performance.now();
const start = new Date().toISOString();
let peakHeap = 0;
const timer = setInterval(() => { const h = process.memoryUsage(); if (h.heapUsed > peakHeap) peakHeap = h.heapUsed; }, 250);
const code = await main(argv);
clearInterval(timer);
const ru = process.resourceUsage();
const rec = {
  script, argv, start, end: new Date().toISOString(), wall_s: Math.round(performance.now() - t0) / 1000, exit: code,
  max_rss_kib: ru.maxRSS, user_cpu_s: ru.userCPUTime / 1e6, system_cpu_s: ru.systemCPUTime / 1e6, peak_heap_used_bytes_sampled: peakHeap,
  node: process.version, exec_argv: process.execArgv,
};
writeFileSync(out, `${JSON.stringify(rec, null, 2)}\n`);
process.exitCode = code;
