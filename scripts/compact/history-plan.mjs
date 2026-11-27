// Prepare an offline historical replay from an immutable root and its
// original compaction edges. Tags and producing-run annotations are hints;
// only matching manifest digests on both sides establish day membership.
import { dayOf } from '@domains/compact';
import { canonical, carryWithdrawn, checkForward, rankOf, RootError, validateRoot, WITHDRAWN_DAYS } from '@domains/root';
import { Fault, readRootJson, UsageError } from '../root/lib.mjs';

export const HISTORY_PLAN_FORMAT = 'domains.compact-history-plan.v1';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const DATASETS = ['domains', 'feed'];
const MAX_EDGES = 64;
const MAX_DAYS = 366;
const WITHDRAWN_MS = WITHDRAWN_DAYS * 86_400_000;
const SPAN_START = 'dev.pkgforge.domains.span.start';
const SPAN_END = 'dev.pkgforge.domains.span.end';
const datesOf = (from, to) => {
  const first = dayOf(from);
  const end = dayOf(to);
  if (first.start > end.start) throw new UsageError('--to must be on or after --from');
  const days = [];
  for (let day = first; day.start < end.end; day = dayOf(day.end.slice(0, 10))) {
    if (days.length >= MAX_DAYS) throw new UsageError(`a replay takes at most ${MAX_DAYS} days`);
    days.push(day);
  }
  return days;
};
const overlaps = (a, b) => a.start < b.end && b.start < a.end;
const within = (a, b) => a.start >= b.start && a.end <= b.end;
const same = (a, b) => a.repo === b.repo && a.tag === b.tag && a.manifest === b.manifest;

async function rootAt(reader, digest, deps) {
  if (typeof digest !== 'string' || !DIGEST.test(digest)) throw new UsageError(`${JSON.stringify(digest)} is not an immutable root digest`);
  const result = await readRootJson(reader, digest, deps);
  if (result.digest !== digest) throw new Fault(`root ${digest} read as ${result.digest}`);
  return { digest, root: validateRoot(result.root) };
}

async function edgesOf(hints, fetchRoot) {
  if (!Array.isArray(hints) || hints.length > MAX_EDGES) throw new UsageError(`--edges must list at most ${MAX_EDGES} historical root transitions`);
  const edges = [];
  for (const hint of hints) {
    const after = await fetchRoot(hint?.after?.digest);
    const before = await fetchRoot(hint?.before?.digest);
    if (after.root.previous !== before.digest || after.root.root_seq !== before.root.root_seq + 1) {
      throw new Fault(`${before.digest} and ${after.digest} are not adjacent roots`);
    }
    const anchor = hint.planAnchor === undefined ? before : await fetchRoot(hint.planAnchor.digest);
    // The plan and its promotion can be separated by unrelated root writes.
    // Recheck a bounded chain of only those intervening roots.
    let at = before;
    for (let i = 0; at.digest !== anchor.digest; i += 1) {
      if (i === 8 || at.root.previous === null || at.root.root_seq <= anchor.root.root_seq) throw new Fault(`${anchor.digest} does not precede ${before.digest} inside the planning window`);
      const older = await fetchRoot(at.root.previous);
      if (older.root.root_seq !== at.root.root_seq - 1) throw new Fault(`${older.digest} is out of sequence before ${at.digest}`);
      at = older;
    }
    edges.push({ after, before, anchor });
  }
  return edges;
}

function inventoryOf(inventory) {
  if (!Array.isArray(inventory)) throw new UsageError('--inventory must be a list of archive manifest descriptors');
  const entries = new Map();
  for (const row of inventory) {
    if (!DATASETS.includes(row?.dataset)) continue;
    if (!DIGEST.test(row.digest ?? '') || !row.annotations || row.error !== undefined) throw new Fault(`inventory entry ${row.tag} has no verified manifest descriptor`);
    if (entries.has(row.digest)) throw new Fault(`inventory repeats ${row.digest}`);
    entries.set(row.digest, row);
  }
  return entries;
}

function verifyInventory(pack, dataset, inventory) {
  const found = inventory.get(pack.manifest);
  if (
    found === undefined ||
    found.dataset !== dataset ||
    found.repo !== pack.repo ||
    found.tag !== pack.tag ||
    found.annotations[SPAN_START] !== pack.span.start ||
    found.annotations[SPAN_END] !== pack.span.end
  ) {
    throw new Fault(`the proved ${dataset} input ${pack.tag}@${pack.manifest} has no matching archive inventory entry`);
  }
}

function verifyCompactionEdge(before, after) {
  try {
    checkForward(before.root, after.root);
  } catch (e) {
    if (e instanceof RootError) throw new Fault(`root_seq ${after.root.root_seq} cannot prove a forward compaction: ${e.message}`);
    throw e;
  }
  const created = Date.parse(after.root.created);
  const carried = carryWithdrawn(before.root.withdrawn, created);
  if (canonical(after.root.withdrawn) !== canonical(carried)) throw new Fault(`root_seq ${after.root.root_seq} changes withdrawals like a rollback; it cannot prove original compaction inputs`);
  // A rollback that discards any of the immediate predecessor's live packs
  // records those withdrawals when the predecessor is inside the retention
  // window. Beyond it the same visible pack substitution could be a rollback
  // with no withdrawal evidence, and the OCI root format has no action flag.
  if (created - Date.parse(before.root.created) > WITHDRAWN_MS) {
    throw new Fault(`root_seq ${after.root.root_seq} is beyond the ${WITHDRAWN_DAYS}-day withdrawal window of its predecessor; original compaction provenance is ambiguous`);
  }
}

