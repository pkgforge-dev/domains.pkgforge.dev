// scripts/measure/range-load.test.mjs — DOM-007's load script against a local
// HTTP server that stands in for the probe Worker's /range route. The server's
// answers are synthetic, in the shape probes/worker/src/range.ts writes: their
// digests, sizes, colos and timings are invented, and no probe made them. Each
// criterion's refusal is planted in the server's answers.
//
//   node scripts/test.mjs scripts/measure --name "range load"
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { quantile } from '../../probes/worker/src/gaps.ts';
import { classify, DEFAULT_TAG, distinctBlocks, judge, main, mulberry32, parseFlags, RESULT_SCHEMA, readUrl, redactHost, SCHEMA, summarize, UsageError } from './range-load.mjs';

const SCRIPT = fileURLToPath(new URL('./range-load.mjs', import.meta.url));
const PIN = `sha256:${'a'.repeat(64)}`;
const LAYER = `sha256:${'b'.repeat(64)}`;
const SIZE = 100 * 1024 * 1024;
const REPO = 'pkgforge-dev/domains.pkgforge.dev/probe';
const dir = mkdtempSync(join(tmpdir(), 'range-load-'));
after(() => rmSync(dir, { recursive: true, force: true }));

// An answer of the route for query q: a 206 read, from the block cache when q asks cache=block.
function answer(q, over = {}) {
  const cache = q.cache ?? 'none';
  return {
    v: 1,
    entry: 'DOM-007',
    query: { repo: q.repo, tag: q.tag, offset: Number(q.offset), length: Number(q.length), cache },
    ok: true,
    status: 206,
    failed_at: null,
    error: null,
    manifest: { digest: PIN },
    layer: { digest: LAYER, size: SIZE, title: 'payload.bin', index: 0 },
    signed: null,
    bytes: null,
    steps: [],
    subrequests: cache === 'block' ? 0 : 3,
    total_ms: 7,
    cf_ray: null,
    colo: 'TST',
    cache: { mode: cache, ...(cache === 'block' ? { manifest: 'hit', block: 'hit' } : {}), puts: [] },
    ...over,
  };
}

