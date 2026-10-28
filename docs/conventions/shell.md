# shell.md

Traps in passing text and reading results between shells, and the rules that
avoid them. Every entry here is a measured defect, and most of them fail
silently, which is why they are worth a document.

The shape of almost all of them is the same: **a payload crosses a boundary and
loses its quoting, or a result crosses a boundary and loses its meaning.**

⚠ **Every measurement below was taken on the operator's Windows machines, for
the sibling repository and the template it was copied from. None was taken again
in this repository.** Read each as that author's measurement with its stated
conditions.

---

## 1. A prose payload goes through a file. Not through a shell.

⛔ **Write the text to a file with a file-writing tool, then pass the path.**
This applies to a commit message, a document, a script, a JSON body, anything
multi-line, and anything containing an apostrophe, a backtick, a dollar sign or
a backslash.

### ⭐ The order to reach for, and it is not the order that comes to mind

⛔ **A heredoc is the last resort, not the first, and it is where sessions go
first anyway.** The pattern is consistent enough to be worth naming: a session
reaches for `<<'EOF'`, is bitten, reaches for it again with more quoting, is
bitten again, and eventually writes the file with something else. Every one of
those attempts costs a turn and some of them corrupt a file quietly.

| reach for | when |
| --- | --- |
| ⭐ **whatever writes a file directly for you**, without a shell in the path | ⛔ **always, if you have one.** Nothing quotes, nothing expands, nothing to escape. |
| a small script that takes the payload as base64 and writes the file atomically | you are in a shell and the payload is prose, a patch or a substitution |
| base64 through an argument | the payload has to cross a shell at all |
| copy from a file that already exists | the content is already on disk |
| ⚠ a quoted heredoc | ⛔ nothing. See the measurement below, and the one under it. |

⚠ **This is not a style preference and the measurement is two rows down.** A
quoted heredoc is documented to be literal, and passed inline to a shell it is
not: the backticks in a prose payload execute.

⭐ **A tool that patches rather than rewrites is worth more than it looks**,
because the alternative is reading a file, editing it in memory and writing the
whole thing back, and every one of those steps is a chance to lose the parts
that were not being changed.

The reason it is a file and not "better quoting" is that quoting is not
sufficient. Measured on 2026-08-25:

| how the payload travelled | result |
| --- | --- |
| written to a file, then read by the shell | 8657 bytes, byte-exact, exit 0 |
| passed inline to `bash -c` inside a **quoted** heredoc `<<'EOF'` | the backticks in the prose are **executed**: `origin: command not found` |

The second row is the surprising one. A quoted heredoc is supposed to be
literal, and when the payload is handed to a shell as an inline string it is
not reliably so. The minimal reproduction is one line of text containing
`` `backticks` `` and it fires with LF endings and with CRLF endings alike.

⚠ **The way this fails is worse than an error.** The file is written, nothing
returns non-zero, and the damage is a substituted or truncated fragment
somewhere in the middle of a long document. The first sign is usually a commit
subject that reads like a fragment of the body.

Related failures with the same cause:

- A PowerShell here-string written inside a `bash` command is parsed by bash
  first. `@'...'@` is an `@`, a single-quoted string, and an `@`, so it ends at
  the first apostrophe in the text. The phrase "the run's own deadline" turns
  the rest of a commit message into shell commands.
- `python -c` and `python - <<'PY'` are fine for code with no apostrophes and
  no backslashes. A Windows path in a Python string literal has both.
- A backslash escape that survives one hop loses a backslash on the next, and
  the receiving language reads what is left as an escape sequence. `\b` becomes
  a backspace byte and `\f` becomes a form feed. The file is written, nothing
  errors, and a regex meant to end in a word boundary ends in a byte no editor
  shows.

