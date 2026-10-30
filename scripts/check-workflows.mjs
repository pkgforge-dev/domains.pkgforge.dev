// scripts/check-workflows.mjs — the workflow policy of DOM-014 (TODO/foundation.md):
// every workflow file parses as YAML and keeps the 15 rules below.
//
// Push access to this repository is the trust root of the data. The
// repository's default workflow permission was `write` when DOM-014 measured
// it (2026-10-27T08:34:25Z) and was `read` when it was read again
// (2026-10-28T15:47:13Z); these rules hold whatever that setting is. So a
// workflow that grants too much, holds a Cloudflare credential, deletes from
// GHCR or runs an unpinned action is refused here, by the gate, before it
// reaches main.
//
// The `yaml` package decides the shape, never a line scan: a line scan cannot
// read the flow form `permissions: { packages: write }`, an alias or a merge
// key, and a file that does not parse (a line fallen out of its block scalar,
// the measure-feeds.yml defect of commit 5e7a646) is a finding with its line.
// Comments are not read, except the `# vX.Y.Z` beside a pinned `uses:`. Rules
// 9, 10 and 13 read a run string with its `\` line continuations joined.
//
// The rules (each one has a planted fixture in scripts/fixtures/workflows/):
//   parse  the file is one YAML mapping with a `jobs` mapping
//   1   top-level `permissions: {}`; no `write-all` or `read-all` anywhere
//   2   no `contents: write`, `pages: write` or `id-token: write` in any job
//   3   any other write grant only in a job JOB_GRANTS names for it; a job that
//       calls the local root-promote.yml may hold ROOT_PROMOTE_GRANTS. A job
//       that holds packages: write runs on main alone: its `if:` holds
//       `github.ref == 'refs/heads/main'` as one operand of a top-level `&&`,
//       with no top-level `||` (onMainOnly). A job that calls root-promote.yml
//       is held by the called file's own job, which holds packages: write.
//   4   `defaults.run.shell: bash`, and no job default that is not bash
//   5   `timeout-minutes` on every job, except a reusable workflow call
//   6   a job's `uses:` is ./.github/workflows/<name>.y(a)ml or a pin; a
//       step's `uses:` is a pin (a local action is a file these rules never
//       read). A pin is OWNER/NAME@<40 hex> that ACTION_PINS lists, with the
//       `# vX.Y.Z` comment of its row; every actions/checkout sets
//       `persist-credentials: false`
//   7   no `inputs`, `matrix`, `needs`, `steps`, `github.event`,
//       `github.head_ref`, `github.base_ref`, `github.ref` or
//       `github.ref_name` expression inside a `run:`, a `shell:` or a
//       `with.script` string (values go through `env:`); context names are
//       read without regard to case, as GitHub reads them
//   8   no `pull_request_target` or `workflow_run` trigger
//   9   no `secrets` reference, no job `secrets:` and no `workflow_call`
//       secrets; no name holding CLOUDFLARE or CF_API; no `wrangler deploy`,
//       `publish`, `versions upload`, `versions deploy` or `rollback`; no
//       cloudflare/wrangler-action
//   10  no deletion of GHCR content: a DELETE method (a curl or gh flag, a
//       `method: DELETE`, an octokit 'DELETE /...' request, requests.delete)
//       in a job that names `packages`, `ghcr.io`, `/manifests/` or
//       `/blobs/`; `oras manifest|blob|repo delete`; `crane delete`; `skopeo
//       delete`; `regctl ... rm|delete`; `docker rmi` of a registry
//       reference; actions/delete-package-versions; a `deletePackage...` REST
//       call. Flags may sit between the words. The scripts a workflow runs
//       and the packages they import are read for the same (checkScript): an
//       argument array such as `['manifest', 'delete', ref]` too.
//   11  runner `ubuntu-24.04` only, with no job `container:` or `services:`
//   12  a workflow with `schedule:` has `workflow_dispatch:` too
//   13  a concurrency `queue` is `single` or `max`, and `max` never with a
//       `cancel-in-progress` that is not false; a job that runs `oras tag`,
//       scripts/ghcr/push.mjs with `state` or `root`, or scripts/root/promote.mjs
//       or rollback.mjs is in the group `root-writer` with `queue: max` and
//       `cancel-in-progress: false` (its own or the workflow's), and so is
//       every job of root-promote.yml itself (ruling 18, read by the file's
//       name); a job that only calls root-promote.yml holds no group, and one in
//       root-writer (its own or the workflow's) is refused: the caller and the
//       called workflow would wait on each other (assumed: no page read states
//       it, and nothing has measured it). Two calls do queue in the group of
//       root-promote.yml (MEASURED 2026-10-29T15:50Z, DOM-020).
//   14  actions/upload-artifact sets `overwrite: true`
//   15  no unquoted `if: !` (YAML reads it as a tag, not as a negation)
//
// Usage:
//   node scripts/check-workflows.mjs            every *.yml and *.yaml of .github/workflows/,
//                                               then rule 10 over the scripts and packages (scriptFiles)
//   node scripts/check-workflows.mjs FILE...    those files alone (the fixtures, a draft): a
//                                               .yml or .yaml as a workflow, any other as a script;
//                                               a file named root-promote.yml is held as that workflow
//
// Prints `FILE:LINE: rule N: what` on stderr for each finding.
// Exit codes: 0 every file keeps every rule, 1 a finding, 2 a file could not be
// read, or .github/workflows/ holds no workflow file.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAlias, isMap, isScalar, isSeq, LineCounter, parseDocument, visit } from 'yaml';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const WORKFLOWS = join('.github', 'workflows');

