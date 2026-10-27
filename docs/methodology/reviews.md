# reviews.md

The deep review pass, which is part (c) of [`gate.md`](gate.md).

At least three passes, and ⛔ **they are three different questions, not one
sweep written up three times.** A single pass finds what you are already
looking for. A recurring defect class is found by a *different* lens than the
one that is looking.

---

## The three lenses

### 1. The door sweep

**"What other door reaches this code?"**

Enumerate every affordance the change adds, then list every caller and every
surface that can reach it. Then ⭐ **grep for the ones you did not enumerate.**
A list written from memory is not complete.

- Check the **guard**, not just the guarded code. An operation that reads one
  resource and writes another needs **two** authorizations.
- Grep an abstraction's **callers** before believing it is load-bearing.
- A gate on one of several paths into the same action is the single most
  recurring hole there is.

⚠ The task list is never the enumeration. It does not contain them all.

### 2. The guard mutation

**"Can my new guard actually fail?"**

⛔ **Plant the defect the guard exists to catch, and read the exit code
unpiped.** A guard that has never been seen to refuse is a guard nobody knows
works.

The shape of it: a scan reports "no orphans" over the exact orphan it exists
to find, because its model of a reader is too narrow. It is green, it is
trusted, and it checks nothing.

Two shapes to test for specifically:

- A test whose **name** claims more than it **checks**.
- A check that passes because a different code path happens to satisfy it.

⚠ A patch script that asserts only that *something* in the file changed
reports success while the replacement it exists to make silently does not
match. This lens is what catches it.

⚠ **A mutation scratch copy has its own `node_modules` and its own caches.** A
copy that links the real `node_modules` as a whole shares caches and package
links that point at the real tree. A suite in the copy then runs the real,
unplanted code, and a survival is false. So, in the copy:

1. Make a real `node_modules` directory. Link only the third-party packages
   into it.
2. Point every workspace link at the copy's own `packages/<name>/` and
   `apps/<worker>/` directories.
3. Give the copy its own, empty caches.
4. **Canary first.** Plant a marker that every suite touches and see the suite
   fail with an unpiped exit code. Do not trust a survival before the canary
   has failed.

A survival recorded from a copy that was not isolated is run again under this
layout before it is reported.

### 3. The claim audit

**"Which sentence in what I am about to publish is not backed by an artefact I
can point at?"**

Re-read the handoff, the summary and the documentation against the data, the
tree and the live state. This is the pass that catches:

- a number with the wrong denominator;
- a conclusion drawn from a single sample;
- a novelty claim this project already made somewhere else;
- a measurement quoted without its conditions;
- a file a summary claims was written that is not on disk.

⛔ **A summary is a claim like any other.** Yours, or the harness's. "I wrote X,
I deployed Y, the tests pass" is real only once git, the suite or the live
system confirms it.

---

## More than three, when the change earns it

A fourth and fifth are welcome. Two that pay often:

- **"What did I measure but never verify?"** A number taken and never checked
  against a second source.
- **"What did the driven pass show that the suite could not?"** Naturally
  distinct from the door sweep, because it starts from the user rather than
  from the code.

⛔ **What is not acceptable is three headings over one sweep.** Each pass must
be able to name what it looked at that the others did not, and the handoff says
so per pass.

---

## ⛔ Before any lens: do not stop at the first explanation that fits

**A lens finds a candidate. It does not finish the job.** The discipline for
getting from a candidate to a conclusion is in
[`research.md`](research.md) section 2, with the measured pair of runs that
paid for it: enumerate three explanations before testing one, test to refute,
let no line of inquiry suppress another, and read it once more afterwards
looking only for what is not on your list.

⚠ **It belongs there rather than here because it governs every conclusion**, not
only the ones a review reaches. A review that skips it produces three lenses
over one hypothesis, which is the same defect this page already names in
another costume.

---

## A pass with no findings

⭐ **A pass that reports nothing means that pass was too shallow.**

Three passes reporting nothing is a weaker result than one pass reporting a
real defect. If a pass genuinely found nothing, the handoff says **what would
have had to be true for it to fire.** That sentence is the evidence the pass
happened at all.

⚠ **That is not a licence to invent one.** An empty result beats a manufactured
one, and the sentence above is precisely what distinguishes a pass that ran and
found nothing from a pass that did not run. Padding a lens to look diligent
costs the next reader their trust in the ones that did fire.

---

## The mechanical half is a script's job

Anything a check can assert should be asserted by a check, not by a reading.
Statuses that disagree between two files, counts that do not add up, a
reference naming nothing, a dead link, a cited path or line that does not
resolve.

⭐ Doing the mechanical half in one second is what leaves time for the half that
needs reading. A record check of this kind finds, in under a second, a
disagreement two human readers pass over.

⛔ **What no check can answer is whether a claim is true.** That is lens 3, and
it stays with the reviewer.

---

## What the review owes the record

- The findings, per pass, with which lens found each.
- The change summary: files touched, lines added and removed.
- What was **fixed** as a result. A listed finding that was not fixed says
  where it is tracked.
- For any pass with no findings, what would have made it fire.
