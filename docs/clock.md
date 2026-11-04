# The clock

The clock starts the runs of `ingest-live.yml`. Ruling 8 asks that it be
measured. `docs/architecture.md` section 5.2 owns the design of the three
clocks and the rule. This document owns the numbers the verdict rests on and
the verdict in force.

The verdict in force is `actions-chain`, the self-dispatch chain.
`config/clock.json` records it, and `scripts/ingest/chain.mjs` is its one
reader. `node scripts/measure/clock-verdict.mjs` derives the verdict from the
three result files below, and `--check` holds `config/clock.json` to it. The
test "clock verdict" holds the table below, and every number in the prose of
this page, to the same files and to the constants of the script.

## The three clocks over 48 hours

| Clock | Result | Window, UTC | Interval | Runs / expected | Median gap | p90 gap | Max gap | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A. `schedule` | `docs/research/measure/DOM-001/schedule.json` | 2026-10-28T20:20:09Z to 2026-10-30T20:20:09Z | 5 min | 10 / 576 | 334.58 min | 411.82 min | 411.82 min | FAIL |
| B. Self-dispatch chain | `docs/research/measure/DOM-001/chain.json` | 2026-10-28T15:16:01Z to 2026-10-30T15:16:01Z | 5 min | 577 / 576 | 5 min | 5.02 min | 5.9 min | PASS |
| C. Cloudflare cron Worker | `docs/research/measure/DOM-002/worker.json` | 2026-10-28T15:23:24.560Z to 2026-10-30T15:23:24.560Z | 1 min | 2,875 / 2,880 | 1 min | 1.01 min | 2.73 min | PASS |

- **A** is `measure-clock-schedule.yml`, a cron line on this repository
  (DOM-001). `scripts/measure/clock-gaps.mjs` measured it.
- **B** is `measure-clock-chain.yml`: each run dispatches the next with
  `gh workflow run` and its own `GITHUB_TOKEN` (DOM-001).
  `scripts/measure/clock-gaps.mjs` measured it.
- **C** is the cron of the probe Worker `domains-probe`, each tick writing its
  record to R2 (DOM-002, DOM-061). A tick records no colo.
  `scripts/measure/worker-clock-gaps.mjs` measured it.

A gap is the time between two consecutive ticks. The window ends with a
closing gap, so a clock that stops more than 60 minutes before the window's
end fails. Each result file states its own definitions of a tick, the window
and the quantiles.

## The rule

Take the first of A, then B, then C whose p90 gap is at most 15 minutes and
whose largest gap is at most 60 minutes. If none passes, the verdict is
`none`: no `config/clock.json` is written, and DOM-003 stays open with a
question to the operator. Ruling 17 sets both numbers.

`RULE` of `scripts/measure/clock-gaps.mjs` holds the two numbers.
`probes/worker/src/gaps.ts` holds a copy for clock C, and the test "worker
clock gaps: the probe and clock-gaps.mjs share the rule, the break threshold
and the quantile" of `scripts/measure/worker-clock-gaps.test.mjs` holds the
copy equal. The `rule` of `config/clock.json` records the rule the verdict was
decided by, and `--check` holds it to `RULE`. The test "clock verdict" holds
the numbers of this page, of `docs/architecture.md` section 5.2 and of ruling
17 to `RULE`. A changed rule edits each of these, then runs
`node scripts/measure/clock-verdict.mjs --check`. A result judged by another
rule is judged again by the one in force.

## The chain in force

- **The interval.** `config/clock.json` sets `interval_min` to 30, the default
  of `scripts/ingest/chain.mjs`, and `--check` holds it to `INTERVAL_MIN` of
  `clock-verdict.mjs`. Ruling 27 sets the interval. The job `chain` of a run
  dispatches the successor at the start of the run, then sleeps to the next
  multiple of 30 minutes. The successor waits in the group `ingest-live`
  until the run ends. The cron backstop of `ingest-live.yml` has one slot an
  interval (`docs/architecture.md` section 5.3).