// Rule 3: the jobs that may hold each write grant. The one place a job name is
// added, in the same change as the workflow that needs it; the DOM-014 table of
// TODO/foundation.md is its floor (check-workflows.test.mjs). A write grant
// with no row here is held by no job.
export const JOB_GRANTS = {
  packages: ['measure-push', 'ref', 'ingest', 'kafka', 'tiles', 'feeds', 'zones', 'compact', 'assemble', 'promote', 'mirror', 'rev', 'quality', 'validate', 'push'],
  issues: [
    'measure-push',
    'ref',
    'ingest',
    'kafka',
    'tiles',
    'feeds',
    'zones',
    'compact',
    'assemble',
    'promote',
    'mirror',
    'rev',
    'quality',
    'validate',
    'push',
    'staleness',
    'schedules',
    'status',
    'check',
    'issues',
    'watchdog',
    'keepalive',
  ],
  actions: ['chain', 'measure-chain', 'keepalive', 'kick', 'schedules', 'check'],
};
// Rule 6: the actions a workflow may run, each at one commit and the release
// that commit is (the four pins of the committed workflows). A new action or a
// new release is a row here, in the same change as the workflow that needs it,
// so the `# vX.Y.Z` beside a pin is checked against a reviewed row, never
// taken on its word.
export const ACTION_PINS = {
  'actions/checkout': { sha: '3d3c42e5aac5ba805825da76410c181273ba90b1', tag: 'v7.0.1' },
  'actions/download-artifact': { sha: '9000827ccba6bdab643e8b6fd33ac0654aef8333', tag: 'v8.0.2' },
  'actions/setup-node': { sha: '949feb2413d6458794dcd2491c4babbbce0c15c1', tag: 'v7.1.0' },
  'actions/upload-artifact': { sha: 'cf430e030ddbb5b0abf93d22962f4752f3646cd9', tag: 'v7.0.2' },
};
// Rule 2: no job holds these. The project has no status branch, pushes no
// branch to publish, and has no Pages site.
const NEVER_WRITE = ['contents', 'pages', 'id-token'];
// Rule 3: a job that calls the local root-promote.yml grants the called
// workflow what its `promote` job holds (DOM-020, TODO/storage.md): packages
// alone. `issues` joins this list when DOM-034 adds the issue script that the
// job's last step stands in for; until then no step of the job uses it, so
// neither the job nor a caller holds it.
export const ROOT_PROMOTE_GRANTS = ['packages'];
// Rule 3: the grants a job holds on main alone. packages: write writes GHCR,
// the only copy of the data (docs/architecture.md section 4), so a dispatch on
// another branch runs code that main never reviewed against it. A review of
// 2026-10-30 planted the deletion of `github.ref == 'refs/heads/main'` from the
// assemble jobs of a copy of the compaction workflows, and every rule passed it.
export const MAIN_ONLY_GRANTS = ['packages'];
const RUNNER = 'ubuntu-24.04';
const ROOT_WRITER = 'root-writer';

export const RULES = {
  parse: 'the file parses as one YAML mapping with a jobs mapping',
  1: 'top-level permissions: {}',
  2: 'no contents, pages or id-token write',
  3: 'a write grant only in a job JOB_GRANTS names, and packages: write on main alone',
  4: 'defaults.run.shell: bash',
  5: 'timeout-minutes on every job',
  6: 'listed pinned actions, checkout without credentials',
  7: 'no untrusted expression inside run, shell or script',
  8: 'no pull_request_target or workflow_run',
  9: 'no secret, Cloudflare credential or deploy',
  10: 'no deletion of GHCR content',
  11: 'runner ubuntu-24.04, no container or services',
  12: 'workflow_dispatch beside schedule',
  13: 'concurrency queue and root-writer',
  14: 'upload-artifact with overwrite: true',
  15: 'no unquoted if: !',
};