// The stand-in probe. respond(query, n) gives { status, body, delay, hang } for the n-th request (0 is the pin).
async function probe(respond = (q) => ({ body: answer(q) })) {
  const state = { requests: [], inflight: 0, maxInflight: 0 };
  const server = createServer(async (req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const q = Object.fromEntries(u.searchParams);
    const n = state.requests.length;
    state.requests.push({ path: u.pathname, q });
    state.inflight += 1;
    state.maxInflight = Math.max(state.maxInflight, state.inflight);
    const r = await respond(q, n);
    if (r.delay) await delay(r.delay);
    state.inflight -= 1;
    if (r.hang) return;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    res.writeHead(r.status ?? 200, { 'content-type': typeof r.body === 'string' ? 'text/plain' : 'application/json' });
    res.end(text);
  });
  await new Promise((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    url: `http://127.0.0.1:${server.address().port}/range`,
    state,
    close: () =>
      new Promise((ok) => {
        server.closeAllConnections();
        server.close(ok);
      }),
  };
}

async function run(args) {
  let stdout = '';
  let stderr = '';
  const code = await main(args, { stdout: { write: (s) => (stdout += s) }, stderr: { write: (s) => (stderr += s) } });
  return { code, stdout, stderr };
}

let n = 0;
const outPath = () => join(dir, `result-${n++}.json`);

test('range load: the flags are checked, and a run that cannot start exits 2 with the usage', async () => {
  const base = ['--url', 'https://p.example.test/range'];
  for (const [args, why] of [
    [['--mode', 'cold', '--rps', '1'], /--url is required/],
    [['--url', 'https://p.example.test/gaps', '--mode', 'cold', '--rps', '1'], /ending in \/range/],
    [[...base, '--mode', 'hot', '--rps', '1'], /--mode must be/],
    [[...base, '--mode', 'cold'], /--rps is required/],
    [[...base, '--mode', 'cold', '--rps', '0'], /--rps must be a whole number from 1 to 500/],
    [[...base, '--mode', 'cold', '--rps', '1', '--length', '1048577'], /--length must be a whole number from 1 to 1048576/],
    [[...base, '--mode', 'warm', '--rps', '1', '--cache', 'none'], /--mode warm reads with --cache block/],
    [[...base, '--mode', 'cold', '--rps', '1', '--blocks', '5'], /--blocks is a flag of --mode warm/],
    [[...base, '--mode', 'single', '--rps', '1'], /--rps is not a flag of --mode single/],
    [[...base, '--mode', 'single', '--sizes', '1024,big'], /--sizes is a comma list/],
    [[...base, '--mode', 'cold', '--rps', '1', '--tag', 'Size-1536m'], /--tag must be a lowercase tag/],
    [[...base, '--mode', 'cold', '--rps', '1', '--bogus', '1'], /unknown flag --bogus/],
  ]) {
    assert.throws(
      () => parseFlags(args),
      (e) => e instanceof UsageError && why.test(e.message),
      args.join(' '),
    );
  }
  const f = parseFlags([...base, '--mode', 'cold', '--rps', '100', '--seconds', '60', '--expect', '206']);
  assert.deepEqual([f.repo, f.tag, f.length, f.cache, f.seconds, f.expect, f.place], [REPO, DEFAULT_TAG, 25600, 'none', 60, 206, 'local']);
  assert.equal(parseFlags([...base, '--mode', 'warm', '--rps', '5']).cache, 'block');
  assert.deepEqual(parseFlags([...base, '--mode', 'single']).sizes, [1024, 25600, 65536, 1048576]);
  const cli = await new Promise((done) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [SCRIPT, '--mode', 'cold'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (c) => (err += c));
    child.on('close', (code) => done({ code, err }));
  });
  assert.equal(cli.code, 2);
  assert.match(cli.err, /--url is required[\s\S]*usage:/);
});

