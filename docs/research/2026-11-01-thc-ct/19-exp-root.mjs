// DOM-029 instrument 19, copied from .tmp/dom029/challenge/root-lens/exp-root.mjs as it ran on 2026-11-01T10:21Z.
// The question: whether the live root with the backfill segments validates with the gaps named, and what a failed leg strands (design M24).
// Its paths resolve from the repository root or from this file, and the conditions block is added; nothing else changed.
// The report is docs/research/2026-11-01-thc-ct.md.
import * as conditionsFs from 'node:fs';
import * as conditionsOs from 'node:os';
// The conditions of this run, printed to stderr on the way out (docs/methodology/research.md section 4.2).
process.on('exit', (code) => {
  const c = { instrument: 'docs/research/2026-11-01-thc-ct/19-exp-root.mjs', at: new Date().toISOString(), exit: code, node: process.version, os: `${conditionsOs.platform()} ${conditionsOs.release()}`, cpu: conditionsOs.cpus()[0]?.model ?? null, cpus: conditionsOs.cpus().length, memory_bytes: conditionsOs.totalmem(), argv: process.argv.slice(2) };
  try {
    conditionsFs.writeSync(2, `conditions ${JSON.stringify(c)}\n`);
  } catch {}
});
// root-lens (scratch, not tracked): the live root of 2026-11-01 plus the backfill's segments, under the design's
// D7 (the `quarantine` field) and D8 (holes named in gaps) as a scratch patch of packages/root (rp/).
// E1 one promotion of every segment; E2 a failed leg under keepLiveSet and the 7-day expiry of the owed list;
// E3 planTier over every day (ruling 23, 24, the corpus_since move); E4 D18 day packs, then weeks and months.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { buildRoot, checkForward, checkLiveSet, comparePacks, layerBytes, RootError, validateRoot } from './rp/index.ts';
import { planTier } from '../../../packages/compact/src/index.ts';
import { digestOf, pack } from '../../../../packages/root/test/helpers.ts';

const liveJson = JSON.parse(readFileSync(new URL('./root-now.json', import.meta.url), 'utf8'));
const live = { root: validateRoot(liveJson, { strict: false }), digest: digestOf('live now') };
const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().replace('.000Z', 'Z');
const days = [];
for (let d = Date.UTC(2026, 8, 1); d <= Date.UTC(2026, 9, 31); d += DAY) days.push(iso(d).slice(0, 10));
const GAPS = ['2026-10-04', '2026-10-09'];
const QUAR = ['2026-10-05', '2026-10-06', '2026-10-15'];
// the day 2026-10-31 is read by the first live run (design section 13 step 2), before the backfill
const seg = (dataset, day, o = {}) => {
  const np = pack(dataset, 'seg', `${day}T00:00:00Z`, { sources: ['thc-ct'], end: iso(Date.parse(`${day}T00:00:00Z`) + DAY), count: 1000, salt: `${dataset} ${day}` });
  return o.quarantine ? { ...np, pack: { ...np.pack, quarantine: true } } : np;
};
const adds = (skip = []) => days.filter((d) => !GAPS.includes(d) && !skip.includes(d)).flatMap((d) => ['names', 'domains'].map((ds) => seg(ds, d, { quarantine: QUAR.includes(d) })));
const now = '2026-11-01T12:00:00Z';
const gapsOf = (g) => ({ ...live.root.gaps, ...(g.length ? { 'thc-ct': g } : {}) });
const say = (s) => console.log(s);
const tryBuild = (label, add, gaps, l = live, at = now) => {
  try {
    const root = buildRoot({ live: l, add, psl: l.root.psl, now: at, gaps });
    say(`${label}: OK root_seq ${root.root_seq} names ${root.datasets.names.length} domains ${root.datasets.domains.length} corpus_since ${JSON.stringify(root.corpus_since)} root.json ${layerBytes(root).length} B`);
    return root;
  } catch (e) {
    say(`${label}: ${e instanceof RootError ? `RootError ${e.code}` : e.constructor.name}: ${String(e.message).slice(0, 200)}`);
    return null;
  }
};
say(`live root_seq ${live.root.root_seq}, ${layerBytes(live.root).length} B; ${days.length} days 09-01..10-31 (${adds().length / 2} with a file)`);