const EXPR = /\$\{\{([\s\S]*?)\}\}/g;
// Rule 7: a context a caller, a branch name or an earlier step controls.
// `github.event_name` is GitHub's own and passes; `github.event`,
// `github['event']` do not. GitHub reads context names without regard to
// case, so `INPUTS.day` is `inputs.day`. `github.actor` and
// `github.triggering_actor` are logins (letters, digits, hyphens and a
// `[bot]` suffix) and `github.workflow` is the file's own name, so they pass.
const UNTRUSTED_REF = String.raw`(?:event|head_ref|base_ref|ref_name|ref)`;
const UNTRUSTED = new RegExp(String.raw`(?<![\w.-])(?:inputs|matrix|needs|steps)\b|(?<![\w.-])github\s*(?:\.\s*${UNTRUSTED_REF}\b|\[\s*['"]${UNTRUSTED_REF}['"]\s*\])`, 'i');
const SECRETS = /(?<![\w.-])secrets\b/i;
const CF_KEY = /cloudflare|cf_api/i;
// Case-sensitive in a value: a name is upper case, prose is not.
const CF_VALUE = /CLOUDFLARE|CF_API/;
const DEPLOY = /\bwrangler\b[^\n;|&]*?\s(?:deploy|publish|rollback|versions\s+(?:upload|deploy))\b|cloudflare\/wrangler-action/i;
// A curl or gh flag (`-X`, `-sSX`, `--request`, `--method`), a `method:` or
// `method=` field, an octokit request string, or python requests.
const DELETE_METHOD = /(?:^|\s)(?:-[A-Za-z]*X\s*|--request[\s=]+|--method[\s=]+)['"]?DELETE\b|\bmethod['"]?\s*[:=]\s*['"]DELETE\b|['"`]DELETE\s+\/|\brequests\.delete\s*\(/i;
const REGISTRY_PATH = /packages|ghcr\.io|\/manifests\/|\/blobs\//i;
// Flags may stand between a tool and its verb: `crane --insecure delete`.
const FLAGS = String.raw`(?:\s+-\S+)*`;
const DELETERS = [
  new RegExp(String.raw`\boras${FLAGS}\s+(?:manifest|blob|repo)${FLAGS}\s+delete\b`, 'i'),
  new RegExp(String.raw`\bcrane${FLAGS}\s+delete\b`, 'i'),
  new RegExp(String.raw`\bskopeo${FLAGS}\s+delete\b`, 'i'),
  new RegExp(String.raw`\bregctl${FLAGS}\s+(?:manifest|tag|blob|image)${FLAGS}\s+(?:rm|delete)\b`, 'i'),
  /\bdocker\s+(?:rmi|image\s+(?:rm|remove))\b[^\n;|&]*\//i,
  /actions\/delete-package-versions/i,
  /\bdeletePackage/i,
];
// Rule 10 in a script: an oras or regctl argument array whose verbs delete,
// flags and their values allowed between them:
// `['manifest', '--registry-config', config, 'delete', ref]`.
const ARGV_DELETE = /(['"`])(?:manifest|blob|repo|tag)\1\s*,\s*(?:(?:(['"`])-[^'"`\n]*\2|[A-Za-z_$][\w$.]*)\s*,\s*)*(['"`])(?:delete|rm)\3/i;
// Rule 10 beyond the workflow files: a workflow runs scripts, and they import
// the packages, so a deletion written there reaches GHCR with the job's token
// as surely as one in a `run:`. Read: every file under scripts/ and packages/
// with one of these extensions, or with none and a `#!` first line
// (scripts/install-oras). check-workflows.test.mjs plants every deleter as test
// data and is the one file left out.
const SCRIPT_DIRS = ['scripts', 'packages'];
const SCRIPT_EXT = /\.(?:mjs|cjs|js|ts|mts|cts|sh)$/;
const SCRIPT_EXEMPT = new Set(['scripts/check-workflows.test.mjs']);
// Rule 13: a step that moves a tag of the root or of state.
const ROOT_MOVE = [/\boras\s+tag\b/, /scripts\/ghcr\/push\.mjs\b[^\n]*\b(?:state|root)\b/, /\bscripts\/root\/(?:promote|rollback)\.mjs\b/];
// Rule 13 (ruling 18): the one workflow that moves root:latest for every
// caller, read by its file name; it holds the group root-writer itself.
const ROOT_PROMOTE_FILE = /(?:^|\/)root-promote\.ya?ml$/;
const PINNED = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/[^@\s]+)?@[0-9a-f]{40}$/;
const VERSION_COMMENT = /^[ \t]+#[ \t]*(v\d+\.\d+\.\d+)(?:[ \t]|$)/;
const LOCAL_USES = /^\.\//;
const LOCAL_WORKFLOW = /^\.\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/;
const ROOT_PROMOTE = /^\.\/(?:[^\s@]*\/)?root-promote\.ya?ml$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const expressions = (s) => [...s.matchAll(EXPR)].map((m) => m[1]);
const firstLine = (s) => String(s).split('\n')[0];
// A run string with its `\` line continuations joined, as bash reads it.
const joinLines = (s) => s.replace(/\\\r?\n/g, ' ');