test('range load: cold pins the tag to its manifest digest, then asks a new block of every request by that digest, and PASSes a fast probe', async () => {
  const p = await probe();
  try {
    const out = outPath();
    const r = await run(['--url', p.url, '--rps', '20', '--seconds', '1', '--mode', 'cold', '--expect', '206', '--seed', '7', '--place', 'operator', '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    const [first, ...timed] = p.state.requests;
    assert.deepEqual(first?.q, { repo: REPO, tag: DEFAULT_TAG, offset: '0', length: '1', cache: 'none' });
    assert.equal(timed.length, 20);
    assert.ok(timed.every(({ path, q }) => path === '/range' && q.tag === PIN && q.repo === REPO && q.length === '25600' && q.cache === 'none' && Number(q.offset) % 25600 === 0));
    assert.equal(new Set(timed.map(({ q }) => q.offset)).size, 20, 'every block is new');
    assert.match(r.stdout, /^requests {5}20 {2}206 20 {2}429 0 {2}5xx 0 {2}other 0$/m);
    assert.match(r.stdout, /^PASS p95-under-3000ms/m);
    assert.match(r.stdout, /^PASS no-429/m);
    assert.match(r.stdout, /\nPASS\n$/);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(result.schema, SCHEMA);
    assert.equal(result.verdict, 'PASS');
    assert.deepEqual(result.target, { host: '127.0.0.1:' + new URL(p.url).port, path: '/range', repo: REPO, tag: DEFAULT_TAG, ref: PIN, layer: { digest: LAYER, size: SIZE, title: 'payload.bin' } });
    assert.deepEqual([result.run.mode, result.run.place, result.run.seed, result.run.rps, result.run.seconds], ['cold', 'operator', 7, 20, 1]);
    assert.deepEqual(result.summary.colos, { TST: 20 });
    assert.deepEqual(result.summary.subrequests, { n: 20, p50: 3, max: 3, mean: 3 });
  } finally {
    await p.close();
  }
});

test('range load: the loop is open: requests start on the clock while earlier ones are still unanswered', async () => {
  const p = await probe((q, i) => ({ body: answer(q), delay: i === 0 ? 0 : 300 }));
  try {
    const started = performance.now();
    const r = await run(['--url', p.url, '--rps', '20', '--seconds', '1', '--mode', 'cold', '--expect', '206']);
    const elapsed = performance.now() - started;
    assert.equal(r.code, 0, r.stdout);
    assert.equal(p.state.requests.length, 21);
    // A closed loop holds one request in flight and takes 20 x 300 ms; this one holds about 6.
    assert.ok(p.state.maxInflight >= 4, `at most ${p.state.maxInflight} in flight`);
    assert.ok(elapsed < 3000, `took ${Math.round(elapsed)} ms`);
  } finally {
    await p.close();
  }
});

test('range load: one 429 fails no-429', async () => {
  const p = await probe((q, i) => ({ body: i === 5 ? answer(q, { ok: false, status: 429, failed_at: 'manifest' }) : answer(q) }));
  try {
    const r = await run(['--url', p.url, '--rps', '20', '--seconds', '1', '--mode', 'cold']);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^FAIL no-429 {2}1 of 20$/m);
    assert.match(r.stdout, /^by_status +206:19 429@manifest:1$/m);
    assert.match(r.stdout, /\nFAIL\n$/);
  } finally {
    await p.close();
  }
});

test('range load: 5xx at 1% of answers passes and above 1% fails, whether the read or the Worker itself answered it', async () => {
  for (const [bad, verdict] of [
    [[10], 'PASS'],
    [[10, 20], 'FAIL'],
  ]) {
    const p = await probe((q, i) => {
      if (i === 10) return { body: answer(q, { ok: false, status: 503, failed_at: 'blob' }) };
      if (i === 20 && bad.includes(20)) return { status: 502, body: 'error code: 502' };
      return { body: answer(q) };
    });
    try {
      const r = await run(['--url', p.url, '--rps', '50', '--seconds', '2', '--mode', 'cold']);
      assert.equal(r.code, verdict === 'PASS' ? 0 : 1, r.stdout);
      assert.match(r.stdout, new RegExp(`^${verdict} 5xx-at-most-1pct {2}${bad.length} of 100$`, 'm'));
      if (bad.length === 2) assert.match(r.stdout, /worker-502:1/);
    } finally {
      await p.close();
    }
  }
});

test('range load: a p95 over the warm limit fails, after the prefill read each fixed block once', async () => {
  const p = await probe((q, i) => ({ body: answer(q), delay: i <= 5 ? 0 : 350 }));
  try {
    const out = outPath();
    const r = await run(['--url', p.url, '--rps', '10', '--seconds', '1', '--mode', 'warm', '--blocks', '5', '--length', '1024', '--out', out]);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stdout, /^FAIL p95-under-300ms {2}p95 \d+ ms$/m);
    assert.match(r.stdout, /^PASS warm-reads-cached {2}10 of 10 expected answers from the block cache$/m);
    const prefill = p.state.requests.slice(1, 6).map(({ q }) => [q.offset, q.cache]);
    assert.deepEqual(
      prefill.sort((a, b) => Number(a[0]) - Number(b[0])),
      [
        ['0', 'block'],
        ['1024', 'block'],
        ['2048', 'block'],
        ['3072', 'block'],
        ['4096', 'block'],
      ],
    );
    assert.deepEqual(
      p.state.requests.slice(6).map(({ q }) => q.offset),
      ['0', '1024', '2048', '3072', '4096', '0', '1024', '2048', '3072', '4096'],
    );
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.ok(result.summary.latency_ms.p95 >= 350, `p95 ${result.summary.latency_ms.p95} ms`);
    assert.deepEqual(result.prefill, { requests: 5, expected: 5 });
    assert.equal(result.run.blocks, 5);
  } finally {
    await p.close();
  }
});

