// scripts/measure/push-summary.mjs — DOM-006 (TODO/storage.md): does a push of
// 1536 MiB, and one of 4096 MiB, from a runner finish inside GHCR's 10-minute
// upload limit; does one manifest take the 128 layers a year pack needs; does
// a rewritten tag leave the old manifest readable; and does a package that a
// workflow's own GITHUB_TOKEN first pushes come out public and linked?
//
// It reads push-result.json, which .github/workflows/measure-push.yml writes
// as the artifact push-result: {schema, entry, records}, one record per
// measurement, each named by its `kind`. It prints one line per measurement,
// then PASS or FAIL for each criterion. Every number it prints was read from a
// record, and a criterion with no record fails. A file of another schema, a
// record of an unknown kind or a field of the wrong type is refused whole.
//
// Usage:
//   node scripts/measure/push-summary.mjs --run RUN_ID [--repo OWNER/NAME] [--out FILE]
//     downloads the artifact push-result of that run with `gh run download`,
//     writes FILE (default docs/research/measure/DOM-006/result.json), and
//     keeps the artifact beside it as push-result-RUN_ID.json
//   node scripts/measure/push-summary.mjs --file PATH [--out FILE]
//     reads a local push-result.json, and writes FILE only when --out is given
//   --require NAME[,NAME...]  only these criteria decide the exit code; the
//     workflow's own verdict is --require anonymous-read
// Exit codes: 0 every deciding criterion passed · 1 one failed · 2 could not
// run (no artifact, a file it refuses, a run id or repository the file does
// not name, a --run artifact of a run off main, an unknown option).
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../files.mjs';
import { parseArgs } from '../lib/args.mjs';

export const SCHEMA = 'domains.measure.push.v1';
export const RESULT_SCHEMA = 'domains.measure.push-summary.v1';
export const ENTRY = 'DOM-006';
export const ARTIFACT = 'push-result';
export const FILE = 'push-result.json';
export const REPO = 'pkgforge-dev/domains.pkgforge.dev';
export const WORKFLOW = '.github/workflows/measure-push.yml';
export const MAIN_REF = 'refs/heads/main';
export const PACKAGE = 'ghcr.io/pkgforge-dev/domains.pkgforge.dev/probe';
export const DEFAULT_OUT = join(ROOT, 'docs', 'research', 'measure', ENTRY, 'result.json');
// GHCR's upload limit, READ mirror-archlinux docs/measurements.md (GHCR table).
export const UPLOAD_LIMIT_S = 600;
// docs/architecture.md section 4.2: a year pack of names is 100 parts of 1 GiB.
export const LAYER_FLOOR = 128;
// The first push of the workflow's default inputs, and the raw chunk of DOM-042.
export const SIZES_MIB = [1536, 4096];

const pushName = (mib) => `push-${mib}m-under-${UPLOAD_LIMIT_S}s`;
const LAYERS_NAME = `layers-at-least-${LAYER_FLOOR}`;
export const CRITERIA = [...SIZES_MIB.map(pushName), LAYERS_NAME, 'anonymous-read', 'second-push-with-token'];

export class ShapeError extends Error {
  name = 'ShapeError';
}
export class RunError extends Error {
  name = 'RunError';
}

const OUTCOMES = new Set(['accepted', 'refused', 'rate-limited', 'timeout', 'error']);
const VIAS = new Set(['qq', 'token', 'none']);
// The reads of the workflow's anonymous step, by the name it records.
export const WHATS = new Set(['size-manifest', 'size-blob', 'size-blob-range', 'retag-tag', 'retag-a-manifest', 'retag-a-blob', 'earlier-b-manifest', 'earlier-a-manifest', 'earlier-a-blob']);

