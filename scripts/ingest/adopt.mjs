// scripts/ingest/adopt.mjs — the proposals a backfill's plan writes itself,
// with no adapter run (DOM-029, design D22 and section 6.4), for
// scripts/ingest/thc-plan.mjs:
//
//   adoptProposal({ adapter, rows, manifests, state, run, attempt, at })
//       the segments a run pushed to obs that no state took: a cancelled
//       backfill, a push or promote job that failed, or owed items that
//       expired after OWED_DAYS. Their tags are in GHCR and neither the root
//       nor state holds them, so without this they are stranded for good
//       (design M24 E2). Re-reading the day instead costs a download of up to
//       2 GiB, and push.mjs refuses a rebuild under another code as `replaced`.
//   gapProposal({ adapter, gaps, state, run, attempt, at })
//       the days the plan found listed by no host past their gap instant
//       (D+2 12:00Z), declared as gaps (D9 of DOM-029), with no segment.
//
// Each is built with propose of @domains/state, which validates it whole, and
// keeps the adapter's live cursor (`before` equal to `after`, the state's own
// cursor), as a backfill run's proposal does (D17 of DOM-024): advance accepts
// it beside the legs' proposals of the same push (D13 of DOM-029), and owes
// each segment, quarantined or not (D7).
//
// An adopted segment, from the manifest alone (no blob is read, no PSL):
//   ref obs:<tag>, digest the manifest's digest, source, dataset, start and
//   end from dev.pkgforge.domains.source, dataset, span.start and span.end,
//   count from dev.pkgforge.domains.count, and quarantined from
//   dev.pkgforge.domains.quarantine ("1", or absent; any other value is
//   refused, as packFromManifest of @domains/root refuses it).
// The manifest must be a segment (its artifact type, tier seg) of one of the
// adapter's sources, of one of that source's datasets and of its precision.
// The history day of a one-day segment of a day source is the names segment's
// when the day has one, else the domains segment's, as run.mjs writes it: its
// count is the raw layer's size for a band of metric bytes (the file as
// fetched), else the segment's records, and its quarantined the segment's.
// The segments of one source and day must carry one raw blob: two files of
// one day are refused, never adopted side by side.
// A refusal is a Fault of scripts/root/lib.mjs, with the tag it is about.
import { artifactType } from '@domains/ghcr';
import { VERIFY_ANNOTATIONS } from '@domains/pack';
import { QUARANTINE_ANNOTATION, TIER_ANNOTATION } from '@domains/root';
import { cursorOf, propose, StateError } from '@domains/state';
import { Fault } from '../root/lib.mjs';
import { RAW_TITLE } from './writer.mjs';

const SEGMENT_TYPE = artifactType('segment');
const TITLE = 'org.opencontainers.image.title';
const DAY_MS = 86_400_000;
const WHOLE = /^(?:0|[1-9][0-9]*)$/;
const DATASET_ORDER = ['names', 'domains'];
const A = VERIFY_ANNOTATIONS;