function expand(dataset, pack, edges, inventory, used) {
  if (pack.tier === 'd') {
    verifyInventory(pack, dataset, inventory);
    return [pack];
  }
  const matches = edges.filter(({ after, before }) => after.root.datasets[dataset]?.some((p) => same(p, pack)) && !before.root.datasets[dataset]?.some((p) => same(p, pack)));
  if (matches.length !== 1) throw new Fault(`${pack.tag}@${pack.manifest} needs one proved compaction edge, found ${matches.length}`);
  const { after, before, anchor } = matches[0];
  const inputsOf = (root) => (root.datasets[dataset] ?? []).filter((p) => overlaps(p.span, pack.span));
  const originals = inputsOf(before.root);
  if (originals.length === 0 || originals.some((p) => !within(p.span, pack.span) || rankOf(p.tier) >= rankOf(pack.tier) || rankOf(p.tier) < rankOf('d'))) {
    throw new Fault(`${pack.tag}: archive edge does not replace whole lower compacted spans`);
  }
  if (inputsOf(after.root).length !== 1 || JSON.stringify(inputsOf(anchor.root).map((p) => p.manifest)) !== JSON.stringify(originals.map((p) => p.manifest))) {
    throw new Fault(`${pack.tag}: the plan and promotion roots do not bind the same original inputs`);
  }
  verifyCompactionEdge(before, after);
  used.set(pack.manifest, { before: before.digest, after: after.digest, planAnchor: anchor.digest, inputDigests: originals.map((p) => p.manifest) });
  return originals.flatMap((p) => expand(dataset, p, edges, inventory, used));
}

export async function planHistory({ ref, from, to, hints, inventory }, reader, deps = {}) {
  const days = datesOf(from, to);
  const span = { start: days[0].start, end: days.at(-1).end };
  const cache = new Map();
  async function fetchRoot(digest) {
    if (!cache.has(digest)) cache.set(digest, await rootAt(reader, digest, deps));
    return cache.get(digest);
  }
  const { root } = await fetchRoot(ref);
  const edges = await edgesOf(hints, fetchRoot);
  if (edges.some(({ after }) => after.root.root_seq > root.root_seq || after.root.created > root.created)) throw new Fault('a historical edge is newer than the pinned target root');
  const archive = inventoryOf(inventory);
  const used = new Map();
  const current = {};
  for (const dataset of DATASETS) {
    const covers = (root.datasets[dataset] ?? []).filter((p) => p.tier !== 'seg' && overlaps(p.span, span));
    if (covers.some((p) => !within(p.span, span) || rankOf(p.tier) < rankOf('d'))) throw new Fault(`${dataset}: replay interval must include each entire affected compacted span`);
    if (covers.some((p) => p.tier === 'y')) throw new Fault(`${dataset}: a historical year needs intermediate monthly assemblies`);
    current[dataset] = covers.map((p) => ({ pack: p, days: expand(dataset, p, edges, archive, used) }));
  }
  const domainLive = root.datasets.domains ?? [];
  const overlays = domainLive.filter((p) => p.tier === 'seg' && overlaps(p.span, span));
  if (overlays.some((p) => !within(p.span, span))) throw new Fault('a live domains segment crosses the replay interval');
  const inputsFor = (dataset, day) => current[dataset].flatMap((p) => p.days).filter((p) => p.span.start === day.start && p.span.end === day.end);
  const replay = days.map((day) => {
    const canonical = Object.fromEntries(DATASETS.map((dataset) => [dataset, inputsFor(dataset, day)]));
    if (canonical.domains.length !== 1 || canonical.feed.length !== 1) throw new Fault(`${day.date}: exactly one proved domains day and feed carry are required`);
    const extra = overlays.filter((p) => overlaps(p.span, day));
    if (extra.some((p) => !within(p.span, day))) throw new Fault(`${day.date}: a live segment crosses its day boundary`);
    return { date: day.date, domains: [...canonical.domains, ...extra], carry: canonical.feed[0] };
  });
  const earlier = domainLive.filter((p) => p.span.end <= span.start);
  return {
    format: HISTORY_PLAN_FORMAT,
    root: { digest: ref, seq: root.root_seq, psl: root.psl },
    span,
    tags: [...new Set(inventory.filter((row) => DATASETS.includes(row?.dataset)).map((row) => row.tag))].sort(),
    evidence: Object.fromEntries(used),
    earlier,
    replay,
    targets: DATASETS.flatMap((dataset) => current[dataset].map(({ pack, days }) => ({ dataset, pack, days: days.map((p) => p.span.start.slice(0, 10)) }))),
    downstream: (root.datasets.feed ?? []).filter((p) => p.span.start >= span.end),
  };
}