// The key and value nodes at a path of keys and indexes, aliases resolved. Where
// the path leaves the nodes (a merged key), the deepest node found stands in.
function nodeAt(doc, path) {
  let node = doc.contents;
  let found = { key: null, value: node };
  for (const step of path) {
    if (isAlias(node)) node = node.resolve(doc);
    if (isMap(node)) {
      const pair = node.items.find((p) => isScalar(p.key) && String(p.key.value) === String(step));
      if (!pair) break;
      node = isAlias(pair.value) ? pair.value.resolve(doc) : pair.value;
      found = { key: pair.key, value: node };
    } else if (isSeq(node) && typeof step === 'number' && node.items[step]) {
      node = isAlias(node.items[step]) ? node.items[step].resolve(doc) : node.items[step];
      found = { key: null, value: node };
    } else {
      break;
    }
  }
  return found;
}

function lineAt(doc, lc, path) {
  const { key, value } = nodeAt(doc, path);
  const offset = (key ?? value)?.range?.[0] ?? 0;
  return lc.linePos(offset).line;
}

// Every string of a parsed value, and every key, with its path.
function walk(value, path, fn) {
  if (Array.isArray(value)) {
    for (const [i, v] of value.entries()) walk(v, [...path, i], fn);
  } else if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      fn({ key: k, path: [...path, k] });
      walk(v, [...path, k], fn);
    }
  } else if (typeof value === 'string') {
    fn({ value, path });
  }
}

function triggers(on) {
  if (typeof on === 'string') return [on];
  if (Array.isArray(on)) return on.map(String);
  if (isObj(on)) return Object.keys(on);
  return [];
}

// The operands of `op` (`&&` or `||`) at the top level of an expression:
// outside parentheses and outside single-quoted strings, where GitHub's
// expressions keep their literals.
function operands(expr, op) {
  const out = [];
  let depth = 0;
  let quoted = false;
  let from = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i];
    if (c === "'") quoted = !quoted;
    else if (quoted) continue;
    else if (c === '(') depth += 1;
    else if (c === ')') depth -= 1;
    else if (depth === 0 && expr.startsWith(op, i)) {
      out.push(expr.slice(from, i));
      from = i + op.length;
      i += op.length - 1;
    }
  }
  out.push(expr.slice(from));
  return out.map((s) => s.trim());
}

// Rule 3: the test that keeps a job on main, either way round, in any case
// (GitHub compares strings and reads context names without regard to case),
// in parentheses or not.
const MAIN_TEST = /^\(*\s*(?:github\.ref\s*==\s*'refs\/heads\/main'|'refs\/heads\/main'\s*==\s*github\.ref)\s*\)*$/i;

// Whether a job's `if:` keeps it on main: with or without ${{ }}, the main test
// is one operand of the top-level `&&` chain, and the expression has no
// top-level `||`, which would let another operand run the job anywhere.
export function onMainOnly(cond) {
  if (typeof cond !== 'string') return false;
  let e = cond.trim();
  const wrapped = e.match(/^\$\{\{([\s\S]*)\}\}$/);
  if (wrapped) e = wrapped[1].trim();
  if (operands(e, '||').length > 1) return false;
  return operands(e, '&&').some((o) => MAIN_TEST.test(o));
}

const stepsOf = (job) => (Array.isArray(job.steps) ? job.steps.map((s, i) => [i, s]).filter(([, s]) => isObj(s)) : []);
const runsOf = (job) => stepsOf(job).filter(([, s]) => typeof s.run === 'string');

function checkPermissions(ctx, id, job) {
  const perms = job.permissions;
  if (perms === undefined) return;
  const at = ctx.at('jobs', id, 'permissions');
  if (!isObj(perms)) {
    ctx.add(1, at, `job ${id}: permissions is ${JSON.stringify(perms)}; give it a mapping of the scopes it needs`);
    return;
  }
  const callsRootPromote = typeof job.uses === 'string' && ROOT_PROMOTE.test(job.uses);
  for (const [scope, level] of Object.entries(perms)) {
    if (String(level).toLowerCase() !== 'write') continue;
    const s = scope.toLowerCase();
    const line = ctx.at('jobs', id, 'permissions', scope);
    if (NEVER_WRITE.includes(s)) {
      ctx.add(2, line, `job ${id} holds ${scope}: write; no job holds it (data goes to GHCR, status through the Worker)`);
    } else if (!JOB_GRANTS[s]) {
      ctx.add(3, line, `job ${id} holds ${scope}: write, which JOB_GRANTS gives to no job; add a row with the entry that needs it`);
    } else if (!JOB_GRANTS[s].includes(id) && !(callsRootPromote && ROOT_PROMOTE_GRANTS.includes(s))) {
      ctx.add(3, line, `job ${id} holds ${scope}: write, and JOB_GRANTS names only ${JOB_GRANTS[s].join(', ')}; rename the job or add it with the entry that needs it`);
    } else if (MAIN_ONLY_GRANTS.includes(s) && !callsRootPromote && !onMainOnly(job.if)) {
      ctx.add(3, line, `job ${id} holds ${scope}: write and can run off main; give it an if: that holds github.ref == 'refs/heads/main' joined by && at the top level, with no top-level ||`);
    }
  }
}