// The one segment of `m` ({ tag, digest, json }), with its history measure.
function segmentOf(m, rows) {
  const at = `obs:${m?.tag}`;
  const bad = (detail) => new Fault(`adopt ${at}: ${detail}`);
  if (m === null || typeof m !== 'object' || typeof m.tag !== 'string' || typeof m.digest !== 'string' || m.json === null || typeof m.json !== 'object')
    throw bad('is not a manifest { tag, digest, json }');
  const j = m.json;
  if (j.artifactType !== SEGMENT_TYPE) throw bad(`is ${JSON.stringify(j.artifactType ?? null)}, not ${SEGMENT_TYPE}`);
  const a = j.annotations ?? {};
  const get = (key) => {
    const v = a[key];
    if (typeof v !== 'string' || v === '') throw bad(`has no annotation ${key}`);
    return v;
  };
  if (get(TIER_ANNOTATION) !== 'seg') throw bad(`has the tier ${a[TIER_ANNOTATION]}, not seg`);
  const source = get(A.source);
  const row = rows.find((r) => r.id === source);
  if (row === undefined) throw bad(`is of ${JSON.stringify(source)}, which is not a source of the adapter (${rows.map((r) => r.id).join(', ')})`);
  const dataset = get(A.dataset);
  if (!row.datasets.includes(dataset)) throw bad(`holds ${dataset}, which ${source} does not write (${row.datasets.join(', ')})`);
  const precision = get(A.precision);
  if (precision !== row.precision) throw bad(`has the precision ${precision}, and ${source} is of precision ${row.precision}`);
  const count = get(A.count);
  if (!WHOLE.test(count) || !Number.isSafeInteger(Number(count))) throw bad(`has the count ${JSON.stringify(count)}, not a whole number`);
  const q = a[QUARANTINE_ANNOTATION];
  if (q !== undefined && q !== '1') throw bad(`carries ${QUARANTINE_ANNOTATION}=${JSON.stringify(q)}; a quarantined segment is pushed with "1", and no other value is read`);
  const start = get(A.spanStart);
  const end = get(A.spanEnd);
  const raw = (j.layers ?? []).find((l) => l.annotations?.[TITLE] === RAW_TITLE) ?? null;
  const oneDay = row.precision === 'day' && start.endsWith('T00:00:00Z') && Date.parse(end) - Date.parse(start) === DAY_MS;
  let measure = null;
  if (oneDay) {
    if (row.band.metric === 'bytes') {
      if (raw === null) throw bad(`carries no layer ${RAW_TITLE}, and the band of ${source} measures the file's bytes`);
      measure = raw.size;
    } else measure = Number(count);
  }
  return {
    segment: { ref: at, digest: m.digest, source, dataset, start, end, count: Number(count), quarantined: q === '1' },
    day: oneDay ? start.slice(0, 10) : null,
    raw: raw?.digest ?? null,
    measure,
  };
}

// propose of @domains/state, its refusal as a Fault.
function proposed(input, what) {
  try {
    return propose(input);
  } catch (e) {
    if (e instanceof StateError) throw new Fault(`${what}: ${e.message}`);
    throw e;
  }
}

export function adoptProposal({ adapter, rows, manifests, state, run, attempt, at, lane = null }) {
  if (!Array.isArray(manifests) || manifests.length === 0) throw new Fault(`adopt ${adapter}: no manifest to adopt`);
  const parsed = manifests.map((m) => segmentOf(m, rows));
  // One history item a (source, day): the names segment's when the day has one.
  const days = new Map();
  for (const p of parsed) {
    if (p.day === null) continue;
    const key = `${p.segment.source} ${p.day}`;
    const was = days.get(key);
    if (was !== undefined && was.raw !== p.raw)
      throw new Fault(`adopt ${p.segment.ref}: ${was.segment.ref} of the same day carries the raw blob ${was.raw}, and this one ${p.raw}: two files of one day are not adopted together`);
    if (was === undefined || DATASET_ORDER.indexOf(p.segment.dataset) < DATASET_ORDER.indexOf(was.segment.dataset)) days.set(key, p);
  }
  const cursor = cursorOf(state, adapter);
  return proposed(
    {
      adapter,
      lane,
      run,
      attempt,
      at,
      before: cursor,
      after: cursor,
      segments: parsed.map((p) => p.segment),
      raw: [],
      history: [...days.values()].map((p) => ({ source: p.segment.source, day: p.day, count: p.measure, quarantined: p.segment.quarantined })),
    },
    `adopt ${adapter}`,
  );
}

export function gapProposal({ adapter, gaps, state, run, attempt, at, lane = null }) {
  if (!Array.isArray(gaps) || gaps.length === 0) throw new Fault(`gaps ${adapter}: no day to declare`);
  const cursor = cursorOf(state, adapter);
  return proposed({ adapter, lane, run, attempt, at, before: cursor, after: cursor, segments: [], raw: [], history: [], gaps }, `gaps ${adapter}`);
}
