// DOM-062 instrument: read the pkgforge.dev zone's gates with the cf CLI,
// read-only, and print each answer with every Cloudflare id taken out
// (TODO/serve.md, DOM-062). Written 2026-11-03 for cf 1.0.0-beta.27.
//
// Question: which zone rule or setting could refuse, limit or challenge a
// scripted caller of domains.pkgforge.dev, as the zone holds them now?
//
// It runs only `cf ... get`, `cf ... list` and `cf auth scopes` (READS below),
// each in its own process, and keeps cf's output in memory: nothing raw reaches
// a file. Before it prints, it drops every key that holds an id, an owner or an
// account (DROP), and writes any 32-hex string as <id> and any e-mail address
// as <email>. Every host of the zone other than domains.pkgforge.dev (and
// its subdomains) is another project's, and it prints as <other-host>, so
// those names stay out of this tree. A read with `pick` prints only the
// fields it names. It keeps names, versions, times, expressions, actions and
// thresholds.
//
//   node docs/research/measure/DOM-062/01-cf-read.mjs            every read of READS
//   node docs/research/measure/DOM-062/01-cf-read.mjs --shape    the keys and types only
//   node docs/research/measure/DOM-062/01-cf-read.mjs --more     the reads of MORE only: the
//     rules that can set Under Attack mode, the browser integrity check or a
//     redirect for one host, and the page rules and the phase name of Super
//     Bot Fight Mode. MORE was added after 06-cf-read-after.out, which
//     ran READS alone, as 01-cf-read-before.out and 04-cf-read-after.out did.
//
// Exit codes: 0 every read exited 0 · 1 a read exited non-zero (printed, with
// its stderr stripped the same way; an entry point the zone or the account
// does not hold answers 404 and exits 1) · 2 cf could not start.
import { spawnSync } from 'node:child_process';

const Z = ['-z', 'pkgforge.dev'];
export const READS = [
  { args: ['auth', 'scopes'] },
  { args: ['zones', 'get', ...Z], pick: (d) => ({ name: d.name, status: d.status, paused: d.paused, type: d.type, plan: d.plan?.name }) },
  { args: ['rulesets', 'entrypoint', 'get', 'http_ratelimit', ...Z] },
  { args: ['rulesets', 'entrypoint', 'get', 'http_request_firewall_custom', ...Z] },
  { args: ['rulesets', 'entrypoint', 'get', 'http_request_firewall_managed', ...Z] },
  { args: ['rulesets', 'entrypoint', 'get', 'ddos_l7', ...Z] },
  { args: ['rulesets', 'entrypoint', 'get', 'http_ratelimit'] },
  { args: ['rulesets', 'entrypoint', 'get', 'http_request_firewall_custom'] },
  { args: ['rulesets', 'entrypoint', 'get', 'http_request_firewall_managed'] },
  { args: ['bot-management', 'get', ...Z] },
  { args: ['zones', 'settings', 'get', 'security_level', ...Z] },
  { args: ['zones', 'settings', 'get', 'browser_check', ...Z] },
  { args: ['zones', 'settings', 'get', 'challenge_ttl', ...Z] },
  { args: ['firewall', 'access-rules', 'list', ...Z] },
  { args: ['firewall', 'access-rules', 'list'] },
  { args: ['user', 'firewall', 'access-rules', 'list'] },
  { args: ['firewall', 'lockdowns', 'list', ...Z] },
  { args: ['firewall', 'ua-rules', 'list', ...Z] },
];

export const MORE = [
  { args: ['rulesets', 'entrypoint', 'get', 'http_config_settings', ...Z] },
  { args: ['rulesets', 'entrypoint', 'get', 'http_request_dynamic_redirect', ...Z] },
  // Super Bot Fight Mode: no such phase is known to the API (it answers 400); bot-management get reads Bot Fight Mode.
  { args: ['rulesets', 'entrypoint', 'get', 'http_request_sbfm', ...Z] },
  // A page rule's action names its setting in `id`, which DROP would drop: it is kept as `action`.
  {
    args: ['page-rules', 'list', ...Z],
    pick: (d) => d.map((r) => ({ targets: r.targets, actions: (r.actions ?? []).map((x) => ({ action: x.id, value: x.value })), priority: r.priority, status: r.status, modified_on: r.modified_on })),
  },
];

// Keys whose value is an id, an owner or an account: dropped whole.
const DROP = new Set(['id', 'zone_id', 'account_id', 'zone', 'account', 'owner', 'owner_type', 'ref', 'tag', 'scope']);
const HEX32 = /\b[0-9a-f]{32}\b/gi;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A host under the zone, with any leading "*." or ".": group 1 holds the labels before pkgforge.dev.
const ZONE_HOST = /(?<![A-Za-z0-9-])(?:\*\.|\.)?((?:[A-Za-z0-9-]+\.)+)pkgforge\.dev\b/g;
const ours = (labels) => /(?:^|\.)domains\.$/i.test(labels);

export function strip(v) {
  if (typeof v === 'string')
    return v
      .replace(HEX32, '<id>')
      .replace(EMAIL, '<email>')
      .replace(ZONE_HOST, (m, labels) => (ours(labels) ? m : '<other-host>'));
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === 'object') {
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = DROP.has(k) ? '<dropped>' : strip(x);
    return out;
  }
  return v;
}

function shape(v) {
  if (Array.isArray(v)) return v.length === 0 ? [] : [shape(v[0]), `(${v.length})`];
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, DROP.has(k) ? '<dropped>' : shape(x)]));
  return typeof v;
}

// cf.cmd through cmd.exe on Windows; every argument is a plain word, so none needs quoting.
function cf(args) {
  if (process.platform === 'win32') return spawnSync('cmd.exe', ['/d', '/c', 'cf', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return spawnSync('cf', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

const onlyShape = process.argv.includes('--shape');
let worst = 0;
for (const { args, pick } of process.argv.includes('--more') ? MORE : READS) {
  const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const r = cf(args);
  if (r.error) {
    process.stdout.write(`cf could not start: ${r.error.code ?? r.error.name}\n`);
    process.exit(2);
  }
  process.stdout.write(`== ${at} cf ${args.join(' ')} exit ${r.status}\n`);
  if (r.status !== 0) worst = 1;
  let doc;
  try {
    doc = JSON.parse(r.stdout);
  } catch {
    doc = undefined;
  }
  if (doc === undefined) {
    const lines = r.stdout.trim().split('\n').length;
    process.stdout.write(onlyShape ? `stdout (not JSON, ${r.stdout.length} B, ${lines} lines)\n` : `stdout (not JSON, ${r.stdout.length} B):\n${strip(r.stdout.trim())}\n`);
  } else {
    const view = pick ? pick(doc) : doc;
    process.stdout.write(`${JSON.stringify(onlyShape ? shape(view) : strip(view), null, 2)}\n`);
  }
  if (r.stderr.trim()) process.stdout.write(onlyShape ? `stderr (${r.stderr.length} B)\n` : `stderr:\n${strip(r.stderr.trim())}\n`);
}
process.exitCode = worst;
