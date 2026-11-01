// adapters/oi-nrd/src/window.ts — the window rule of the OpenINTEL NRD topics
// (DOM-026, design D8): where a window that starts at a second ends, and the
// bounds a record time must lie in.
//
// A window is `windowS` (10 minutes), ending on a multiple of it, or the rest
// of its hour when that hour ended at least `catchUpAfterS` (an hour) before
// ctx.now: a catch-up window, which only a backlog or a long stall has. Either
// way it ends on a 10-minute or an hour edge, so no window crosses an hour edge
// (D19 of DOM-024: a second-precision segment lies in one hour). The rule reads
// ctx.now and nothing else, so two runs with one `now` cut the same windows.
//
// Times here are whole seconds since the Unix epoch. A record stores them as
// seconds since 2026-01-01T00:00:00Z (docs/format.md section 1, the Time row).

export interface WindowLimits {
  // A window's length near now, in seconds: a divisor of 3600.
  readonly windowS: number;
  // An hour that ended this many seconds before ctx.now is one window.
  readonly catchUpAfterS: number;
}

const HOUR_S = 3600;

// 2026-01-01T00:00:00Z: a record time is unsigned from here (docs/format.md section 1).
export const EPOCH_2026_S = Date.UTC(2026, 0, 1) / 1000;

// The end of the window that starts at startS, by ctx.now in seconds.
export function windowEnd(startS: number, nowS: number, limits: WindowLimits): number {
  const hourEnd = Math.floor(startS / HOUR_S) * HOUR_S + HOUR_S;
  if (hourEnd <= nowS - limits.catchUpAfterS) return hourEnd;
  return Math.floor(startS / limits.windowS) * limits.windowS + limits.windowS;
}

// ISO 8601 UTC to the second, as a tag and a cursor's through name a time.
export const isoOf = (s: number): string => `${new Date(s * 1000).toISOString().slice(0, 19)}Z`;

// The seconds of an ISO 8601 UTC time to the second.
export const secondsOf = (iso: string): number => Date.parse(iso) / 1000;

// The upper bound of a record time the run takes (settled S5 of DOM-026): at
// most `slackS` after ctx.now. The Kafka record time is the producer's
// CreateTime, so a clock fault of the producer can put it anywhere; a record
// past this bound stops its topic before it, and becomes readable once the
// clock passes it. A record before EPOCH_2026_S, which no record can store,
// stops nothing: index.ts joins it to a window at the window's start.
export function clockProblem(t: number, nowS: number, slackS: number): string | null {
  if (t > nowS + slackS) return `later than the run's time ${isoOf(nowS)} plus ${slackS} s`;
  return null;
}
