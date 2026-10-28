// scripts/lib/workflow-step.mjs — run one step's `run: |` block of a workflow
// under bash, with a fake `gh` and a fake `sleep` first on PATH, for the tests
// of the chain workflows (scripts/measure/feed-chain.test.mjs and
// clock-chain.test.mjs). The fake gh never reaches GitHub: it logs each call
// and answers from the FAKE_* variables. `gh run list --jq FILTER` applies the
// filter to FAKE_RUNS through the real jq, so the workflow's own filter is
// what is tested.
//
// On Windows only Git's bash is used, never the WSL launcher in System32, and
// jq's CRLF output is cut to LF by a wrapper, as a Linux runner prints it.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

function findBash() {
  if (process.platform !== 'win32') return spawnSync('bash', ['-c', 'exit 0']).status === 0 ? 'bash' : null;
  const candidates = [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe'), join(homedir(), 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe')];
  return candidates.find((p) => existsSync(p)) ?? null;
}

export const BASH = findBash();
// The real jq as bash names it, or null.
export const JQ = BASH ? spawnSync(BASH, ['-c', 'command -v jq'], { encoding: 'utf8' }).stdout?.trim() || null : null;

// The run block of the step with `id: <id>`, dedented. `mustMatch` is a
// pattern the block must hold, so a test cannot pass on another step.
export function stepScript(workflowFile, id, mustMatch) {
  const lines = readFileSync(workflowFile, 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === `id: ${id}`);
  const run = lines.findIndex((l, i) => i > at && l.trim() === 'run: |');
  if (at < 0 || run < at) throw new Error(`${workflowFile}: no step with id ${id} and a run block`);
  const indent = lines[run].indexOf('run:') + 2;
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() !== '' && l.length - l.trimStart().length < indent) break;
    body.push(l.slice(indent));
  }
  const script = body.join('\n');
  if (mustMatch && !mustMatch.test(script)) throw new Error(`${workflowFile}: the step ${id} does not hold ${mustMatch}`);
  return script;
}

const FAKE_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$FAKE_LOG"
case "$1 $2" in
  "api repos/"*) [ "$FAKE_STATE" = fail ] && exit 1; printf '%s\\n' "$FAKE_STATE" ;;
  "run list")
    [ "$FAKE_RUNS" = fail ] && exit 1
    filter=""
    while [ $# -gt 0 ]; do
      if [ "$1" = --jq ]; then filter="$2"; fi
      shift
    done
    if [ -n "$filter" ]; then printf '%s' "$FAKE_RUNS" | jq -r "$filter"; else printf '%s\\n' "$FAKE_RUNS"; fi
    ;;
  "workflow run")
    n=$(( $(cat "$FAKE_DISPATCHES" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$FAKE_DISPATCHES"
    [ "$FAKE_RUN" = fail ] && exit 1
    [ "$FAKE_RUN" = "fail-$n" ] && exit 1
    exit 0
    ;;
  *) exit 9 ;;
esac
`;
const FAKE_SLEEP = `#!/usr/bin/env bash
printf 'sleep %s\\n' "$*" >> "$FAKE_LOG"
`;
const fakeJq = (real) => `#!/usr/bin/env bash
"${real}" "$@" | tr -d '\\r'
exit "\${PIPESTATUS[0]}"
`;

const posix = (p) => p.replaceAll('\\', '/');

// Runs `script` under bash with the fakes. `fake` sets FAKE_STATE (the
// workflow's state, or fail), FAKE_RUNS (the run listing as JSON, or fail) and
// FAKE_RUN (ok, fail, or fail-N for the Nth dispatch only); `env` adds or
// overrides the GITHUB_* variables. Returns the exit status, the output, the
// calls the fakes saw and what the step wrote to its summary and environment.
export function runStep(t, script, { fake = {}, env = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'workflow-step-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const fakes = [
    ['gh', FAKE_GH],
    ['sleep', FAKE_SLEEP],
  ];
  if (JQ) fakes.push(['jq', fakeJq(JQ)]);
  for (const [name, body] of fakes) {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), 0o755);
  }
  const files = { log: join(dir, 'log'), env: join(dir, 'env'), summary: join(dir, 'summary') };
  for (const f of Object.values(files)) writeFileSync(f, '');
  const runnerTemp = join(dir, 'runner-temp');
  const prelude = 'if command -v cygpath >/dev/null 2>&1; then PATH="$(cygpath -u "$FAKE_DIR"):$PATH"; else PATH="$FAKE_DIR:$PATH"; fi\nmkdir -p "$RUNNER_TEMP"\n';
  const r = spawnSync(BASH, ['-c', `${prelude}${script}`], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_DIR: dir,
      FAKE_LOG: posix(files.log),
      FAKE_DISPATCHES: posix(join(dir, 'dispatches')),
      FAKE_STATE: fake.state ?? 'active',
      FAKE_RUNS: fake.runs ?? '[]',
      FAKE_RUN: fake.dispatch ?? 'ok',
      GITHUB_ENV: posix(files.env),
      GITHUB_STEP_SUMMARY: posix(files.summary),
      GITHUB_REF: 'refs/heads/main',
      GITHUB_REPOSITORY: 'pkgforge-dev/domains.pkgforge.dev',
      GITHUB_RUN_ID: '42',
      GITHUB_RUN_ATTEMPT: '1',
      GH_TOKEN: 'placeholder',
      RUNNER_TEMP: posix(runnerTemp),
      ...env,
    },
  });
  const read = (f) => readFileSync(f, 'utf8');
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, calls: read(files.log).split('\n').filter(Boolean), env: read(files.env), summary: read(files.summary) };
}