// ---- E1
say('--- E1: one promotion');
const r1 = tryBuild('E1 every segment, gaps 10-04 and 10-09, three quarantined days', adds(), gapsOf(GAPS));
tryBuild('E1 no gaps named', adds(), gapsOf([]));
tryBuild('E1 only 10-04 named', adds(), gapsOf(['2026-10-04']));
if (r1) {
  checkForward(live.root, r1);
  say(`E1 checkForward(live, next): accepted. through thc-ct ${r1.through['thc-ct']}; as_of ${r1.as_of}; psl_live ${r1.psl_live.length}`);
  const q = r1.datasets.names.filter((p) => p.quarantine === true).map((p) => p.tag.slice(7, 15));
  say(`E1 quarantined entries in names: ${[...new Set(q)].join(',')} (x2 datasets)`);
}
// a quarantine value other than true is refused
try {
  const bad = adds().map((np, i) => (i === 0 ? { ...np, pack: { ...np.pack, quarantine: 1 } } : np));
  buildRoot({ live, add: bad, psl: live.root.psl, now, gaps: gapsOf(GAPS) });
  say('E1 quarantine: 1 accepted (UNEXPECTED)');
} catch (e) {
  say(`E1 quarantine: 1 refused: ${String(e.message).slice(0, 120)}`);
}

// ---- E2: keepLiveSet as scripts/root/promote.mjs, with checkLiveSet given the gaps
function keepLiveSet(input) {
  try {
    buildRoot(input);
    return { add: input.add, waiting: [], passes: 0 };
  } catch (e) {
    if (!(e instanceof RootError && e.code === 'live-set')) throw e;
  }
  const base = buildRoot({ ...input, add: [] });
  const lists = new Map(Object.entries(base.datasets).map(([ds, packs]) => [ds, [...packs]]));
  const join = ({ dataset, pack: p }) => {
    const list = [...(lists.get(dataset) ?? []), p].sort(comparePacks);
    checkLiveSet(dataset, list, input.gaps);
    lists.set(dataset, list);
  };
  const kept = [];
  const why = new Map();
  let pending = input.add.map((np, i) => ({ np, i })).sort((a, b) => comparePacks(a.np.pack, b.np.pack) || a.i - b.i);
  let passes = 0;
  for (let moved = true; moved; ) {
    moved = false;
    passes += 1;
    const still = [];
    for (const c of pending) {
      try {
        join(c.np);
        kept.push(c);
        moved = true;
      } catch (e) {
        if (!(e instanceof RootError && e.code === 'live-set')) throw e;
        why.set(c.i, e.message);
        still.push(c);
      }
    }
    pending = still.reverse();
  }
  return { add: kept.sort((a, b) => a.i - b.i).map((k) => k.np), waiting: pending.sort((a, b) => a.i - b.i).map((c) => ({ ref: c.np.pack.tag, np: c.np, message: why.get(c.i) })), passes };
}
say('--- E2: a leg fails (no segment, no gap), keepLiveSet of --partial, then the repair');
for (const failed of ['2026-09-20', '2026-10-22']) {
  const t0 = performance.now();
  const k = keepLiveSet({ live, add: adds([failed]), psl: live.root.psl, now, gaps: gapsOf(GAPS) });
  const waitDays = [...new Set(k.waiting.map((w) => w.ref.slice(7, 15)))].sort();
  say(`E2 leg ${failed} failed: kept ${k.add.length} of ${adds([failed]).length}, waiting ${k.waiting.length} (${waitDays.length} days, ${waitDays[0]}..${waitDays.at(-1)}), passes ${k.passes}, ${(performance.now() - t0).toFixed(0)} ms`);
  const mid = buildRoot({ live, add: k.add, psl: live.root.psl, now, gaps: gapsOf(GAPS) });
  const midLive = { root: mid, digest: digestOf('mid') };
  say(`E2   the partial root: root_seq ${mid.root_seq} corpus_since ${JSON.stringify(mid.corpus_since)}`);
  // repair inside 7 days: the owed list still holds the waiting ones
  const fixed = [seg('names', failed), seg('domains', failed)];
  const a = tryBuild(`E2   repair in time (waiting + the repaired day)`, [...k.waiting.map((w) => w.np), ...fixed], gapsOf(GAPS), { root: mid, digest: digestOf('mid') }, '2026-11-01T13:00:00Z');
  // repair after OWED_DAYS: the waiting ones expired from state; thc-plan skips a day whose two tags exist (D22), so only the repaired day is owed
  const b = tryBuild(`E2   repair after OWED_DAYS (the repaired day alone; the others expired from owed and D22 skips them)`, fixed, gapsOf(GAPS), midLive, '2026-11-09T13:00:00Z');
  if (b) say(`E2   ... the root is valid and ${waitDays.length} days stay out of it for good: corpus_since ${JSON.stringify(b.corpus_since)}, names ${b.datasets.names.length} packs`);
  void a;
}