test('range load: a warm run whose reads never came from the block cache fails warm-reads-cached, however fast', async () => {
  const p = await probe((q) => ({ body: answer(q, { subrequests: 1, cache: { mode: 'block', manifest: 'hit', block: 'miss', signed: 'hit', puts: [] } }) }));
  try {
    const r = await run(['--url', p.url, '--rps', '10', '--seconds', '1', '--mode', 'warm', '--blocks', '5', '--length', '1024']);
    // Its latency is the machine's own and is not asserted: warm-reads-cached
    // fails it alone.
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^FAIL warm-reads-cached {2}0 of 10 expected answers from the block cache$/m);
    assert.match(r.stdout, /^cache {8}manifest hit 10 miss 0 error 0 · signed hit 10 miss 0 error 0 · block hit 0 miss 10 error 0$/m);
  } finally {
    await p.close();
  }
});

test('range load: an answer that is not JSON 200 counts by the Worker status, and a client timeout and a step timeout count as other', async () => {
  const p = await probe((q, i) => {
    if (i === 3) return { status: 500, body: 'worker threw' };
    if (i === 4) return { hang: true };
    if (i === 5) return { body: answer(q, { ok: false, status: null, failed_at: 'range', error: 'timeout' }) };
    if (i === 6) return { status: 400, body: { error: 'offset past the end' } };
    return { body: answer(q) };
  });
  try {
    const out = outPath();
    const r = await run(['--url', p.url, '--rps', '10', '--seconds', '1', '--mode', 'cold', '--timeout-ms', '1000', '--out', out]);
    assert.equal(r.code, 1);
    const s = JSON.parse(readFileSync(out, 'utf8')).summary;
    assert.deepEqual(s.counts, { requests: 10, expected: 6, 429: 0, '5xx': 1, other: 3 });
    assert.deepEqual(s.by_status, { 206: 6, 'worker-500': 1, 'client-timeout': 1, 'timeout@range': 1, 'worker-400': 1 });
    assert.ok(s.latency_ms.max >= 1000, 'the client timeout counts in the latency');
    assert.deepEqual(
      s.samples.map((x) => x.key),
      ['worker-500', 'client-timeout', 'timeout@range', 'worker-400'],
    );
  } finally {
    await p.close();
  }
});

test('range load: a pin read that does not answer 206 exits 2 and writes nothing', async () => {
  for (const respond of [
    (q) => ({ body: answer(q, { ok: false, status: 404, failed_at: 'manifest', manifest: null, layer: null }) }),
    () => ({ status: 400, body: { error: 'tag is required' } }),
    (q) => ({ body: answer(q, { manifest: { digest: 'sha256:short' } }) }),
  ]) {
    const p = await probe(respond);
    try {
      const out = outPath();
      const r = await run(['--url', p.url, '--rps', '10', '--seconds', '1', '--mode', 'cold', '--out', out]);
      assert.equal(r.code, 2, r.stderr);
      assert.match(r.stderr, /could not run: the pin read/);
      assert.equal(p.state.requests.length, 1);
      assert.equal(existsSync(out), false);
    } finally {
      await p.close();
    }
  }
  const p = await probe((q) => ({ body: answer(q, { manifest: { digest: `sha256:${'c'.repeat(64)}` } }) }));
  try {
    const r = await run(['--url', p.url, '--rps', '10', '--seconds', '1', '--mode', 'cold', '--tag', PIN]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /the pin read of sha256:a{64} answered the manifest sha256:c{64}/);
  } finally {
    await p.close();
  }
});