function checkConcurrency(ctx, c, path) {
  if (!isObj(c) || c.queue === undefined) return;
  const line = ctx.at(...path, 'queue');
  if (c.queue !== 'single' && c.queue !== 'max') ctx.add(13, line, `queue is ${JSON.stringify(c.queue)}; it is single or max`);
  if (c.queue === 'max' && c['cancel-in-progress'] !== undefined && c['cancel-in-progress'] !== false) {
    ctx.add(13, ctx.at(...path, 'cancel-in-progress'), 'queue: max with a cancel-in-progress that is not false; GitHub refuses queue: max with cancel-in-progress: true');
  }
}

const holdsRootWriter = (c) => isObj(c) && c.group === ROOT_WRITER && c.queue === 'max' && c['cancel-in-progress'] === false;
const inRootWriter = (c) => isObj(c) && c.group === ROOT_WRITER;

function checkWorkflow(ctx) {
  const { wf } = ctx;
  // Rule 1.
  if (!isObj(wf.permissions) || Object.keys(wf.permissions).length > 0) {
    ctx.add(1, wf.permissions === undefined ? 1 : ctx.at('permissions'), `top-level permissions is ${JSON.stringify(wf.permissions ?? null)}; it is {} and each job names its own`);
  }
  // Rule 4.
  if (wf.defaults?.run?.shell !== 'bash') ctx.add(4, ctx.at('defaults'), 'defaults.run.shell is not bash');
  // Rules 8 and 12.
  const on = triggers(wf.on);
  for (const t of on)
    if (t === 'pull_request_target' || t === 'workflow_run') ctx.add(8, ctx.at('on', ...(isObj(wf.on) ? [t] : [])), `the trigger ${t} runs with the base repository's token on code it did not review`);
  if (on.includes('schedule') && !on.includes('workflow_dispatch')) ctx.add(12, ctx.at('on'), 'schedule without workflow_dispatch; dispatch-overdue cannot start it');
  // Rule 9, a reusable workflow that takes secrets from its caller.
  if (isObj(wf.on) && isObj(wf.on.workflow_call) && wf.on.workflow_call.secrets !== undefined) {
    ctx.add(9, ctx.at('on', 'workflow_call', 'secrets'), 'workflow_call takes secrets; the repository holds none, and github.token is the token');
  }
  // Rule 13, the workflow's group.
  checkConcurrency(ctx, wf.concurrency, ['concurrency']);

  for (const [id, job] of Object.entries(ctx.jobs)) {
    if (!isObj(job)) {
      ctx.add('parse', ctx.at('jobs', id), `job ${id} is not a mapping`);
      continue;
    }
    if (job.steps !== undefined && !Array.isArray(job.steps)) ctx.add('parse', ctx.at('jobs', id, 'steps'), `job ${id}: steps is not a list`);
    checkPermissions(ctx, id, job);
    const reusable = typeof job.uses === 'string';
    // Rule 4, a job's own default.
    if (job.defaults?.run?.shell !== undefined && job.defaults.run.shell !== 'bash')
      ctx.add(4, ctx.at('jobs', id, 'defaults'), `job ${id}: defaults.run.shell is ${JSON.stringify(job.defaults.run.shell)}`);
    // Rule 5.
    if (!reusable && (job['timeout-minutes'] === undefined || job['timeout-minutes'] === null)) ctx.add(5, ctx.at('jobs', id), `job ${id} has no timeout-minutes`);
    // Rule 11.
    if (!reusable) {
      const r = job['runs-on'];
      const ok = r === RUNNER || (Array.isArray(r) && r.length === 1 && r[0] === RUNNER);
      if (!ok) ctx.add(11, ctx.at('jobs', id, 'runs-on'), `job ${id} runs on ${JSON.stringify(r ?? null)}; the runner is ${RUNNER}`);
    }
    // Rule 11: an image is code no pin of rule 6 covers.
    for (const key of ['container', 'services']) {
      if (job[key] !== undefined) ctx.add(11, ctx.at('jobs', id, key), `job ${id} sets ${key}:; a job runs on ${RUNNER} itself, with no image`);
    }
    // Rule 6, a reusable workflow call.
    if (reusable) checkUses(ctx, job.uses, ['jobs', id, 'uses'], { job: true });
    // Rule 9, a job that hands secrets on.
    if (job.secrets !== undefined) ctx.add(9, ctx.at('jobs', id, 'secrets'), `job ${id} passes secrets; the repository holds none, and github.token is the token`);
    // Rule 13, the job's group.
    checkConcurrency(ctx, job.concurrency, ['jobs', id, 'concurrency']);
    const movesRoot = runsOf(job).some(([, s]) => ROOT_MOVE.some((re) => re.test(s.run.replace(/\\\r?\n/g, ' '))));
    if (movesRoot && !holdsRootWriter(wf.concurrency) && !holdsRootWriter(job.concurrency)) {
      ctx.add(13, ctx.at('jobs', id), `job ${id} moves a root or state tag outside the group ${ROOT_WRITER} with queue: max and cancel-in-progress: false`);
    }
    // Ruling 18: root-promote.yml holds the group, so a job that calls it holds none.
    if (reusable && ROOT_PROMOTE.test(job.uses) && (inRootWriter(wf.concurrency) || inRootWriter(job.concurrency))) {
      ctx.add(
        13,
        ctx.at('jobs', id),
        `job ${id} calls root-promote.yml from inside the group ${ROOT_WRITER}; root-promote.yml holds the group itself (ruling 18), and the caller and the called workflow would wait on each other (assumed, not measured)`,
      );
    }
    if (ctx.name !== null && ROOT_PROMOTE_FILE.test(ctx.name) && !holdsRootWriter(wf.concurrency) && !holdsRootWriter(job.concurrency)) {
      ctx.add(
        13,
        ctx.at('jobs', id),
        `job ${id} of root-promote.yml is outside the group ${ROOT_WRITER} with queue: max and cancel-in-progress: false; every promotion of the root waits in it (ruling 18)`,
      );
    }

    for (const [i, step] of stepsOf(job)) {
      const at = (...rest) => ctx.at('jobs', id, 'steps', i, ...rest);
      if (typeof step.uses === 'string') {
        checkUses(ctx, step.uses, ['jobs', id, 'steps', i, 'uses'], { job: false });
        // Rule 6, the token checkout would leave in .git/config.
        if (/^actions\/checkout[@/]/i.test(step.uses)) {
          const p = step.with?.['persist-credentials'];
          if (p !== false && p !== 'false') ctx.add(6, at('uses'), `job ${id}: actions/checkout without persist-credentials: false`);
        }
        // Rule 14.
        if (/^actions\/upload-artifact[@/]/i.test(step.uses)) {
          const o = step.with?.overwrite;
          if (o !== true && o !== 'true') ctx.add(14, at('uses'), `job ${id}: actions/upload-artifact without overwrite: true; a re-run cannot replace its artifact`);
        }
      }
      // Rule 7: the strings a shell or a script runs.
      const sinks = [
        [['run'], step.run],
        [['shell'], step.shell],
        [['with', 'script'], isObj(step.with) ? step.with.script : undefined],
      ];
      for (const [where, s] of sinks) {
        if (typeof s !== 'string') continue;
        for (const e of expressions(s)) {
          if (UNTRUSTED.test(e)) ctx.add(7, at(...where), `job ${id}: the expression \${{${e}}} is inside ${where.join('.')}; pass it through env:`);
        }
      }
    }
  }
}

