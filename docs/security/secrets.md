# secrets.md

What never enters the tree, and what to do when something did.

⭐ **This project holds no secret of its own.** CI writes to GHCR with the
workflow's own `GITHUB_TOKEN`, which GitHub mints for one job and expires with
it. The Worker is deployed from the operator's machine with their wrangler
login. CI holds no Cloudflare credential, and no credential crosses between
GitHub and Cloudflare (the operator's ruling of 2026-10-27, `TODO/RULES.md` §5).
The rest of this page is what to do if that ever stops being true, and what to
do about a value that gets pasted anyway.

---

## The rule

⛔ **A secret never enters the repository, a log line, a commit message, a
document, an issue, or a handoff.**

Not an expired one. Not one that looks redacted. Not one in an example. Not
"just for a moment, I will remove it before committing."

A secret is any value that grants access: an API token, a password, a private
key, a session string, a connection string with credentials in it, a signed
URL, a webhook secret, a recovery code. ⚠ An account identifier, a zone
identifier and an internal hostname are not credentials, but they are still
fingerprints of a private system and they do not belong in a public repository
(below).

---

## An agent never asks for a value

⛔ **The operator names what they hold. You say where it goes.**

```text
operator:  I have a Cloudflare API token.
agent:     Put it in .dev.vars as CF_API_TOKEN. That file is ignored by
           .gitignore. Tell me when it is there; do not paste it here.
```

This holds even when the operator offers. A value pasted into a session is in a
transcript, and a transcript is not a secret store.

Three consequences that come up constantly:

- ⛔ **Never read `.dev.vars`, `.env*`, `~/.wrangler` or `.cloudflare/`.** Name a
  key, never a value. The wrangler login lives in the operator's home
  directory, and a session that can read it can act as the operator on
  Cloudflare.
- ⛔ **Do not set a secret you cannot read back.** Writing a platform secret
  clobbers a working value with no way to restore it. That is the operator's
  action, always.
- ⚠ **"Blocked on credentials" is often the wrong words.** Check what the
  project's own tooling already reads before reporting a blocker. Then check
  whether the step needs a credential at all: reading GHCR and the Worker is
  anonymous, and a workflow writes with its own token.

---

## Where a secret would live

| kind | where |
| --- | --- |
| local development | a gitignored `.dev.vars`, with the committed `.dev.vars.example` twin carrying every name and fake values |
| deployed Worker | `npx wrangler secret put <NAME>`, run by the operator, one Worker at a time |
| a workflow | no repository secret. The workflow's own `GITHUB_TOKEN`, with the narrowest `permissions:` block the job needs |
| a token an agent may use | none |

⭐ **The `.example` twin is the useful half.** It documents which keys exist and
what shape each takes, so a reader knows what to obtain without anyone
publishing what they are. It holds no name yet.

⛔ **A name is added to `.dev.vars.example` in the same change as the code that
reads it**, and the entry says why a Worker needs a value it cannot get another
way.

⛔ **List the ignore rule before the file exists.** A credential file added to
`.gitignore` after the fact is trackable in between, and once staged, a later
ignore rule does nothing: `.gitignore` only applies to files git is not already
tracking.

---

## No credential crosses between GitHub and Cloudflare

The two halves of this project never share a credential.

- **GitHub side.** A workflow pushes OCI artifacts to GHCR with `GITHUB_TOKEN`,
  declared with `permissions:` on the job. The first push of a package creates
  it, and the workflow makes it public. No personal access token is created,
  stored or used.
- **Cloudflare side.** The Worker reads GHCR anonymously, and the operator
  deploys it with their local wrangler login. No Cloudflare token is stored in
  GitHub, as a repository secret or in a workflow file.

⛔ **A change that adds a token to either side is refused**, whatever it saves.
If a step cannot work without one, the entry records the step, the refusal it
met and the options, and waits for the operator (`TODO/RULES.md` §5). It is not
worked around.

⚠ **A third-party action runs with the job's token.** Pin each action by commit,
read what it does before adding it, and give the job only the permissions it
needs. A workflow triggered by a pull request from a fork never receives a write
token, and one that checks out the fork's code never runs with one.

---

## Logging

⛔ Never log a secret, or a prefix of one long enough to be useful.

This project logs no secret today. When one exists, route every secret-shaped
value through one redaction helper and make that the only way such a value
reaches output. A redactor used in most places is a redactor that fails, because
the one call site that forgot is the one that leaks. The shapes a secret scan
refuses live in `scripts/scan-secrets.mjs`, and a source whose key has a prefix
adds its shape there in the same change.

⚠ Log the **fact** rather than the value. "Authenticated as the deploy
identity" is useful; the token that authenticated is not.

---

## When something got in

Order matters, and the first step is not the git one.

1. ⛔ **Rotate the credential.** Immediately, before anything else. It is
   compromised from the moment it was written, and the rest of this list does
   not change that. A rewritten history does not un-publish a value: it was
   readable, it may be cached, mirrored, or already indexed. A workflow's
   `GITHUB_TOKEN` expires with its job and needs no rotation. A wrangler login
   is revoked by the operator in the Cloudflare dashboard.
2. **Tell the operator.** They own the account and they may need to check for
   use. Do not quietly clean it up.
3. **Remove it from the working tree**, and add the ignore rule.
4. **A history rewrite is the operator's call and the operator's action.** It
   is destructive, it breaks every clone, and it is not the fix. It is tidying
   after the fix. Never run one unprompted, and back up before running one at
   all.

⚠ **Do not report this as handled until the rotation is confirmed.** The
tempting failure is to remove the file, see a clean tree, and call it done.

---

## This repository is public

Everything above, and one addition: ⛔ **nothing that fingerprints a private
system.** Real zone identifiers, project ids, internal hostnames, credential
filenames specific to one machine, the names of private projects.

None of it is a credential and all of it is a map. The resource ledger
(`docs/resources.md`) therefore names the zone as `ZONE_ID` and the account as
`ACCOUNT_ID`, read from the operator's login when a command runs, and records
resource names and ids that are not private. One exception: a Worker's wrangler
configuration may carry the `account_id` that a custom domain needs, as the
public `mirror-archlinux` repository does (`docs/architecture.md` §12). An
account identifier grants no access by itself.

A sweep before a release, over the whole tree:

```bash
git ls-files -z | xargs -0 grep -nIE '[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}'
```

```bash
git ls-files -z | xargs -0 grep -nIE '\b[0-9a-f]{24,}\b'
```

Then read every hit. ⚠ A grep sweep finds the shapes it knows. It does not find
a password that looks like a word, or a hostname that looks like prose, and it
will not tell you that a file full of correct-looking examples describes a real
system. The sweep narrows the reading; it does not replace it. The research
reports under `docs/research/` hold feed data with many hex digests: read them
as data, not as credentials, and expect hits there.
