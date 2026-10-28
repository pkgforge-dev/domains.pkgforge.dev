// scripts/measure/feed-times.mjs — at what UTC time does each daily new-domain
// feed publish, and when does a day's file stop changing? (DOM-012,
// TODO/ingest.md.) It reads the polls of measure-feeds.yml, which
// feed-poll.mjs writes, and its result sets the late thresholds of DOM-027 and
// DOM-028 and the stale rule of DOM-034.
//
// It reads every *.jsonl under the polls directory (as `gh run download` lays
// them out, one `feeds-<run id>-<attempt>/` per attempt of a run; a run before
// the attempt was named is `feeds-<run id>/`), takes the window [from, from + N
// days), `from` being the first poll, and prints per feed and per day when the
// file first appears, when its content last changes and the lag after UTC
// midnight; then the median and maximum over the days, the gaps of the series
// and the verdict. DEFINITIONS below is written into the result, so the file
// says what each number means.
//
// The window is complete when a poll at or after its end exists (the run that
// holds it has ended and uploaded, and so has every run before it) or six
// hours have passed since its end (a job lasts at most 350 minutes, so a chain
// that stopped early has uploaded all it has). An incomplete window is not
// written and exits 1.
//
// Usage:
//   node scripts/measure/feed-times.mjs [--download] [--polls DIR] [--days 7] [--from ISO]
//     [--max-bracket-min 30] [--repo OWNER/NAME] [--verdict FILE]
//
//   --download  first fetch the artifacts of each completed run, one per attempt,
//               with `gh run download` into DIR/<artifact name>/ (an artifact already
//               there is not fetched again)
//   --polls     default docs/research/measure/DOM-012/polls, so the committed polls
//               are the evidence the result is computed from
//   --days      the window's length, 2 or more; the rule asks days - 1 observed days
//   --verdict   write the result to FILE; with no polls in DIR, read FILE, check
//               that its verdict follows from its rows, and judge it
//
// Exit codes: 0 PASS · 1 FAIL, or the window is not complete yet · 2 could not
// run (a bad argument, no polls and no result, an unknown schema, a result whose
// verdict does not follow from its rows, `gh run list` failing).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from '../lib/args.mjs';
import { iscPresent, SCHEMA as POLL_SCHEMA, whoisdsPresent } from './feed-poll.mjs';

export const RESULT_SCHEMA = 'dom-012-feed-times/1';
export const DEFAULT_REPO = 'pkgforge-dev/domains.pkgforge.dev';
export const WORKFLOW = 'measure-feeds.yml';
export const DEFAULT_POLLS = 'docs/research/measure/DOM-012/polls';
export const FEEDS = Object.freeze(['isc', 'whoisds', 'cenk', 'hagezi']);
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MIN = 60_000;
const DAY = 86_400_000;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The poll interval is 10 minutes; a gap past this is listed.
const GAP_LIST_MIN = 15;
// A day's file is settled when no content change follows its last one for this long.
const SETTLED_MIN = 24 * 60;
const COMPLETE_AFTER_MS = 6 * 60 * MIN;
const LISTING_LIMIT = 200;

export const DEFINITIONS = Object.freeze({
  time: "a poll's start; a change happened between that poll and the previous successful poll of the same file, and the bracket is that span in minutes",
  dated_lag_min: 'for ISC and WhoisDS, whose files are named by a date D: minutes from D+1T00:00Z, the UTC midnight that ends D; negative during D',
  isc_present: 'ISC answers 200 with more than 64 B (the file of a day with no names yet is an empty array of 55 B); its content is its length',
  whoisds_present: 'WhoisDS answers 200 with a body; its content is the CRC-32, size and name of each zip entry (read when its answer changes and hourly), else its length and type',
  appear: 'the first poll that saw the file present; observed when the poll before it saw it absent and the bracket is at most max_bracket_min',
  last_change: 'the last poll that saw the content differ from the poll before it, after the file appeared',
  settled: `no content change for ${SETTLED_MIN} minutes after the last one, until the last poll of the file`,
  final_lag_min: 'the lag of the last change when its bracket is at most max_bracket_min, else of the appearance when observed; summarised over settled days',
  last_modified_lag_min: "ISC only: the lag of the final Last-Modified header, the server's own time of its last write",
  same_as: 'WhoisDS only: the latest earlier date whose path served the same zip entries',
  rolling:
    'cenk and hagezi publish one file by commit: a publication is a commit that touched the file, at its committer time; it is visible at the first poll that saw the raw file ETag change after it, before the next commit',
  rolling_lag_min: 'for cenk and hagezi: minutes from 00:00Z of the UTC day of the commit',
  rolling_observed: 'a UTC day inside the window whose polls of the file leave no gap over max_bracket_min, or a day with a publication whose visible change is bracketed within max_bracket_min',
  verdict: 'PASS when each of the four feeds has at least min_observed_days observed days',
});

