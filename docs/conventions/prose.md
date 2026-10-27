# prose.md

How documents are written here. One half is checked by `scripts/text-check.mjs`
and the other half is a reading, which the third review lens holds
([`../methodology/reviews.md`](../methodology/reviews.md)).

---

## ⭐ The rule is a register, and it has a name

⛔ **Write every document here in ASD-STE100, Simplified Technical English.**
Not a house style, not a list of banned characters: a controlled language,
published and maintained outside this repository, written so that a procedure
means one thing to every reader, including one reading it in a second language
and one reading it under pressure.

It binds every document in this tree, every commit message, record entry and
review write-up. There is no register for the important pages and a looser one
for the rest.

Beyond the register: every claim is backed by a command a reader can run or a
path a reader can open. Write for an agent with no memory of the session that
wrote the file, and for a person who is looking for one fact.

### The rules, in full, in this repository's words

⛔ **These are the working rules. They are not a summary of the standard and
they are not optional.** The standard itself is somebody else's document and is
not reproduced here. What follows is the subset that governs writing in this
tree, stated so that a reviewer can hold it and an author can check themselves
against it.

**Words**

1. **One word, one meaning, one part of speech.** A term keeps the same sense
   for the whole document. A check refuses, a guard refuses, a gate refuses:
   pick one and keep it.
2. ⛔ **Never reach for a synonym to avoid repetition.** Repeating the term is
   correct. Varying it makes a reader ask whether you mean something else, and
   in a technical document they are right to ask.
3. **Do not use a noun as a verb, or a verb as a noun.** "Action the finding"
   and "the ask" are both refused.
4. **Use the real noun rather than one made from a verb.** "It fails" beats "a
   failure occurs". "The check refuses it" beats "refusal takes place".
5. ⚠ **No more than three nouns in a row.** "Gate check exit code handling" has
   four and means nothing. Break it with a preposition: "handling the exit code
   of a gate check".

**Verbs and voice**

6. **Active voice.** "The check refuses it", never "it is refused".
7. **Simple tenses only.** Present for what is true, past for what happened.
   Not "will have been", not "would have needed to be".
8. **Do not drop the verb.** A heading may; a sentence may not.
9. **Start an instruction with its verb.** "Run the gate before you push", not
   "The gate should be run before pushing".

**Sentences and paragraphs**

10. **One instruction per sentence.** A sentence carrying a second clause
    between dashes is two instructions wearing one.
11. **An instruction is at most 20 words. A descriptive sentence is at most
    25.** ⚠ This one is a reading. No check counts words, because a splitter
    that cannot tell a list from a sentence would refuse correct writing.
12. **A paragraph covers one topic and runs to at most six sentences.**
13. **Put the condition before the instruction.** "If the check exits 2, read
    the first line" rather than "read the first line if the check exits 2". A
    reader who acts on the first half of a sentence must not have acted wrongly.
14. **Put a warning before the step it applies to**, never after. A caution a
    reader meets afterwards is a caution about damage already done.

**Punctuation**

15. ⛔ **A sentence that needs a long dash is a sentence to split**, and every
    spelling of the dash is the same defect. The next section carries the rule.
16. **No slash meaning "and or".** Write which one you mean, or write both.
17. **Nothing essential inside parentheses.** A reader skips them. If it
    matters, it is a sentence.

**What this cannot hold**

⚠ **Almost all of these are readings.** No linter can decide whether two words
mean the same thing, and one that tried would refuse correct writing. What
`scripts/text-check.mjs` holds is narrow: the narrative markers listed under
"Present tense, no story" in [`docs.md`](docs.md), control bytes, and invalid
UTF-8. A green gate is not a well-written page.

---

## ⛔ The dash rule is about the sentence, not about the character

**A sentence that needs a dash is a sentence to split.** That is the whole
rule, and every spelling of the dash is the same defect: the long dash, a run
of hyphens between two words, and a comma splice carrying the same
parenthetical.

