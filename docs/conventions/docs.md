# docs.md

The document set, what each one owns, and the rules that keep it trustworthy.

[`prose.md`](prose.md) is how they are written. This is which ones exist and
what makes them true.

---

## The set

Create what the project has a use for and nothing else: a file nobody selected
is a file a future session reads, believes, and follows into a rule that was
never meant to apply.

| file | owns |
| --- | --- |
| `AGENTS.md` | ⭐ the router. The absolutes, the work loop, what to read for which task. A session may be handed this file alone, so it states the absolutes in full and links everything else. |
| `README.md` | what this is, for a competent stranger. What, why, how to start, where the docs are. |
| `TODO/PROGRESS.md` | ⭐ the record: the one file every session reads first. The baseline, what the last session did, and the work order. Nothing else carries a work order. |
| `TODO/INDEX.md` | every entry, one row each, with the counts and the argument behind the order |
| `TODO/RULES.md` | how this repository is worked on, rule by rule, and the operator's rulings in §5 |
| `TODO/<area>.md` | the entries themselves, by area: foundation, ingest, storage, serve, ops |
| `HUMAN.md` | the operator's side: machine setup, the deploy, what they hold, the prompts they paste |
| `SECURITY.md` | the threat model, who holds what, the blast radius of each leak. Writing it is the audit. |
| `CHANGELOG.md` | what shipped, when, and where the evidence is |
| `docs/architecture.md` | ⭐ the technical reference: the design in force. When any document conflicts with this one, this one wins and the other is the defect. |
| `docs/sources.md` | the source catalogue: each feed, what it gives, its definitions and its measured limits |
| `docs/clock.md` | the clock in force: the 48-hour numbers of the three clocks and the verdict they give |
| `docs/resources.md` | every cloud resource and its undo |
| `docs/methodology/` | how work is done: sessions, the gate, reviews, entries, research |
| `docs/conventions/` | how things are written and committed: prose, documents, code, forbidden patterns, git, shell |
| `docs/security/secrets.md` | what never enters the tree, and what to do when something did |
| `docs/research/` | dated reports with their instruments and data, kept as they ran |
| `RESUME.md` | ⚠ written at the START of a session and refreshed as work moves, so a session that dies mid-task still hands something over. Gitignored. Overwritten every session, never appended to. [`../methodology/sessions.md`](../methodology/sessions.md) |

---

## The invariants

### One fact, one home

Every fact lives in exactly one document. A version string, a constant, a
limit, a schema: one place.

⛔ **A value in two documents with no check between them drifts**, and the copy
a reader trusts is the wrong one. If a number must appear twice, derive it from
the source, or have a check assert the two agree.

⚠ The trap is that a value which never changes cannot expose a missing check.
It sits correct for a year and drifts the first time it moves.

### The technical reference wins

When any document conflicts with `docs/architecture.md`, the reference is right
and the other document is the defect. Fix it in the same change and say so in
the entry.

### Documentation ships with the code it describes

⛔ Doc and code drifting apart is a forbidden pattern. The moment code changes a
documented behaviour, the document changes with it. In the same commit, not
later.

### Present tense, no story

⛔ **A technical document states what the system is and does, in the present
tense.** It does not say what the project did: no earlier behaviour, no
"since <entry> it does X", no account of how a defect was found, no dated
anecdote. A fact that matters stays, as a present-tense fact with its reason
and, where it is measured, the figure and its conditions.

The story has its own homes, and a technical document may point at them: the
git log, the entries in `TODO/`, `CHANGELOG.md` and the dated reports in
`docs/research/`.

⭐ **It is checked.** `node scripts/text-check.mjs`, a gate step, reads exactly
these technical documents:

- `AGENTS.md`, `README.md`, `HUMAN.md`, `SECURITY.md`;
- `docs/architecture.md`, `docs/sources.md`, `docs/clock.md`, `docs/resources.md`;
- every page under `docs/methodology/`, `docs/conventions/` and
  `docs/security/`;
- every generated root document, `apps/<worker>/public/*.md|txt|json`, when the
  Worker generates them;