test('range load: single reads each size one at a time, cold over new blocks with no cache, then warm over one block from the block cache', async () => {
  const p = await probe();
  try {
    const out = outPath();
    const r = await run(['--url', p.url, '--mode', 'single', '--count', '3', '--sizes', '1024,2048', '--out', out]);
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.equal(p.state.maxInflight, 1);
    const [, ...reads] = p.state.requests.map(({ q }) => [q.length, q.cache, q.offset]);
    assert.equal(reads.length, 14);
    for (const [at, size] of [
      [0, '1024'],
      [7, '2048'],
    ]) {
      const cold = reads.slice(at, at + 3);
      assert.ok(
        cold.every(([l, c, o]) => l === size && c === 'none' && Number(o) % Number(size) === 0),
        JSON.stringify(cold),
      );
      assert.equal(new Set(cold.map(([, , o]) => o)).size, 3);
      assert.deepEqual(
        reads.slice(at + 3, at + 7),
        Array.from({ length: 4 }, () => [size, 'block', '0']),
      );
    }
    assert.match(r.stdout, /^1024 {7}cold {2}3 {4}3 {4}/m);
    assert.match(r.stdout, /^2048 {7}warm {2}3 {4}3 {4}.* 3$/m);
    assert.match(r.stdout, /^PASS all-expected {2}12 of 12$/m);
    const result = JSON.parse(readFileSync(out, 'utf8'));
    assert.deepEqual(
      result.rows.map((row) => [row.size, row.kind, row.counts.expected]),
      [
        [1024, 'cold', 3],
        [1024, 'warm', 3],
        [2048, 'cold', 3],
        [2048, 'warm', 3],
      ],
    );
  } finally {
    await p.close();
  }
});

test('range load: the summary takes gaps.ts quantiles over every request, and judge holds 1% as a pass and more as a fail', () => {
  const rec = (ms, cls = 'expected', key = '206', block) => ({ i: 0, offset: 0, lag: 0, ms, cls, key, error: null, subrequests: 3, worker_ms: ms - 1, colo: 'TST', cache: block ? { block } : {} });
  const ms = Array.from({ length: 200 }, (_, i) => i + 1);
  const s = summarize(ms.map((v) => rec(v)));
  assert.deepEqual(s.latency_ms, { n: 200, p50: quantile(ms, 0.5), p95: quantile(ms, 0.95), max: 200 });
  assert.deepEqual([s.latency_ms.p50, s.latency_ms.p95], [101, 191]);
  const records = [...Array.from({ length: 98 }, () => rec(10)), rec(10, '5xx', '503@blob'), rec(10, 'other', '404@manifest')];
  const names = (crit) => Object.fromEntries(crit.map((c) => [c.name, c.pass]));
  assert.deepEqual(names(judge(summarize(records), 'cold')), { requests: true, 'p95-under-3000ms': true, 'no-429': true, '5xx-at-most-1pct': true, 'other-at-most-1pct': true });
  records.push(rec(10, '5xx', '503@blob'));
  assert.equal(names(judge(summarize(records), 'cold'))['5xx-at-most-1pct'], false);
  assert.equal(names(judge(summarize([]), 'cold')).requests, false);
  assert.equal(names(judge(summarize([rec(300, 'expected', '206', 'hit')]), 'warm'))['p95-under-300ms'], false, 'the limit is strict');
  assert.equal(names(judge(summarize([rec(299, 'expected', '206', 'hit'), rec(1, 'expected', '206', 'miss')]), 'warm'))['warm-reads-cached'], false, 'half is not more than half');
  // 2% other (a 404 and a client timeout), fast and with no 5xx or 429: other-at-most-1pct fails it alone.
  const others = [...Array.from({ length: 98 }, () => rec(10)), rec(10, 'other', '404@manifest'), rec(10, 'other', 'client-timeout')];
  assert.deepEqual(names(judge(summarize(others), 'cold')), { requests: true, 'p95-under-3000ms': true, 'no-429': true, '5xx-at-most-1pct': true, 'other-at-most-1pct': false });
  const oneIn100 = [...Array.from({ length: 99 }, () => rec(10)), rec(10, 'other', 'client-timeout')];
  assert.equal(names(judge(summarize(oneIn100), 'cold'))['other-at-most-1pct'], true, '1% passes');
});