// ---- E3
say('--- E3: planTier over every day of the promoted root (names, domains, feed)');
const tally = (rows) => rows.reduce((m, r) => ({ ...m, [r]: (m[r] ?? 0) + 1 }), {});
if (r1) {
  const plan = (dataset, tier, start) => planTier({ datasets: r1.datasets, corpus_since: r1.corpus_since, gaps: r1.gaps }, dataset, tier, start);
  for (const ds of ['names', 'domains', 'feed']) {
    const rows = [];
    const odd = [];
    for (const d of [...days, '2026-11-01']) {
      try {
        const p = plan(ds, 'd', `${d}T00:00:00Z`);
        rows.push(p.verdict);
        if (p.verdict !== 'ready' && !(ds === 'feed' && p.verdict === 'skip' && d < '2026-10-25')) odd.push(`${d}:${p.verdict}`);
      } catch (e) {
        rows.push(`throws ${e.code ?? e.name}`);
        odd.push(`${d}: ${e.code ?? e.name}: ${String(e.message).slice(0, 110)}`);
      }
    }
    say(`E3 ${ds} d: ${JSON.stringify(tally(rows))}; other than ready (feed skip before 10-25 not listed): ${odd.slice(0, 14).join(' | ')}`);
  }
  const p5 = plan('domains', 'd', '2026-10-05T00:00:00Z');
  say(`E3 domains 10-05 (quarantined seg): ${p5.verdict}, inputs ${p5.inputs.length}, excluded ${p5.excluded.length}; the input keeps its mark: ${p5.inputs[0].quarantine}`);
  const f5 = plan('feed', 'd', '2026-10-05T00:00:00Z');
  say(`E3 feed 10-05: ${f5.verdict}: ${f5.reason.slice(0, 120)}`);
  const g4 = plan('names', 'd', '2026-10-04T00:00:00Z');
  say(`E3 names 10-04 (gap): ${g4.verdict}: ${g4.reason.slice(0, 120)}`);
  const w = plan('names', 'w', '2026-09-07T00:00:00Z');
  say(`E3 names week 09-07 before any day pack: ${w.verdict}: ${w.reason.slice(0, 100)}`);
}