⚠ **Some agent tooling collapses `\\` to `\` before the shell sees it.** Verify
it in the environment you are in rather than assuming either way:

```bash
printf 'literal: C:\\Users and regex \\d+\n'
```

If the output shows one backslash where you wrote two, every literal double
backslash has to go through a file-writing tool instead.

⛔ **The probe fires on this machine.** Measured on one Windows 11 machine
(10.0.26200) on 2026-09-10, from a harness whose commands reach `bash` as
written text: the line above answers `printf: missing unicode digit for \U`,
which is `printf` receiving `\U` where `\\U` is written. The same collapse
turns a `\\n` in a patch script's search string into a real newline, so the
patch matches nothing and **reports no error**, because a replace that finds
nothing is not a failure to any of the tools involved. ⭐ The visible symptom
is a file that has not changed, which is the same symptom as a file that did
not need to.

### ⭐ The channel that cannot be reached into: base64

When a payload has to cross a shell at all, **base64 is the one encoding no
shell interprets.** It is `[A-Za-z0-9+/=]` and needs no quoting anywhere: not
in bash, not in PowerShell, not in `cmd`. A quote, a backtick, a dollar sign,
a percent, an emoji and an indented terminator all survive it unchanged.

That makes it the right transport for a helper that writes files:

| channel | when |
| --- | --- |
| ⭐ **base64 argument** | anything with quoting hazards. Nothing in it is a character a shell acts on. |
| **copy from another file** | the payload already exists on disk |
| **stdin** | ⚠ only behind a pipe, and only from a POSIX shell. See below. |

⛔ **PowerShell's stdin to a native command is NOT byte-exact, and Git Bash's
is.** Measured on one 59-byte fixture: piping it through PowerShell writes
**61** bytes, because PowerShell's native-command pipe appends a trailing CRLF.
The tail `3e 20 3c 0a` arrives as `3c 0a 0d 0a`. The same file piped through
Git Bash is byte-identical, as are the base64 and copy-from-file paths from
**both** shells.

⚠ A receiving tool cannot tell an intended trailing newline from an added one,
so it must not guess. **From PowerShell, use base64 or copy-from-file. Reserve
stdin for pipes in a POSIX shell.**

⭐ Two properties worth building into any such helper, because both turn a
silent failure into a loud one:

- **Write atomically**: a temp file in the *same* directory, then rename. A
  killed process leaves the old file intact rather than a truncated one. Same
  directory matters: a rename across volumes is a copy and loses the guarantee.
- **Require an expected match count on a substitution.** A replace that matches
  a different number of times than you believed is refused, and the file is
  left untouched. ⛔ A silent no-op that reports success is the failure that
  discipline exists to remove.

---

## 2. An exit code is read from the process that produced it, unpiped

⛔ Piping a check into anything reports the **pipeline's** status, not the
check's, so a guard that failed reads as green.

```bash
node scripts/check-thing.mjs
```

```bash
pwsh -NoProfile -File scripts/check-thing.ps1
```

Not `check | grep`, not `check | Select-String`, not `check | tee`. Run it,
read `$?` or `$LASTEXITCODE`, then look at the output separately if you need to.

The same rule in PowerShell has a second edge: `-ErrorAction SilentlyContinue`
suppresses the error *output* while the cmdlet failure still sets a failing
status. To make a failure genuinely non-fatal, promote it and swallow it:

```powershell
try { Some-Cmdlet -ErrorAction Stop } catch { }
```

---

## 3. stdout and stderr are different streams and merging them is a decision

⛔ **Anything reading a value reads stdout alone and checks the exit code.**
Merging is correct only when the thing you want is on either stream.

The worked example: `git rev-parse --abbrev-ref HEAD` in a repository with no
commits prints `HEAD` to stdout **and** a three-line fatal to stderr, exiting
128. A probe that merges the streams puts that fatal into a field called
`branch`.

The opposite case is equally real: `java -version` prints the version to
**stderr**, so a probe reading stdout alone finds nothing. Merge on purpose
there, and say why in a comment.

---

## 4. A subshell discards the assignment you made in it

⛔ In POSIX shells, a function called inside `$( )` runs in a subshell. Any
variable it sets is gone when it returns.

```sh
collect() { FOUND="$FOUND $1"; printf 'value'; }   # FOUND is lost
x=$(collect a)                                      # ...because of this
```

Signal through the exit code or the output, and let the caller record it:

```sh
x=$(collect a); rc=$?
[ "$rc" = 3 ] && FOUND="$FOUND a"
```

The same shape appears with `while read` on the right of a pipe: the loop body
runs in a subshell and its assignments vanish. A here-document redirect does
not create one, which is why a lookup table is fed to the loop that way.

---

## 5. Line endings

A carriage return in a file `.gitattributes` says is LF is **invisible to git
and visible to everything else.** The index is normalised either way, so
`git diff` shows nothing and a review cannot see it.

It is not invisible to a regex reading the working tree. In .NET, `(?m)^...$`
matches before the newline and leaves the carriage return inside the capture,
so a status cell reads as `done` plus a byte and matches nothing.

⚠ The drift arrives from your own tooling. `Set-Content` writes CRLF on Windows
by default, and so do most editors and most file-writing tools.

Two things fix it and neither is a manual step anybody has to remember:

- a `.gitattributes` that states the rule per type (this repository's own);
- a comparison of every tracked file's working-tree endings against what
  `.gitattributes` resolves for it, using git's own answer rather than a second
  table. No gate step runs it, so a session runs it by hand:

```bash
git ls-files --eol
```

⚠ **Git Bash's `grep` cannot count carriage returns.** On the operator's Windows
machine, GNU grep 3.0 in Git Bash reports every line of an LF-only file as a
match for `$'\r'`, with `-U` or without it, and `grep -cP '\r'` reports none on
a CRLF file. MEASURED in this repository, 2026-10-28, by a script file run with
Git's `bash.exe` 5.3.15: after `printf 'a\nb\nc\n' > lf` (`od -c` shows
`a \n b \n c \n`), `grep -c $'\r' lf`, `grep -cU $'\r' lf` and
`grep -c -e $'\r$' lf` each print 3. The same commands typed through a tool that
passes the command line on for you can print 0, so the answer depends on the
path the argument takes, which is the trap. Count CR bytes with a tool that
reads bytes, never with `grep -c`:

```bash
tr -cd '\r' < FILE | wc -c
```

⚠ **`.ps1` is the one file type that keeps CRLF.** Windows PowerShell 5.1
mis-parses a here-string whose terminator arrives with a bare LF. The simpler
defence, and the one this repository uses, is to write no here-strings in a
`.ps1` at all.

---

## 6. A control byte goes in a file as an escape, never as itself

⛔ A literal control byte makes the file invisible to both review tools. `grep`
calls it binary and skips it, saying so in a line nobody reads, and `git diff`
prints "Binary files differ" so a code review of the file shows no diff at all.

The runtime value is identical either way, so only reviewability is ever at
stake, which is exactly why it survives so long unnoticed.

Write `\0`, `\t`, `\x1f`. Never the byte. Guard it with a check that fails
rather than warns, over every tracked text file.

---

## 7. Windows specifics

- ⭐ **Git Bash rewrites arguments that look like POSIX paths.** Anything with a
  leading slash is converted to a Windows path before the target process sees
  it. When the argument does not name a file on this machine, the rewrite is
  corruption, it is silent, and the error never names the cause. Measured on
  2026-08-26:

  ```bash
  gh api /repos/OWNER/NAME/actions/workflows
  ```

  ```text
  invalid API endpoint: "C:/Program Files/Git/repos/OWNER/NAME/actions/workflows".
  ```

  `gh` happens to detect it and say so. Almost nothing else does: a container
  runtime receives the rewritten path as a real argument and acts on it.

  ⛔ **The rewrite has three shapes and only one of them looks wrong.**
  Measured on one Windows 11 machine (10.0.26200) on 2026-09-18, Git Bash
  5.3.15, by printing the argument vector of a NATIVE Windows callee
  (`node` v26.7.0); a callee that is itself an msys program receives every one
  of these unchanged, so the trap depends on what you are calling as well as
  on what you sent:

  | sent | arrived as |
  | --- | --- |
  | `/single` | `C:/Program Files/Git/single` |
  | ⚠ `/b` | `B:/`, a drive root, because one letter reads as a drive |
  | ⛔ `//double-slash` | `/double-slash`. **One slash is silently removed** and nothing else changes. |
  | `a/b` | `a/b`, untouched. Only a LEADING slash triggers it. |

  ⭐ **The third row is the one that costs a session.** The first two produce a
  path so obviously wrong that the receiver complains. A payload beginning `//`
  is a Go, C or JavaScript comment, and it arrives looking almost right, so it
  is written to a file and read back much later. ⚠ It is also why a helper that
  takes a text payload as an argument is given that payload as base64 rather
  than as text.

  ⚠ **The rewrite is about the ARGUMENT, not the callee's platform.** `gh.exe`
  is a Windows program and is corrupted anyway, because what it wants is an
  API path rather than a file path. The question to ask is whether the leading
  slash you write is meant to name something on this filesystem.

  Two variables turn it off, and they cover different things. `MSYS_NO_PATHCONV`
  disables the leading-path heuristic; `MSYS2_ARG_CONV_EXCL` is a per-argument
  exclusion list, and `'*'` excludes everything. ⛔ **Any command whose POSIX
  paths are destined for a non-Windows process carries both:**

  ```bash
  MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*' podman run --rm alpine ls /etc
  ```

  ⚠ This is the root cause behind the reserved-name bullet below, which is why
  the two are next to each other.