⚠ **Banning the character teaches agents to respell it.** An agent that finds
the long dash refused writes two hyphens or a comma instead. Every run stays
green, and no sentence gets shorter. Split the sentence, make the clause its
own sentence, or put it in a table.

⭐ **Four exemptions, each because the text is not this repository writing.** A
fenced block and a code span, so a page can show the spelling it refuses. A
quoted line, because the operator's words are kept verbatim. A table row and a
heading, because neither is a sentence. A link target and a bare URL.

No gate step checks this rule. The review does.

---

## The three markers, and nothing else

⛔ ⭐ ⚠ and no others. Each means one thing:

| marker | meaning |
| --- | --- |
| ⛔ | a rule that has already been broken, or one whose violation is unrecoverable. A hard stop. |
| ⭐ | reach for this first. The highest-value item on the page. |
| ⚠ | a trap. It works until it does not, and the failure is quiet. |

⛔ **They do not stack.** There is no `⛔⛔` and no `⛔⛔⛔`. Escalating a marker
is how a vocabulary stops meaning anything: once a page has three levels of
stop, a reader has to weigh them, and weighing is what a marker exists to
prevent. One marker or none.

⭐ **Use them sparingly enough that they are still visible.** A page where every
paragraph carries one has no markers at all. If a page needs more than a
handful, the page is a rulebook pretending to be a summary and it should be
split.

⚠ **No gate step counts markers.** Sparingness is a reading, and so is the rule
that they do not stack.

### Status glyphs are a second tier, and a different job

⭐ **A semantic marker and a status glyph are not the same thing.** ⛔ means a
rule whose violation is unrecoverable. A check reporting that one file of forty
failed needs a pass or fail glyph, which denotes a state rather than a rule.

| tier | the set | where it belongs | what it means |
| --- | --- | --- | --- |
| prose markers | ⛔ ⭐ ⚠ | documents | the table above. Sparing, and they do not stack. |
| status glyphs | ✅ ❌ | machine output, result tables, checklists | passed, or failed. Nothing else. |

⛔ **A status glyph never carries a rule, and a marker never reports a result.**
With no glyph available an author reaches for ⛔ to mean "this one failed", and
that is exactly the dilution the three-marker rule exists to prevent.

---

## Amend in place. Do not stack banners.

⛔ **When a rule changes, rewrite the rule.** Do not append a dated box under
the old text saying the text above is retired.

A document written by accretion, where the paragraph says one thing and a box
below it says the opposite, has a documented failure mode: an agent reads the
first paragraph of the box, stops, and acts on the retired rule.

What to do instead:

1. **Rewrite the rule to its current form.** The current text is the only text.
2. **Put the story of the change in `CHANGELOG.md`** and in the commit message.
   The git log keeps the superseded wording. A dated report in `docs/research/`
   keeps a dead end and the measurement behind it.
3. **Link to the story once**, from the rule, in a sentence, when a reader needs
   it to use the thing correctly.

The story of a change belongs in the changelog or the log. The document says
what is true now. A reader reaching for a rule needs one answer, and a page that
offers two makes them guess which is live.

⚠ This is not licence to delete a dead end. A route that failed is recorded with
the reason, in the entry or in a report, so a later session does not re-derive
it wrongly.

---

## Say what is not true

Reserve an explicit place for the truths that are tempting to hide. This feature
has a known gap. This estimate excludes something that cannot be measured.

⛔ **Never a fabricated number.** When the real value is unknown, write a dash.
A wrong number on a report is worse than no number, because a blank gets
checked and a number gets used.

⚠ **A measurement carries its conditions or it is not a measurement.** A rate
with no date, no machine, no sample count and no input size cannot be compared
to anything, which makes it worse than an absence: it invites a comparison that
means nothing. Date every measured claim, and name the machine that took it.

⚠ **Measured, or labelled.** An estimate is allowed. It is labelled as one, in
the same sentence, every time it appears.

---

## Every claim is verified before it is written

Writing the documentation is the audit. Being forced to state precisely what
something does, and then checking whether that is true, is where a startling
share of real defects are found. Expect the documentation pass to generate
findings, and treat that as the feature rather than as a delay.