- the string literals of a Worker's docs registry, `apps/<worker>/src/docs.ts`,
  and not its comments.

It refuses a short list of markers that only a story uses: `no longer`,
`used to` (a past habit, not the passive "is used to"), `previously`,
`originally`, `formerly`, `until recently`, `back then`, `had been`,
`turned out`, `we decided` (and found, chose, learned, discovered,
realised), `the first review`, `after the merge`, `this has happened`,
`a session once`, `is now`, `it now <verb>s` and `since DOM-<n>`. A code span or
a fenced block is skipped, so a page can name a marker it refuses.

⚠ **The list is small on purpose.** A marker that refuses correct
present-tense writing gets a check switched off, so a word such as `was` or
`now` is a reading, not a check. `scripts/text-check.test.mjs` holds each marker
against a sample and against the tree.

### Every claim is verified before it is written

Writing the documentation is the audit. Being forced to say precisely what
something does, and then checking whether that is true, is where a surprising
share of real defects are found.

⚠ The most confident sentence in a file is regularly the only false one. A test
file header asserting it runs "exactly as production uses it" is the sentence
that hides the gap between the two.

### Prefer a shape a check can assert

Where a document names a file, a constant, a route or an identifier, prefer a
form a check can verify against the tree, so a rename fails a gate instead of
rotting quietly. The record guard already opens every backticked repository path
in a narrative document and fails on one that does not exist.

⚠ **A document that cannot be checked is a document that drifts.** That is not
an argument against writing prose. It is an argument for making the mechanical
parts mechanical, so the reading is spent on the parts that need it.

### Say what is not true

Reserve a place for the truths that are tempting to hide. This has a known gap.
This estimate excludes something unmeasurable.

⛔ A limit hidden is a defect filed against the caller later.

### A public repository fingerprints nothing private

This repository is public. ⛔ No document, example or ledger row carries a zone
identifier, a token, a key or a private hostname. A command that needs one names
it as an upper-case variable and says where to read it, for example `ZONE_ID`.
One account identifier is allowed in one place: a Worker's wrangler
configuration may carry the `account_id` that a custom domain needs, as the
public `mirror-archlinux` repository does (`docs/architecture.md` §12). An
account identifier is no credential. Everywhere else it is `ACCOUNT_ID`.
[`../security/secrets.md`](../security/secrets.md) has the sweep.

---

## The changelog

**What shipped, when, and where the evidence is.** One entry per shipped unit
of work, pointing at the record that carries the detail.

⭐ It is also the destination for what a documentation pass removes. When a
document loses the *story* of a fix, what broke and the sentence's earlier
wording, the story comes here. So this file is expected to grow, and its length
is not a defect.

| the text is | where it goes |
| --- | --- |
| a fact, limit or constraint a future session needs | ⛔ the document. Not here. |
| a measurement with its conditions | ⛔ the document, as a table. Not here. |
| the story of a fix, or a superseded claim kept for provenance | ⭐ here |
| the full detail of one session's work | ⛔ the entry. Here goes a pointer to it. |

Four rules. No gate step holds them yet, so the review does, and a rule stated
and enforced by nothing is a preference until a check exists:

1. ⛔ **Newest first, always.** A new entry goes at the top of its section,
   never appended to the bottom.
2. ⛔ **Every heading carries a date.** Consider a full ISO 8601 UTC stamp:
   several entries sharing one date cannot be ordered from what was written
   down.
3. ⛔ **Every entry names its record**, the entry or commit carrying the
   evidence. An entry with no record is a claim.
4. ⛔ **Every entry says whether it deployed.** "No deploy" is a complete and
   common answer. Silence is not.

And two things an entry must not do:

- ⛔ **Do not tidy the file while shipping something else.** Reordering old
  entries in the commit that adds a new one makes both unreviewable. Tidying is
  its own commit.
- ⛔ **Do not delete an entry.** A superseded one is amended in place with a
  dated note. Amend, never silently delete.

⚠ A check can hold the order, the dates and the pointers. **It cannot check
that an entry is true.** That stays with the claim audit,
[`../methodology/reviews.md`](../methodology/reviews.md) lens 3.