// ---- E4: D18, the day packs of 09-01..10-24, then weeks and months
say('--- E4: D18 (a day pack for each backfilled day, 09-01..10-24, ledger off), then weeks and months');
if (r1) {
  const replace = [];
  for (const d of days.filter((x) => x <= '2026-10-24' && !GAPS.includes(x))) {
    for (const ds of ['names', 'domains']) {
      const start = `${d}T00:00:00Z`;
      const end = iso(Date.parse(start) + DAY);
      const inside = r1.datasets[ds].filter((p) => p.span.start >= start && p.span.end <= end);
      const sources = [...new Set(inside.flatMap((p) => p.sources))].sort();
      replace.push({ old: inside.map((p) => p.manifest), new: pack(ds, 'd', start, { sources, count: 1000, salt: `d ${ds} ${d}` }) });
    }
  }
  let r2 = null;
  try {
    r2 = buildRoot({ live: { root: r1, digest: digestOf('r1') }, replace, psl: r1.psl, now: '2026-11-02T12:00:00Z' });
    say(`E4 root after D18: OK names ${r2.datasets.names.length} domains ${r2.datasets.domains.length} root.json ${layerBytes(r2).length} B`);
  } catch (e) {
    say(`E4 D18 replace: ${e.code}: ${String(e.message).slice(0, 200)}`);
  }
  if (r2) {
    const plan = (ds, tier, start) => planTier({ datasets: r2.datasets, corpus_since: r2.corpus_since, gaps: r2.gaps }, ds, tier, start);
    for (const [tier, starts] of [
      ['w', ['2026-08-31', '2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19', '2026-10-26']],
      ['m', ['2026-09-01', '2026-10-01']],
    ]) {
      for (const ds of ['names', 'domains']) {
        say(`E4 ${ds} ${tier}: ${starts.map((s) => { try { const p = plan(ds, tier, `${s}T00:00:00Z`); return `${s.slice(5)}=${p.verdict}`; } catch (e) { return `${s.slice(5)}=${e.code}`; } }).join(' ')}`);
      }
    }
    const m9 = plan('domains', 'm', '2026-09-01T00:00:00Z');
    say(`E4 domains month 09: ${m9.verdict}, ${m9.inputs.length} inputs, records upper bound ${m9.records}; reason ${m9.reason.slice(0, 160)}`);
    const sumRecords = (ds) => r2.datasets[ds].reduce((n, p) => n + p.count, 0);
    say(`E4 (synthetic counts) packs: names ${r2.datasets.names.length}, domains ${r2.datasets.domains.length}`);
    void sumRecords;
  }
}

// ---- E5: D17, the rebuild of the seven live day packs (10-25..10-31) once THC's segments are beside them
say('--- E5: D17 rebuilds of the live days with THC beside them, oldest first, one promotion each');
if (r1) {
  let cur = { root: r1, digest: digestOf('r1') };
  let t = Date.parse('2026-11-02T00:00:00Z');
  const liveDays = ['2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30', '2026-10-31'];
  let ok = 0;
  for (const d of liveDays) {
    const start = `${d}T00:00:00Z`;
    const end = iso(Date.parse(start) + DAY);
    const replace = [];
    for (const ds of ['names', 'domains', 'feed']) {
      const inside = cur.root.datasets[ds].filter((p) => p.span.start >= start && p.span.end <= end);
      if (inside.length === 0) continue;
      const sources = [...new Set(inside.flatMap((p) => p.sources))].sort();
      const base = inside.find((p) => p.tier === 'd');
      const rebuild = Number((/-r(\d+)$/.exec(base.tag) ?? [0, 1])[1]) + 1;
      replace.push({ old: inside.map((p) => p.manifest), new: pack(ds, 'd', start, { sources, count: 1000, rebuild, salt: `r ${ds} ${d}` }) });
    }
    t += 60_000;
    try {
      const next = buildRoot({ live: cur, replace, psl: cur.root.psl, now: iso(t) });
      cur = { root: next, digest: digestOf(`e5 ${d}`) };
      ok += 1;
    } catch (e) {
      say(`E5 ${d}: ${e.code}: ${String(e.message).slice(0, 200)}`);
    }
  }
  say(`E5 ${ok} of ${liveDays.length} rebuild promotions valid; names-d-20261029-r2 sources ${JSON.stringify(cur.root.datasets.names.find((p) => p.tag === 'names-d-20261029-r2')?.sources)}; feed-d-20261031-r2 sources ${JSON.stringify(cur.root.datasets.feed.find((p) => p.tag === 'feed-d-20261031-r2')?.sources)}`);
  const pl = planTier({ datasets: cur.root.datasets, corpus_since: cur.root.corpus_since, gaps: cur.root.gaps }, 'domains', 'd', '2026-10-29T00:00:00Z');
  say(`E5 plan of domains 10-29 after its rebuild: ${pl.verdict} (${pl.reason.slice(0, 80)})`);
}
