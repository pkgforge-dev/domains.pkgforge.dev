// scripts/ghcr/rate.mjs — GHCR's rate limit and the time of one attempt, for
// every script of scripts/ghcr/ (docs/architecture.md section 4.7 rule 5).
//
// A 429 costs no attempt: the script pauses 20 to 60 s, uniform, and asks
// again, until the pauses would pass the cap of the operation: 1,800 s for a
// pack part, 600 s for a manifest, 420 s for a promotion tag (READ
// mirror-archlinux docs/design.md rules and scripts/lib.sh throttle_pause, by
// DOM-019). One attempt may last 300 s plus its bytes at 2 MiB/s, and never
// more than 600 s: GHCR's upload limit is 10 minutes (docs/architecture.md
// section 4.3).
//
//   const { value } = await underRateLimit('read ref', RATE_CAPS_S.manifest, attempt, deps)
//
// `attempt` returns `{ limited: true }` for a 429 and anything else otherwise;
// readPaused wraps a reader call, whose 429 is GhcrError rate-limited.
import { GhcrError } from '../../packages/ghcr/src/reader.ts';

export const PAUSE_S = Object.freeze({ min: 20, max: 60 });
export const RATE_CAPS_S = Object.freeze({ part: 1800, manifest: 600, tag: 420 });
export const ATTEMPT_S = Object.freeze({ base: 300, max: 600, bytesPerSecond: 2 * 1024 * 1024 });
// oras's words for a 429, and GHCR's (mirror-archlinux scripts/lib.sh rate_limited).
export const RATE_LIMITED = /toomanyrequests|status code 429|429 Too Many/i;

export class RateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RateLimitError';
  }
}

export const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Seconds one attempt that moves `bytes` may last.
export function attemptSeconds(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) throw new RangeError(`attemptSeconds: ${bytes} is not a byte count`);
  return Math.min(ATTEMPT_S.max, ATTEMPT_S.base + Math.ceil(bytes / ATTEMPT_S.bytesPerSecond));
}

// One pause, in whole seconds from PAUSE_S.min to PAUSE_S.max.
export function pauseSeconds(random = Math.random) {
  const r = random();
  if (!(r >= 0 && r < 1)) throw new RangeError(`pauseSeconds: random() gave ${r}, not a number in [0, 1)`);
  return PAUSE_S.min + Math.floor(r * (PAUSE_S.max - PAUSE_S.min + 1));
}

// Runs `attempt` until its result is not `{ limited: true }`, pausing between,
// and throws RateLimitError when the next pause would pass `capSeconds`.
// Returns the last result and the seconds paused.
export async function underRateLimit(label, capSeconds, attempt, { sleep = realSleep, random = Math.random, log = () => undefined } = {}) {
  let paused = 0;
  for (;;) {
    const result = await attempt();
    if (result?.limited !== true) return { result, paused };
    const p = pauseSeconds(random);
    if (paused + p > capSeconds) throw new RateLimitError(`${label}: GHCR answered 429 again after ${paused} s of pauses; the next pause of ${p} s would pass the cap of ${capSeconds} s`);
    log(`${label}: GHCR answered 429; pausing ${p} s (${paused + p} s of at most ${capSeconds} s), which costs no attempt`);
    await sleep(p * 1000);
    paused += p;
  }
}

// A reader call under the rate limit: its value, or its GhcrError other than 429.
export async function readPaused(label, fn, deps = {}) {
  const { result } = await underRateLimit(
    label,
    RATE_CAPS_S.manifest,
    async () => {
      try {
        return { value: await fn() };
      } catch (err) {
        if (err instanceof GhcrError && err.code === 'rate-limited') return { limited: true };
        throw err;
      }
    },
    deps,
  );
  return result.value;
}