// Rule 6 for one `uses:` value; `job` is true for a reusable workflow call.
function checkUses(ctx, uses, path, { job }) {
  const line = ctx.at(...path);
  if (LOCAL_USES.test(uses)) {
    if (!job) ctx.add(6, line, `uses: ${uses} is a local action; its steps are a file these rules never read`);
    else if (!LOCAL_WORKFLOW.test(uses)) ctx.add(6, line, `uses: ${uses} is not a workflow of .github/workflows/, the files these rules read`);
    return;
  }
  if (!PINNED.test(uses)) {
    ctx.add(6, line, `uses: ${uses} is not pinned to a 40-hex commit`);
    return;
  }
  const [name, sha] = uses.split('@');
  const row = Object.hasOwn(ACTION_PINS, name) ? ACTION_PINS[name] : null;
  if (row === null) ctx.add(6, line, `uses: ${name} is not in ACTION_PINS; add its row with the entry that needs it`);
  else if (row.sha !== sha) ctx.add(6, line, `uses: ${uses} is not the commit ACTION_PINS holds for ${name} (${row.sha}, ${row.tag})`);
  const node = nodeAt(ctx.doc, path).value;
  const end = node?.range?.[1];
  const nl = end === undefined ? -1 : ctx.text.indexOf('\n', end);
  const rest = end === undefined ? '' : ctx.text.slice(end, nl === -1 ? ctx.text.length : nl);
  const comment = rest.match(VERSION_COMMENT);
  if (!comment) ctx.add(6, line, `uses: ${uses} has no # vX.Y.Z comment naming the release it pins`);
  else if (row !== null && row.sha === sha && comment[1] !== row.tag) ctx.add(6, line, `uses: ${uses} says ${comment[1]}; ACTION_PINS holds ${row.tag} for that commit`);
}

