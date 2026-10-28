import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ISC_LAGS, SCHEMA, utcDate, WHOISDS_LAGS } from './feed-poll.mjs';
import { analyse, checkResult, DEFINITIONS, datedFeed, download, formatTable, gapsOf, judge, loadPolls, main, RESULT_SCHEMA, rollingFeed, stampOf, stats } from './feed-times.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MIN = 60_000;
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString();
const dayStart = (date) => Date.parse(`${date}T00:00:00Z`);
const hm = (h, m, s = 0) => (h * 60 + m) * MIN + s * 1000;
const dayIndex = (date) => Math.round(dayStart(date) / DAY);
const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const listDate = (ms) => {
  const d = new Date(ms);
  return `${d.getUTCDate()} ${MONTH[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

// ISC, a synthetic shape in the pattern of the single HEADs of 2026-10-28
// (10:29Z to 10:31Z): those readings give end states only, a 404 page for a
// date not yet written and an empty array of 55 B for a fresh one. Every clock
// time below is a placeholder, since publication times are what DOM-012
// measures: the file of D does not exist before D 09:38, is the 55 B array
// until D+1 07:41, grows at D+2 09:38, is rewritten with the same length at
// D+3 09:38, and takes its final length at D+4 23:36.
function iscFile(date, t) {
  const d = dayStart(date);
  if (t < d + hm(9, 38)) return { status: 404, length: 196, etag: null, last_modified: null, type: 'text/html' };
  let length = 55;
  let lm = d + hm(9, 38);
  for (const [when, len] of [
    [d + DAY + hm(7, 41), 3_000_000],
    [d + 2 * DAY + hm(9, 38), 3_100_000],
    [d + 3 * DAY + hm(9, 38), 3_100_000],
    [d + 4 * DAY + hm(23, 36), 3_150_000],
  ]) {
    if (t >= when) [length, lm] = [len, when];
  }
  return { status: 200, length, etag: `"${length.toString(16)}-${lm.toString(16)}"`, last_modified: new Date(lm).toUTCString(), type: 'application/x-gzip' };
}

// WhoisDS, a synthetic shape: the 2026-10-28 readings saw an empty page at a
// date's path and a path that served an earlier date's list. The times are
// placeholders, not readings: the path of D is an empty page until D 00:30,
// then serves the list of D-1, and its own list from D 21:00.
const whoisList = (date) => ({
  length: 500_000 + (dayIndex(date) % 1000),
  entries: [{ name: 'domain-names.txt', crc32: ((dayIndex(date) * 2654435761) >>> 0).toString(16).padStart(8, '0'), size: 1_100_000, csize: 500_000, mtime: `${date}T16:52:08` }],
});
function whoisPath(date, t) {
  const d = dayStart(date);
  if (t < d + hm(0, 30)) return null;
  return whoisList(t < d + hm(21, 0) ? utcDate(d - DAY) : date);
}

// cenk commits at 13:00:54 and hagezi at 07:33:31 each day; the raw file's
// ETag follows a few minutes later.
const ROLL = {
  cenk: { at: hm(13, 0, 54), cdn: 3 * MIN, header: (d) => [`# Last update: ${listDate(d)} 13:00:21 UTC`, '# Domains: 699,953'] },
  hagezi: { at: hm(7, 33, 31), cdn: 2 * MIN, header: (d) => [`# Last modified: ${listDate(d)} 07:04 UTC`, '# Number of entries: 2897068'] },
};
function lastCommitDay(feed, t, shift = 0) {
  const d = Math.floor(t / DAY) * DAY;
  return t - shift >= d + ROLL[feed].at ? d : d - DAY;
}

// Polls of a chain: runs of 34 polls 10 minutes apart, 13 minutes between
// runs, none inside a break.
function chainTimes(from, until, breaks = []) {
  const runs = [];
  let start = from;
  while (start < until) {
    const times = [];
    for (let i = 0; i < 34; i++) times.push(start + i * 10 * MIN);
    runs.push(times.filter((t) => !breaks.some(([a, b]) => t >= a && t < b)));
    start = times[33] + 13 * MIN;
  }
  return runs;
}

