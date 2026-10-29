// scripts/ghcr/rate.mjs: a 429 costs no attempt and pauses 20 to 60 s until
// the cap; any other result or error passes through at once. The 429 texts
// are the three spellings mirror-archlinux's rate_limited reads.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GhcrError } from '../../packages/ghcr/src/reader.ts';
import { RATE_CAPS_S, RATE_LIMITED, RateLimitError, readPaused, underRateLimit } from './rate.mjs';

const recorder = () => {
  const sleeps = [];
  return { sleeps, deps: { sleep: async (ms) => sleeps.push(ms), random: () => 0.5, log: () => undefined } };
};

test('rate: the caps are 1,800 s for a part, 600 s for a manifest and 420 s for a promotion tag', () => {
  assert.deepEqual({ ...RATE_CAPS_S }, { part: 1800, manifest: 600, tag: 420 });
});

test('rate: underRateLimit pauses after each 429 and returns the first other result with the seconds paused', async () => {
  const { sleeps, deps } = recorder();
  const answers = [{ limited: true }, { limited: true }, { code: 0 }];
  const r = await underRateLimit('x', 600, async () => answers.shift(), deps);
  assert.deepEqual(r, { result: { code: 0 }, paused: 80 });
  // random() 0.5 is a pause of 20 + floor(0.5 * 41) = 40 s.
  assert.deepEqual(sleeps, [40_000, 40_000]);
});

test('rate: the pause that would pass the cap is not taken: RateLimitError', async () => {
  const { sleeps, deps } = recorder();
  await assert.rejects(
    underRateLimit('x', 100, async () => ({ limited: true }), deps),
    (e) => e instanceof RateLimitError && /after 80 s of pauses; the next pause of 40 s would pass the cap of 100 s/.test(e.message),
  );
  assert.deepEqual(sleeps, [40_000, 40_000]);
});

test('rate: readPaused asks a reader call again after its 429 and passes any other error on at once', async () => {
  const { sleeps, deps } = recorder();
  let n = 0;
  const v = await readPaused(
    'read',
    async () => {
      n += 1;
      if (n < 3) throw new GhcrError('rate-limited', 'GHCR answered 429', 429);
      return 'value';
    },
    deps,
  );
  assert.equal(v, 'value');
  assert.equal(sleeps.length, 2);
  await assert.rejects(
    readPaused(
      'read',
      async () => {
        throw new GhcrError('refused', 'no', 401);
      },
      deps,
    ),
    (e) => e instanceof GhcrError && e.code === 'refused',
  );
  assert.equal(sleeps.length, 2);
});

test('rate: the 429 texts of GHCR and oras are read as a rate limit, a denial is not', () => {
  for (const t of ['Error: response status code 429: toomanyrequests: retry later', 'HTTP 429 Too Many Requests', 'unexpected status code 429']) assert.match(t, RATE_LIMITED);
  for (const t of ['Error: denied: permission_denied', 'Error: ghcr.io/x:y: not found', 'Error: unauthorized: authentication required']) assert.doesNotMatch(t, RATE_LIMITED);
});