// Each record kind and its fields. Every field is present; `?` allows null.
// A field whose name ends in `digest` or `sha256` holds `sha256:` and 64 hex.
export const KINDS = {
  run: { id: 'str', attempt: 'str', sha: 'str', ref: 'str', workflow_ref: 'str', repository: 'str', started_at: 'str', image: 'str?', oras: 'str?', curl: 'str?', inputs: 'obj' },
  existed: { token_status: 'num', status: 'num', present: 'bool?', tags: 'num?' },
  push: { tag: 'str', mib: 'num', bytes: 'num', payload_sha256: 'str', seconds: 'num', rc: 'num', digest: 'str?', rate_limit_pauses: 'num', error: 'str?' },
  stop: { reason: 'str' },
  package: { status: 'num', visibility: 'str?', repository: 'str?', created_at: 'str?', updated_at: 'str?', message: 'str?' },
  'retag-earlier': { status: 'str', b_digest: 'str?', a_digest: 'str?', run: 'str?', at: 'str?', error: 'str?' },
  'retag-push': { which: 'str', payload_sha256: 'str', seconds: 'num', rc: 'num', digest: 'str?', rate_limit_pauses: 'num', error: 'str?' },
  layers: { n: 'num', outcome: 'str', seconds: 'num', rc: 'num', digest: 'str?', rate_limit_pauses: 'num', error: 'str?' },
  'layers-stop': { reason: 'str' },
  anon: { what: 'str', ref: 'str', status: 'num', via: 'str', qq_status: 'num', token_status: 'num?', digest: 'str?', layer_digest: 'str?', layers: 'num?', bytes: 'num?' },
  end: { finished_at: 'str' },
};
// Kinds a run writes at most once; `push`, `retag-push`, `layers` and `anon`
// are unique by the key named here.
const SINGLE = new Set(['run', 'existed', 'stop', 'package', 'retag-earlier', 'layers-stop', 'end']);
const UNIQUE_BY = { push: 'mib', 'retag-push': 'which', layers: 'n', anon: 'what' };

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TYPES = {
  str: (v) => typeof v === 'string',
  num: (v) => typeof v === 'number' && Number.isFinite(v),
  bool: (v) => typeof v === 'boolean',
  obj: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

function checkRecord(r, i) {
  const at = `record ${i}`;
  if (!TYPES.obj(r) || typeof r.kind !== 'string') throw new ShapeError(`${at} is not an object with a string kind`);
  if (!Object.hasOwn(KINDS, r.kind)) throw new ShapeError(`${at} has the unknown kind "${r.kind}"`);
  const spec = KINDS[r.kind];
  for (const [field, type] of Object.entries(spec)) {
    if (!(field in r)) throw new ShapeError(`${at} (${r.kind}) has no field ${field}`);
    const v = r[field];
    const nullable = type.endsWith('?');
    if (v === null && nullable) continue;
    if (!TYPES[type.replace('?', '')](v)) throw new ShapeError(`${at} (${r.kind}) field ${field} is not a ${type.replace('?', '')}`);
    if (/(?:digest|sha256)$/.test(field) && !DIGEST.test(v)) throw new ShapeError(`${at} (${r.kind}) field ${field} is not a sha256 digest`);
  }
  if (r.kind === 'run' && !(TYPES.num(r.inputs.size_mb) && TYPES.num(r.inputs.layers))) throw new ShapeError(`${at} (run) inputs need the numbers size_mb and layers`);
  if (r.kind === 'layers' && !OUTCOMES.has(r.outcome)) throw new ShapeError(`${at} (layers) has the unknown outcome "${r.outcome}"`);
  if (r.kind === 'retag-push' && r.which !== 'a' && r.which !== 'b') throw new ShapeError(`${at} (retag-push) which is "${r.which}", not a or b`);
  if (r.kind === 'retag-earlier' && !['present', 'absent', 'error'].includes(r.status)) throw new ShapeError(`${at} (retag-earlier) has the unknown status "${r.status}"`);
  if (r.kind === 'anon' && !VIAS.has(r.via)) throw new ShapeError(`${at} (anon) has the unknown via "${r.via}"`);
  if (r.kind === 'anon' && !WHATS.has(r.what)) throw new ShapeError(`${at} (anon) reads the unknown "${r.what}"`);
}

// The parsed and checked push-result.json, or a ShapeError naming the fault.
export function parseResult(text) {
  let doc;
  try {
    doc = JSON.parse(text);
  } catch (e) {
    throw new ShapeError(`not JSON: ${e.message}`);
  }
  if (!TYPES.obj(doc)) throw new ShapeError('the top level is not an object');
  if (doc.schema !== SCHEMA) throw new ShapeError(`schema is ${JSON.stringify(doc.schema)}, not ${SCHEMA}`);
  if (doc.entry !== ENTRY) throw new ShapeError(`entry is ${JSON.stringify(doc.entry)}, not ${ENTRY}`);
  if (!Array.isArray(doc.records)) throw new ShapeError('records is not an array');
  doc.records.forEach(checkRecord);
  const seen = new Set();
  for (const r of doc.records) {
    const key = SINGLE.has(r.kind) ? r.kind : `${r.kind}:${r[UNIQUE_BY[r.kind]]}`;
    if (seen.has(key)) throw new ShapeError(`more than one ${SINGLE.has(r.kind) ? `${r.kind} record` : `${r.kind} record for ${r[UNIQUE_BY[r.kind]]}`}`);
    seen.add(key);
  }
  if (!seen.has('run')) throw new ShapeError('no run record');
  if (!doc.records[0] || doc.records[0].kind !== 'run') throw new ShapeError('the first record is not the run record');
  if (!doc.records.find((r) => r.kind === 'run').workflow_ref.includes(`/${WORKFLOW}@`)) throw new ShapeError(`the run is not of ${WORKFLOW}`);
  return doc;
}

const round = (v, places) => Math.round(v * 10 ** places) / 10 ** places;
const short = (d) => (d ? d.slice(0, 19) : '-');

// Everything the criteria and the result file read, drawn from the records.
export function derive(doc) {
  const of = (kind) => doc.records.filter((r) => r.kind === kind);
  const one = (kind) => of(kind)[0] ?? null;
  const pushes = of('push').map((p) => ({
    ...p,
    // MB is 10^6 bytes, as mirror-archlinux's "34 MB/s" counts it.
    mb_per_s: p.rc === 0 && p.seconds > 0 ? round(p.bytes / 1e6 / p.seconds, 1) : null,
  }));
  const attempts = of('layers');
  const accepted = attempts.filter((a) => a.outcome === 'accepted').map((a) => a.n);
  const refused = attempts.filter((a) => a.outcome === 'refused').map((a) => a.n);
  const largest = accepted.length ? Math.max(...accepted) : 0;
  const smallestRefused = refused.length ? Math.min(...refused) : null;
  const anon = new Map(of('anon').map((a) => [a.what, a]));
  return {
    run: one('run'),
    end: one('end'),
    existed: one('existed'),
    stop: one('stop'),
    pkg: one('package'),
    pushes,
    layers: { attempts, largest, smallestRefused, inconsistent: smallestRefused !== null && smallestRefused <= largest, stop: one('layers-stop') },
    retag: { earlier: one('retag-earlier'), a: of('retag-push').find((p) => p.which === 'a') ?? null, b: of('retag-push').find((p) => p.which === 'b') ?? null },
    anon,
  };
}

// 124 is timeout's own exit, 137 its kill after the grace period.
const exitText = (rc, seconds) => (rc === 124 || rc === 137 ? `ended by the job's limit after ${seconds} s` : `oras exited ${rc} after ${seconds} s`);
const rate = (v) => (v === null ? '-' : v.toFixed(1));
const viaText = (a) => (a.via === 'qq' ? 'Bearer QQ==' : a.via === 'token' ? `the anonymous token flow (Bearer QQ== answered ${a.qq_status})` : 'no credential');
const answerText = (a) => `HTTP ${a.status} (Bearer QQ== ${a.qq_status}${a.token_status === null ? '' : `, anonymous token endpoint ${a.token_status}`})`;

function pushCriterion(d, mib) {
  const name = pushName(mib);
  const p = d.pushes.find((x) => x.mib === mib);
  if (!p) return { name, pass: false, detail: `no push of ${mib} MiB in this run${d.stop ? `: ${d.stop.reason}` : ''}` };
  if (p.rc !== 0) return { name, pass: false, detail: `${exitText(p.rc, p.seconds)}${p.error ? `: ${p.error}` : ''}` };
  if (p.bytes !== mib * 1048576) return { name, pass: false, detail: `the payload held ${p.bytes} bytes, not ${mib} MiB` };
  if (!p.digest) return { name, pass: false, detail: 'oras exited 0 and printed no manifest digest' };
  if (p.seconds >= UPLOAD_LIMIT_S) return { name, pass: false, detail: `${p.seconds} s, not under GHCR's ${UPLOAD_LIMIT_S} s upload limit` };
  return { name, pass: true, detail: `${p.seconds} s, ${rate(p.mb_per_s)} MB/s` };
}

function layersCriterion(d) {
  const { attempts, largest, smallestRefused, stop } = d.layers;
  const tail = `${smallestRefused === null ? 'none refused' : `smallest refused ${smallestRefused}`}${stop ? `; ${stop.reason}` : ''}`;
  if (!attempts.length) return { name: LAYERS_NAME, pass: false, detail: `not measured${stop ? `: ${stop.reason}` : d.stop ? `: ${d.stop.reason}` : ''}` };
  return { name: LAYERS_NAME, pass: largest >= LAYER_FLOOR, detail: `largest accepted ${largest}, ${tail}` };
}

function anonymousCriterion(d) {
  const name = 'anonymous-read';
  const a = d.anon.get('size-manifest');
  if (!a) return { name, pass: false, detail: 'not measured: no anonymous read of the first push' };
  const pushed = d.pushes.find((p) => p.tag === a.ref);
  if (a.status !== 200) return { name, pass: false, detail: `${a.ref}: ${answerText(a)}` };
  // docs/architecture.md section 4.3: the reader asks the token endpoint only after a 401 or a 403.
  if (a.via === 'token' && a.qq_status !== 401 && a.qq_status !== 403) {
    return {
      name,
      pass: false,
      detail: `${a.ref}: Bearer QQ== answered ${a.qq_status} and only the token flow read it; the reader of docs/architecture.md section 4.3 falls back after 401 or 403 alone`,
    };
  }
  if (!pushed || !pushed.digest) return { name, pass: false, detail: `${a.ref}: read 200, and this run recorded no digest for its push to compare` };
  if (a.digest !== pushed.digest) return { name, pass: false, detail: `${a.ref}: the bytes read hash to ${a.digest}, not the pushed ${pushed.digest}` };
  return { name, pass: true, detail: `${a.ref}: 200 via ${viaText(a)}, the digest of the push` };
}

function secondPushCriterion(d) {
  const name = 'second-push-with-token';
  const e = d.existed;
  const first = d.pushes[0] ?? null;
  if (!e) return { name, pass: false, detail: 'not measured: no record of whether the probe existed before this run' };
  if (e.present === false) {
    return { name, pass: false, detail: `the probe did not exist before this run (tags/list ${e.status}), so this run created it; dispatch ${WORKFLOW} again and summarise that run` };
  }
  if (e.present !== true) return { name, pass: false, detail: `could not tell whether the probe existed before this run (token endpoint ${e.token_status}, tags/list ${e.status})` };
  if (!first) return { name, pass: false, detail: `the probe existed before this run, and this run recorded no push${d.stop ? `: ${d.stop.reason}` : ''}` };
  if (first.rc !== 0) return { name, pass: false, detail: `the probe existed before this run, and this run's push of ${first.tag} failed: ${first.error ?? `oras exited ${first.rc}`}` };
  return { name, pass: true, detail: `the probe existed before this run (${e.tags ?? '-'} tags), and this run's token pushed ${first.tag}` };
}

// The five criteria of the entry's Prove, in its order.
export function criteria(d) {
  return [...SIZES_MIB.map((mib) => pushCriterion(d, mib)), layersCriterion(d), anonymousCriterion(d), secondPushCriterion(d)];
}

const readText = (a) => (a ? `${a.status}${a.via === 'qq' ? '' : ` via ${a.via}`}` : '-');

// One line per measurement, in the order the run took them.
export function measurementLines(d) {
  const r = d.run;
  const out = [];
  out.push(
    `measure-push run ${r.id} attempt ${r.attempt}, ${r.sha.slice(0, 12)} on ${r.ref}, ${r.image ?? '-'}, oras ${r.oras ?? '-'}, curl ${r.curl ?? '-'}, ${r.started_at} to ${d.end?.finished_at ?? '-'}`,
  );
  out.push(`inputs: size_mb ${r.inputs.size_mb}, layers ${r.inputs.layers === 0 ? '0 (the series 100, 256, 1000)' : r.inputs.layers}`);
  const e = d.existed;
  out.push(
    e
      ? `existed before this run: ${e.present === null ? 'unknown' : e.present ? 'yes' : 'no'} (token endpoint ${e.token_status}, tags/list ${e.status}${e.tags === null ? '' : `, ${e.tags} tags`})`
      : 'existed before this run: not measured',
  );
  const pauses = (x) => (x.rate_limit_pauses ? `, after ${x.rate_limit_pauses} pause(s) for a 429` : '');
  for (const p of d.pushes) {
    out.push(
      p.rc === 0
        ? `push ${p.tag}: ${p.bytes} bytes in ${p.seconds} s, ${rate(p.mb_per_s)} MB/s, manifest ${short(p.digest)}${pauses(p)}`
        : `push ${p.tag}: ${exitText(p.rc, p.seconds)}${pauses(p)}: ${p.error ?? '-'}`,
    );
  }
  if (d.stop) out.push(`stopped: ${d.stop.reason}`);
  const k = d.pkg;
  out.push(k ? `package record: HTTP ${k.status}, visibility ${k.visibility ?? '-'}, repository ${k.repository ?? '-'}${k.message ? `, "${k.message}"` : ''}` : 'package record: not measured');
  const { a, b, earlier } = d.retag;
  if (a || b) {
    const tag = d.anon.get('retag-tag');
    const am = d.anon.get('retag-a-manifest');
    const ab = d.anon.get('retag-a-blob');
    out.push(
      `retag: A ${short(a?.digest)}, then B ${short(b?.digest)}; the tag reads ${tag ? `${readText(tag)} ${short(tag.digest)}${tag.digest && tag.digest === b?.digest ? ' (B)' : ''}` : '-'}; A by digest ${readText(am)}${am?.digest && am.digest === a?.digest ? ' (A)' : ''}, its blob ${readText(ab)}${ab?.digest && ab.digest === a?.payload_sha256 ? ' (the A payload)' : ''}`,
    );
  }
  if (earlier) {
    if (earlier.status === 'present') {
      const eb = d.anon.get('earlier-b-manifest');
      const ea = d.anon.get('earlier-a-manifest');
      const eab = d.anon.get('earlier-a-blob');
      out.push(
        `retag of run ${earlier.run ?? '-'}: its B ${short(earlier.b_digest)} by digest ${readText(eb)}; its A ${short(earlier.a_digest)}, untagged since ${earlier.at ?? '-'}, by digest ${readText(ea)}${ea?.digest && ea.digest === earlier.a_digest ? ' (A)' : ''}, its blob ${readText(eab)}`,
      );
    } else {
      out.push(`retag of an earlier run: ${earlier.status}${earlier.error ? `: ${earlier.error}` : ''}`);
    }
  }
  for (const x of d.layers.attempts) out.push(`layers ${x.n}: ${x.outcome} in ${x.seconds} s${pauses(x)}${x.error && x.outcome !== 'accepted' ? `: ${x.error}` : ''}`);
  if (d.layers.stop) out.push(`layers stopped: ${d.layers.stop.reason}`);
  if (d.layers.inconsistent) out.push(`layers: NOTE the registry accepted ${d.layers.largest} and refused ${d.layers.smallestRefused}, so the limit is not a count alone`);
  const sm = d.anon.get('size-manifest');
  if (sm) {
    const sb = d.anon.get('size-blob');
    const sr = d.anon.get('size-blob-range');
    out.push(
      `anonymous read ${sm.ref}: manifest ${answerText(sm)}${sm.layers === null ? '' : `, ${sm.layers} layer(s)`}; blob ${sb ? answerText(sb) : '-'}; 1 KiB range ${sr ? `${answerText(sr)}, ${sr.bytes ?? 0} bytes` : '-'}`,
    );
  }
  return out;
}

// What docs/research/measure/DOM-006/result.json holds.
export function resultFile(d, crit) {
  const r = d.run;
  const sm = d.anon.get('size-manifest') ?? null;
  const read = (what) => {
    const a = d.anon.get(what);
    return a ? { status: a.status, via: a.via, digest: a.digest } : null;
  };
  const { a, b, earlier } = d.retag;
  return {
    schema: RESULT_SCHEMA,
    entry: ENTRY,
    run: { id: r.id, attempt: r.attempt, sha: r.sha, ref: r.ref, image: r.image, oras: r.oras, curl: r.curl, started_at: r.started_at, finished_at: d.end?.finished_at ?? null, inputs: r.inputs },
    package: PACKAGE,
    visibility: d.pkg?.visibility ?? null,
    package_record_status: d.pkg?.status ?? null,
    linked_repository: d.pkg?.repository ?? null,
    existed_before: d.existed?.present ?? null,
    anonymous_read: sm
      ? {
          ref: sm.ref,
          status: sm.status,
          via: sm.via,
          qq_status: sm.qq_status,
          token_status: sm.token_status,
          digest: sm.digest,
          blob_status: d.anon.get('size-blob')?.status ?? null,
          range_status: d.anon.get('size-blob-range')?.status ?? null,
        }
      : null,
    pushes: d.pushes.map((p) => ({ tag: p.tag, mib: p.mib, bytes: p.bytes, seconds: p.seconds, mb_per_s: p.mb_per_s, rc: p.rc, digest: p.digest, error: p.error })),
    layers: {
      largest_accepted: d.layers.largest,
      smallest_refused: d.layers.smallestRefused,
      attempts: d.layers.attempts.map((x) => ({ n: x.n, outcome: x.outcome, seconds: x.seconds, error: x.error })),
      stop: d.layers.stop?.reason ?? null,
    },
    retag: {
      a: a?.digest ?? null,
      b: b?.digest ?? null,
      tag_after_retag: read('retag-tag'),
      a_after_retag: read('retag-a-manifest'),
      a_blob_after_retag: read('retag-a-blob'),
      earlier: earlier
        ? {
            status: earlier.status,
            run: earlier.run,
            a: earlier.a_digest,
            untagged_since: earlier.at,
            b: earlier.b_digest,
            a_read: read('earlier-a-manifest'),
            a_blob_read: read('earlier-a-blob'),
            b_read: read('earlier-b-manifest'),
          }
        : null,
    },
    criteria: crit.map((c) => ({ name: c.name, verdict: c.pass ? 'PASS' : 'FAIL', detail: c.detail })),
  };
}

// The text of push-result.json from the artifact of run `runId`.
export function downloadResult(runId, { repo = REPO, spawn = spawnSync } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'domains-push-result-'));
  try {
    const r = spawn('gh', ['run', 'download', String(runId), '--repo', repo, '--name', ARTIFACT, '--dir', dir], { encoding: 'utf8' });
    if (r.error) throw new RunError(`gh could not start: ${r.error.message}`);
    if (r.status !== 0)
      throw new RunError(
        `gh run download ${runId} --repo ${repo} --name ${ARTIFACT} exited ${r.status}: ${String(r.stderr ?? '')
          .trim()
          .slice(0, 300)}`,
      );
    try {
      return readFileSync(join(dir, FILE), 'utf8');
    } catch (e) {
      throw new RunError(`the artifact ${ARTIFACT} of run ${runId} holds no ${FILE}: ${e.message}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// A temp file in the same directory, then a rename: a killed run leaves the old file whole.
function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

const OPTIONS = new Set(['_', 'run', 'file', 'repo', 'out', 'require']);

// The command line; returns the exit code. `spawn`, `log` and `err` are seams for the test.
export function main(argv, { spawn = spawnSync, log = console.log, err = console.error } = {}) {
  const args = parseArgs(argv);
  const fail = (msg) => {
    err(`push-summary: ${msg}`);
    return 2;
  };
  const unknown = Object.keys(args).filter((k) => !OPTIONS.has(k));
  if (unknown.length || args._.length) return fail(`unknown argument ${unknown.length ? `--${unknown[0]}` : args._[0]}`);
  if (Boolean(args.run) === Boolean(args.file)) return fail('give exactly one of --run RUN_ID and --file PATH');
  if (args.run !== undefined && !/^\d+$/.test(String(args.run))) return fail('--run takes a numeric run id');
  if (args.file === true || args.out === true || args.repo === true || args.require === true) return fail('--file, --out, --repo and --require each take a value');
  const repo = args.repo ?? REPO;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) return fail(`--repo ${repo} is not OWNER/NAME`);
  const deciding = args.require ? String(args.require).split(',') : CRITERIA;
  const bad = deciding.filter((n) => !CRITERIA.includes(n));
  if (bad.length) return fail(`--require names the unknown criterion ${bad[0]}; known: ${CRITERIA.join(', ')}`);

  let text;
  try {
    text = args.run ? downloadResult(args.run, { repo, spawn }) : readFileSync(resolve(String(args.file)), 'utf8');
  } catch (e) {
    if (e instanceof RunError) return fail(e.message);
    if (typeof e?.code === 'string') return fail(`cannot read ${args.file}: ${e.message}`);
    throw e;
  }
  let doc;
  try {
    doc = parseResult(text);
  } catch (e) {
    if (e instanceof ShapeError) return fail(`${args.run ? `the artifact of run ${args.run}` : args.file}: ${e.message}`);
    throw e;
  }
  const d = derive(doc);
  if (args.run && d.run.id !== String(args.run)) return fail(`the artifact names run ${d.run.id}, not ${args.run}`);
  if (args.run && d.run.repository !== repo) return fail(`the artifact names the repository ${d.run.repository}, not ${repo}`);
  // DOM-006's proof is a run of the workflow on main: a run dispatched on
  // another branch pushes the same probe with code that is not main's.
  if (args.run && (d.run.ref !== MAIN_REF || !d.run.workflow_ref.endsWith(`/${WORKFLOW}@${MAIN_REF}`))) return fail(`the artifact is of a run on ${d.run.ref}, not ${MAIN_REF}`);

  const crit = criteria(d);
  for (const line of measurementLines(d)) log(line);
  for (const c of crit) log(`${c.pass ? 'PASS' : 'FAIL'} ${c.name}  ${c.detail}`);

  const out = args.out ? resolve(String(args.out)) : args.run ? DEFAULT_OUT : null;
  if (out) {
    writeAtomic(out, `${JSON.stringify(resultFile(d, crit), null, 2)}\n`);
    log(`wrote ${out}`);
    if (args.run) {
      const raw = join(dirname(out), `push-result-${args.run}.json`);
      writeAtomic(raw, text);
      log(`wrote ${raw}`);
    }
  }
  return crit.every((c) => c.pass || !deciding.includes(c.name)) ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv.slice(2));