- **The scheduled workflows.** After the start, the job `chain` runs
  `scripts/ingest/chain.mjs due`. It dispatches each workflow of the table
  `DUE`, the compactions, `ref-refresh.yml` and `ingest-thc.yml`, one row
  for each cron of a file, when its cron's last instant and the grace of
  20 minutes have passed with no run of it since that instant. GitHub started the crons of `compact-daily.yml` and
  `ref-refresh.yml` hours late, and the weekly, monthly and yearly crons have
  not fired yet (DOM-023's Found on the late crons), so under `actions-chain`
  the chain is their clock too. Their crons stay, and start them when the
  chain is off. `docs/architecture.md`
  section 5.2 gives the rule.
- **The lateness of the chain itself.** B's row is the chain at its own
  interval. `p90_gap_min` and `max_gap_min` of `config/clock.json` are B's
  gaps at that interval, not at `interval_min`. At an interval of 30 minutes
  the p90 gap is expected to be about 30 minutes [E]. So the rule's p90 of
  15 minutes judges the three clocks above and does not bound the chain. The
  largest gap of 60 minutes stays the bound it is held to (ruling 27). A run
  of `scripts/measure/clock-gaps.mjs` over 48 hours of the runs of
  `ingest-live.yml`, its schedule and dispatched runs together, would replace
  the estimate and show whether the bound holds, and DOM-034 runs it. A
  run that outlasts the interval ends its gap when the run ends, because the
  successor starts then. The next gap is shorter, because the successor sleeps
  to the boundary after its own start.
- **The cost.** The chain holds one of the jobs that the organisation runs at
  once, for as long as it runs (the limit is in `docs/architecture.md`
  section 5.1). Over its 48 hours the measured chain used 171,180 s, about
  47.6 hours, of runner time (`chain.json`, `cost`). Runner time is free for a
  public repository.
- **The legs.** The lane `kafka` of `config/lanes.json` holds `oi-nrd`
  (DOM-026), and the lanes `tiles` and `feeds` are empty. So each run of the
  chain plans one leg, pushes the segments of `oi-nrd`, moves `state` and
  promotes, then sleeps.
- **Stopping it.** `gh workflow disable ingest-live.yml`, the undo of the row
  of `ingest-live.yml` in `docs/resources.md`, stops the chain and the cron
  backstop. That a disabled workflow starts no dispatched run is assumed, not
  measured.
- **Restarts.** A run of the cron backstop of `ingest-live.yml`
  (`docs/architecture.md` section 5.3) dispatches a successor when none
  waits, so the next backstop run restarts a broken chain. GitHub started the
  backstop's schedule runs hours apart, as late as A's (DOM-024's Correction
  on the backstop's runs), so that restart takes hours. The watchdog of
  DOM-034 adds `dispatch-overdue`, itself on a schedule, and how soon it
  restarts the chain is not measured.
- **No Worker dispatches a workflow.** That would need a GitHub token in
  Cloudflare, and no credential crosses between GitHub and Cloudflare
  (ruling 6).

A cron Worker would carry the freshness through a hot tier in R2 (DOM-025).
The verdict is an Actions clock at the interval B was measured at, so DOM-025
is closed on ruling 8 with no code, and the Kafka lane runs on Actions with
the other lanes. A live tier on Cloudflare from the operator (ruling 27)
takes DOM-025 up again (its Found on ruling 27).

## What the verdict does not show

- The chain at 30 minutes is not measured (the lateness of the chain, above).
- Each clock was measured once, over one window of 48 hours. GitHub's
  queueing on another day is not measured. One burst of the organisation's
  jobs is measured, in DOM-034's Found on the burst: how long no ingest leg
  of the chain started. How often such bursts come is not measured.
- The colo of clock C's cron invocations is not recorded, so C is one window
  from one colo that is not known.