test('range load: classify reads the route status, then the Worker status, then the client failure', () => {
  const body = (over) => ({ http: 200, body: { v: 1, ok: true, status: 206, failed_at: null, error: null, ...over }, ms: 1, client: null });
  assert.deepEqual(classify(body({}), 206), { cls: 'expected', key: '206' });
  assert.deepEqual(classify(body({ ok: false, status: 206, failed_at: 'range', error: 'short' }), 206), { cls: 'other', key: '206@range-refused' });
  assert.deepEqual(classify(body({ ok: false, status: 429, failed_at: 'blob' }), 206), { cls: '429', key: '429@blob' });
  assert.deepEqual(classify(body({ ok: false, status: 504, failed_at: 'range' }), 206), { cls: '5xx', key: '504@range' });
  assert.deepEqual(classify(body({ ok: false, status: null, failed_at: 'manifest', error: 'unreachable: TypeError' }), 206), { cls: 'other', key: 'error@manifest' });
  assert.deepEqual(classify({ http: 429, body: null, ms: 1, client: null }, 206), { cls: '429', key: 'worker-429' });
  assert.deepEqual(classify({ http: 200, body: { v: 2 }, ms: 1, client: null }, 206), { cls: 'other', key: 'worker-200-not-an-answer' });
  assert.deepEqual(classify({ http: null, body: null, ms: 1, client: 'client-error ECONNRESET' }, 206), { cls: 'other', key: 'client-error ECONNRESET' });
});

test('range load: the helpers keep the account subdomain out, build the read URL, and draw distinct blocks from a seed', () => {
  assert.equal(redactHost('domains-probe.someaccount.workers.dev'), 'domains-probe.ACCOUNT.workers.dev');
  assert.equal(redactHost('domains.pkgforge.dev'), 'domains.pkgforge.dev');
  assert.equal(redactHost('127.0.0.1:8787'), '127.0.0.1:8787');
  assert.equal(
    readUrl('https://p.example.test/range?x=1', { repo: REPO, ref: PIN, offset: 25600, length: 25600, cache: 'none' }),
    `https://p.example.test/range?repo=${encodeURIComponent(REPO)}&tag=${encodeURIComponent(PIN)}&offset=25600&length=25600&cache=none`,
  );
  const a = distinctBlocks(mulberry32(42), 100, 1000);
  assert.equal(new Set(a).size, 100);
  assert.ok(a.every((k) => Number.isInteger(k) && k >= 0 && k < 1000));
  assert.deepEqual(distinctBlocks(mulberry32(42), 100, 1000), a, 'the same seed draws the same blocks');
  assert.notDeepEqual(distinctBlocks(mulberry32(1), 100, 1000), distinctBlocks(mulberry32(2), 100, 1000), 'another seed draws other blocks');
  assert.throws(
    () => distinctBlocks(mulberry32(1), 501, 1000),
    (e) => e instanceof UsageError && /lower --rps or --seconds/.test(e.message),
  );
});