// The strings of a value, continuations joined, as one text.
function textOf(value) {
  const out = [];
  walk(value, [], ({ value: s }) => {
    if (s !== undefined) out.push(joinLines(s));
  });
  return out.join('\n');
}

// Rules 9 and 10 read every key and every string of the file. A DELETE is
// judged against the registry words of its whole job and of the workflow's
// own keys (an `env:` can hold the URL that a `run:` deletes).
function checkStrings(ctx) {
  const outside = textOf(Object.fromEntries(Object.entries(ctx.wf).filter(([k]) => k !== 'jobs')));
  const jobText = new Map(Object.entries(ctx.jobs).map(([id, job]) => [id, `${textOf(job)}\n${outside}`]));
  const scopeOf = (path) => (path[0] === 'jobs' && jobText.has(path[1]) ? jobText.get(path[1]) : textOf(ctx.wf));
  walk(ctx.wf, [], ({ key, value: raw, path }) => {
    if (key !== undefined) {
      if (CF_KEY.test(key)) ctx.add(9, ctx.at(...path), `the name ${key} holds a Cloudflare credential's name; CI holds none`);
      return;
    }
    const value = joinLines(raw);
    const line = ctx.at(...path);
    const last = path[path.length - 1];
    // An `if:` is an expression whole, with or without ${{ }}.
    const exprs = last === 'if' ? [value] : expressions(value);
    if (exprs.some((e) => SECRETS.test(e))) ctx.add(9, line, 'a secrets reference; the repository holds none, and github.token is the token');
    if (CF_VALUE.test(value)) ctx.add(9, line, 'a Cloudflare credential name (CLOUDFLARE or CF_API); CI holds none');
    if (DEPLOY.test(value)) ctx.add(9, line, 'a Worker deploy; the operator deploys with the local wrangler login');
    if ((DELETE_METHOD.test(value) && REGISTRY_PATH.test(scopeOf(path))) || DELETERS.some((re) => re.test(value))) ctx.add(10, line, 'a deletion of GHCR content; raw data is kept always');
  });
}

// Rule 15: `if: !x` is the tag `!x` on an empty value, never a negation.
function checkTags(ctx) {
  visit(ctx.doc, {
    Pair(_, pair) {
      if (!isScalar(pair.key) || pair.key.value !== 'if') return;
      const tag = pair.value?.tag;
      if (typeof tag === 'string' && !tag.startsWith('tag:yaml.org,2002:')) {
        ctx.add(15, ctx.lc.linePos(pair.key.range[0]).line, `if: ${tag} is a YAML tag, not an expression; quote it or write if: \${{ ${tag} }}`);
      }
    },
  });
}

// The findings of one workflow's text: [{ line, rule, what }], by line. `name`
// is the file's path as shown: root-promote.yml is held to its own clause of
// rule 13 by it.
export function checkText(text, name = null) {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, merge: true, prettyErrors: false });
  const findings = [];
  const add = (rule, line, what) => findings.push({ line, rule, what });
  const done = () => findings.sort((a, b) => a.line - b.line || String(a.rule).localeCompare(String(b.rule)));
  if (doc.errors.length > 0) {
    // One error cascades into several at the same place; each line and message once.
    const seen = new Set();
    for (const e of doc.errors) {
      const line = Array.isArray(e.pos) ? lc.linePos(e.pos[0]).line : 1;
      const what = firstLine(e.message).replace(/ at line \d+, column \d+:?$/, '');
      if (!seen.has(`${line} ${what}`)) add('parse', line, what);
      seen.add(`${line} ${what}`);
    }
    return done();
  }
  let wf;
  try {
    wf = doc.toJS({ maxAliasCount: 1000 });
  } catch (e) {
    add('parse', 1, firstLine(e.message));
    return done();
  }
  if (!isObj(wf)) {
    add('parse', 1, 'the file is not a YAML mapping');
    return done();
  }
  const ctx = { doc, lc, text, name, wf, jobs: isObj(wf.jobs) ? wf.jobs : {}, add, at: (...path) => lineAt(doc, lc, path) };
  if (!isObj(wf.jobs)) add('parse', ctx.at('jobs'), 'jobs is not a mapping of jobs');
  checkWorkflow(ctx);
  checkStrings(ctx);
  checkTags(ctx);
  return done();
}

