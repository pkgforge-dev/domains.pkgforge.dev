# Ops

The freshness clock and its measurements, the watchers that keep the clock running, the coverage table, the validation sample, the failure drills and the runbooks.

Notation. A GitHub Actions expression is written `<expr:X>` in this file. It stands for X inside a pair of double braces. The record guard refuses a double brace in any entry file, so a workflow shape here never shows one.

"The mirror" in this file is mirror-archlinux, `https://github.com/pkgforge-dev/mirror-archlinux` at commit `669ac725f8081445c164113f2ed092533de112e2`. An entry that copies from it reads the file at `https://raw.githubusercontent.com/pkgforge-dev/mirror-archlinux/669ac725f8081445c164113f2ed092533de112e2/<path>`. It is never THC's mirror: "THC's mirror" is this project's own GHCR copy of THC's monthly database (DOM-042).

Every workflow an entry writes passes `scripts/check-workflows.mjs` (DOM-014): the job names that may hold `packages: write`, `issues: write` or `actions: write` are in the one table of DOM-014. A job named in this file is a name in that table.

## DOM-001 — Measure the Actions clock: a schedule and a self-dispatch chain

- **Status:** partial
- **Waiting:** until 2026-10-30T15:00:00Z; run scripts/measure/clock-gaps.mjs on measure-clock-schedule.yml and measure-clock-chain.yml over the 48 hours, record both verdicts, disable the schedule and the keepalive, and close
- **Priority:** P1
- **Effort:** M
- **Source:** the operator, 2026-10-27, ruling 8 of `TODO/RULES.md` section 5: "leave both as measurements for that agent to do, ideally actions since its a real vm with near gigabit speed". Architecture section 5.2 states the three clocks and the decision rule.
- **Problem:** every ingest run needs a clock that starts it. GitHub's `schedule` starts runs late. Nobody has measured this repository's own workflows. A wrong clock leaves the 1 h window of `/v1/new` empty for hours.
- **Premise:**
  - MEASURED by the operator's agent at 2026-10-27T06:33Z over the last 300 runs of mirror-archlinux, all events. Its `*/15` workflow "Upstream watch" ran 40 times with a median gap of 233 min (p90 318, max 377). Its `17 */3` workflow "Sync all targets" had a median gap of 274 min even with 10 dispatches among 37 runs. Its hourly "Status" reached a 53 min median only with 90 dispatches.
  - MEASURED in design B, M8 (2026-10-27T05:12:30Z, `runs?event=schedule` of the same repository): the `*/15` cron made 66 scheduled runs in 10.1 days against about 970 expected, median gap 227 min, max 443 min. The `17 */3` cron made 57 runs in 12.7 days against about 101, median 320 min, max 512 min. The scripts are `docs/research/2026-10-27-design-b/scripts/actions_history.mjs` and `actions_queue.mjs`. The results are `docs/research/2026-10-27-design-b/results/actions_history.txt` and `actions_queue.txt`.
  - MEASURED again on 2026-10-27T09:14Z (the review of this record, `runs?event=schedule` of the same `*/15` workflow): 67 runs, median gap 229 min, p90 314 min, max 443 min. Three readings of one cron agree within 6 min on the median (227, 229 and 233).
  - MEASURED in design B, M8 (2026-10-27T06:11:56Z, 24 recent runs, 250 jobs): once a run exists, its runner starts fast. Median 2 s, p90 3 s, max 7 s. A dispatched run queues like a scheduled run.
  - READ in GitHub's documentation (design B, R2): a `schedule` run can be delayed, and queued jobs can be dropped. It runs only on the default branch. The smallest interval is 5 minutes. GitHub disables schedules after 60 days with no repository activity.
  - READ in GitHub's documentation (events that trigger workflows): an event made with `GITHUB_TOKEN` starts no new run, except `workflow_dispatch` and `repository_dispatch`. So a job can start its successor with `gh workflow run` and its own token. The mirror's `scripts/dispatch-overdue` does this.
  - MEASURED `gh api orgs/pkgforge-dev --jq '{plan:.plan.name, public_repos:.public_repos}'` at 2026-10-27T08:22:51Z: `{"plan":"free","public_repos":628}`. The Free plan runs 20 jobs at once for the whole organisation, so a chain that never ends holds 1 of 20 slots.
  - MEASURED `gh api repos/pkgforge-dev/domains.pkgforge.dev/actions/permissions` at 2026-10-27T08:34:25Z: Actions is enabled and all actions are allowed. The default workflow permission is `write`, so every workflow below declares `permissions` itself.
  - The repository has no commit when this entry is written. A `schedule` runs only from the default branch. Push to `main` once the gate is green.