function synthPolls(from, until, breaks = []) {
  const lastZip = new Map();
  const etags = {};
  const out = [];
  chainTimes(from, until, breaks).forEach((times, run) => {
    const lines = [
      {
        schema: SCHEMA,
        kind: 'start',
        run_id: String(run + 1),
        node: 'v26.7.0',
        runner_os: 'Linux',
        runner_arch: 'X64',
        user_agent: 'ua',
        interval_min: 10,
        isc_lags: ISC_LAGS,
        whoisds_lags: WHOISDS_LAGS,
      },
    ];
    times.forEach((t, i) => {
      const p = { schema: SCHEMA, kind: 'poll', run_id: String(run + 1), poll: i, started: iso(t), isc: {}, whoisds: {}, requests: 15, failed: 0 };
      p.isc.latest = iscFile(utcDate(t, 1), t);
      for (const lag of ISC_LAGS) p.isc[utcDate(t, lag)] = iscFile(utcDate(t, lag), t);
      for (const lag of WHOISDS_LAGS) {
        const date = utcDate(t, lag);
        const list = whoisPath(date, t);
        const head = list ? { status: 200, length: list.length, type: 'application/octet-stream' } : { status: 200, length: 0, type: 'text/html; charset=UTF-8' };
        const w = { head };
        const fp = `${head.length}|${head.type}`;
        const seen = lastZip.get(date);
        if (list && (!seen || seen.fp !== fp || t - seen.t >= 60 * MIN)) {
          w.zip = { status: 200, bytes: list.length, entry_count: 1, entries: list.entries };
          lastZip.set(date, { fp, t });
        }
        p.whoisds[date] = w;
      }
      for (const feed of Object.keys(ROLL)) {
        const committedDay = lastCommitDay(feed, t);
        const visibleDay = lastCommitDay(feed, t, ROLL[feed].cdn);
        const etag = `"${feed}-${visibleDay}"`;
        const changed = etags[feed] !== etag;
        etags[feed] = etag;
        p[feed] = {
          file: changed ? { status: 206, etag, total: 11_900_223, header: ROLL[feed].header(visibleDay) } : { status: 304, etag, total: null },
          commit: { sha: `${feed}${committedDay.toString(16)}aaaaaaaa`, committed: iso(committedDay + ROLL[feed].at) },
        };
      }
      lines.push(p);
    });
    out.push(lines);
  });
  return out;
}