- ⛔ **The Windows reserved device names are `CON`, `PRN`, `AUX`, `NUL`, `COM1`
  to `COM9` and `LPT1` to `LPT9`**, in any case and with any extension. Two
  different triggers create one as a real file, and the second is the one nobody
  expects:

  1. **Your own redirect.** `2>/dev/null` under a shell that does not map
     `/dev/null` creates a file called `nul`, which git then tracks, which
     breaks `git stash` outright, and which cannot be deleted by `rm` or by
     Python.
  2. ⚠ **A tool's own argument list.** `podman machine ssh` on Windows passes
     `-o UserKnownHostsFile=NUL` to its own ssh invocation. Under Git Bash that
     is a filename, not the null device, so a 99-byte `NUL` holding an ssh host
     key appears in whatever directory the command ran in. Measured on
     2026-08-27 with `MSYS_NO_PATHCONV=1 MSYS2_ARG_CONV_EXCL='*'` already set:
     **the prefix above does not prevent this one**, because the argument does
     not look like a path.

  ⚠ The two differ in recoverability, so do not assume the worse case is the
  only case. On the same machine `rm` removes the `NUL` written by trigger 2,
  and does not remove the lowercase `nul` from trigger 1. Put the whole reserved
  set in `.gitignore` before any of it happens, because the directory it lands
  in is usually a repository.
