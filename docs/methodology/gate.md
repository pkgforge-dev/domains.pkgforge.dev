# gate.md

What a unit of work passes before it is done. Three parts, none of them
skippable, with commands actually run and output actually inspected.

⭐ **Each part is blind to the class the other two catch. That is why there are
three and not one.** The suite proves the code. The driven pass proves the
product and the platform. The review proves the composition. Skip one and you
ship the class it owns.

If a part cannot pass, that is a **finding recorded in the entry**, not a silent
omission. A gate you cannot run is a gate you require setup for, never one you
skip or report as passed.

---

## (a) The automated suites, headless

The record guard, the full test suite, the formatter and linter, the text and
secret sweeps, and this unit's own acceptance checks. Green means green: a
pre-existing failure is a debt to fix or to raise, never a line to wave past.

⭐ **Run it with one command, not from memory.** This part is a LIST, and a list
run by hand is run in the order somebody recalls it, and five hand-typed runs
are five different subsets: each is green, and none is the same gate.

```bash
npm run gate
```

`TODO/RULES.md` §1 lists the steps, and `scripts/gate.test.mjs` holds that list
equal to the one `scripts/gate.mjs` runs.

⛔ **A step that cannot start fails the run**, with exit 2 and the step named. A
tool that is not installed means nothing about its subject was verified, so the
gate never skips a step silently and never reports one as a pass.

Two disciplines that catch what a naive pass count hides:

⛔ **Count the test files the runner reports against the files on disk.** A
green "N passed" beside an error line is a file that never ran. Trust the count
and the exit code, not the passed number. `scripts/test.mjs` fails when no test
ran, and when a `--name` filter matches none.

⛔ **Grep yourself for the forbidden patterns** before declaring green. See
[`../conventions/forbidden-patterns.md`](../conventions/forbidden-patterns.md).

⛔ **Read every exit code from the process that produced it, unpiped.** A guard
piped into anything reports the pipeline's status, so a guard that failed reads
as green. [`../conventions/shell.md`](../conventions/shell.md) section 2.

**A green suite proves your code and nothing else.** It is blind to the
platform's real behaviour and to every door a caller can reach. That is why it
is necessary and not sufficient.

---

## (b) Drive the real thing yourself

⛔ **For every caller-facing change, run the actual system and use it as the real
caller would. This is not the operator's job to do for you.**

The reason is specific. The **one-gated-door** class of defect, where a
control is enforced on one path and not its siblings, is invisible to a green
suite and is caught only by driving the real thing. So are two more:

- **Composition failures.** Each part correct, the assembly wrong.
- **The centrepiece that is dead code.** Tested, documented logic with no
  reachable caller. You find it by trying to do the thing.

**How, here.** The Worker and the data are public and need no credential, so
the pass needs no password, no session and no walker user.

- Call `https://domains.pkgforge.dev` with `curl` for every route the change
  touches. Read the status, the provenance headers and the body from the
  response, and assert them rather than looking at them. A header that names a
  source or a tier is checked against what the answer used (`AGENTS.md`
  absolute 11).
- Read the GHCR artifacts **anonymously**: no `docker login`, no token, no
  `gh` credential in the process. A package that is still private, or a tag
  that does not resolve, fails here and nowhere else. `oras manifest fetch` and
  `curl` against the registry's public API both work.
- For an ingest or publish workflow, read the run itself: `gh run view` and the
  artifacts it pushed, and compare the digest it printed with the one the
  registry answers.
- Record the commands and their output in the entry.

⛔ **Deferring the pass to a task for the operator is a failed gate, not a
deferral.** There is one exception and it is narrow: if this harness genuinely
cannot reach the running system at all, that is the capability check firing.
Say so, name what is needed, and get it set up. Shipping anyway, as though the
pass happened, is a failed gate wearing a green badge.

⚠ The distinction matters. Punting a pass you *could* have run is offloading.
Reporting one you *cannot* run is honesty. They are not the same and the entry
must say which.

---

## (c) The deep reviews

At least three, each asking a **different** question. The full specification,
including the three lenses and what makes a pass real, is
[`reviews.md`](reviews.md).

⭐ **A pass reporting nothing was too shallow**, and [`reviews.md`](reviews.md)
argues that in full. Say what each pass swept, and where one genuinely found
nothing, say what would have had to be true for it to fire.

---

## Before you promise a gate: the capability check

Your harness is not guaranteed to have every capability this methodology
assumes. One session gets a shell and nothing else. Another gets a browser, a
deployment path and a real client. Another is sandboxed with no network at all.

⛔ **Establish what you can actually do before committing to a plan whose gates
you cannot pass.**

| capability | which gate needs it |
| --- | --- |
| run the build, the tests, the scripts | (a), all of it |
| outbound network to `domains.pkgforge.dev` and `ghcr.io` | (b) |
| `gh`, signed in to read this repository's runs and issues | (b) for a workflow |
| the operator's wrangler login, for a deploy | (b) for a Worker change: the operator deploys, see `HUMAN.md` |
| outbound network to the sources | reference material, real feeds |

⚠ **A resuming session re-runs this check for itself.** The session that froze
may have had a deploy path this one lacks, or the reverse. That changes what
this session can prove, and it is surfaced rather than assumed.

Write the inventory, and any gap that blocks a gate, into the first status
update and into the entry.

---

## Local is not production

⚠ The runtime you test in does not enforce every policy the deployed platform
does. Request size limits, CPU limits, header rewrites, subrequest counts and
memory ceilings: a local runtime is routinely more permissive. A workflow run
differs from a laptop in its network, its disk and its clock.

The shape of it: a limit the deployment platform enforces silently, far below
what the local runtime allows. Every local test passes, and every request in
production fails.

**The suite proves the code. Only a deployed request proves the platform.**
Anything platform-shaped gets a real-environment checkpoint, and that
checkpoint is part of (b).

---

## What "done" means

All three parts pass, with commands actually run and output actually inspected,
never checked off from memory. Then:

- the record is updated in the same change as the work, not after it;
- the documentation that describes the changed behaviour changes with it;
- the entry carries its closing evidence: the driven-pass commands and output,
  and the review findings;
- what the reviews surfaced is **fixed**, not just listed.

⛔ A unit of work whose scope grew during implementation re-passes the gate
against its **new** scope. The gate is against the work as it stands at the
end, not as it was first scoped.