test('range load: --merge joins run files into one result and two tables, FAILs when one run failed, and refuses a file that is not a run', async () => {
  // Two run files made by the script against the stand-in probe; the plan of
  // each place is then laid out as copies of them with run.place, run.mode and
  // run.rps changed (synthetic: their counts are the templates').
  const tpl = join(dir, 'merge-templates');
  mkdirSync(tpl);
  const fast = await probe();
  try {
    assert.equal((await run(['--url', fast.url, '--rps', '10', '--seconds', '1', '--mode', 'cold', '--place', 'operator', '--out', join(tpl, 'load.json')])).code, 0);
    assert.equal((await run(['--url', fast.url, '--mode', 'single', '--count', '2', '--sizes', '1024', '--place', 'runner', '--out', join(tpl, 'single.json')])).code, 0);
  } finally {
    await fast.close();
  }
  const load = JSON.parse(readFileSync(join(tpl, 'load.json'), 'utf8'));
  const single = JSON.parse(readFileSync(join(tpl, 'single.json'), 'utf8'));
  const runs = join(dir, 'merge');
  mkdirSync(runs);
  const lay = (name, doc) => writeFileSync(join(runs, name), JSON.stringify(doc));
  for (const place of ['operator', 'runner']) {
    lay(`${place}-single.json`, { ...single, run: { ...single.run, place } });
    for (const mode of ['cold', 'warm'])
      for (const rps of [20, 50, 100]) {
        // One run fails its own criterion: operator warm 50.
        const failed = place === 'operator' && mode === 'warm' && rps === 50;
        const criteria = failed ? [...load.criteria, { name: 'warm-reads-cached', pass: false, detail: '0 of 10' }] : load.criteria;
        lay(`${place}-${mode}-${rps}.json`, { ...load, run: { ...load.run, place, mode, rps }, criteria, verdict: failed ? 'FAIL' : 'PASS' });
      }
  }
  const out = outPath();
  const r = await run(['--merge', runs, '--out', out]);
  assert.equal(r.code, 1, r.stderr);
  assert.match(r.stdout, /^\| operator \| cold \| 20 \| 10 \| 10 \| 0 \| 0 \| 0 \| \d+ \| \d+ \| \d+ \| 7 \| 3 \| PASS \|$/m);
  assert.match(r.stdout, /^\| operator \| warm \| 50 \| 10 \| 10 \| 0 \| 0 \| 0 \| \d+ \| \d+ \| \d+ \| 7 \| 3 \| FAIL \|$/m);
  assert.match(r.stdout, /^\| runner \| 1024 \| cold \| 2 \| 2 \| /m);
  assert.match(r.stdout, /^\| runner \| 1024 \| warm \| 2 \| 2 \| .* \| 2 \|$/m);
  assert.match(r.stdout, new RegExp(`^refs: ${PIN} \\(layer ${LAYER}, ${SIZE} B\\)$`, 'm'));
  assert.match(r.stdout, /\nFAIL\n$/);
  const merged = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(merged.schema, RESULT_SCHEMA);
  assert.deepEqual(merged.places, ['operator', 'runner']);
  assert.equal(merged.runs.length, 12);
  assert.deepEqual(
    merged.runs.filter((x) => x.verdict !== 'PASS').map((x) => [x.file, x.failed]),
    [['operator-warm-50.json', ['warm-reads-cached']]],
  );
  assert.deepEqual(merged.refs, [{ ref: PIN, layer: { digest: LAYER, size: SIZE, title: 'payload.bin' } }]);
  // A run file whose verdict does not follow from its criteria is refused.
  const liar = JSON.parse(readFileSync(join(runs, 'operator-warm-50.json'), 'utf8'));
  lay('operator-warm-50.json', { ...liar, verdict: 'PASS' });
  const lying = await run(['--merge', runs]);
  assert.equal(lying.code, 2);
  assert.match(lying.stderr, /could not merge: operator-warm-50\.json says PASS, its criteria say FAIL/);
  lay('operator-warm-50.json', liar);
  // A place that lacks a run of the plan is refused, and nothing is written.
  rmSync(join(runs, 'runner-warm-100.json'));
  const partOut = outPath();
  const part = await run(['--merge', runs, '--out', partOut]);
  assert.equal(part.code, 2);
  assert.match(part.stderr, /could not merge: the plan is not whole; missing: runner warm 100/);
  assert.equal(existsSync(partOut), false);
  // One passing file alone is not a plan.
  const lone = join(dir, 'merge-lone');
  mkdirSync(lone);
  writeFileSync(join(lone, 'operator-cold-20.json'), readFileSync(join(runs, 'operator-cold-20.json')));
  const alone = await run(['--merge', lone]);
  assert.equal(alone.code, 2);
  assert.match(alone.stderr, /missing: operator single, operator cold 50, operator cold 100, operator warm 20/);
  lay('runner-warm-100.json', { ...load, run: { ...load.run, place: 'runner', mode: 'warm', rps: 100 } });
  writeFileSync(join(runs, 'stray.json'), JSON.stringify({ schema: 'domains.measure.push.v1' }));
  const refused = await run(['--merge', runs]);
  assert.equal(refused.code, 2);
  assert.match(refused.stderr, /could not merge: stray\.json is not a result of this script/);
  assert.throws(
    () => parseFlags(['--merge', runs, '--rps', '5']),
    (e) => e instanceof UsageError && /--merge takes --out only/.test(e.message),
  );
});