- ⚠ **`/tmp` is not one directory.** Git Bash resolves it inside the msys root;
  a native Windows Python or PowerShell resolves it somewhere else entirely, or
  not at all. A file written by one and read by the other is not found. Use a
  repository-relative scratch directory, or an absolute path both agree on.
- ⚠ **A shim is not an executable.** On Windows the node ecosystem ships shims,
  and scoop's are `.ps1`. `Process.Start` with `UseShellExecute` false throws
  "not a valid application for this OS platform" on a `.ps1` and refuses a
  `.cmd`. Route a `.ps1` to a PowerShell host and a `.cmd` to `cmd.exe`.
- ⛔ **End a process by its PID, never by its image name.**
  `taskkill /F /IM workerd.exe`, `pkill node` and `killall` end every process of
  that name on the machine: the operator's own `wrangler dev` sessions and
  another session's test run among them. The sibling repository's gate failed
  twice on 2026-10-27 because one session ran `taskkill /F /IM workerd.exe`
  (its `TODO/PROGRESS.md` baseline, read here and not measured here). Read the
  PID from the process you started and end that one: `taskkill /PID <pid> /T /F`
  on Windows, `kill <pid>` elsewhere. `scripts/test.mjs` ends its own children
  this way.
- ⚠ **`wsl.exe` writes UTF-16LE**, which a redirected stdout reads as empty or
  as mojibake.
