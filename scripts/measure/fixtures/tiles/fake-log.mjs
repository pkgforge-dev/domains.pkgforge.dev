// scripts/measure/fixtures/tiles/fake-log.mjs — SYNTHETIC static CT hosts for
// the tests of DOM-011 (scripts/measure/ct-*.test.mjs, tiles-*.test.mjs).
// Nothing here was recorded from a log: every tree, timestamp and name is
// built from the arguments. The shapes follow the API the scripts read
// (scripts/measure/ct-tiles.mjs): `checkpoint` is three lines and a signature
// line, `tile/names/<N>` and `tile/names/<N>.p/<W>` are one JSON object an
// entry.
//
// Usage:
//   import { fakeLog, fakeFetch, T0 } from './fixtures/tiles/fake-log.mjs'
//   const fetchFn = fakeFetch({ 'https://log.test/': fakeLog({ size: 1000 }) })
// The fetch records every call in fetchFn.calls ({ url, headers }).
import { tilePath } from '../../ct-tiles.mjs';

// 2026-10-26T12:00:00Z, the start of the synthetic trees' clocks.
export const T0 = Date.parse('2026-10-26T12:00:00Z');

const text = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });

// A synthetic log of `size` entries. Entry i has the Timestamp ts(i) and the
// names dns(i). Tiles below `firstServed` answer 404, as IPng's do; a tile in
// `missing` answers 404 too; `status(path)` may answer any other status first
// (a 429, a 500), or return null to go on. `lengths` false sends no
// Content-Length, as a host that compresses on the fly does.
export function fakeLog({
  origin = 'log.test/fake',
  size,
  ts = (i) => T0 + i * 1000,
  dns = (i) => [`n${i}.example.com`],
  firstServed = 0,
  missing = new Set(),
  status = null,
  lengths = true,
  notFound = '404 page not found',
}) {
  const tileOf = new Map();
  const last = Math.floor(size / 256) - 1;
  const partial = size % 256;
  for (let n = 0; n <= last; n++) tileOf.set(`tile/names/${tilePath(n)}`, { n, w: 256 });
  if (partial > 0) tileOf.set(`tile/names/${tilePath(last + 1)}.p/${partial}`, { n: last + 1, w: partial });
  const body = ({ n, w }) => {
    const lines = [];
    for (let k = 0; k < w; k++) {
      const i = n * 256 + k;
      lines.push(JSON.stringify({ Timestamp: ts(i), Subject: { CN: dns(i)[0] ?? '' }, DNS: dns(i) }));
    }
    return `${lines.join('\n')}\n`;
  };
  return {
    size,
    handle(path) {
      const planted = status?.(path) ?? null;
      if (planted) return planted;
      if (path === 'checkpoint') return text(`${origin}\n${size}\nq4PMvo9ylN3kbcPrvBBUb7wQ0yaDKPVx2RxOv7S4Z30=\n\n— ${origin} c3ludGhldGljCg==\n`);
      const t = tileOf.get(path);
      if (!t || t.n < firstServed || missing.has(t.n)) return text(notFound, 404, { server: 'synthetic', 'content-length': String(notFound.length) });
      const b = body(t);
      return text(b, 200, lengths ? { 'content-length': String(Buffer.byteLength(b)) } : {});
    },
  };
}

// A fetch over hosts: `routes` maps a base URL (ending in /) to a fakeLog, or
// a full URL to a function (url, init) => Response. Anything else answers 599
// from no host, so an unplanned request shows in a test as a failure.
export function fakeFetch(routes) {
  const calls = [];
  const fetchFn = async (url, init = {}) => {
    calls.push({ url, headers: { ...(init.headers ?? {}) } });
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    const exact = routes[url];
    if (typeof exact === 'function') return exact(url, init);
    for (const [base, log] of Object.entries(routes)) {
      if (typeof log === 'function' || !url.startsWith(base)) continue;
      const r = log.handle(url.slice(base.length));
      if (r) return r;
    }
    return text('no such synthetic route', 599);
  };
  fetchFn.calls = calls;
  return fetchFn;
}

// A synthetic log list in the v3 shape: `logs` are [operator, description,
// state, monitoring URL] of tiled logs; `rfc6962` the same with a URL.
export function fakeList({ logs = [], rfc6962 = [], timestamp = '2026-10-28T13:37:58Z' } = {}) {
  const ops = new Map();
  const op = (name) => {
    if (!ops.has(name)) ops.set(name, { name, email: [], logs: [], tiled_logs: [] });
    return ops.get(name);
  };
  for (const [o, description, state, monitoring_url] of logs) op(o).tiled_logs.push({ description, monitoring_url, state: { [state]: { timestamp: '2026-01-01T00:00:00Z' } } });
  for (const [o, description, state, url] of rfc6962) op(o).logs.push({ description, url, state: { [state]: { timestamp: '2026-01-01T00:00:00Z' } } });
  return { _synthetic: 'built by scripts/measure/fixtures/tiles/fake-log.mjs; not a recorded list', version: '0.synthetic', log_list_timestamp: timestamp, operators: [...ops.values()] };
}