- **Approach:**
  - **Three workflows**, all under `.github/workflows/`. Copy the header shape of mirror-archlinux `.github/workflows/upstream-watch.yml` at commit 669ac725f8081445c164113f2ed092533de112e2 (raw URL `https://raw.githubusercontent.com/pkgforge-dev/mirror-archlinux/669ac725f8081445c164113f2ed092533de112e2/.github/workflows/upstream-watch.yml`): `permissions: {}` at the top, grants per job, `defaults.run.shell: bash`, `ubuntu-24.04`, `timeout-minutes`. These workflows use no third-party action, so nothing needs a commit pin.
  - **The schedule workflow is sampled by the clock it measures.** That is the measurement: the runs that GitHub starts from a cron are the sample, whatever their gaps. Every other measurement in this repository that needs a regular sample (DOM-011, DOM-012, DOM-049) takes it from inside a long job or a chain, never from a cron, because this entry measures how unreliable a cron is (a median gap of 229 min on a `*/15` cron, MEASURED 2026-10-27T09:14Z over 67 runs of mirror-archlinux's workflow: p90 314 min, max 443 min).
  - **`measure-clock-schedule.yml`** measures clock A. The expression values go through `env`, never into the `run:` string (rule 7 of DOM-014):

        name: Measure clock schedule
        on:
          schedule:
            - cron: '*/5 * * * *'
          workflow_dispatch:
        permissions: {}
        defaults:
          run:
            shell: bash
        concurrency:
          group: measure-clock-schedule
          cancel-in-progress: false
        jobs:
          tick:
            runs-on: ubuntu-24.04
            timeout-minutes: 5
            permissions:
              contents: read
            steps:
              - name: Record the tick
                env:
                  EVENT: <expr:github.event_name>
                  RUN_ID: <expr:github.run_id>
                run: echo "event=$EVENT run=$RUN_ID at=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_STEP_SUMMARY"

    The run's `created_at` is the time GitHub made it. `github.event.schedule` is the cron string and not the slot, so no slot time is read from it.
  - **`measure-clock-chain.yml`** measures clock B. A run starts its successor first. The concurrency group makes the successor wait until this run ends, so the gap between two runs is the queue time. The run then sleeps to the next 5 minute boundary and ends. The job is named `measure-chain`, the name of DOM-014's table for a measurement chain. The block below is the shape, and the two paragraphs after the `queue: max` paragraph add the guards of the file's step `id: successor`:

        name: Measure clock chain
        on:
          workflow_dispatch:
        permissions: {}
        defaults:
          run:
            shell: bash
        concurrency:
          group: measure-clock-chain
          queue: max
          cancel-in-progress: false
        jobs:
          measure-chain:
            runs-on: ubuntu-24.04
            timeout-minutes: 15
            permissions:
              actions: write
              contents: read
            steps:
              - name: Start the successor, then wait for the next 5 minute boundary
                env:
                  GH_TOKEN: <expr:github.token>
                  CHAIN_END: <expr:vars.CHAIN_END>
                run: |
                  now=$(date +%s)
                  echo "run=$GITHUB_RUN_ID started=$(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$GITHUB_STEP_SUMMARY"
                  if [ -z "$CHAIN_END" ] || [ "$now" -lt "$(date -d "$CHAIN_END" +%s)" ]; then
                    gh workflow run measure-clock-chain.yml --ref main --repo "$GITHUB_REPOSITORY"
                  fi
                  next=$(( (now / 300 + 1) * 300 ))
                  sleep $(( next - $(date +%s) ))

    `queue: max` keeps up to 100 pending runs in turn (mirror-archlinux `docs/operations.md`, "Concurrency"). actionlint does not know the key, so DOM-014 allows it.

    A re-run starts no successor: its `GITHUB_RUN_ATTEMPT` is above 1, and its attempt 1 already started one. A run also starts no successor when `gh run list --branch main` shows another run of the workflow waiting. A waiting run has a status other than `in_progress` and `completed`. Either case would start a second chain, and two chains hold each other's runs. Every start lag would then read as a wait behind the other chain. `scripts/measure/clock-chain.test.mjs` runs the step under a fake `gh`.

    A run on a ref other than `main` starts no successor. A `CHAIN_END` that is not an instant like `2026-10-30T11:00:00Z`, or not a real date, fails the run and starts nothing. A run that finds `CHAIN_END` passed starts nothing and exits 0 with no sleep. An empty `CHAIN_END` never ends the chain. The step tries the dispatch 3 times, 15 s apart, and then fails the run: that is a chain break, which the keepalive restarts. Each run writes its run id, attempt and start to its step summary, and a run that does not fail also writes `successor=`.
  - **`measure-clock-chain-keep.yml`** is the backstop. Cron `*/30 * * * *` with `workflow_dispatch:` beside it (rule 12 of DOM-014), `permissions: {}` at the top, `defaults.run.shell: bash`, one job named `keepalive` with `timeout-minutes: 5` and `permissions: actions: write, contents: read`, and `GH_TOKEN` through `env`. It runs `gh run list --workflow measure-clock-chain.yml --limit 50 --json databaseId,status` and counts every run whose status is not `completed` as alive. When none is alive it runs `gh workflow run measure-clock-chain.yml --ref main`. This is the shape of `scripts/dispatch-overdue`. Every restart it makes counts as one chain break. It never makes the first start: when the workflow has no run at all, it starts nothing, so the start instant and `CHAIN_END` stay with the person who dispatches the chain. It starts nothing once `CHAIN_END` has passed, and nothing when `measure-clock-chain.yml` is not `active`. A malformed `CHAIN_END` fails its run.
  - **Start and stop.** Push the three files to `main`. Set `CHAIN_END` at the first dispatch, to the dispatch time plus 48 hours, because an empty `CHAIN_END` never ends the chain. In Git Bash, with GNU `date`, run `gh variable set CHAIN_END --body "$(date -u -d '+48 hours' +%Y-%m-%dT%H:%M:%SZ)"` and then `gh workflow run measure-clock-chain.yml --ref main`. Read the value back with `gh variable get CHAIN_END` and record it with the dispatch time in this entry. The chain ends by itself at `CHAIN_END`. When both result files are written, run `gh workflow disable measure-clock-schedule.yml` and `gh workflow disable measure-clock-chain-keep.yml`.
  - **`scripts/measure/clock-gaps.mjs`** reads the runs. It prints one JSON object on stdout and one `verdict=` line on stderr. `scripts/measure/clock-gaps.test.mjs` runs it on run lists with known gaps. It also runs it on the run list of mirror-archlinux's `upstream-watch.yml` in `scripts/measure/fixtures/clock-gaps/mirror-upstream-watch.runs.json`.
    - **The listing.** It reads the run list as JSON pages, `gh api 'repos/<repo>/actions/workflows/<file>/runs?event=<event>&branch=main&exclude_pull_requests=true&per_page=100&page=<n>'`, and selects the fields by name. It refuses the listing with exit 2 when GitHub counts 1,000 runs or more. That is the most the endpoint lists for a query filtered by event or branch. It also refuses a listing that holds fewer distinct runs than GitHub counts.
    - **The tick.** For each run it reads `repos/<repo>/actions/runs/<id>/attempts/1/jobs`. A run's tick is the earliest `started_at` among the jobs of its first attempt that a runner took. A job that a runner took has `runner_name` set. It does not read `run_started_at`. A run that no runner took is no tick. If that run was created inside the window, it is counted in `runs_not_started`.
    - **The flags.** Its flags are `--workflow`, `--event`, `--interval-min`, `--hours` and `--out`, and also `--repo` and `--runs`. `--repo` defaults to `pkgforge-dev/domains.pkgforge.dev`. With `--out` it also writes the run list beside the result as `<name>.runs.json`. `--runs` computes a result again offline from such a file.
    - **The window.** The window is `[from, from + 48 h)`, `from` being the first tick. Its gaps are the gaps between consecutive ticks in it, plus a closing gap. The closing gap runs from its last tick to the first tick at or after its end, or to its end when no tick came. So a clock that stops inside the window fails it.
    - **Exit codes.** It exits 0 when the window is complete and measured, with `PASS` or `FAIL` as the finding and `--out` written. It exits 1 when the window has not ended, and writes nothing. It exits 2 when it could not run.
  - **Result schema** (`docs/research/measure/DOM-001/schedule.json` and `chain.json`): `{clock, workflow, event, from, to, hours, runs, expected, gaps_min:{median,p90,max}, start_lag_s:{median,p90,max}, slots:{expected,hit,missed}, breaks_over_30min, verdict, rule:{p90_max_min:15, max_max_min:60}}`, then `version`, `complete`, `hours_seen`, `repo`, `branch`, `interval_min`, `gaps` (the count), `runs_not_started`, `cost:{runner_s_total, runner_s_median, note}`, `conditions:{fetched_at, gh, listed_runs, node}` and `definitions`. `clock` is `actions-schedule` for the event `schedule` and `actions-chain` for `workflow_dispatch`. `expected` is `hours * 60 / interval`. `start_lag_s` is the tick minus the run's `created_at`. `breaks_over_30min` counts gaps over 30 minutes. `verdict` is `PASS` when the p90 gap is at most 15 min and the max gap is at most 60 min, else `FAIL`.
    - **The quantile.** A median or p90 is the value at index `floor(n * q)` of the ascending list. So the median of an even count is the upper middle value. This is the rule of design B's `actions_history.mjs`, which produced the premise numbers. The verdict reads the unrounded gaps.
    - **The slots.** `slots` is the cron's own slot arithmetic. It is computed for the schedule only, and is `null` for the chain. The slot of a run is `floor(created_at / interval)`. The expected slots are the `expected` slots that start at the slot of the first tick's run. `hit` counts the expected slots that hold a run, started or not, and `missed` counts the rest.
    - **What `missed` means.** A run that GitHub delays into a later slot counts in that later slot. So `missed` is a lower bound of the slots the cron lost. No per-run slot lag is recorded, because a run does not say which slot it was meant for.
  - **Cost to note in the result file.** The schedule uses about 10 s of runner time per run. The chain holds one of the 20 organisation slots for 48 hours. Both are free for a public repository.
- **Decision:** both clocks use a 5 minute interval, the smallest GitHub allows, so the two numbers compare fairly. The real ingest interval is 10 minutes (architecture section 5.3). A clock that holds at 5 holds at 10.
- **Depends on:** none
- **Prove:** `node scripts/measure/clock-gaps.mjs --workflow measure-clock-schedule.yml --event schedule --interval-min 5 --hours 48 --out docs/research/measure/DOM-001/schedule.json` and the same with `--workflow measure-clock-chain.yml --event workflow_dispatch --out docs/research/measure/DOM-001/chain.json`; each exits 0 when 48 hours of runs exist, prints one `verdict=` line, and writes its file.
  - `node scripts/test.mjs scripts/measure --name "^clock gaps"` passes, and `node scripts/test.mjs scripts/measure --name "^clock chain"` passes.
  - `gh run list --workflow measure-clock-chain.yml --limit 3 --json status,event,createdAt` shows a pending or running successor.
  - Both result files, and the `schedule.runs.json` and `chain.runs.json` beside them, are committed with the numbers in the entry's `Measured` line when it closes.
- **Built 2026-10-28T14:31Z:** the tree holds `.github/workflows/measure-clock-schedule.yml`, `.github/workflows/measure-clock-chain.yml` and `.github/workflows/measure-clock-chain-keep.yml`. It holds `scripts/measure/clock-gaps.mjs` with its test `scripts/measure/clock-gaps.test.mjs`, and `scripts/measure/clock-chain.test.mjs`. That test cuts the chain and keepalive steps from their workflows. It runs them under bash with a fake `gh` and a fake `sleep`, through `scripts/lib/workflow-step.mjs`. The fixture `scripts/measure/fixtures/clock-gaps/mirror-upstream-watch.runs.json` is a real run list, read from GitHub at 2026-10-28T10:33:41Z.
  - **Tested** 2026-10-28T14:28Z on the operator's Windows 11 workstation with Node v26.7.0, and run again at 2026-10-28T14:47Z with the same counts. `node scripts/test.mjs scripts/measure --name "^clock gaps"` exits 0 with 21 tests. `node scripts/test.mjs scripts/measure --name "^clock chain"` exits 0 with 7 tests. None of the 7 is skipped, because bash and jq were found.
  - **The fixture run.** `node scripts/measure/clock-gaps.mjs --runs scripts/measure/fixtures/clock-gaps/mirror-upstream-watch.runs.json --workflow upstream-watch.yml --event schedule --interval-min 15 --hours 48` exits 0 at 2026-10-28T14:26Z, and again at 2026-10-28T14:48Z. It prints `verdict=FAIL` for the window 2026-10-16T21:43:52Z to 2026-10-18T21:43:52Z. The window holds 16 of 192 runs. The gaps are median 168.78 min, p90 291.33 min and max 314.33 min, with 16 breaks. The slots are 16 hit and 176 missed.
  - **Not run.** No workflow of this entry has run. `scripts/check-workflows.mjs` of DOM-014 does not exist yet. The builder checked the three files against DOM-014's rules by reading only.
  - **What waits.** After the push to `main`, the entry waits for `CHAIN_END`, the first dispatch and the successor check. After 48 hours it waits for the two `clock-gaps.mjs` runs, and then for the two disables. At one run every 5 minutes, 1,000 runs take 83 hours from the first tick. `clock-gaps.mjs` refuses a listing at that count with exit 2. So read the schedule's result within about 35 hours of the end of its window.
  - **`start_lag_s` of the chain.** When the chain has run, its `start_lag_s` settles whether a queued run's `created_at` is the time of the dispatch or of the dequeue. A run that the concurrency group holds takes its `created_at` at one of the two. The dispatch gives a lag of about 300 s, and the dequeue gives a few seconds. The verdict reads the gaps between ticks and does not depend on it.
- **Correction 2026-10-28T14:31Z:** the Approach read `run_started_at` as the time a run began. It sorted the runs by it, and `start_lag_s` was `run_started_at` minus `created_at`. The Approach and the result schema now read the tick from the jobs.
  - MEASURED 2026-10-28T10:27:06Z, `gh api 'repos/pkgforge-dev/mirror-archlinux/actions/workflows/sync.yml/runs?per_page=40'`: `run_started_at` equals `created_at` on all 40 runs, scheduled and dispatched. So it does not say when work began. The jobs of three of those runs started 2 to 3 s after `created_at`, read at 2026-10-28T10:27:32Z.
  - MEASURED 2026-10-28T10:28:10Z, `gh api repos/pkgforge-dev/mirror-archlinux/actions/runs/40326458163/attempts/1/jobs`: a job that a runner took has `runner_name` set. A skipped job has `runner_name` null and `started_at` equal to `created_at`.
  - So a run's tick is now the earliest `started_at` among the first-attempt jobs that a runner took. `start_lag_s` is that tick minus `created_at`.
- **Correction 2026-10-28T14:31Z:** the Approach now describes the built shape where it differed. Each item below names one difference.
  - **The listing.** `clock-gaps.mjs` reads JSON pages and refuses a listing at the 1,000 run cap. The planned `--paginate --jq @tsv` stream would have hidden a lost run.
  - **The closing gap.** The window carries a closing gap. Without it, the first 48 hours and only the gaps inside them would pass a clock that stopped at hour 24. The test "a clock that stops inside the window fails on its closing gap" plants that case.
  - **The result.** The quantile rule is `floor(n * q)`. The result carries the extra fields listed in the schema, and a `.runs.json` beside it.
  - **The slots.** The schema read that `hit` counts the slots of the window that hold at least one run. `hit` now counts the expected slots that hold a run, started or not. The expected slots start at the slot of the first tick's run. `slots` is now `null` for the chain.
  - **The keepalive.** The keepalive counts every run that is not `completed` as alive. The planned sum of `in_progress` and `queued` misses a successor that the concurrency group holds as `pending` or `waiting`. Under `queue: max` that miss would start a second chain, which runs beside the first until `CHAIN_END`. This is a reading of GitHub's run statuses, not a measurement. `clock-chain.test.mjs` holds the rule.
  - **Setting `CHAIN_END`.** The Start line read: set `CHAIN_END` after 48 hours. An empty `CHAIN_END` never ends the chain, which then holds one of the organisation's 20 job slots. So the Start line now sets `CHAIN_END` at the first dispatch.
  - **The disables.** The Start line read: wait one cycle after `CHAIN_END`, then disable the schedule and the keepalive. It now disables them when both result files are written. The schedule's window starts at its own first tick, not at the chain's dispatch. A schedule disabled before its window ends would fail on the closing gap.
  - **The Prove.** The Prove read `--name "clock gaps"`. That filter also selects DOM-002's `worker clock gaps` tests: 31 tests ran at 2026-10-28T14:28Z. The Prove now reads `--name "^clock gaps"`, which selects this entry's 21, and adds `--name "^clock chain"`.

## DOM-002 — Measure the Cloudflare cron clock with a probe Worker that writes a hot tier to R2

- **Status:** partial
- **Waiting:** until 2026-10-30T15:30:00Z; run `node scripts/measure/worker-clock-gaps.mjs --url "$PROBE_URL/gaps" --hours 48 --out docs/research/measure/DOM-002/worker.json` over the 48 hours from the first tick at 2026-10-28T15:23:24Z, record the verdict, set `crons = []`, deploy, and close
- **Priority:** P1
- **Effort:** S
- **Source:** the operator, ruling 8 of 2026-10-27: the clock is measured, and the alternative to Actions is "a Cloudflare cron Worker writing a 72 h hot tier to R2". Design B section 0 item 4 and section 5.1. Architecture sections 4.9 and 5.2. The probe Worker is DOM-061.
- **Problem:** if Actions is too late (DOM-001), the design needs a second clock. Nothing is known about Cloudflare cron reliability for this account, or about writing a hot tier to R2 from a cron. The deployed probe (DOM-061) records the ticks. This entry reads 48 hours of them and turns them into the numbers of the decision rule.
- **Premise:**
  - READ in Cloudflare's documentation (design B, R3, fetched 2026-10-27T05:38Z from `https://developers.cloudflare.com/workers/platform/limits/`, `.../workers/platform/pricing/`, `.../workers/configuration/cron-triggers/` and `.../r2/pricing/`): a cron invocation gets 15 min of wall time. CPU defaults to 30 s for a cron under an hour and to 15 min for a cron of an hour or longer. A Worker gets 10,000 subrequests by default, 6 simultaneous connections waiting for headers and 128 MB of memory. An account has at most 250 crons. Workers Paid costs $5 a month with 10 million requests and 30 million CPU-ms included. R2 gives 10 GB, 1 million class A and 10 million class B operations a month free, and free egress.
  - Not measured: cron lateness and drops for this account, R2 put latency from a cron, and the number of class A operations a 72 h hot tier costs.
  - DOM-061 deploys the probe with its two cron triggers, so the 48 hours start at the first tick of that deploy. DOM-005, DOM-007 and DOM-008 depend on DOM-061 and not on this entry: the 48 hours block DOM-003 and what waits for the clock verdict, and nothing else.
- **Approach:**
  - **`scripts/measure/worker-clock-gaps.mjs`** calls the probe's `/gaps` route (DOM-061) and writes `docs/research/measure/DOM-002/worker.json`. The schema is the schema of DOM-001 with `clock: "worker"`, plus `put_ms:{median,p90,max}`, `class_a_ops` (ticks plus hot puts plus heartbeats) and `class_b_ops`. `expected` is 2,880 ticks of the minute cron and 576 of the 5 minute cron in 48 hours. The verdict uses the minute cron and the same rule as DOM-001 (p90 gap at most 15 min, max gap at most 60 min), and the 5 minute cron's numbers are recorded beside it. The `slots` member of DOM-001's schema is computed the same way from `scheduledTime`, which a Worker cron does carry.
  - **Run for 48 hours** from the first tick, then stop the crons: deploy with `crons = []` so the probe stops spending operations (the Operator line). The Worker stays for DOM-005, DOM-007 and DOM-008, and is deleted when they close (DOM-061, "Deletion").
- **Decision:** the verdict comes from the minute cron, the finer of the two samples, with the 5 minute cron beside it, so the Worker is held to the same rule as the Actions clocks at the cadence the real hot tier would run (architecture section 4.9). Splitting the deploy out (DOM-061) keeps the wall-time wait off the entries that only need a Worker to exist.
- **Depends on:** DOM-061
- **Prove:** `node scripts/measure/worker-clock-gaps.mjs --url "$PROBE_URL/gaps" --hours 48 --out docs/research/measure/DOM-002/worker.json` exits 0 when 48 hours of ticks exist, prints one `verdict=` line, and writes the file. PROBE_URL is the probe's workers.dev URL that DOM-061 recorded.
  - `curl -sS "$PROBE_URL/gaps?hours=48" | jq '.gaps_min, .put_ms, .class_a_ops'` prints the numbers.
  - `node scripts/test.mjs scripts/measure --name "worker clock gaps"` passes on a recorded tick list with known gaps.
- **Operator:** 48 hours after DOM-061's deploy, set `crons = []` in `probes/worker/wrangler.toml` (the agent makes the edit) and run `cd probes/worker && npx wrangler@4.150.0 deploy`. Run `npx wrangler@4.150.0 whoami` first and read that it names the account of DOM-061's Closed line.
- **Found 2026-10-28T14:30Z (DOM-061):** `scripts/measure/worker-clock-gaps.mjs` always asks `/gaps` with `ticks=1` (line 67). So the 48 hour reading makes the probe parse 3,458 tick records from R2 listings when no tick is missing. That is 2,880 of the minute cron, 576 of the 5 minute cron, and the first tick of each cron past the window. The probe returns every one of them in its answer.
  - **The limits of Workers Free.** The premise quotes the limits of Workers Paid. READ 2026-10-28T14:45Z, `https://developers.cloudflare.com/workers/platform/limits/`: on Workers Free an HTTP request gets 10 ms of CPU, and so does a cron trigger. An invocation gets 50 subrequests, and 1,000 subrequests to Cloudflare services such as R2. A Worker that goes above its CPU limit fails with error 1102. The 48 hour answer can use more than 10 ms of CPU, and nobody has measured it.
  - **The account's plan.** `npx wrangler whoami` prints no plan. The copied report `docs/research/web-pkgforge-2026-10-27/2026-10-27-domain-and-ip.md`, section 2, names account `2a97c8f2…` "on the Free plan with Workers Paid" on 2026-10-27. DOM-061's Operator line names the deploy account: the `account_id` of mirror-archlinux `worker/wrangler.toml` at commit 669ac725f8081445c164113f2ed092533de112e2. READ 2026-10-28T14:50Z with `gh api`: that `account_id` starts with the same 8 characters. The report cuts the id, so the tie is a match of the first 8 characters only.
  - **What to do.** Read the account's Workers plan before this entry's reading, and record it here. If the 48 hour read fails on a limit, record the answer and keep this entry open on it. The answer names its R2 list calls in `list_calls`.
  - **The arithmetic.** The arithmetic of the reader is `probes/worker/src/gaps.ts`, which the script imports. Its `RULE`, `BREAK_MIN` and `quantile()` are copies of those of `scripts/measure/clock-gaps.mjs`. The test "the probe and clock-gaps.mjs share the rule, the break threshold and the quantile" in `scripts/measure/worker-clock-gaps.test.mjs` (line 213) holds them equal. The quantile is the value at index `floor(n * q)` of the ascending list. So the median of an even count is the upper middle value.
  - **The cache.** The probe puts a `/gaps` answer in the Cache API for 60 s. A second read within 60 s may return the same answer, if workers.dev keeps the entry. Nobody has measured whether it does. Two reads within 60 s measure it: the same `now` in both answers means that the second came from the cache. `list_calls` does not tell the two apart, because a cached answer carries the count of the read that made it.

## DOM-061 — Deploy the probe Worker and its R2 bucket

- **Status:** done
- **Priority:** P1
- **Effort:** M
- **Source:** split out of DOM-002 by the review of this record (2026-10-27): DOM-005, DOM-007 and DOM-008 need a Worker deployed on Cloudflare, and none of them needs 48 hours of ticks. Ruling 8 of `TODO/RULES.md` section 5. Architecture sections 4.9 and 12.
- **Problem:** four measurements run on one probe Worker: the cron clock (DOM-002), Kafka over a socket (DOM-005), Range reads from GHCR (DOM-007) and the decode CPU (DOM-008). None starts before the Worker exists. While the Worker was a part of DOM-002, those measurements and everything behind them waited for 48 hours of ticks. A deploy takes minutes, and it needs the operator's login, so it is an entry of its own.
- **Premise:**
  - READ in mirror-archlinux `worker/wrangler.toml` at commit 669ac725f8081445c164113f2ed092533de112e2: a Worker on a custom domain of the `pkgforge.dev` zone is deployed from the operator's own wrangler login, and the file names the account in `account_id`. A custom domain needs the zone in the same account. The probe does not need a custom domain.
  - On the operator's machine `npx wrangler whoami` lists the accounts. An agent may run it: it prints account names and reads no secret. It must show the account that holds the `pkgforge.dev` zone (Operator action 1 of `TODO/PROGRESS.md`). Every entry that deploys runs it first and records the account name it printed.
  - R2 must be enabled on that account (dashboard, R2 Object Storage, Overview). `npx wrangler@4.150.0 r2 bucket list` answers once it is.
  - Cloudflare's cron, CPU and R2 limits are in the premise of DOM-002.
- **Approach:**
  - **Probe Worker** `domains-probe`, source `probes/worker/` (`wrangler.toml`, `package.json`, `src/index.ts`, `src/gaps.ts`, `src/types.ts`, and the tests `src/gaps.test.ts`, `src/index.test.ts` and `src/workerd.test.ts`). `workers_dev = true` and `preview_urls = false` (decision below), no route. `compatibility_date = "2026-10-13"` and `compatibility_flags = ["no_nodejs_compat", "no_nodejs_compat_v2"]`, the date and the flags of the test harness (`packages/testkit/src/workerd.ts`). The flags are also DOM-030's, whose CPU DOM-008 reads on this probe. `src/index.test.ts` holds both equal to the harness's. Pin `npx wrangler@4.150.0`, as mirror-archlinux does in `docs/worker.md` ("Deploy"). Bind the R2 bucket as `PROBE`.
  - **Two cron triggers** in `wrangler.toml`: `crons = ["* * * * *", "*/5 * * * *"]`. The `scheduled` handler looks up `controller.cron` in the `CRONS` table of `src/gaps.ts` and refuses a cron with no row. `src/index.test.ts` holds the table equal to the crons of `wrangler.toml`.
    - Every tick writes `ticks/<slug>/<scheduledTime ISO>.json`, with the slug `m1` for the minute cron and `m5` for the 5 minute cron. Its body is `{v, cron, scheduledTime, startedAt, lag_ms}`, with `put_ms` or `put_error` on a 5 minute tick. Its R2 custom metadata holds the same fields except `scheduledTime`, which the key holds. `startedAt` is `Date.now()` at the top of the handler, and `lag_ms = startedAt - scheduledTime`.
    - The `*/5` tick first writes the hot object `hot/<scheduledTime ISO>.bin`, 1 MiB of bytes from `crypto.getRandomValues` in 64 KiB calls. It records the `put` time in `put_ms`. This stands for one hot-tier pack. The real hot tier writes at most 10 packs an hour (architecture section 4.9). When the hot put fails, the tick is still written with `put_error`, and the invocation then fails so that Workers Logs shows it.
    - Both write a heartbeat `heartbeat.json` last.
  - **Route contract.** `GET /` prints the route list. `GET /gaps?hours=N` reads the ticks from listings of `ticks/` with custom metadata, reads no tick object, and answers the result schema of DOM-002. `hours` is 1 to 336, default 48, and `ticks=1` adds every tick the answer read. An unknown path answers 404, another method 405, and another query parameter 400. A `/gaps` answer is kept 60 s in the Cache API, keyed on the normalised query, with `cache-control: public, max-age=60`. An error is not kept. Whether workers.dev keeps the entry is not measured. DOM-005 adds `/kafka`, DOM-007 adds `/range`, DOM-008 adds `/decode`, each as one row of `ROUTES` in `src/index.ts` and a module beside it. Those entries extend this Worker and do not make a new one.
  - **Lifecycle rule.** Objects under `hot/` expire after 3 days, so the bucket holds at most about 1.2 GB while both crons run (the Correction below has the arithmetic). Create it with `npx wrangler@4.150.0 r2 bucket lifecycle add domains-probe expire-hot hot/ --expire-days 3`, the positional form that `npx wrangler@4.150.0 r2 bucket lifecycle add --help` prints. Then `npx wrangler@4.150.0 r2 bucket lifecycle list domains-probe` reads the rule back. Ticks are under 200 B each and stay.
  - **Deletion.** The probe is temporary. It holds no data of value (random bytes and tick records), and its routes answer anyone who has the workers.dev URL. When DOM-002, DOM-005, DOM-007 and DOM-008 have all closed, DOM-056 deletes it: `npx wrangler@4.150.0 delete --name domains-probe`, then the bucket's objects, then `npx wrangler@4.150.0 r2 bucket delete domains-probe`. Both rows of `docs/resources.md` then move to Retired with the date.
- **Decision:** the probe uses `workers.dev`, for its life only. `SECURITY.md` keeps `workers_dev = false` for every Worker that serves callers, and says that a measurement Worker (this probe and the drill of DOM-053) runs on workers.dev, binds only a temporary bucket and is deleted when its entries close. The final hostname `domains.pkgforge.dev` is one level below the zone, so the zone's Universal certificate covers it. A probe host such as `probe.domains.pkgforge.dev` would be two levels and would need another certificate decision that a throwaway Worker does not deserve. The `workers.dev` URL is printed by `wrangler deploy`.
- **Depends on:** none
- **Prove:** `curl -sS "$PROBE_URL/"` prints the route list, and `curl -sS "$PROBE_URL/gaps?hours=1" | jq '.runs, .expected'` prints numbers a few minutes after the deploy. PROBE_URL is the workers.dev URL that `wrangler deploy` printed.
  - `node scripts/test.mjs probes/worker --name "gaps"` passes.
  - `npx wrangler@4.150.0 whoami` lists the account that holds the `pkgforge.dev` zone, and this entry's Closed line names it.
  - `grep -c 'domains-probe' docs/resources.md` prints at least 2: a row for the Worker and a row for the bucket, each with its undo.
- **Built 2026-10-28T14:30Z:** the tree holds `probes/worker/` with `wrangler.toml`, `package.json`, `src/index.ts`, `src/gaps.ts`, `src/types.ts` and the tests `src/gaps.test.ts`, `src/index.test.ts` and `src/workerd.test.ts`. It also holds DOM-002's reader `scripts/measure/worker-clock-gaps.mjs` with `scripts/measure/worker-clock-gaps.test.mjs`. `docs/resources.md` has a row for the Worker and a row for the bucket. Each row has its undo and the date `pending`.
  - **The arithmetic.** `src/gaps.ts` computes DOM-002's result with DOM-001's definitions. They are the closing gap, the quantile at index `floor(n * q)` of the ascending list, and the rule of 15 and 60 minutes. `scripts/measure/worker-clock-gaps.test.mjs` holds its `RULE`, `BREAK_MIN` and `quantile()` equal to those of `scripts/measure/clock-gaps.mjs`.
  - **Where it differs.** A Worker tick carries more than a run, so the arithmetic differs in three places. It reads the window and the slots on `scheduledTime`, and the gaps on `startedAt`. `start_lag_s` keeps 3 places. In a window that has not ended, a slot counts as missed only once its interval has passed.
  - **Tested** 2026-10-28T14:28Z on the operator's Windows 11 workstation with Node v26.7.0, and run again from 2026-10-28T14:47Z to 14:48Z with the same counts. `node scripts/test.mjs probes/worker --name "gaps"` exits 0 with 30 tests. `node scripts/test.mjs probes/worker` exits 0 with 44 tests over 3 files. Among them, `src/workerd.test.ts` runs the probe in workerd through Miniflare with an in-memory R2. `node scripts/test.mjs scripts/measure --name "worker clock gaps"` exits 0 with 10 tests.
  - **The dry run.** From `probes/worker`, `wrangler deploy --dry-run --outdir ../../.tmp/ops-probe-dry` exits 0 at 2026-10-28T14:23Z, with the wrangler 4.150.0 of `node_modules`. It prints `Total Upload: 21.38 KiB / gzip: 6.67 KiB` and the binding `env.PROBE (domains-probe)`, and deploys nothing. A run into another `--outdir` at 2026-10-28T14:48Z prints the same. At 2026-10-28T14:26Z, `wrangler r2 bucket lifecycle add --help` of the same wrangler prints `add <bucket> [name] [prefix]` with `--expire-days`. `grep -c 'domains-probe' docs/resources.md` prints 4.
  - **Not run.** The build created no bucket and deployed nothing. The listing of ticks with custom metadata has run only on a fake bucket and on Miniflare's in-memory R2. So the deployed `/gaps` read is its first run on R2.
  - **What waits.** The entry waits for `whoami`, the bucket and its lifecycle rule, the deploy, the two `curl` reads of the Prove, and the ledger dates. The first tick of the deploy starts DOM-002's 48 hours.
- **Correction 2026-10-28T14:30Z:** the Approach set `compatibility_date = "2026-10-27"`. The probe now deploys with 2026-10-13, the harness's date, so the deploy and its tests run one runtime.
  - MEASURED 2026-10-28T10:30Z and recorded in `packages/testkit/src/workerd.ts`: workerd 1.20261006.1 refuses 2026-10-27. It names 2026-10-13 as the newest date it runs. Wrangler 4.150.0 pins that workerd.
  - `wrangler deploy --dry-run` accepts either date, so the dry run does not decide this. It accepts 2026-10-27 in the build's run at 2026-10-28T10:50Z, and 2026-10-13 at 2026-10-28T14:23Z.
  - The Approach also sets the flags `no_nodejs_compat` and `no_nodejs_compat_v2`, the harness's and DOM-030's.
- **Correction 2026-10-28T14:30Z:** the Approach read that the bucket never passes 0.9 GB. About 1.2 GB is the bound while both crons run, within R2's 10 GB of free storage that DOM-002's premise quotes. This is arithmetic from the code and the documentation, not a measurement.
  - The 5 minute cron writes 288 hot objects of 1 MiB a day, which is 288 MiB. Kept 3 days, that is 864 MiB or 0.906 GB, already above 0.9 GB.
  - READ 2026-10-28T10:51Z, `https://developers.cloudflare.com/r2/buckets/object-lifecycles/`: R2 removes an expired object typically within 24 hours of its expiry. So the bucket can hold 4 days of hot objects: 1,152 MiB or 1.21 GB.
  - The ticks add 1,728 records a day of under 200 B each, under 0.35 MB a day.
  - DOM-002 stops the crons after 48 hours, when the hot objects total 576 MiB or 0.60 GB.
- **Correction 2026-10-28T14:30Z:** the Problem and the Operator line read that the operator runs the deploy. Ruling 14 of `TODO/RULES.md` section 5 is the operator's, of 2026-10-28. Under it, the agent runs the Operator line itself with the operator's local wrangler login. It runs `whoami` first, then creates the bucket and its lifecycle rule, and then deploys. It records the account name that `whoami` printed. If `npx wrangler@4.150.0 r2 bucket list` refuses because R2 is not enabled on the account, enabling R2 in the dashboard stays the operator's step.
- **Correction 2026-10-28T14:30Z:** the Approach now describes the built shape where it differed. Each item below names one difference.
  - **The cache.** `/gaps` answers anyone, and each call makes R2 list calls, each a class A operation. By the arithmetic of `src/index.ts`, a call at the largest `hours`, 336, makes at least 28 list calls once 336 hours of ticks exist. So the probe puts an answer in the Cache API for 60 s. Cost is meant to be bounded by caching, never by refusing a caller (AGENTS.md absolute 8). Whether workers.dev keeps the entry, and so honours that bound, is not measured.
  - **The custom metadata.** A tick carries its fields as R2 custom metadata, except `scheduledTime`, which its key holds. So `/gaps` reads listings and no tick object.
  - **The hot put.** The Approach read that the `*/5` tick also writes the hot object. The tick now writes the hot object first. When the hot put fails, the tick is still written, with `put_error`. The invocation then fails, so that Workers Logs shows it.
  - **The cron table.** The Approach read that the `scheduled(event, env, ctx)` handler branches on `event.cron`. The handler now looks up `controller.cron` in the `CRONS` table of `src/gaps.ts`. It refuses a cron that has no row, and writes nothing for it.
  - **The lifecycle command.** The lifecycle command is the positional form that the help of wrangler 4.150.0 prints.
- **Operator:** run `npx wrangler login` if needed, then `npx wrangler whoami`. It must show the account that holds the `pkgforge.dev` zone. That account id is the `account_id` line of `worker/wrangler.toml` in mirror-archlinux at commit 669ac725f8081445c164113f2ed092533de112e2. Enable R2 on the account. Then run `cd probes/worker && npx wrangler@4.150.0 r2 bucket create domains-probe && npx wrangler@4.150.0 deploy`, and the lifecycle command above.
- **Resources:** Worker `domains-probe`. Undo: `npx wrangler@4.150.0 delete --name domains-probe`. R2 bucket `domains-probe`. Undo: expire or delete every object (the lifecycle rule above with `--expire-days 1` and a wait, or `npx wrangler@4.150.0 r2 object delete domains-probe/<key>`), then `npx wrangler@4.150.0 r2 bucket delete domains-probe`. Add both rows to `docs/resources.md` in the same change.
- **Closed 2026-10-28T15:26Z (proven):** the probe runs on the account that holds the `pkgforge.dev` zone, and both crons write to its bucket.
  - `npx wrangler@4.150.0 whoami` at 2026-10-28T15:12:57Z names the account `Ajamx101@gmail.com's Account`, with `account (read)` among the token's scopes. The agent ran every step under ruling 14.
  - The bucket: `npx wrangler@4.150.0 r2 bucket create domains-probe` exits 0. `r2 bucket lifecycle add domains-probe expire-hot hot/ --expire-days 3 --force` exits 0, and `r2 bucket lifecycle list domains-probe` reads back `name: expire-hot`, `prefix: hot/`, `action: Expire objects after 3 days`, beside the account's default rule that aborts unfinished multipart uploads after 7 days. Done by 2026-10-28T15:13:35Z.
  - The deploy: `cd probes/worker && npx wrangler@4.150.0 deploy` exits 0 at 2026-10-28T15:13:54Z. It uploads 21.38 KiB (6.67 KiB gzip), binds `env.PROBE (domains-probe)`, and prints the workers.dev URL and `schedule: * * * * *` and `schedule: */5 * * * *`. `PROBE_URL` is that URL. Its subdomain is the account's own and is not written into this public tree (`docs/security/secrets.md`); the deploy prints it again.
  - The crons took about 9.5 minutes to start. `/gaps?hours=1` answered `runs: 0` until 15:20:24Z, a `wrangler tail` of 150 s from about 15:20:40Z saw no event, and the first tick of the minute cron started at 2026-10-28T15:23:24.560Z. Cloudflare documents that a new cron trigger can take up to 15 minutes to propagate. DOM-002's window starts at that first tick.
  - `curl -sS "$PROBE_URL/"` at 15:24:38Z: status 200, routes `GET /, GET /gaps`. `curl -sS "$PROBE_URL/gaps?hours=1"` at 15:24:39Z: status 200, `.runs` 2, `.expected` 60, verdict `INCOMPLETE`, start lag 1.295 s. At 15:25:41Z: `runs` 3, the 5-minute cron 1 run, `hot_puts` 1, `put_errors` 0, `put_ms` 587. The answer carries `cache-control: public, max-age=60`.
  - `node scripts/test.mjs probes/worker --name "gaps"` exits 0 with 30 tests at 15:24:38Z. `grep -c 'domains-probe' docs/resources.md` prints 4, and the Worker and bucket rows carry their created times and undo commands.
  - Gate part (b) is the reads above against the deployed Worker; part (c) is the wave's three lenses, which ran on `probes/worker` before the commit.

## DOM-003 — Decide the clock from the measurements

- **Status:** open
- **Priority:** P1
- **Effort:** S
- **Source:** ruling 8 of 2026-10-27; architecture section 5.2 ("The decision rule").
- **Problem:** the ingest workflows (DOM-024) and the hot tier (DOM-025) both depend on one fact: which clock runs the live ingest. The two measurements give numbers. Nothing turns the numbers into a recorded verdict, so a later agent could choose by taste.
- **Premise:**
  - The rule is in architecture section 5.2. Read the first of clock A (`schedule`), then clock B (the self-dispatch chain), whose 48 hour p90 gap is at most 15 minutes and whose max gap is at most 60 minutes. If A and B both fail, the verdict is clock C, the Cloudflare cron Worker (DOM-025).
  - The thresholds come from the freshness target, and they are the author's proposal. Ruling 8 asks that the clock be measured and records no threshold, and the operator has not set one. A 1 h window is useful only when the newest data is at most 30 minutes old at p90. A gap of 15 minutes, a run of 3 minutes and a publish of 2 minutes give 20 minutes. A max gap of 60 minutes keeps a 1 h window from ever being empty. The operator may change either number: every result file records the rule it was judged by (`rule`), and `scripts/measure/clock-verdict.mjs` and `config/clock.json` hold the two numbers once, so a change is one edit and a re-run of `--check`.
  - A is cheaper than B, because a chain holds one of the organisation's 20 job slots for ever. So A is tried first.
  - Inputs: `docs/research/measure/DOM-001/schedule.json`, `docs/research/measure/DOM-001/chain.json` and `docs/research/measure/DOM-002/worker.json`.
- **Approach:**
  - **`scripts/measure/clock-verdict.mjs`** reads the three result files and derives the verdict with the rule above. Flags: `--check` compares the derived verdict with `config/clock.json` and exits 1 on a difference. Without `--check` it prints the derived verdict.
  - **`config/clock.json`**: `{"clock":"actions-schedule"|"actions-chain"|"worker","decided":"<UTC time>","evidence":["DOM-001","DOM-002"],"p90_gap_min":N,"max_gap_min":N,"rule":{"p90_max_min":15,"max_max_min":60}}`. DOM-024 reads it to wire `ingest-live.yml`. DOM-025 reads it to unblock.
  - **`docs/clock.md`**: the three clocks, the rule, the measured numbers of all three files with their dates, the cost of the chain (one organisation slot, 48 hours of runner time in the probe), and the restart design: a chain that breaks is restarted by `dispatch-overdue` (DOM-034). Add the sentence that no Worker dispatches a workflow, because no credential crosses between GitHub and Cloudflare (ruling 6).
  - **If the verdict is `actions-schedule` or `actions-chain`:** close DOM-025 as `done` on ruling 8, with the numbers recorded in that entry. **If it is `worker`:** build DOM-025. **If none of the three passes:** the verdict is `none`. Leave this entry open. Add a question to `TODO/PROGRESS.md` "Open questions" with the three sets of numbers and a recommendation. Do not invent a fourth clock.
  - **If clock C wins but DOM-005 failed,** the Kafka lane stays on an Actions chain with its own longer lag. Record that in `docs/clock.md`.
- **Decision:** the verdict comes from a script, not from a reading, so a changed measurement changes the verdict with no edit of prose. The alternative, a prose verdict, can drift from the numbers it cites.
- **Depends on:** DOM-001, DOM-002
- **Prove:** `node scripts/measure/clock-verdict.mjs --check` exits 0, and `node scripts/test.mjs scripts/measure --name "clock verdict"` passes.
  - The test builds three result fixtures that pass, fail and mix, and asserts the verdict for each: A passes gives `actions-schedule`; A fails and B passes gives `actions-chain`; A and B fail and C passes gives `worker`; all fail gives `none`.
  - `jq .clock config/clock.json` prints the verdict.

## DOM-025 — The Worker hot tier, only if the clock verdict is a Worker

- **Status:** open
- **Priority:** P2
- **Effort:** L
- **Source:** design B section 5.1 and section 6.5; ruling 8 of 2026-10-27; architecture sections 4.9 and 5.2.
- **Problem:** when Actions is too late to keep a 1 h window fresh, a Cloudflare cron Worker must carry the freshness. It writes a 72 h hot tier to R2. A design built only on Actions would not need it.
- **Condition:** DOM-003's verdict must be `worker` in `config/clock.json`. Start only when `node scripts/measure/clock-verdict.mjs` prints `clock: worker`. If the verdict is `actions-schedule` or `actions-chain`, close this entry as `done` on ruling 8 with the numbers of DOM-003 recorded here. No code is written then.
- **Premise:**
  - READ design B section 5.1: the cron Worker carries Kafka, ISC and names tiles every 1 to 10 minutes. It writes 5 to 10 minute journals and hourly packs to R2 under `hot/`. It writes a heartbeat object.
  - READ design B section 6.5: hot tier budget `hot/feed/` 0.1 GB and `hot/ct/` 0.7 GB. Architecture section 4.9 sets `hot/` to 0.8 GB in total, 4.5 GB planned for the bucket and a hard write stop at 4.3 GB.
  - The hot tier carries only what needs no ledger. That is OpenINTEL claims, ISC rows, and CT names with their log times. Newness verdicts stay `provisional` until the daily job makes them exact (architecture section 5.8).
  - Kafka over a Worker `connect()` needs DOM-005 to pass. If it failed, the Kafka lane stays on Actions.
  - The Worker cannot dispatch an Actions workflow. That needs a token, and no credential crosses between GitHub and Cloudflare (ruling 6). So the Actions backup path runs on its own cron backstop (architecture section 5.3) and the watchdog reads the Worker's heartbeat through the API.
  - The R2 bucket `domains-pkgforge-cache` comes from DOM-031. If it does not exist when this entry starts, do DOM-031 first.
- **Approach:**
  - **Worker** `domains-pkgforge-clock`, source `apps/clock/`, cron from `config/clock.json` measurements (1 or 5 minutes, whichever DOM-002 passed). No route, `workers_dev = false`. Bindings: R2 `CACHE` for `domains-pkgforge-cache`. Same `wrangler.toml` shape as DOM-030 without `routes`.
  - **Adapters in the Worker.** The adapter modules of `adapters/` that need only `fetch` or `cloudflare:sockets` run here: `isc-new`, `oi-nrd` (Kafka, only if DOM-005 passed), `ct-tiles` (with the contact User-Agent of DOM-011). Reuse the same modules, with `packages/pack` writing DPK1 segments into memory. Do not fork the adapter code.
  - **Hot objects.** `hot/seg/<source>/<window start>.pack` and `.idx`, and `hot/manifest.json` (list of hot segments with spans and sources, `as_of`). Keep 72 hours by key. A lifecycle rule expires `hot/` after 7 days as a backstop. The Worker never writes `blk/` (the API Worker does).
  - **Heartbeat.** `hot/heartbeat.json` with `{beat, cron, last_ok:{source: time}}`. The API (DOM-030) exposes its age as `hot.age_s` in `/v1/status` (DOM-033). The watchdog (DOM-034) raises `stale-hot-tier` when it is older than 30 minutes.
  - **API seam.** When `hot/manifest.json` exists, `/v1/new` (DOM-032) merges hot rows newer than the root's `as_of` and marks them `provisional: true`. When it is absent, the API ignores the hot tier. The API never reads `config/clock.json`.
  - **Backup path.** The Actions chain or cron of `ingest-live.yml` (DOM-024) keeps running at its backstop cron `7,22,37,52 * * * *`. It writes the durable segments. The Worker's hot rows and Actions' segments are the same observations, so the merge by minimum and maximum drops the duplicates.
  - **Budget guard.** Stop writing `hot/` when the size counter passes 0.8 GB for that prefix.
- **Decision:** one cron Worker for the hot tier, separate from the API Worker. The hot tier is the only place a row lives for up to 72 hours before Actions writes it to GHCR, and it carries `connect()` sockets and adapter code. The API Worker keeps only the cache warmer and the size recount of DOM-031, which copy data that GHCR already holds. A separate Worker has its own deploy, its own heartbeat and its own failure, so a broken clock never takes the read path down.
- **Depends on:** DOM-003, DOM-017, DOM-024
- **Prove:** `node scripts/test.mjs apps/clock --name "hot tier"` passes, and `curl -sS https://domains.pkgforge.dev/v1/status | jq '.hot'` prints `age_s` under 600.
  - `node scripts/measure/worker-clock-gaps.mjs --url "$CLOCK_URL/gaps" --hours 48 --out docs/research/measure/DOM-025/worker.json` shows p90 gap at most 15 min (the clock Worker exposes the same `/gaps` route through a token-free read of its ticks; add it).
  - If the verdict is not `worker`: `node scripts/measure/clock-verdict.mjs --check` prints the Actions clock and this entry closes on the ruling.
- **Operator:** run `npx wrangler@4.150.0 whoami` first and record the account name it prints in this entry's Closed line. Then deploy by hand: `cd apps/clock && npx wrangler@4.150.0 deploy`.
- **Resources:** Worker `domains-pkgforge-clock`. Undo: `npx wrangler@4.150.0 delete --name domains-pkgforge-clock`. The Worker uses the bucket of DOM-031. Add the row to `docs/resources.md`.

## DOM-034 — Watchdogs: keepalive, overdue dispatch and issues

- **Status:** open
- **Priority:** P1
- **Effort:** M
- **Source:** mirror-archlinux (commit 669ac725f8081445c164113f2ed092533de112e2), `docs/operations.md` sections "Each scheduled workflow starts the others", "Staleness" and "Issues the automation raises and clears". Design A section 5.1 and design B section 8. Architecture sections 5.3, 5.9 and 8.
- **Problem:** GitHub delays and drops scheduled runs, disables schedules after 60 days with no activity, and a dropped run leaves nothing behind that could notice. A source that goes quiet shows only as old data. A person must hear about both.
- **Premise:**
  - READ mirror `docs/operations.md`: "GitHub can delay or drop a scheduled run. A dropped run leaves nothing behind that could notice. So each scheduled workflow runs `scripts/dispatch-overdue WORKFLOW MAX_MINUTES` for the others." A run that is queued or in progress counts as fresh. A workflow with no run at all is started. It starts a workflow only when its state is `active`. Runs start on `main` only.
  - READ mirror `scripts/keep-schedules-enabled`: it lists the workflows with `gh api --paginate repos/$slug/actions/workflows`, and for each file that exists in the tree it calls `PUT .../actions/workflows/$id/enable` when the state is `active` or `disabled_inactivity`. A workflow with state `disabled_manually` stays disabled and is named in a warning.
  - READ mirror `scripts/check-schedules-fired`: it discovers every scheduled workflow from `.github/workflows/`, derives each tolerance from the workflow's own cron through `scripts/cron-tolerance` (largest gap in days times 2 plus 1), and exits 3 when a schedule has not fired within its tolerance. It exits 0 when every one has fired, and 1 when it could not run. A workflow that has existed for less than its tolerance and has no scheduled run is not a failure. The tolerance has day resolution, so a sub-daily cron gets the tolerance of a daily one.
  - READ mirror `scripts/watch-schedules`: it runs the two scripts above to the end and raises or clears the issue `schedules-stopped` through `scripts/track-issue`. Exit 3 keeps the run red after the issue is raised.
  - READ mirror `scripts/track-issue`: `raise <key> <title> <body-file>` opens the issue once and only rewrites its body after that. `clear <key> <note>` comments and closes. The key is an HTML comment in the body. The script finds the issue by listing open issues, never by search, because the search index lags. Label `automation`. It needs `issues: write`.
  - READ mirror `status.yml`: cron `47 * * * *`, jobs `kick`, `decide`, `build`, `deploy`, `worker`. `kick` runs `dispatch-overdue sync.yml 240` and `dispatch-overdue watchdog.yml 1560`. `worker` runs with `!cancelled()` on `main`, so a failed `build` raises `status-down`. READ mirror `watchdog.yml`: cron `41 7 * * *`, jobs `staleness` and `schedules`. `schedules` runs `scripts/watch-schedules`, then `dispatch-overdue sync.yml 240` and `dispatch-overdue status.yml 120` with `if: always() && github.ref == 'refs/heads/main'`.
  - READ mirror `docs/operations.md`: `worker-down` opens only when the probe fails in 2 status runs in a row and the first failure is 3000 s (50 minutes) or more before the second. A fault of a few minutes opens no issue.
  - No Cloudflare credential exists in GitHub, and none in Cloudflare (ruling 6). So only Actions workflows dispatch workflows.
- **Approach:**
  - **Copy these files** from mirror-archlinux, raw URL `https://raw.githubusercontent.com/pkgforge-dev/mirror-archlinux/669ac725f8081445c164113f2ed092533de112e2/<path>`: `scripts/dispatch-overdue`, `scripts/keep-schedules-enabled`, `scripts/watch-schedules`, `scripts/check-schedules-fired`, `scripts/cron-tolerance`, `scripts/track-issue`. They are small bash scripts. Read `docs/conventions/shell.md` first. The mirror's `scripts/watch-schedules` sources `scripts/lib.sh` for `die`, `warn` and `REPO_ROOT`. Do not copy the 78 KB `lib.sh`. Write a 20 line `scripts/lib/watch.sh` with those three. Remove the special case for `sync.yml` in `dispatch-overdue`: here every workflow counts all its runs, except that for `ingest-live.yml` a run counts only when its event is the chain, a schedule or a dispatch.
  - **`watchdog.yml`**, cron `41 7 * * *` with `workflow_dispatch:` beside it, concurrency group `watchdog`. Jobs: `staleness` (`contents: read`, `issues: write`) runs `scripts/check-staleness` and raises or clears `stale-<source>`; `schedules` (`actions: write`, `contents: read`, `issues: write`) runs `scripts/watch-schedules`, then `dispatch-overdue ingest-live.yml 45`, `dispatch-overdue status.yml 120` and `dispatch-overdue compact-daily.yml 1560`. Both names are in DOM-014's table.
  - **`status.yml`**, cron `47 * * * *` with `workflow_dispatch:` beside it, concurrency group `status`. Jobs: `kick` (`actions: write`, `contents: read`) runs `dispatch-overdue ingest-live.yml 45`, `dispatch-overdue ingest-thc.yml 1560` and `dispatch-overdue watchdog.yml 1560`; `status` (`contents: read`, `issues: write`, `!cancelled()` on `main`) runs `scripts/status-collect.mjs` and `scripts/check-status.mjs`. **There is no status branch and no status file.** A branch push needs `contents: write`, which DOM-014 forbids in every job, and the status of the data needs no copy: the Worker computes it from the root (`/healthz` and `/v1/status`, DOM-033, which read `root:latest` and the clock), the run's step summary keeps the hour's reading, and `gh run list --workflow status.yml` is the history. These ages are design values [E]: the chain interval is 10 minutes, so 45 minutes is four misses. Replace them with numbers from DOM-001 to DOM-003 when those close.
  - **`scripts/status-collect.mjs`** reads, with no credential: `root:latest` (as_of, root_seq, per-source `through`), `GET https://domains.pkgforge.dev/healthz` and `/v1/status` (it fails open until DOM-030 exists), and each source's upstream (HEAD of the THC listing and file, Kafka reachability and offsets, ISC ETag, WhoisDS date file). It prints one JSON object `{as_of, root_age_s, worker:{ok,version}, sources:[{id,status,through,upstream_age_s}]}` to the step summary and to a file under `RUNNER_TEMP` that `scripts/check-status.mjs` reads. Nothing is published.
  - **`scripts/check-staleness.mjs`** applies the thresholds of architecture section 8 and the measurements of DOM-004, DOM-009 and DOM-012: `thc-ct` is `late` when no file exists by 06:00 UTC and `down` after 36 hours; `oi-*` and `oi-cs` are `late` with no new offset for 30 minutes; `isc-new` and `whoisds` are `late` after 6 hours; `ct-*` per log by cursor age. It writes `<source>.state` and `<source>.md` files for the raise or clear step.
  - **Issues**, one per problem, raised by `scripts/track-issue`: `schedules-stopped`; `stale-<source>`; `anomaly-<source>` (raised by the verifier, DOM-018); `status-down` (the Worker's `/v1/status` cannot be read, or reports `root_age_s` above 10,800 s (3 hours) in the status run, or above 21,600 s (6 hours) in the watchdog run); `worker-down` (2 failed probes in a row, the first 3000 s or more before the second); `visibility-<package>` (the anonymous-read check of DOM-019); `stale-hot-tier` (DOM-025 only).
  - **Tests** are `node:test` files under `scripts/watch/` that run the bash scripts against a stub `gh` placed first on `PATH`, as mirror `tests/unit/45-dispatch-overdue.sh` does. Cover: a fresh workflow starts nothing; a workflow with no run is started; a disabled workflow is not started and exits 0; a workflow with a queued run is fresh; a manual disable raises the issue and keeps the step green.
- **Decision:** the watchers live in Actions, not in a Worker. A Worker would need a token to dispatch a workflow, and ruling 6 forbids a credential between the two. The Worker still shows the age of the root in `/healthz` and `/v1/status`, so a person or an outside monitor can see a stopped Actions chain.
- **Depends on:** DOM-023, DOM-024
- **Prove:** `node scripts/test.mjs scripts/watch --name "dispatch-overdue"` passes, and `node scripts/test.mjs scripts/watch --name "track-issue"` passes.
  - `gh workflow run watchdog.yml --ref main` then `gh run list --workflow watchdog.yml --limit 1 --json conclusion --jq '.[0].conclusion'` prints `success`.
  - Planted fault: `gh workflow disable ingest-live.yml`, `gh workflow run watchdog.yml --ref main`, then `gh issue list --state open --label automation --json title --jq '.[].title'` lists a `schedules-stopped` issue. Run `gh workflow enable ingest-live.yml` and the next watchdog run closes the issue.
- **Found 2026-10-28T14:30Z (DOM-006):** `.github/workflows/measure-push.yml` holds no `issues: write`. Its job `measure-push` has `contents: read` and `packages: write` (lines 78 to 80), and a failed anonymous read of the probe package fails the job through `push-summary.mjs --require anonymous-read`. The commit that adds `scripts/track-issue` grants `issues: write` to that job, adds the step that raises `visibility-<package>` after a failed anonymous read, and updates the job permissions in the row of `measure-push.yml` in `docs/resources.md`.

## DOM-035 — The coverage table and cross-source agreement

- **Status:** open
- **Priority:** P2
- **Effort:** M
- **Source:** design A section 9 and section 3.1 [M8, M9]; design B section 9 and M6; architecture sections 8 and 9.
- **Problem:** no source is complete, so a reader needs to know how much each source sees of the others. Today that knowledge is five numbers in two research files. The service must publish it daily, and a source that falls out of agreement must show.
- **Premise:**
  - MEASURED in design A, M8 and M9 (2026-10-27T05:32Z to 05:37Z; scripts `docs/research/2026-10-27-design-a/scripts/kafka-window.mjs`, `ct-window.mjs`, `f64cmp.mjs`, `miss.mjs`): in the window 2026-10-26T12:00 to 12:05Z, the Kafka feed held 239,171 distinct names, and 95,130 of them (39.8%) were in THC's 2026-10-26 dump. Of the 144,041 that were not, many were cloud or machine names (`aws.dev` 10,356, `dyingbirds.com` 4,638, `amazonaws.com` 4,570, `sfdc.net` 2,484) and many were ordinary names. 37,972 of 90,373 registrable domains of the window had any name in THC.
  - MEASURED in design A, M9: 68,994 of 70,624 Sycamore2027h1 names (97.7%) and 67,275 of 68,604 Willow2027h1 names (98.1%) were in THC's dump. Willow and Sycamore overlap 83.5% of Willow and 81.1% of Sycamore. 71.0% of Sycamore's names were in the Kafka window.
  - MEASURED in design B, M6 (scripts `docs/research/2026-10-27-design-b/scripts/agree1.mjs` and `agree2.mjs`; results `docs/research/2026-10-27-design-b/results/agree1.txt` and `agree2.txt`): of ISC's domains first seen 2026-10-26, 25.5% were in THC's 2026-10-26 dump and 54.8% in its 2026-10-25 dump. For 2026-10-25 the figures are 12.4% and 22.2%. WhoisDS's file dated D shares 79.8% (D = 10-26) and 66.2% (D = 10-25) with ISC's day D-1, and about 0% with ISC's day D.
  - The THC days 2026-10-04 and 2026-10-09 are missing from both THC hosts (design A M2).
  - Two sources of one family are not independent evidence (architecture section 2).
- **Approach:**
  - **Where it runs.** In `compact-daily.yml` (DOM-023), after the day pack exists. Seam: `packages/compact/src/coverage.ts` and `scripts/compact/coverage.mjs`.
  - **The measure.** For every ordered source pair (A, B) and every day D, count `|A_D|`, `|B_D|` and `|A_D and B_D|` by merge-join over the two sorted key streams of the day's packs. No hash set. Share = `both / a_count`. Do it at name level for sources that feed `names` and at registrable-domain level for sources that feed only `domains`.
  - **Short windows.** For a stream source against a day source, also compute rolling 5 minute windows of the stream against the day set, as design A did. Keep the 24 windows of one fixed hour each day to bound the cost.
  - **Output.** `coverage.json`: `{as_of, day, pairs:[{a, b, level, window, a_count, b_count, both, share_a_in_b, same_family}], gaps:{<source>:[<date>]}}`. A pair of one family has `same_family: true` and does not count toward `corroborated`. The file becomes a layer of the root manifest (DOM-020 builds the layer list) and a write-once artifact `dumps:coverage-<YYYYMMDD>` (a small JSON, kept for ever).
  - **Regression fixture.** Encode the five baselines above as the first test: the Kafka-in-THC pair gives 39.8% for the 5 minute window, and so on. The fixtures are synthetic sets built to the same intersection sizes, because the research dumps these baselines came from are not in the repository (`docs/research/README.md`). Once the raw lane exists (architecture section 3.4), a later test may replay a stored window.
  - **Gaps.** `gaps.thc-ct` lists 2026-10-04 and 2026-10-09 until a backfill fills them. `/v1/coverage` (DOM-033) serves the file.
- **Decision:** share of A in B, not Jaccard. A reader asks "of what A saw, how much did B see", and that answers "if B dies, what do we lose". Jaccard hides the direction.
- **Depends on:** DOM-023, DOM-026, DOM-029
- **Prove:** `node scripts/test.mjs packages/compact --name "coverage"` passes.
  - `curl -sS https://domains.pkgforge.dev/v1/coverage | jq '.data.pairs[0], .data.gaps'` prints a pair and the gap list.
  - `curl -sS -H 'Authorization: Bearer QQ==' -H 'Accept: application/vnd.oci.image.manifest.v1+json' https://ghcr.io/v2/pkgforge-dev/domains.pkgforge.dev/root/manifests/latest | jq -r '.layers[].annotations["org.opencontainers.image.title"]'` lists `coverage.json`.

## DOM-050 — RDAP sampling: check claimed_new rows against registries

- **Status:** open
- **Priority:** P2
- **Effort:** M
- **Source:** design B section 9 ("Validation sample") and M5; architecture section 9; `docs/research/web-pkgforge-2026-10-27/landscape.md` section 4.
- **Problem:** `claimed_new` rows say a source calls a domain new. Nothing checks the claim against a registry. A reader cannot tell which source's claims are reliable. RDAP is the only registry evidence this project can fetch for most gTLDs.
- **Premise:**
  - MEASURED in design B, M5 (2026-10-27T05:49:13Z to 05:50:40Z; script `docs/research/2026-10-27-design-b/scripts/rdapval.mjs`; summary `docs/research/2026-10-27-design-b/results/rdapval_summary.txt`; raw `rdapval.json`): of 25 `.com` and `.net` OpenINTEL events with a fresh certificate, 25 were registered within 1 day (median 0.1 day) by Verisign RDAP. Of 25 with a certificate older than 30 days, 14 were not found and 11 were registered 35 to 5,157 days earlier. So none of the old-certificate events was a new registration.
  - MEASURED in `docs/research/web-pkgforge-2026-10-27/landscape.md` (2026-10-27): Verisign's RDAP, `https://rdap.verisign.com/com/v1/domain/<domain>`, answers in 0.36 s with 3,026 B and has `events` (registration, expiration, last changed). The IANA bootstrap file `https://data.iana.org/rdap/dns.json` (71,348 B, publication 2026-10-22) lists 1,204 TLDs with an RDAP service. 233 of the 1,437 root-zone TLDs have none, including 175 of 248 two-letter ccTLDs (`.de .jp .cn .ru .it .es .ch .se .dk .be .at .io .co .me .us` among them). `rdap.org` answers 302 to the registry and 404 for `.de`, `.io` and `.co.jp`. `.np` has no RDAP.
  - READ in design B section 9: Google Registry answered 429 in earlier research. Rate-limit per host.
  - The sample must not touch the query path. It runs in Actions only.
- **Approach:**
  - **Workflow** `quality-rdap.yml`, cron `20 3 * * *` with `workflow_dispatch:` beside it (after `compact-daily.yml`, `35 1 * * *`), `permissions: {}` at the top. Job `quality` (`contents: read`, `packages: write`, `issues: write`; it raises `anomaly-<source>` and `visibility-<package>`) draws the sample and pushes the report and the `rdap` segment. Job `promote` calls `root-promote.yml` (DOM-020), which holds the group `root-writer`; the calling job holds `packages: write` and `contents: read`.
  - **Sampler** `scripts/quality/rdap-sample.mjs`. It reads yesterday's rows through the public API, as a consumer does: `curl -sS 'https://domains.pkgforge.dev/v1/new?since=1d&basis=claimed&source=<id>&limit=10000'`. It draws 200 random rows per source (`oi-nrd`, `oi-nrd-confirmed`, `isc-new`, `whoisds`, `cenk-nrd`, `hagezi-nrd`) whose TLD has RDAP in the bootstrap file. A seeded generator makes the draw reproducible from the date.
  - **Client** `scripts/quality/rdap.mjs`: load `dns.json` once a run; pick the base URL by TLD; GET `<base>domain/<name>` with a 10 s timeout; read the `events` entry with `eventAction: registration`; classify: `new_within_1d`, `older` (days earlier), `not_found` (404), `no_rdap`, `error`. At most 1 request a second per host, and honour `Retry-After` on a 429.
  - **Report.** `quality-<YYYYMMDD>.json` in the `dumps` package: per source `{sampled, new_within_1d, older, not_found, no_rdap, error, median_age_days}`, plus the share `new_within_1d / (sampled - no_rdap - error)`. Keep it for ever. `/v1/status` shows the last report's shares.
  - **Evidence segment.** For each sampled row with a registration event, write one segment row for source `rdap` (bit 16, family `registry`, precision `day`, kind `registered_claim`, basis `rdap`, tier T1) with `first` and `last` equal to the registration date. The ledger (DOM-021) merges it like any source. A domain registered long before its claimed date then has an earlier global `first_seen` and stops being `new`. The next daily recompute corrects the feed.
  - **Tests.** `node:test` with recorded RDAP answers (200, 404, 429, no bootstrap entry). A planted answer with a registration 2,000 days old classes as `older`.
- **Decision:** the `rdap` segment carries the registration date as `first`. The registration date is the earliest evidence any source has, so the definition of `first_seen` (architecture section 2) holds with no special case. The alternative, evidence-only entries that leave `first_seen` alone, needs a second rule in the ledger for one source.
- **Depends on:** DOM-032
- **Prove:** `node scripts/test.mjs scripts/quality --name "rdap"` passes.
  - `gh workflow run quality-rdap.yml --ref main`, then `gh run list --workflow quality-rdap.yml --limit 1 --json conclusion --jq '.[0].conclusion'` prints `success`.
  - `curl -sS 'https://domains.pkgforge.dev/v1/new?since=2d&basis=rdap&limit=5' | jq '.data[0].registered'` prints a `basis: "rdap"` object.
  - Anonymous read: `node scripts/ghcr/tags.mjs dumps --prefix quality-` (DOM-019, which follows the registry's `Link` header past 1,000 tags) lists the report tag.

## DOM-055 — Failure drills

- **Status:** open
- **Priority:** P2
- **Effort:** M
- **Source:** architecture section 8 (the failure table); design A section 8; design B section 8. The drills in mirror-archlinux `docs/tests.md` and `tests/unit/42-registry-faults.sh` are the model: each fault is planted and the visible result is asserted.
- **Problem:** architecture section 8 promises a behaviour for every failure. A promise nobody has seen kept is a guess. The service must be seen to stay honest when a source or a layer fails: it answers from the rest and says what failed.
- **Premise:**
  - Every failure in architecture section 8 has an expected provenance: `meta.sources_failed`, `x-domains-sources-failed`, `x-domains-degraded: 1`, `x-domains-cache`, an issue key, or a refusal to promote.
  - THC's volume fell to about a third of September's during early October: 843 to 986 MB a day in September, 984 and 957 MB on 10-01 and 10-02, 445 MB on 10-03 and 77 to 340 MB a day from 10-05 (MEASURED 2026-10-27T09:34:52Z, the Hugging Face tree; design A M2 first saw the drop). The quarantine floor is 40% of the 7 day median of accepted days, and 3 consecutive days below it reset the baseline (architecture section 5.8).
  - Kafka retention is 25 to 27 hours for `certstream_domains` and 11 to 13 days for the NRD topics, so replay has a bound.
  - Mirror lesson: a decoder status read through a pipe hides a failure (mirror `docs/design.md`, "A function that reads a status under `set -e` and `pipefail`"). A drill must read the exit code of the process that failed.
  - Live drills touch production, so each is non-destructive and short. A drill never deletes a GHCR object (no script may, ruling 5).
- **Approach:**
  - **Offline drills** under `scripts/drills/` as `node:test` files with mocks (a mock registry from DOM-019's tests, a mock Kafka, a Cache API stub with a clock). Each asserts the result and the headers:
    - THC file absent: the adapter reads the Hugging Face bucket; if both fail the source is `late` and `/v1/new` lists it in `sources_failed`.
    - THC day under 40% of the 7 day median: the segment is pushed with the `quarantine` annotation, `new` ignores it, and an `anomaly-thc-ct` issue is raised. Three such days in a row reset the baseline and the third is accepted. The drill replays the file sizes of 2026-09-01 to 2026-10-26 in date order (the listing of DOM-009) and asserts that 10-05 and 10-06 are quarantined, 10-07 is accepted, and 10-15 (77 MB) is quarantined.
    - Kafka unreachable: the lane is `late`; a later run replays from the stored offset and writes the same segment bytes.
    - A bad segment (out of order key): the verifier (DOM-018) refuses it, the tier is rebuilt without it, and `root:latest` does not move.
    - A root older than the live one: promotion refuses it (DOM-020).
    - A names-tile log answers 404 or 429: other logs continue, the cursor holds.
    - GHCR answers 5xx or stalls past 10 s: the Worker serves from the Cache API or R2, with `x-domains-degraded: 1`.
    - R2 empty: the Worker reads GHCR with `x-domains-cache: ghcr` (DOM-053 drives it live).
  - **Live drills**, each a script with `--live` and a printed plan before it acts:
    - Actions stopped: `gh workflow disable ingest-live.yml`, wait for the next `watchdog.yml` run or start one, assert the `schedules-stopped` issue and that `/healthz` still answers with a growing `root_age_s`, then `gh workflow enable ingest-live.yml`.
    - Root rollback: read `root:latest`, read its `previous` digest, fetch the previous manifest by digest anonymously and assert its `root_seq` is lower and its packs all exist. A rollback is a new root that names older packs (architecture section 8). Run the promotion of such a root only against the mock registry.
  - **Each drill prints** `drill=<name> expected=<headers> got=<headers> result=PASS|FAIL` and exits 1 on FAIL.
  - Record the outcome table in `docs/research/measure/DOM-055/drills.md`.
- **Decision:** the destructive part runs only against mocks, and the live part only toggles a workflow and reads. A drill that moves the real root would risk the data it tests.
- **Depends on:** DOM-023, DOM-034, DOM-044
- **Prove:** `node scripts/test.mjs scripts/drills` passes, and `node scripts/drills/actions-stopped.mjs --live` prints `result=PASS` and leaves `ingest-live.yml` enabled (`gh workflow list --json name,state --jq '.[] | select(.name=="Ingest live")'` shows `active`).
- **Found 2026-10-28T15:10Z (DOM-004):** the premise's retention figures move. At 2026-10-28T14:22:26Z `certstream_domains` kept messages about 24.2 hours back. The three NRD topics deleted no message between 2026-10-27T05:30:36Z and 2026-10-28T15:00:19Z, so their retention is unknown and at least 13 days (DOM-004's Corrections in `TODO/ingest.md`). A drill that rests on a replay bound reads the earliest retained offsets with ListOffsets at its own run, not from this premise.
  - `curl -sS -o /dev/null -D - https://domains.pkgforge.dev/healthz | grep -i '^x-domains'` shows the provenance headers during the drill.

## DOM-056 — Runbooks and the resource ledger

- **Status:** open
- **Priority:** P2
- **Effort:** S
- **Source:** mirror-archlinux `docs/operations.md` at commit 669ac725f8081445c164113f2ed092533de112e2 (read it at `https://raw.githubusercontent.com/pkgforge-dev/mirror-archlinux/669ac725f8081445c164113f2ed092533de112e2/docs/operations.md`); architecture section 12.
- **Problem:** an operator and a later agent need one page that says what runs by itself, what a person must do, and how to undo each cloud resource. Without it, each person reads twelve workflows to learn the shape.
- **Premise:**
  - mirror-archlinux `docs/operations.md` has these sections: "Workflows and schedules" (a table of workflow, triggers, does), "The jobs of the watchdog", "Concurrency" (group, queue, effect), "Each scheduled workflow starts the others" (table of who starts whom and the age), "Staleness", "Issues the automation raises and clears" (table: issue, raised when, cleared when, by), "What needs a person", "Re-run a sync", "Repository settings", "Secrets". It is written to be read by a person who has not seen the code.
  - Architecture section 12 lists the cloud resources and their undo: the probe Worker and bucket (DOM-061, temporary, deleted below), the drill Worker and bucket (DOM-053, temporary), the API Worker and the custom domain (DOM-030), the cache bucket (DOM-031), the clock Worker (DOM-025, conditional), and the GHCR packages, which have no undo by ruling 5.
  - `docs/resources.md` exists and holds the ledger skeleton. Each entry that creates a resource adds its own row in the same change. This entry checks that every row exists and is complete.
  - `HUMAN.md` belongs to another author. This entry does not edit it. If an operator step is missing there, add it to `TODO/PROGRESS.md` "Open questions".
- **Approach:**
  - **`docs/operations.md`**, in the shape of the mirror's. Sections: the workflows and their triggers (the table of architecture section 5.3, filled with the measured run times); who starts whom and the ages of `dispatch-overdue` (DOM-034); the concurrency groups (`root-writer`, `ingest-<source>`, `compact-<tier>`, `watchdog`, `status`, `ci-<ref>`); the clock (`config/clock.json`, `docs/clock.md`); the issues table (every key of DOM-034); what needs a person (the Worker deploys, the deletion of the probe, a source that shut down; a VPS holds no token, DOM-057); how to run a backfill (`gh workflow run ingest-thc.yml -f day=2026-10-05`, and the matrix form of DOM-029); how to re-run a failed compaction; how to deploy and roll back the Worker (`cd apps/api && npx wrangler@4.150.0 deploy`, `npx wrangler@4.150.0 rollback`); how to read the root with no Worker (`curl` with `Authorization: Bearer QQ==`).
  - **Drift test** `scripts/docs/check-operations.mjs` with `scripts/docs/check-operations.test.mjs`. It fails when `docs/operations.md` omits a file of `.github/workflows/`, omits an issue key that `scripts/track-issue` is called with, or when `docs/resources.md` omits a resource of architecture section 12 or has a row with no undo. Add the check to the gate list (`scripts/gate.mjs` STEPS and `TODO/RULES.md` section 1 are held equal by `scripts/gate.test.mjs`: edit both).
  - **Delete the probe.** When DOM-002, DOM-005, DOM-007 and DOM-008 have all closed, the operator deletes the probe: `npx wrangler@4.150.0 whoami` first, then `npx wrangler@4.150.0 delete --name domains-probe`, then the bucket's objects (the lifecycle rule of DOM-061 with `--expire-days 1` and a wait, or `npx wrangler@4.150.0 r2 object delete domains-probe/<key>`), then `npx wrangler@4.150.0 r2 bucket delete domains-probe`. This entry moves the two rows of `docs/resources.md` to Retired with the date. `docs/operations.md` says the same under "what needs a person".
  - **Ledger rows.** For each resource, one row: what, the account, the entry that created it, the date, the undo command. GHCR packages: "no undo, nothing is ever deleted (ruling 5)".
- **Depends on:** DOM-055, DOM-005, DOM-008
- **Operator:** the deletion of the probe above, after the four measurements have closed (DOM-002, DOM-005, DOM-007 and DOM-008). Run `npx wrangler@4.150.0 whoami` first and record the account name it prints in the Retired row.
- **Prove:** `node scripts/test.mjs scripts/docs --name "operations"` passes, and `node scripts/docs/check-operations.mjs` exits 0.
  - `grep -c 'wrangler' docs/resources.md` prints at least 3.
  - A planted missing workflow row makes the check exit 1 (the test plants it).
  - After the deletion, `npx wrangler@4.150.0 r2 bucket list` no longer names `domains-probe`, and `docs/resources.md` lists both probe rows under Retired.