⚠ Do not copy a number out of another document. Derive it, or name where it
came from. A value in two places with no check between them drifts, and the
copy a reader trusts is the wrong one.

---

## One fact, one home

Every fact lives in exactly one document. If it must appear in a second place,
derive it there or have a check assert that the two agree.

⚠ **No gate step finds a duplicated sentence.** It is a reading, so a reviewer
looks for the second copy. The record guard does check the part a machine can:
the counts in `TODO/INDEX.md` and `TODO/PROGRESS.md` are derived from the rows
and compared, and the gate lists in `TODO/RULES.md` and `scripts/gate.mjs` are
held equal by a test.

⚠ **The entry-point router is the one exception.** `AGENTS.md` states the
absolutes in full, because a session may be handed exactly that file.

When two documents conflict, the technical reference (`docs/architecture.md`)
wins and the other one is the defect. Fix it in the same change and say so.

---

## What a document is not

**A document says what the thing does. It does not say what the project did.**

A fixed defect belongs in a reference page only when a reader needs it to use
the thing correctly. "The writer takes a lock now" is history and belongs in the
work record. "Two lints exist because another client will refuse the file" is a
constraint and stays.

⛔ **The history goes to the changelog, the git log, the entries and the dated
reports.** History written into every document it touches leaves each one true
and unreadable. [`docs.md`](docs.md) says which documents `scripts/text-check.mjs`
holds to the present tense.

⚠ An unlinked page is not read, so it is not corrected, and that is the state
every stale document passes through. A page nothing links to is a finding. The
record guard checks that every relative link in a document resolves. It does not
find a page nobody links to.

---

## What the gate checks about documents

1. **Every relative link resolves**, and every backticked repository path in a
   narrative document exists, with a cited line number inside the file
   (`scripts/todo/check.mjs`, checks 7 and 10).
2. **No narrative marker** in a technical document (`scripts/text-check.mjs`).
3. **No control byte and no invalid UTF-8** in any tracked text file
   (`scripts/text-check.mjs`).
4. **No credential shape** (`scripts/scan-secrets.mjs`).

⛔ **What a linter cannot check is whether a claim is true.** That is a reading,
and it belongs to the review pass. A guard that tried to verify prose would
either pass vacuously or refuse legitimate writing, and both are worse than an
honest scope.

---

## ⭐ Where the register actually goes wrong

⛔ **The failure mode is metaphor used as jargon, not marketing copy.** The
offending words are ordinary until they are asked to carry a meaning they do not
have, and no word list holds them: "load-bearing" as a technical term is the
example.

**The two substitutions that do most of the work:**

- **Replace the adjective with the measurement.** "Fast" becomes the number and
  its conditions. "Robust" becomes what it survives.
- ⭐ **Replace the metaphor with the mechanism.** "Load-bearing" becomes what
  breaks when it moves. "Surgical" becomes what it touches and what it does
  not.

⚠ **`simply`, `just`, `obviously` and `of course` are the words to watch
hardest**, and they are ordinary English, which is why no check can have them.
They tell a reader who is stuck that the thing they cannot do is easy.

---

## Defensive framing is not neutral

⛔ **Describe what code does in plain technical terms.** Do not write up-front
disclaimers arguing that something is legitimate, and do not tell a future
reader not to re-open a question.

Both backfire, in opposite directions. A defensive paragraph primes a skeptical
reader to look for the thing it denies. And a grepping agent trips on the
reassurance words themselves and spends its budget reading the matched line.

State the mechanism and its constraints. Name prior art briefly if it helps.
Stop there. The same applies to identifiers: prefer a neutral accurate name to
an evocative one.

⚠ **A ruling is recorded as a ruling.** The operator's decisions that bind this
project are in `TODO/RULES.md` §5, each with the operator's words, a date and an
overturn condition. A document states the technical fact that follows from a
ruling and cites the ruling. It does not argue the ruling again.