- ⚠ **A machine-wide install is not under the user's home.** Checking only
  `~/scoop` reports a tool as absent on a machine that has it under
  `C:\ProgramData\scoop`. Look in both.
- ⚠ **A release binary left running holds its own executable open**, and the
  next build fails on a locked file with an error naming neither. Kill stray
  processes before rebuilding.
- ⛔ **Python on Windows cannot print this repository's own markers.** stdout
  defaults to cp1252, which has no ⛔, no ⭐ and no ⚠. Measured on 2026-08-27,
  Python 3.13.15:

  ```bash
  python -c "print('⛔')"
  ```

  ```text
  UnicodeEncodeError: 'charmap' codec can't encode character '⛔'
  in position 0: character maps to undefined
  ```

  ⭐ Note what the error itself does: it names the character as a codepoint,
  because it cannot print it either.

  ⚠ The failure is at print time, so it passes every test that captures output
  and fails the moment a person runs it at a console. Any script that echoes a
  marker sets `PYTHONIOENCODING=utf-8` or calls
  `sys.stdout.reconfigure(encoding='utf-8')` before printing. Where the encoding
  is not yours to control, print the codepoint instead of the character.
- ⛔ **A byte class is not a character class, and the wrong one is silently
  wrong.** `grep -o '[^\x00-\x7F]'` returns per-byte fragments, so a three-byte
  marker counts as three separate entries and the total is wrong in a way that
  looks like real output. Measured on 2026-08-27 over a file holding exactly one
  ⛔ and one ⚠:

  | tool | answer |
  | --- | --- |
  | `grep -o '[^\x00-\x7F]'` | 6 fragments, none of them a character |
  | `rg -o '[^\x00-\x7F]'` | `1 ⚠`, `1 ⛔` |

  ⚠ **Setting `LC_ALL=C` does not rescue the first row**, and assuming it does
  is the trap. On the measured machine `LANG` is empty, so `LC_ALL=C` changes
  nothing at all. The fix is choosing the right tool, not the locale.

  ⛔ **A check states which of the two jobs it is doing**, because the same
  expression is correct for one and quietly wrong for the other. Counting bytes
  is byte-oriented and belongs to a byte tool. Counting characters is
  character-oriented and needs a Unicode-aware one. This matters most to
  `scripts/text-check.mjs`, which refuses a control byte and invalid UTF-8 and so
  is byte-oriented on purpose.

---

## 8. PowerShell specifics

- ⛔ **Every invocation carries `-NoProfile`, and this is why.** A convention
  that appears in every example and in no explanation is one a session drops
  the first time it types a command from memory. Without it PowerShell runs the profile scripts of
  whoever owns the machine first: they set variables, define functions, change
  the working directory, install argument completers, alias native commands and
  write to stdout. ⭐ **A profile that prints one line puts that line in front
  of your JSON**, and a check that parses its own output then fails on a
  machine that is not yours, for a reason nothing in the repository names.
  ⚠ It also costs startup time on every call, which a gate pays once per check.

  ```bash
  pwsh -NoProfile -File ./scripts/example.ps1
  ```

  ⚠ **The POSIX-side counterpart is not a flag, it is two variables**, and
  section 7 carries it: a Git Bash command whose arguments are destined for a
  non-Windows process sets `MSYS_NO_PATHCONV` and `MSYS2_ARG_CONV_EXCL`. The
  two rules pair up because both stop somebody else's environment rewriting
  what you sent.

  ⚠ **It is a reading here.** No gate step refuses a fenced block that invokes
  `pwsh` or `powershell` without it, so the review holds it.
- ⛔ **`[int]` on a double rounds.** `[int]2.65` is 3, so a 2h39m session
  prints as 3h39m and the number goes straight into a report. Use
  `[math]::Floor`.