function writeRuns(dir, runs) {
  runs.forEach((lines, k) => {
    mkdirSync(join(dir, `feeds-${k + 1}`), { recursive: true });
    writeFileSync(join(dir, `feeds-${k + 1}`, 'polls.jsonl'), `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  });
}

const FROM = Date.parse('2026-10-29T14:00:00Z');
const UNTIL = FROM + 7 * DAY + 6 * 60 * MIN;
const between = (v, lo, hi) => typeof v === 'number' && v >= lo && v <= hi;

function loadedOf(runs) {
  const polls = runs.flat().filter((l) => l.kind === 'poll');
  polls.sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  return { polls, starts: runs.map((r) => r[0]), ends: [], files: runs.length, bad_lines: 0 };
}

test('feed times: a median of an even count is the mean of the middle two', () => {
  assert.deepEqual(stats([5, 1, 3]), { n: 3, median: 3, min: 1, max: 5 });
  assert.deepEqual(stats([4, 1, 3, 2, null]), { n: 4, median: 2.5, min: 1, max: 4 });
  assert.deepEqual(stats([]), { n: 0, median: null, min: null, max: null });
});

test("feed times: a list's own stamp is read from its comment block", () => {
  assert.equal(stampOf(['# Title: x', '# Last modified: 28 Oct 2026 07:04 UTC']), '2026-10-28T07:04:00.000Z');
  assert.equal(stampOf(['# Last update: 27 Oct 2026 13:00:21 UTC']), '2026-10-27T13:00:21.000Z');
  assert.equal(stampOf(['# Domains: 699,953']), null);
  assert.equal(stampOf(undefined), null);
});

test('feed times: only a gap over 15 minutes is listed, the largest always', () => {
  const t = [0, 10, 23, 33, 213].map((m) => FROM + m * MIN);
  assert.deepEqual(gapsOf(t), { largest_gap_min: 180, gaps: [{ after: iso(FROM + 33 * MIN), before: iso(FROM + 213 * MIN), min: 180 }] });
});

test('feed times: seven days of a healthy chain measure every feed and PASS', () => {
  const r = analyse(loadedOf(synthPolls(FROM, UNTIL)), { days: 7, maxBracketMin: 30, now: UNTIL });
  assert.equal(r.schema, RESULT_SCHEMA);
  assert.equal(r.window.complete, true);
  assert.equal(r.window.largest_gap_min, 13);
  assert.deepEqual(r.window.gaps, []);
  assert.deepEqual(r.rule, { min_observed_days: 6, max_bracket_min: 30 });
  assert.equal(r.definitions, DEFINITIONS);

  const isc = r.feeds.isc;
  assert.equal(isc.observed_days, 7);
  const d29 = isc.rows.find((x) => x.date === '2026-10-29');
  assert.ok(between(d29.appear_lag_min, 461, 474), `appear lag ${d29.appear_lag_min}`);
  assert.equal(d29.observed, true);
  assert.equal(d29.changes, 2, 'the rewrite at the same length is no content change');
  assert.ok(between(d29.last_change_lag_min, 5736, 5749));
  assert.equal(d29.final_last_modified, '2026-11-02T23:36:00.000Z');
  assert.equal(d29.last_modified_lag_min, 5736);
  assert.equal(d29.settled, true);
  assert.equal(isc.last_modified_lag_min.median, 5736);
  assert.ok(between(isc.appear_lag_min.max, 461, 474));
  assert.ok(isc.latest.rewrite_interval_min.n > 0);
  assert.equal(isc.rows.find((x) => x.date === '2026-10-23').observed, false, 'a file present at the first look has no observed appearance');

  const who = r.feeds.whoisds;
  assert.equal(who.observed_days, 7);
  const w31 = who.rows.find((x) => x.date === '2026-10-31');
  assert.ok(between(w31.appear_lag_min, -1410, -1397));
  assert.ok(between(w31.last_change_lag_min, -180, -167));
  assert.equal(w31.first_same_as, '2026-10-30', 'the path first serves the list of the day before');
  assert.equal(w31.final_same_as, null);
  assert.equal(w31.built, '2026-10-31T16:52:08');

  for (const [feed, lag] of [
    ['cenk', 781],
    ['hagezi', 454],
  ]) {
    const f = r.feeds[feed];
    assert.equal(f.observed_days, 7, feed);
    assert.equal(f.first_publication_lag_min.median, lag, feed);
    assert.equal(f.first_publication_lag_min.n, 6, `${feed}: the six covered days`);
    assert.deepEqual(f.days_without_publication, []);
    assert.ok(between(f.visible_delay_min.max, 2, 16), `${feed} visible delay ${f.visible_delay_min.max}`);
    assert.equal(f.rows[0].observed, false, 'the partial first day has no visible publication');
    assert.ok(f.rows[1].covered);
  }
  assert.equal(r.feeds.cenk.rows[1].publications[0].stamp, '2026-10-30T13:00:21.000Z');
  assert.equal(r.verdict, 'PASS');
  assert.deepEqual(r.reasons, []);
  assert.equal(formatTable(r).at(-1), 'verdict=PASS');
});

test('feed times: a chain broken across two publications FAILs that feed and lists the gaps', () => {
  const breaks = [
    [Date.parse('2026-10-31T12:00:00Z'), Date.parse('2026-10-31T15:00:00Z')],
    [Date.parse('2026-11-01T12:00:00Z'), Date.parse('2026-11-01T15:00:00Z')],
  ];
  const r = analyse(loadedOf(synthPolls(FROM, UNTIL, breaks)), { days: 7, maxBracketMin: 30, now: UNTIL });
  assert.equal(r.window.gaps.length, 2);
  assert.ok(r.window.largest_gap_min >= 180);
  assert.equal(r.feeds.cenk.observed_days, 5);
  assert.equal(r.feeds.hagezi.observed_days, 7, 'a break that misses the publication leaves the day observed');
  assert.equal(r.feeds.isc.observed_days, 7);
  assert.equal(r.verdict, 'FAIL');
  assert.deepEqual(r.reasons, ['cenk: 5 observed days, fewer than 6']);
});

test('feed times: a zip that differs at the same length is a change, an identity read earlier holds', () => {
  const t0 = Date.parse('2026-10-27T00:05:00Z');
  const head = (length) => ({ status: 200, length, type: length ? 'application/octet-stream' : 'text/html' });
  const zip = (crc) => ({ status: 200, entries: [{ name: 'domain-names.txt', crc32: crc, size: 1145921, mtime: '2026-10-26T16:52:08' }] });
  const at = (k, w) => ({ started: iso(t0 + k * 10 * MIN), whoisds: { '2026-10-27': w } });
  const polls = [
    at(0, { head: head(0) }),
    at(1, { head: head(566869), zip: zip('11394e14') }),
    at(2, { head: head(566869) }),
    at(3, { head: head(566869), zip: zip('0badf00d') }),
    at(4, { head: head(566869) }),
  ];
  const row = datedFeed(polls, 'whoisds', 30 * MIN).rows[0];
  assert.equal(row.changes, 1);
  assert.equal(row.last_change_at, iso(t0 + 30 * MIN));
  assert.equal(row.first_identity, 'domain-names.txt:11394e14:1145921');
  assert.equal(row.final_identity, 'domain-names.txt:0badf00d:1145921');
  assert.equal(row.appear_bracket_min, 10);
});

test('feed times: a failed request is skipped, so the bracket spans it', () => {
  const t0 = Date.parse('2026-10-29T09:00:00Z');
  const at = (k, o) => ({ started: iso(t0 + k * 10 * MIN), isc: { '2026-10-28': o } });
  const polls = [at(0, { status: 200, length: 55 }), at(1, { error: 'timeout' }), at(2, { error: 'timeout' }), at(3, { status: 200, length: 3_000_000 })];
  const row = datedFeed(polls, 'isc', 30 * MIN).rows[0];
  assert.equal(row.appear_bracket_min, 30);
  assert.equal(row.observed, true);
  const late = datedFeed([...polls.slice(0, 3), at(4, { status: 200, length: 3_000_000 })], 'isc', 30 * MIN).rows[0];
  assert.equal(late.appear_bracket_min, 40);
  assert.equal(late.observed, false);
});

test('feed times: the recorded polls of 2026-10-28 show the 10-27 path serving the 10-26 list', () => {
  const dir = join(HERE, 'fixtures', 'feeds');
  const loaded = loadPolls(dir);
  assert.equal(loaded.polls.length, 2);
  assert.equal(loaded.starts.length, 1);
  const r = analyse(loaded, { days: 2, maxBracketMin: 30, now: Date.parse('2026-10-28T11:00:00Z') });
  assert.equal(r.window.complete, false);
  assert.deepEqual(
    r.feeds.isc.rows.map((x) => x.date),
    ['2026-10-22', '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28'],
  );
  assert.equal(r.feeds.isc.rows.find((x) => x.date === '2026-10-28').final_length, 55);
  const w27 = r.feeds.whoisds.rows.find((x) => x.date === '2026-10-27');
  assert.equal(w27.first_same_as, '2026-10-26');
  assert.equal(w27.built, '2026-10-26T16:52:08');
  const pubs = r.feeds.hagezi.rows.flatMap((x) => x.publications);
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0].committed, '2026-10-28T07:33:31.000Z');
  assert.equal(pubs[0].visible_at, null, 'a commit made before the first poll has no visible change');
  assert.equal(r.feeds.hagezi.observed_days, 0);
  assert.equal(r.feeds.hagezi.first_publication_lag_min.n, 0, 'a partial day gives no first publication lag');
  assert.equal(r.verdict, 'FAIL');
});

test('feed times: polls are deduplicated, a partial line counted, an unknown schema refused', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-times-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const line = (o) => JSON.stringify({ schema: SCHEMA, ...o });
  const body = [
    line({ kind: 'start', run_id: '1' }),
    line({ kind: 'poll', run_id: '1', started: '2026-10-29T14:10:00.000Z' }),
    line({ kind: 'poll', run_id: '1', started: '2026-10-29T14:00:00.000Z' }),
    '{"schema":"dom-012-poll/1","kind":"po',
  ].join('\n');
  mkdirSync(join(dir, 'feeds-1'));
  writeFileSync(join(dir, 'feeds-1', 'polls.jsonl'), body);
  writeFileSync(join(dir, 'copy.jsonl'), body);
  const loaded = loadPolls(dir);
  assert.equal(loaded.files, 2);
  assert.equal(loaded.bad_lines, 2);
  assert.deepEqual(
    loaded.polls.map((p) => p.started),
    ['2026-10-29T14:00:00.000Z', '2026-10-29T14:10:00.000Z'],
  );
  writeFileSync(join(dir, 'other.jsonl'), JSON.stringify({ schema: 'dom-012-poll/2', kind: 'poll' }));
  assert.throws(() => loadPolls(dir), /schema "dom-012-poll\/2" is not dom-012-poll\/1/);
  assert.deepEqual(loadPolls(join(dir, 'absent')).polls, []);
});

test('feed times: --verdict writes a complete window and judges it again from its rows', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-times-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const polls = join(dir, 'polls');
  writeRuns(polls, synthPolls(FROM, UNTIL));
  const out = join(dir, 'result.json');
  const logs = [];
  const quiet = { log: (l) => logs.push(l), err: (l) => logs.push(l), now: UNTIL };
  assert.equal(main(['--polls', polls, '--days', '7', '--verdict', out], quiet), 0);
  assert.equal(logs.at(-1), 'verdict=PASS');
  const stored = JSON.parse(readFileSync(out, 'utf8'));
  assert.equal(stored.verdict, 'PASS');
  assert.equal(checkResult(stored), stored);

  const empty = join(dir, 'none');
  assert.equal(main(['--polls', empty, '--verdict', out], quiet), 0, 'with no polls the stored result is judged');
  writeFileSync(out, JSON.stringify({ ...stored, verdict: 'FAIL' }));
  assert.equal(main(['--polls', empty, '--verdict', out], quiet), 2, 'a verdict that does not follow from the rows is refused');
  writeFileSync(out, JSON.stringify({ ...stored, feeds: { ...stored.feeds, cenk: { ...stored.feeds.cenk, observed_days: 9 } } }));
  assert.equal(main(['--polls', empty, '--verdict', out], quiet), 2);
  assert.equal(main(['--polls', empty], quiet), 2, 'no polls and no result');
  assert.equal(main(['--days', 'seven'], quiet), 2);
  assert.equal(main(['--verdict'], quiet), 2);
});

test('feed times: a window whose last runs have not uploaded is not written and exits 1', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-times-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const polls = join(dir, 'polls');
  writeRuns(polls, synthPolls(FROM, FROM + 5 * DAY));
  const out = join(dir, 'result.json');
  const logs = [];
  const opts = { log: (l) => logs.push(l), err: (l) => logs.push(l), now: FROM + 7 * DAY + MIN };
  assert.equal(main(['--polls', polls, '--verdict', out], opts), 1);
  assert.match(logs.at(-1), /not complete/);
  assert.throws(() => readFileSync(out), /ENOENT/);
  assert.equal(main(['--polls', polls, '--verdict', out], { ...opts, now: FROM + 7 * DAY + 6 * 60 * MIN }), 1, 'six hours after its end a broken chain is judged: FAIL');
  assert.equal(JSON.parse(readFileSync(out, 'utf8')).verdict, 'FAIL');
});

test('feed times: download fetches every attempt of each completed run once and names the runs without polls', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'feed-times-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'feeds-3'), { recursive: true });
  writeFileSync(join(dir, 'feeds-3', 'polls.jsonl'), '');
  const calls = [];
  // Run 1 was re-run: attempt 2 uploaded its own artifact beside attempt 1's.
  // Run 5 lists another run's artifact and a name that only starts with its id.
  const artifacts = { 1: ['feeds-1-1', 'feeds-1-2'], 2: ['feeds-2-1'], 3: ['feeds-3'], 5: ['feeds-1-1', 'feeds-51-1', 'feeds-5-x', 'other'] };
  const run = (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args[0] === 'run' && args[1] === 'list') {
      return {
        status: 0,
        stdout: JSON.stringify([
          { databaseId: 1, status: 'completed', conclusion: 'failure' },
          { databaseId: 2, status: 'completed', conclusion: 'cancelled' },
          { databaseId: 3, status: 'completed', conclusion: 'success' },
          { databaseId: 4, status: 'in_progress' },
          { databaseId: 5, status: 'completed', conclusion: 'success' },
        ]),
      };
    }
    if (args[0] === 'api') {
      const id = /runs\/(\d+)\/artifacts$/.exec(args[1])[1];
      return { status: 0, stdout: `${artifacts[id].join('\r\n')}\n` };
    }
    const name = args[args.indexOf('--name') + 1];
    if (args[2] === '1') {
      const target = args[args.indexOf('--dir') + 1];
      assert.equal(target, join(dir, name));
      mkdirSync(target, { recursive: true });
      writeFileSync(join(target, 'polls.jsonl'), '');
      return { status: 0 };
    }
    return { status: 1, stderr: 'no valid artifacts found to download' };
  };
  const r = download('pkgforge-dev/domains.pkgforge.dev', dir, run, () => {});
  assert.deepEqual(r.fetched, ['feeds-1-1', 'feeds-1-2']);
  assert.deepEqual(r.present, ['feeds-3']);
  assert.deepEqual(r.missing, [
    { id: 2, conclusion: 'cancelled' },
    { id: 5, conclusion: 'success' },
  ]);
  assert.equal(r.running, 1);
  assert.deepEqual(calls[0], [
    'gh',
    'run',
    'list',
    '--repo',
    'pkgforge-dev/domains.pkgforge.dev',
    '--workflow',
    'measure-feeds.yml',
    '--limit',
    '200',
    '--json',
    'databaseId,status,conclusion,createdAt',
  ]);
  assert.deepEqual(calls[1], ['gh', 'api', 'repos/pkgforge-dev/domains.pkgforge.dev/actions/runs/1/artifacts', '--paginate', '--jq', '.artifacts[].name']);
  assert.deepEqual(calls[2], ['gh', 'run', 'download', '1', '--repo', 'pkgforge-dev/domains.pkgforge.dev', '--name', 'feeds-1-1', '--dir', join(dir, 'feeds-1-1')]);
  assert.equal(calls.filter((c) => c[2] === 'download' && c[3] === '5').length, 0, "another run's artifact is never fetched under this one");
  // The two attempts of run 1 are both read: loadPolls keys a poll by run and start.
  assert.equal(loadPolls(dir).files, 3);
  assert.throws(
    () =>
      download(
        'a/b',
        dir,
        () => ({ status: 1, stderr: 'HTTP 404' }),
        () => {},
      ),
    /gh run list failed: HTTP 404/,
  );
  assert.throws(
    () =>
      download(
        'a/b',
        dir,
        (_cmd, args) => (args[0] === 'api' ? { status: 1, stderr: 'HTTP 502' } : { status: 0, stdout: JSON.stringify([{ databaseId: 9, status: 'completed' }]) }),
        () => {},
      ),
    /listing the artifacts of run 9 failed: HTTP 502/,
  );
});

test('feed times: judge names every feed short of the rule', () => {
  assert.deepEqual(judge({ isc: { observed_days: 6 }, whoisds: { observed_days: 7 }, cenk: { observed_days: 6 }, hagezi: { observed_days: 6 } }, 6), { verdict: 'PASS', reasons: [] });
  assert.deepEqual(judge({ isc: { observed_days: 5 }, whoisds: { observed_days: 7 }, cenk: { observed_days: 6 } }, 6), {
    verdict: 'FAIL',
    reasons: ['isc: 5 observed days, fewer than 6', 'hagezi: 0 observed days, fewer than 6'],
  });
});

// Hand-built polls of one rolling feed: `times` in ms, each with the file's
// ETag and, when `commit` gives one for that time, the latest commit.
const rollingPolls = (feed, times, { etag = () => '"e"', commit = () => null } = {}) =>
  times.map((t) => ({ started: iso(t), [feed]: { file: { status: 304, etag: etag(t), total: null }, commit: commit(t) } }));
const every10 = (from, until) => {
  const out = [];
  for (let t = from; t < until; t += 10 * MIN) out.push(t);
  return out;
};

test('feed times: a rolling day is covered only when its polls leave no gap at its start, middle or end', () => {
  const D = dayStart('2026-11-02');
  const win = { from: D, to: D + DAY };
  const covered = (times) => rollingFeed(rollingPolls('cenk', times), 'cenk', win, 30 * MIN).rows[0];
  const full = covered(every10(D + 5 * MIN, D + DAY));
  assert.equal(full.covered, true);
  // A covered day with no commit is observed, and listed as a day without a publication.
  assert.equal(full.observed, true);
  assert.deepEqual(rollingFeed(rollingPolls('cenk', every10(D + 5 * MIN, D + DAY)), 'cenk', win, 30 * MIN).days_without_publication, ['2026-11-02']);
  for (const [name, times] of [
    ['polls start 3 h into the day', every10(D + 3 * 60 * MIN, D + DAY)],
    ['polls stop 3 h before its end', every10(D + 5 * MIN, D + 21 * 60 * MIN)],
    ['a 3 h hole in the middle', every10(D + 5 * MIN, D + DAY).filter((t) => t < D + 10 * 60 * MIN || t >= D + 13 * 60 * MIN)],
  ]) {
    const row = covered(times);
    assert.equal(row.covered, false, name);
    assert.equal(row.observed, false, `${name}: no publication bracketed either`);
  }
});

test('feed times: a commit is first seen at the first poll that saw it, and visible at the change after it', () => {
  const D = dayStart('2026-11-02');
  const win = { from: D, to: D + DAY };
  const committed = D + 7 * 60 * MIN;
  const times = every10(D + 5 * MIN, D + DAY);
  const polls = rollingPolls('hagezi', times, {
    etag: (t) => (t >= committed + 12 * MIN ? '"new"' : '"old"'),
    commit: (t) => (t >= committed + 3 * MIN ? { sha: 'abcdef0123456789', committed: iso(committed) } : null),
  });
  const f = rollingFeed(polls, 'hagezi', win, 30 * MIN);
  const pub = f.rows[0].publications[0];
  assert.equal(pub.first_seen, iso(times.find((t) => t >= committed + 3 * MIN)));
  assert.equal(pub.visible_at, iso(times.find((t) => t >= committed + 12 * MIN)));
  assert.equal(pub.lag_min, 420);
  assert.deepEqual(f.days_without_publication, []);
});

// Hand-built polls of ISC for one date: [minute after D's start, status, length].
const iscPolls = (date, seq) => seq.map(([m, status, length]) => ({ started: iso(dayStart(date) + m * MIN), isc: { [date]: { status, length, etag: null, last_modified: null, type: 'x' } } }));

test('feed times: a day still changing is not settled and stays out of final_lag_min; a change bracketed over 30 min has no lag', () => {
  // 2026-11-01 appears at D+1 01:00, changes at D+1 06:00 (lag 360), then is
  // polled 25 h more: settled. 2026-11-02 changes at D+1 06:00 and is polled
  // 2 h more: not settled.
  const day1 = [
    [1430, 404, 196],
    [1500, 200, 100],
    [1790, 200, 100],
    [1800, 200, 3000],
    [1800 + 25 * 60, 200, 3000],
  ];
  const day2 = [
    [1430, 404, 196],
    [1500, 200, 100],
    [1790, 200, 100],
    [1800, 200, 9000],
    [1920, 200, 9000],
  ];
  const f = datedFeed([...iscPolls('2026-11-01', day1), ...iscPolls('2026-11-02', day2)], 'isc', 30 * MIN);
  const [settled, open] = f.rows;
  assert.equal(settled.last_change_lag_min, 360);
  assert.equal(settled.settled, true);
  assert.equal(settled.final_lag_min, 360);
  assert.equal(open.settled, false);
  assert.equal(open.final_lag_min, 360);
  assert.deepEqual(f.final_lag_min, { n: 1, median: 360, min: 360, max: 360 });
  // The last change's poll came 45 minutes after the one before: its lag is unknown.
  const wide = datedFeed(
    iscPolls('2026-11-01', [
      [1430, 404, 196],
      [1500, 200, 100],
      [1755, 200, 100],
      [1800, 200, 3000],
      [1800 + 25 * 60, 200, 3000],
    ]),
    'isc',
    30 * MIN,
  ).rows[0];
  assert.equal(wide.last_change_bracket_min, 45);
  assert.equal(wide.final_lag_min, null);
});

test('feed times: a file that vanishes and comes back is one vanish and one change', () => {
  const row = datedFeed(
    iscPolls('2026-11-01', [
      [1430, 404, 196],
      [1440, 200, 3000],
      [1450, 404, 196],
      [1460, 200, 3000],
    ]),
    'isc',
    30 * MIN,
  ).rows[0];
  assert.equal(row.vanished, 1);
  assert.equal(row.changes, 1);
  assert.equal(row.last_change_at, iso(dayStart('2026-11-01') + 1460 * MIN));
});

test('feed times: a stored PASS over too few observed days is refused, and the window bounds are applied both ways', (t) => {
  const short = analyse(loadedOf(synthPolls(FROM, UNTIL)), { days: 7, maxBracketMin: 30, now: UNTIL });
  assert.equal(short.verdict, 'PASS');
  const forged = structuredClone(short);
  for (const r of forged.feeds.isc.rows) r.observed = false;
  forged.feeds.isc.observed_days = forged.feeds.isc.rows.filter((r) => r.observed).length;
  assert.throws(() => checkResult(forged), /the stored verdict PASS does not follow from the rows \(FAIL\)/);
  // A poll just past the window's end makes it complete before six hours have passed.
  const runs = synthPolls(FROM, FROM + 2 * DAY + 60 * MIN);
  const end = FROM + 2 * DAY;
  assert.equal(analyse(loadedOf(runs), { days: 2, maxBracketMin: 30, now: end + 60 * MIN }).window.complete, true);
  assert.ok(runs.flat().some((l) => l.kind === 'poll' && Date.parse(l.started) >= end));
  const before = runs.map((lines) => lines.filter((l) => l.kind !== 'poll' || Date.parse(l.started) < end));
  assert.equal(analyse(loadedOf(before), { days: 2, maxBracketMin: 30, now: end + 60 * MIN }).window.complete, false);
  assert.equal(analyse(loadedOf(before), { days: 2, maxBracketMin: 30, now: end + 6 * 60 * MIN }).window.complete, true);
  // --from after the first poll leaves the earlier polls out of the window.
  const late = FROM + DAY;
  const r = analyse(loadedOf(synthPolls(FROM, FROM + 4 * DAY)), { days: 2, fromMs: late, maxBracketMin: 30, now: FROM + 5 * DAY });
  assert.ok(Date.parse(r.window.first_poll) >= late, r.window.first_poll);
  assert.ok(r.window.polls_outside > 0);
  // One day leaves no day to miss: the rule needs days - 1 observed days, so --days 1 is refused.
  const dir = mkdtempSync(join(tmpdir(), 'feed-times-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const errs = [];
  assert.equal(main(['--days', '1', '--polls', dir], { log: () => {}, err: (l) => errs.push(l) }), 2);
  assert.match(errs[0], /^usage:/);
});