class InputError extends Error {}

const iso = (ms) => new Date(ms).toISOString();
const round1 = (n) => Math.round(n * 10) / 10;
const minutes = (ms) => (ms === null || ms === undefined ? null : round1(ms / MIN));

export function stats(values) {
  const v = values.filter((n) => typeof n === 'number' && Number.isFinite(n)).sort((a, b) => a - b);
  if (v.length === 0) return { n: 0, median: null, min: null, max: null };
  const mid = Math.floor(v.length / 2);
  const median = v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  return { n: v.length, median: round1(median), min: v[0], max: v[v.length - 1] };
}

// Every poll line under `dir`, deduplicated and in time order. A line that is
// not JSON is counted, not fatal: a job ended mid-write leaves a partial last line.
export function loadPolls(dir) {
  const out = { polls: [], starts: [], ends: [], files: 0, bad_lines: 0 };
  if (!existsSync(dir)) return out;
  const names = readdirSync(dir, { recursive: true })
    .map(String)
    .filter((n) => n.endsWith('.jsonl'))
    .sort();
  const seen = new Set();
  for (const name of names) {
    out.files += 1;
    for (const raw of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (raw.trim() === '') continue;
      let o;
      try {
        o = JSON.parse(raw);
      } catch {
        out.bad_lines += 1;
        continue;
      }
      if (o?.schema !== POLL_SCHEMA) throw new InputError(`${name}: schema ${JSON.stringify(o?.schema)} is not ${POLL_SCHEMA}`);
      if (o.kind === 'start') out.starts.push(o);
      else if (o.kind === 'end') out.ends.push(o);
      else if (o.kind === 'poll') {
        if (Number.isNaN(Date.parse(o.started))) throw new InputError(`${name}: a poll with no start time`);
        const key = `${o.run_id}|${o.started}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.polls.push(o);
      } else throw new InputError(`${name}: unknown line kind ${JSON.stringify(o.kind)}`);
    }
  }
  out.polls.sort((a, b) => Date.parse(a.started) - Date.parse(b.started));
  return out;
}

export function gapsOf(times) {
  let largest = 0;
  const gaps = [];
  for (let i = 1; i < times.length; i++) {
    const g = times[i] - times[i - 1];
    largest = Math.max(largest, g);
    if (g > GAP_LIST_MIN * MIN) gaps.push({ after: iso(times[i - 1]), before: iso(times[i]), min: minutes(g) });
  }
  return { largest_gap_min: minutes(largest), gaps };
}

// The largest span of [start, end) with no time in `times` (sorted).
function maxGap(times, start, end) {
  if (times.length === 0) return end - start;
  let g = Math.max(times[0] - start, end - times[times.length - 1]);
  for (let i = 1; i < times.length; i++) g = Math.max(g, times[i] - times[i - 1]);
  return g;
}

const zipIdentity = (zip) => (zip && !zip.error && Array.isArray(zip.entries) && zip.entries.length > 0 ? zip.entries.map((e) => `${e.name}:${e.crc32}:${e.size}`).join(',') : null);

// How each dated feed is read: the observation of a date in a poll, whether
// it is present, its fingerprint (a change of it is a content change), its
// identity when one is known (a WhoisDS zip's entries).
const DATED = {
  isc: {
    obs: (raw) => raw,
    present: iscPresent,
    fingerprint: (o) => String(o.length),
    identity: () => null,
  },
  whoisds: {
    obs: (raw) => (raw?.head ? { ...raw.head, zip: raw.zip } : null),
    present: whoisdsPresent,
    fingerprint: (o) => `${o.length}|${o.type}`,
    identity: (o) => zipIdentity(o.zip),
  },
};

// One date of a dated feed, from its successful observations in time order.
export function datedRow(date, list, spec, maxBracketMs) {
  const end = Date.parse(`${date}T00:00:00Z`) + DAY;
  const lag = (t) => Math.round((t - end) / MIN);
  let appear = null;
  let lastChange = null;
  let changes = 0;
  let vanished = 0;
  let firstId = null;
  let finalId = null;
  let built = null;
  let prev = null;
  for (const { t, o } of list) {
    const present = spec.present(o);
    const fp = spec.fingerprint(o);
    const own = spec.identity(o);
    // An identity read earlier holds while the answer does not change.
    const id = own ?? (prev?.present && present && prev.fp === fp ? prev.id : null);
    if (present) {
      if (!appear) appear = { t, bracket: prev ? t - prev.t : null };
      else if (!prev.present || prev.fp !== fp || (prev.id && id && prev.id !== id)) {
        changes += 1;
        lastChange = { t, bracket: t - prev.t };
      }
      if (id) {
        firstId = firstId ?? id;
        finalId = id;
      }
      if (own) built = o.zip.entries[0].mtime ?? built;
    } else if (prev?.present) vanished += 1;
    prev = { t, present, fp, id };
  }
  const last = list[list.length - 1];
  const settledFrom = lastChange?.t ?? appear?.t ?? null;
  const stableMin = settledFrom === null ? null : minutes(last.t - settledFrom);
  const observed = appear !== null && appear.bracket !== null && appear.bracket <= maxBracketMs;
  let finalLag = null;
  if (lastChange && lastChange.bracket <= maxBracketMs) finalLag = lag(lastChange.t);
  else if (!lastChange && observed) finalLag = lag(appear.t);
  const row = {
    date,
    appear_at: appear ? iso(appear.t) : null,
    appear_bracket_min: appear ? minutes(appear.bracket) : null,
    appear_lag_min: appear ? lag(appear.t) : null,
    last_change_at: lastChange ? iso(lastChange.t) : null,
    last_change_bracket_min: lastChange ? minutes(lastChange.bracket) : null,
    last_change_lag_min: lastChange ? lag(lastChange.t) : null,
    changes,
    vanished,
    final_length: last.o.length ?? null,
    observed_until: iso(last.t),
    stable_min: stableMin,
    settled: stableMin !== null && stableMin >= SETTLED_MIN,
    final_lag_min: finalLag,
    observed,
  };
  if (spec === DATED.isc) {
    const lm = Date.parse(last.o.last_modified ?? '');
    row.final_last_modified = Number.isNaN(lm) ? null : iso(lm);
    row.last_modified_lag_min = Number.isNaN(lm) ? null : lag(lm);
  } else {
    row.first_identity = firstId;
    row.final_identity = finalId;
    row.built = built;
  }
  return row;
}

// WhoisDS: name the latest earlier date whose path served the same entries.
function markSameAs(rows) {
  for (const r of rows) {
    const earlier = rows.filter((s) => s.date < r.date);
    const match = (id) => (id ? (earlier.filter((s) => s.first_identity === id || s.final_identity === id).pop()?.date ?? null) : null);
    r.first_same_as = match(r.first_identity);
    r.final_same_as = match(r.final_identity);
  }
}

// ISC's `latest` alias: how often its server rewrites it, from the distinct
// Last-Modified values it showed.
function iscLatest(polls) {
  const lms = new Set();
  let lengthChanges = 0;
  let prev = null;
  for (const p of polls) {
    const o = p.isc?.latest;
    if (!o || o.error || o.status !== 200) continue;
    const lm = Date.parse(o.last_modified ?? '');
    if (!Number.isNaN(lm)) lms.add(lm);
    if (prev !== null && o.length !== prev) lengthChanges += 1;
    prev = o.length;
  }
  const sorted = [...lms].sort((a, b) => a - b);
  const intervals = sorted.slice(1).map((t, i) => minutes(t - sorted[i]));
  return { last_modified: sorted.map(iso), rewrite_interval_min: stats(intervals), length_changes: lengthChanges };
}

export function datedFeed(polls, feed, maxBracketMs) {
  const spec = DATED[feed];
  const byDate = new Map();
  for (const p of polls) {
    const t = Date.parse(p.started);
    for (const [date, raw] of Object.entries(p[feed] ?? {})) {
      if (!DATE.test(date)) continue;
      const o = spec.obs(raw);
      if (!o || o.error || typeof o.status !== 'number') continue;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date).push({ t, o });
    }
  }
  const rows = [...byDate.keys()].sort().map((date) => datedRow(date, byDate.get(date), spec, maxBracketMs));
  if (feed === 'whoisds') markSameAs(rows);
  const settled = rows.filter((r) => r.settled);
  const out = {
    kind: 'dated',
    observed_days: rows.filter((r) => r.observed).length,
    appear_lag_min: stats(rows.filter((r) => r.observed).map((r) => r.appear_lag_min)),
    final_lag_min: stats(settled.map((r) => r.final_lag_min)),
  };
  if (feed === 'isc') {
    out.last_modified_lag_min = stats(settled.map((r) => r.last_modified_lag_min));
    out.latest = iscLatest(polls);
  }
  out.rows = rows;
  return out;
}

const MONTHS = Object.freeze({ jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 });

// The list's own time from its comment block: hagezi writes
// `# Last modified: 28 Oct 2026 07:04 UTC`, cenk `# Last update: 27 Oct 2026 13:00:21 UTC`.
export function stampOf(header) {
  for (const line of header ?? []) {
    const m = /^#\s*last (?:modified|updated?)\s*:\s*(\d{1,2}) ([A-Za-z]{3})[a-z]* (\d{4}) (\d{2}):(\d{2})(?::(\d{2}))?\s*UTC\b/i.exec(line);
    const month = m ? MONTHS[m[2].toLowerCase()] : undefined;
    if (month !== undefined) return iso(Date.UTC(Number(m[3]), month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
  }
  return null;
}

export function rollingFeed(polls, feed, win, maxBracketMs) {
  const files = [];
  const commits = new Map();
  for (const p of polls) {
    const t = Date.parse(p.started);
    const f = p[feed]?.file;
    if (f && !f.error && [200, 206, 304].includes(f.status) && typeof f.etag === 'string') files.push({ t, etag: f.etag, total: f.total ?? null, stamp: stampOf(f.header) });
    const c = p[feed]?.commit;
    const committed = Date.parse(c?.committed ?? '');
    if (c && !c.error && typeof c.sha === 'string' && !Number.isNaN(committed) && !commits.has(c.sha)) commits.set(c.sha, { sha: c.sha, committed, first_seen: t });
  }
  const changes = [];
  for (let i = 1; i < files.length; i++) {
    if (files[i].etag !== files[i - 1].etag) changes.push({ t: files[i].t, bracket: files[i].t - files[i - 1].t, total: files[i].total, stamp: files[i].stamp });
  }
  const ordered = [...commits.values()].sort((a, b) => a.committed - b.committed);
  const pubs = ordered.map((c, k) => {
    const next = ordered[k + 1]?.committed ?? Number.POSITIVE_INFINITY;
    const vis = changes.find((ch) => ch.t >= c.committed && ch.t < next) ?? null;
    return {
      t: c.committed,
      bracket: vis ? vis.bracket : null,
      row: {
        sha: c.sha.slice(0, 12),
        committed: iso(c.committed),
        first_seen: iso(c.first_seen),
        visible_at: vis ? iso(vis.t) : null,
        visible_bracket_min: vis ? minutes(vis.bracket) : null,
        visible_delay_min: vis ? minutes(vis.t - c.committed) : null,
        stamp: vis?.stamp ?? null,
        total: vis?.total ?? null,
      },
    };
  });
  const rows = [];
  for (let d = Math.floor(win.from / DAY) * DAY; d < win.to; d += DAY) {
    const full = d >= win.from && d + DAY <= win.to;
    const covered =
      full &&
      maxGap(
        files.filter((f) => f.t >= d && f.t < d + DAY).map((f) => f.t),
        d,
        d + DAY,
      ) <= maxBracketMs;
    const day = pubs.filter((p) => p.t >= d && p.t < d + DAY);
    const bracketed = day.some((p) => p.bracket !== null && p.bracket <= maxBracketMs);
    rows.push({
      date: iso(d).slice(0, 10),
      covered,
      publications: day.map((p) => ({ ...p.row, lag_min: Math.round((p.t - d) / MIN) })),
      first_publication_lag_min: day.length ? Math.round((day[0].t - d) / MIN) : null,
      file_changes: changes.filter((c) => c.t >= d && c.t < d + DAY).length,
      observed: covered || bracketed,
    });
  }
  const visible = pubs.filter((p) => p.bracket !== null && p.bracket <= maxBracketMs);
  return {
    kind: 'rolling',
    observed_days: rows.filter((r) => r.observed).length,
    // Covered days only: on a partial day, or one with a gap, an earlier commit
    // replaced before a poll saw it would go unseen.
    first_publication_lag_min: stats(rows.filter((r) => r.covered).map((r) => r.first_publication_lag_min)),
    visible_delay_min: stats(visible.map((p) => p.row.visible_delay_min)),
    publication_interval_min: stats(ordered.slice(1).map((c, k) => minutes(c.committed - ordered[k].committed))),
    days_without_publication: rows.filter((r) => r.covered && r.publications.length === 0).map((r) => r.date),
    rows,
  };
}

export function judge(feeds, minDays) {
  const reasons = [];
  for (const f of FEEDS) {
    const n = feeds[f]?.observed_days ?? 0;
    if (n < minDays) reasons.push(`${f}: ${n} observed days, fewer than ${minDays}`);
  }
  return { verdict: reasons.length === 0 ? 'PASS' : 'FAIL', reasons };
}

const distinct = (values) => [...new Set(values.filter((v) => v !== undefined && v !== null).map((v) => (typeof v === 'string' ? v : JSON.stringify(v))))];

export function analyse(loaded, { days, fromMs = null, maxBracketMin, now }) {
  const all = loaded.polls;
  const from = fromMs ?? Date.parse(all[0].started);
  const to = from + days * DAY;
  const polls = all.filter((p) => {
    const t = Date.parse(p.started);
    return t >= from && t < to;
  });
  const complete = all.some((p) => Date.parse(p.started) >= to) || now >= to + COMPLETE_AFTER_MS;
  const times = polls.map((p) => Date.parse(p.started));
  const maxBracketMs = maxBracketMin * MIN;
  const win = { from, to };
  const feeds = {
    isc: datedFeed(polls, 'isc', maxBracketMs),
    whoisds: datedFeed(polls, 'whoisds', maxBracketMs),
    cenk: rollingFeed(polls, 'cenk', win, maxBracketMs),
    hagezi: rollingFeed(polls, 'hagezi', win, maxBracketMs),
  };
  const minDays = days - 1;
  const { verdict, reasons } = judge(feeds, minDays);
  return {
    schema: RESULT_SCHEMA,
    entry: 'DOM-012',
    generated: iso(now),
    window: {
      from: iso(from),
      to: iso(to),
      days,
      complete,
      polls: polls.length,
      polls_outside: all.length - polls.length,
      runs: new Set(polls.map((p) => p.run_id)).size,
      first_poll: times.length ? iso(times[0]) : null,
      last_poll: times.length ? iso(times[times.length - 1]) : null,
      tail_gap_min: times.length ? minutes(to - times[times.length - 1]) : null,
      ...gapsOf(times),
      files: loaded.files,
      bad_lines: loaded.bad_lines,
      polls_with_failures: polls.filter((p) => p.failed > 0).length,
    },
    conditions: {
      node: distinct(loaded.starts.map((s) => s.node)),
      runner: distinct(loaded.starts.map((s) => `${s.runner_os}/${s.runner_arch}`)),
      user_agent: distinct(loaded.starts.map((s) => s.user_agent)),
      interval_min: distinct(loaded.starts.map((s) => s.interval_min)),
      isc_lags: distinct(loaded.starts.map((s) => s.isc_lags)),
      whoisds_lags: distinct(loaded.starts.map((s) => s.whoisds_lags)),
    },
    definitions: DEFINITIONS,
    rule: { min_observed_days: minDays, max_bracket_min: maxBracketMin },
    feeds,
    verdict,
    reasons,
  };
}

// A stored result, judged again from its own rows: a verdict or a count that
// does not follow from them is refused.
export function checkResult(result) {
  if (result?.schema !== RESULT_SCHEMA) throw new InputError(`the result's schema ${JSON.stringify(result?.schema)} is not ${RESULT_SCHEMA}`);
  for (const f of FEEDS) {
    const feed = result.feeds?.[f];
    if (!Array.isArray(feed?.rows)) throw new InputError(`the result has no rows for ${f}`);
    const n = feed.rows.filter((r) => r.observed === true).length;
    if (n !== feed.observed_days) throw new InputError(`${f}: observed_days ${feed.observed_days} but ${n} rows are observed`);
  }
  const { verdict } = judge(result.feeds, result.rule?.min_observed_days);
  if (verdict !== result.verdict) throw new InputError(`the stored verdict ${result.verdict} does not follow from the rows (${verdict})`);
  return result;
}

const cell = (v) => (v === null || v === undefined ? '-' : String(v));
const at = (v) => (v ? `${v.slice(0, 16)}Z` : '-');
const yes = (b) => (b ? 'yes' : 'no');
const summary = (s) => `median ${cell(s.median)} max ${cell(s.max)} (n ${s.n})`;

export function formatTable(result) {
  const w = result.window;
  const lines = [
    `window ${w.from} to ${w.to} (${w.days} days${w.complete ? '' : ', NOT complete'}): ${w.polls} polls from ${w.runs} runs, largest gap ${cell(w.largest_gap_min)} min, ${w.gaps.length} gaps over ${GAP_LIST_MIN} min`,
  ];
  for (const g of w.gaps) lines.push(`  gap ${g.after} to ${g.before}: ${g.min} min`);
  for (const feed of ['isc', 'whoisds']) {
    const f = result.feeds[feed];
    lines.push('', `${feed}  date        appear (UTC)       lag  bracket | last change (UTC)  lag  bracket | changes observed settled`);
    for (const r of f.rows) {
      const extra =
        feed === 'isc' ? ` last-modified ${at(r.final_last_modified)} lag ${cell(r.last_modified_lag_min)}` : ` built ${cell(r.built)} same-as ${cell(r.first_same_as)}/${cell(r.final_same_as)}`;
      lines.push(
        `  ${r.date}  ${at(r.appear_at)} ${cell(r.appear_lag_min)} ${cell(r.appear_bracket_min)} | ${at(r.last_change_at)} ${cell(r.last_change_lag_min)} ${cell(r.last_change_bracket_min)} | ${r.changes} ${yes(r.observed)} ${yes(r.settled)}${extra}`,
      );
    }
    lines.push(`  ${feed}: ${f.observed_days} observed days; appear lag ${summary(f.appear_lag_min)}; final lag ${summary(f.final_lag_min)}`);
    if (feed === 'isc') lines.push(`  isc: final Last-Modified lag ${summary(f.last_modified_lag_min)}; latest rewritten every ${summary(f.latest.rewrite_interval_min)} min`);
  }
  for (const feed of ['cenk', 'hagezi']) {
    const f = result.feeds[feed];
    lines.push('', `${feed}  date        covered observed  publications (commit UTC, lag, visible delay, list stamp)`);
    for (const r of f.rows) {
      const pubs = r.publications.map((p) => `${p.committed.slice(11, 19)} ${p.lag_min} +${cell(p.visible_delay_min)} ${cell(p.stamp)}`).join('; ');
      lines.push(`  ${r.date}  ${yes(r.covered)} ${yes(r.observed)}  ${pubs || '-'}`);
    }
    lines.push(
      `  ${feed}: ${f.observed_days} observed days; first publication lag ${summary(f.first_publication_lag_min)}; visible delay ${summary(f.visible_delay_min)}; interval ${summary(f.publication_interval_min)}`,
    );
  }
  lines.push('', `verdict=${result.verdict}${result.reasons.length ? ` (${result.reasons.join('; ')})` : ''}`);
  return lines;
}

const runSync = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 300_000, windowsHide: true });

// The artifacts of every completed run of the workflow, one per attempt, each
// into dir/<name>/: every name the run lists that is feeds-<id> or
// feeds-<id>-<attempt>, so a re-run never hides the polls of the attempt
// before it. `fetched` and `present` name artifacts; `missing` names runs
// with none.
export function download(repo, dir, run = runSync, log = console.log) {
  const fail = (what, r) =>
    new InputError(
      `${what} failed: ${String(r.error?.message ?? r.stderr)
        .trim()
        .slice(0, 200)}`,
    );
  const list = run('gh', ['run', 'list', '--repo', repo, '--workflow', WORKFLOW, '--limit', String(LISTING_LIMIT), '--json', 'databaseId,status,conclusion,createdAt']);
  if (list.error || list.status !== 0) throw fail('gh run list', list);
  let runs;
  try {
    runs = JSON.parse(list.stdout);
  } catch {
    throw new InputError('gh run list printed no JSON');
  }
  if (runs.length >= LISTING_LIMIT) log(`download: the listing holds ${runs.length} runs, its limit; older runs are not listed`);
  const out = { listed: runs.length, fetched: [], present: [], missing: [], running: runs.filter((r) => r.status !== 'completed').length };
  for (const r of runs.filter((x) => x.status === 'completed')) {
    const id = r.databaseId;
    if (!Number.isSafeInteger(id) || id <= 0) throw new InputError(`gh run list gave the run id ${JSON.stringify(id)}`);
    const arts = run('gh', ['api', `repos/${repo}/actions/runs/${id}/artifacts`, '--paginate', '--jq', '.artifacts[].name']);
    if (arts.error || arts.status !== 0) throw fail(`listing the artifacts of run ${id}`, arts);
    const own = new RegExp(`^feeds-${id}(-[1-9][0-9]*)?$`);
    const names = [
      ...new Set(
        String(arts.stdout)
          .split(/\r?\n/)
          .filter((n) => own.test(n)),
      ),
    ].sort();
    let got = 0;
    for (const name of names) {
      const target = join(dir, name);
      if (existsSync(join(target, 'polls.jsonl'))) {
        out.present.push(name);
        got += 1;
        continue;
      }
      const d = run('gh', ['run', 'download', String(id), '--repo', repo, '--name', name, '--dir', target]);
      if (!d.error && d.status === 0 && existsSync(join(target, 'polls.jsonl'))) {
        out.fetched.push(name);
        got += 1;
      }
    }
    if (got === 0) out.missing.push({ id, conclusion: r.conclusion ?? null });
  }
  log(
    `download: ${out.listed} runs listed, ${out.fetched.length} artifacts fetched, ${out.present.length} already here, ${out.missing.length} runs without polls${out.missing.length ? ` (${out.missing.map((m) => `${m.id} ${m.conclusion}`).join(', ')})` : ''}, ${out.running} not completed`,
  );
  return out;
}

function writeAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

const USAGE = 'usage: node scripts/measure/feed-times.mjs [--download] [--polls DIR] [--days 7] [--from ISO] [--max-bracket-min 30] [--repo OWNER/NAME] [--verdict FILE]';

// `deps` replaces `gh`, the clock or the log in a test; the command line passes none.
export function main(argv, deps = {}) {
  const log = deps.log ?? console.log;
  const err = deps.err ?? console.error;
  const args = parseArgs(argv);
  const days = args.days === undefined ? 7 : Number(args.days);
  const maxBracketMin = args['max-bracket-min'] === undefined ? 30 : Number(args['max-bracket-min']);
  const fromMs = typeof args.from === 'string' ? Date.parse(args.from) : null;
  const repo = typeof args.repo === 'string' ? args.repo : DEFAULT_REPO;
  const pollsDir = typeof args.polls === 'string' ? resolve(args.polls) : join(ROOT, DEFAULT_POLLS);
  const verdictFile = typeof args.verdict === 'string' ? resolve(args.verdict) : null;
  if (!Number.isInteger(days) || days < 2 || !(maxBracketMin > 0) || Number.isNaN(fromMs) || !/^[\w.-]+\/[\w.-]+$/.test(repo) || args.verdict === true || args.polls === true) {
    err(USAGE);
    return 2;
  }
  const now = deps.now ?? Date.now();
  try {
    if (args.download === true) download(repo, pollsDir, deps.run ?? runSync, log);
    const loaded = loadPolls(pollsDir);
    let result;
    if (loaded.polls.length > 0) {
      result = analyse(loaded, { days, fromMs, maxBracketMin, now });
      if (!result.window.complete) {
        for (const l of formatTable(result)) log(l);
        log(`the window ends ${result.window.to} and is not complete: its last runs have not uploaded yet; nothing is written`);
        return 1;
      }
      if (verdictFile) writeAtomic(verdictFile, result);
    } else if (verdictFile && existsSync(verdictFile)) {
      result = checkResult(JSON.parse(readFileSync(verdictFile, 'utf8')));
      log(`no polls under ${pollsDir}: judging ${verdictFile}`);
    } else {
      err(`feed-times: no polls under ${pollsDir} and no result to judge; run with --download first`);
      return 2;
    }
    for (const l of formatTable(result)) log(l);
    return result.verdict === 'PASS' ? 0 : 1;
  } catch (e) {
    if (e instanceof InputError || e instanceof SyntaxError) {
      err(`feed-times: ${e.message}`);
      return 2;
    }
    throw e;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv.slice(2));