- ⛔ **`-match` is case-insensitive**, so `'FAILED'` matches `"0 failed"` in a
  summary line and a failing test's name is lost exactly when it is needed.
  Use `-cmatch` when case is the signal, and filter on the per-test line rather
  than the summary.
- ⛔ **`$args` inside a function is an automatic variable** and silently
  swallows a parameter of that name. Variable names are case-insensitive, so
  `$Args` collides too. Name locals so they cannot.
- ⚠ **`$PSNativeCommandUseErrorActionPreference` defaults to false** from pwsh
  7.4, so a native command writing to stderr does not terminate under
  `$ErrorActionPreference = 'Stop'`.
- ⚠ **`Get-Command` finds cmdlets, functions and aliases too.** Filter to
  `Application` and `ExternalScript` when you mean an executable. A cmdlet
  looked for on PATH reports as missing on every machine that has it.
- ⚠ **Read the child's streams before waiting on it.** Calling `WaitForExit`
  first deadlocks any child that fills the pipe buffer: the child blocks on
  write, the parent blocks on the wait, and neither moves until the timeout.
- ⚠ **`ConvertTo-Json` defaults to depth 2**, and renders anything deeper as
  the literal text `System.Collections.Hashtable`. Pass `-Depth`.
- ⛔ **A `.ps1` containing any non-ASCII byte needs a UTF-8 BOM if Windows
  PowerShell 5.1 has to run it.** 5.1 decodes a BOM-less file as the system ANSI
  code page, so every non-ASCII character is mis-decoded. PowerShell 7 defaults
  to UTF-8 and does not care, which is exactly why this is easy to miss: the
  file works on the machine it was written on and breaks on the one it was
  written for. `PSUseBOMForUnicodeEncodedFile` is the analyzer rule that
  catches it.
  ⚠ The alternative is to keep every `.ps1` ASCII-only. That is also defensible;
  what is not defensible is non-ASCII with no BOM and a claim of 5.1 support.
- ⚠ **An empty `catch {}` is refused by PSScriptAnalyzer**, and it should be:
  it is indistinguishable from an accidentally swallowed error. Where swallowing
  is genuinely the design, say so in code rather than by omission. `$null = $_`
  discards the error explicitly and reads as a decision.

---

## 9. A long-running command needs a hard time limit

⛔ Several tools block for as long as you let them. `kubectl version` without
`--client` contacts a cluster, `gradle --version` starts a daemon, a cloud CLI
sits on an update check. A script that shells out to unknown tools without a
limit is a script that hangs, and a script that hangs is one nobody runs twice.

```bash
timeout 6 some-tool --version
```

`timeout` is absent on stock macOS. `gtimeout` is there when coreutils is
installed, and the fallback is to run in the background and kill on a counter.
Exit 124 is the coreutils verdict and 137 is a kill; **both mean "it never
answered", which is a different fact from "it is not installed"** and belongs in
a different field.

---

## 10. Waiting inside an agent session

⚠ **Do not end a turn to wait for something.** The conversation idles, the
harness times out, and the session dies mid-operation with state half-changed.

⛔ **And a scheduler, a monitor or a wake-up facility does not do the waiting
either.** Each of them ends the turn by design: they work by giving control back
and being re-invoked later. Substituting one is not holding, it is the thing
this section forbids, wearing a different name.

⚠ **This is the rule agents break most, and the reason is specific.** Many
harnesses block a foreground `sleep`. A session that has learned "hold with a
sleep loop", finds `sleep` refused, and concludes the rule cannot be followed
here, goes looking for a built-in that can wait. The conclusion is wrong: the
rule is not about `sleep`.

---

### ⭐ Wait on the work, not on the clock

**The best hold has no timer in it at all.** A blocking read costs no CPU,
needs no `sleep`, and ticks exactly when there is something to say.

**If the job prints anything, run it in the foreground and let its own output
be the tick.** There is nothing else to write:

```bash
long_running_thing 2>&1
```

The turn cannot idle while a process is writing to it, and every line is
progress a reader can see.

**If the job is already in the background, block on its log.** Measured on one
Windows 11 machine, 2026-08-28, Git Bash:

```bash
: > run.log
long_running_thing > run.log 2>&1 &
JOB=$!
tail -n +1 -f --pid="$JOB" run.log
wait "$JOB"
printf 'exit=%s\n' "$?"
```

⭐ `--pid` is what makes this terminate: `tail` stops when that process does,
so the hold ends by itself when the work does. Without it the pipeline outlives
the job and the session hangs on a command that will never return.

⚠ **The heartbeat belongs to the JOB, not to the waiter.** A job that can go
quiet for a long time prints its own progress line; the foreground just relays
it. That puts the interval where the knowledge is.

### ⛔ The trap that costs a whole turn

```bash
producer | while IFS= read -r line; do
  printf 'tick: %s\n' "$line"
  case "$line" in done) break ;; esac      # ⛔ does not stop `producer`
done
```

**Each side of a pipeline runs in its own subshell, so `break` leaves the loop
and nothing tells the producer to stop.** The producer keeps writing into a
pipe nobody is reading, and the command never returns.

Measured here: this exact shape runs to a two-minute tool timeout while its
output shows every tick arriving correctly. ⭐ **It looks like it worked right
up until it does not finish**, which is why it is worth a box rather than a
sentence.

The fix is to make the producer's own end the loop's end, which is what
`--pid` above does.

---

### When there genuinely is no signal to block on

Something outside this machine, with nothing local to read, is the only case
that needs a timer. `sleep` is one spelling of a timer and not the only one.
All of these were measured on the same machine and day, asked for 3 seconds:

| | elapsed | needs |
| --- | --- | --- |
| `sleep 3` | 3s | ⚠ blocked outright by some harnesses |
| `timeout 3 tail -f /dev/null` | 3s | coreutils `timeout` |
| `timeout 3 cat` | 3s | coreutils `timeout`, and a stdin nothing writes to |
| `perl -e 'select(undef,undef,undef,3)'` | 4s | perl |
| `[System.Threading.Thread]::Sleep(3000)` | 5s | ⚠ pwsh, and about 2s of that is pwsh starting |

⚠ **The last row is why a PowerShell tick is not free.** Starting `pwsh` per
tick costs roughly two seconds on this machine, so a loop of short ticks spends
most of its time launching a shell. Hold inside one `pwsh` process instead of
starting one per tick.

⚠ **`read -t` is not a portable answer.** It is a bash builtin; `/bin/sh` here
is dash and dash's `read` has no `-t`. And reading from `/dev/null` returns at
once on end-of-file rather than waiting, so it is not a timer even where the
flag exists.

⚠ **`ping` is not a portable timer either.** `-c` counts on POSIX and `-n`
counts on Windows, and against localhost the replies return instantly: `ping -c
3 127.0.0.1` finishes in **0s** here.

The shape, when a timer really is needed:

```bash
i=0
while [ $i -lt 8 ]; do
  timeout 45 tail -f /dev/null
  i=$((i + 1))
  printf 'tick %s  %s\n' "$i" "$(date -u +%H:%M:%SZ)"
  if some_done_condition; then printf 'complete\n'; break; fi
done
```

⚠ **Keep a tick under four minutes** so progress is visible and nothing looks
hung, and note that the ceiling is per tick rather than per wait. A
forty-five-minute operation is ten holds that each print progress, never one
forty-five-minute wait.

---

### The summary

| the situation | hold with |
| --- | --- |
| ⭐ the job prints | run it in the foreground. Nothing else. |
| the job is backgrounded | `tail -f --pid=$JOB` on its log, then `wait` |
| the job is silent | make the job print, then as above |
| ⚠ waiting on something off this machine | a bounded timer loop, from the table |
| ⛔ any of the above | never a scheduler, a monitor or a wake-up facility |