// Rule 10 over one script or package file: [{ line, rule, what }], by line.
// Its comment lines are blanked first (a comment does not run, and this file's
// own header names every deleter): `//` lines in JavaScript and TypeScript, `#`
// lines in a shell script. A DELETE method is judged against the registry words
// of what is left of the file, as a workflow's is against its job.
export function checkScript(text, shell = false) {
  const comment = shell ? /^\s*#/ : /^\s*\/\//;
  const code = text
    .split('\n')
    .map((l) => (comment.test(l) ? '' : l))
    .join('\n');
  const lines = new Set();
  const lineOf = (m) => code.slice(0, m.index + m[0].length - m[0].trimStart().length).split('\n').length;
  const all = (re) => code.matchAll(new RegExp(re.source, `${re.flags}g`));
  for (const re of [...DELETERS, ARGV_DELETE]) for (const m of all(re)) lines.add(lineOf(m));
  if (REGISTRY_PATH.test(code)) for (const m of all(DELETE_METHOD)) lines.add(lineOf(m));
  return [...lines].sort((a, b) => a - b).map((line) => ({ line, rule: 10, what: 'a deletion of GHCR content in a script a workflow can run; raw data is kept always' }));
}

// Whether checkScript reads the file `name` holding `text` as a shell script.
export const isShell = (name, text) => name.endsWith('.sh') || (!SCRIPT_EXT.test(name) && text.startsWith('#!') && !/^#![^\n]*\bnode\b/.test(text));

// Every file of SCRIPT_DIRS under root that checkScript reads; node_modules and
// dot-directories skipped.
export function scriptFiles(root) {
  const out = [];
  const visit = (dir) => {
    let entries;
    try {
      entries = readdirSync(join(root, dir), { withFileTypes: true });
    } catch (e) {
      if (e.code === 'ENOENT') return;
      throw e;
    }
    for (const e of entries) {
      const shown = `${dir}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== 'node_modules' && !e.name.startsWith('.')) visit(shown);
      } else if (e.isFile() && !SCRIPT_EXEMPT.has(shown)) {
        const path = join(root, shown);
        if (SCRIPT_EXT.test(e.name) || (!e.name.includes('.') && readFileSync(path, 'latin1').startsWith('#!'))) out.push({ shown, path });
      }
    }
  };
  for (const dir of SCRIPT_DIRS) visit(dir);
  return out.sort((a, b) => a.shown.localeCompare(b.shown));
}

export const format = (file, f) => `${file}:${f.line}: rule ${f.rule}: ${f.what}`;

// Every *.yml and *.yaml directly under ROOT/.github/workflows/, the files
// GitHub reads; [] when there is none.
export function defaultFiles(root) {
  const dir = join(root, WORKFLOWS);
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.ya?ml$/.test(e.name))
    .map((e) => ({ shown: `.github/workflows/${e.name}`, path: join(dir, e.name) }))
    .sort((a, b) => a.shown.localeCompare(b.shown));
}

function main() {
  const named = process.argv.slice(2);
  let files;
  let scripts = [];
  if (named.length > 0) {
    const shown = (p) => ({ shown: p.replaceAll('\\', '/'), path: p });
    files = named.filter((p) => /\.ya?ml$/.test(p)).map(shown);
    scripts = named.filter((p) => !/\.ya?ml$/.test(p)).map(shown);
  } else {
    try {
      files = defaultFiles(ROOT);
    } catch (e) {
      console.error(`check-workflows: could not list ${WORKFLOWS}: ${e.code ?? e.message}`);
      process.exit(2);
    }
    if (files.length === 0) {
      console.error(`check-workflows: ${WORKFLOWS} holds no *.yml or *.yaml file; nothing was examined`);
      process.exit(2);
    }
    try {
      scripts = scriptFiles(ROOT);
    } catch (e) {
      console.error(`check-workflows: could not list ${SCRIPT_DIRS.join(' and ')}: ${e.code ?? e.message}`);
      process.exit(2);
    }
  }
  let unreadable = 0;
  let count = 0;
  const check = (list, findingsOf) => {
    for (const f of list) {
      let text;
      try {
        text = readFileSync(f.path, 'utf8');
      } catch (e) {
        console.error(`${f.shown}: could not read: ${e.code ?? e.message}`);
        unreadable += 1;
        continue;
      }
      for (const finding of findingsOf(text, f)) {
        console.error(format(f.shown, finding));
        count += 1;
      }
    }
  };
  check(files, (text, f) => checkText(text, f.shown));
  check(scripts, (text, f) => checkScript(text, isShell(f.shown, text)));
  if (unreadable > 0) process.exit(2);
  if (count > 0) {
    console.error(`check-workflows: ${count} finding(s) in ${files.length + scripts.length} file(s)`);
    process.exit(1);
  }
  console.log(`check-workflows: ${files.length} workflow file(s) keep the 15 rules; ${scripts.length} script and package file(s) delete nothing from GHCR (rule 10)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
