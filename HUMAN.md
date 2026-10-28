# HUMAN.md

The operator's side of this repository: what you hold, what you run, and how you
check a unit. Agents read it too, so they know what to ask you for and what
never to ask for.

## 1. Machine check

- Node.js at the version in `.node-version`, with npm.
- `npx wrangler whoami` names the Cloudflare account that holds the
  `pkgforge.dev` zone. Your wrangler login lives in your home directory, and no
  agent reads it. An agent may run `whoami`: it lists account names and reads no
  secret. Every entry that deploys runs it first and records the account name it
  printed.
- `gh auth status` is signed in to an account that can push to
  `pkgforge-dev/domains.pkgforge.dev`.
- `git config --get core.hooksPath` prints `.githooks`, so a commit that credits
  a tool is refused.
- `git ls-files -s .githooks/commit-msg` prints a mode that starts with
  `100755` once the hook is staged. If it prints `100644`, run
  `git update-index --chmod=+x .githooks/commit-msg`; git skips a hook without
  the bit, in silence. After the first `git add`, `node scripts/check-hooks.mjs`
  (a gate step) fails on a hook in the index without the bit.

## 2. What you hold

This project has no secret to paste anywhere.

| what | who holds it | where | blast radius if leaked |
| --- | --- | --- | --- |
| your wrangler login | you | `~/.wrangler`, on your machine only; never read by an agent | the Cloudflare account, as you |
| the workflow's `GITHUB_TOKEN` | nobody: GitHub mints it for one job and it expires with the job | in the job | what the job's `permissions:` block grants, for the length of the job |
| a repository or Worker secret | none exists | not applicable | not applicable |

You make no token for CI and set no repository secret. The ruling is yours
(`TODO/RULES.md` §5, ruling 6): the workflow's own token writes to GHCR, each
package is first pushed by a workflow, and the workflow makes it public. No
credential crosses between GitHub and Cloudflare.

⚠ If a run shows that a push is refused, or that a package stays private, the
cause is a setting only you can change (the organisation's Actions permissions,
or the package's repository access). The session records the refusal message in
`TODO/PROGRESS.md` "Open questions" and waits for you. It does not work around it
with a token.

## 3. Prompts to paste

To start or resume any session:

```text
Read AGENTS.md in FULL & follow
```

## 4. Steps only you can do

### Review and commit the skeleton

The session that wrote the skeleton did not commit. Read the tree, run
`npm run gate`, and commit it yourself with the hook installed (§1), through a
message file. `.tmp/commit-msg.txt` does not exist yet: write it first, with an
editor (`.tmp/` is gitignored, and the gate creates the directory), then:

```bash
git commit -F .tmp/commit-msg.txt
```

### Deploy the probe Worker

The measurements that need a Worker on Cloudflare share one temporary probe
(`TODO/ops.md`, DOM-061). Before the first session that needs it:

1. `npx wrangler login`, then `npx wrangler whoami` lists the account that holds
   the `pkgforge.dev` zone.
2. Enable R2 on that account (dashboard, R2 Object Storage, Overview).
3. Run the Operator line of DOM-061: create the bucket `domains-probe`, add its
   lifecycle rule and deploy from `probes/worker/`. The deploy starts the 48
   hours of DOM-002's cron measurement.
4. When DOM-002, DOM-005, DOM-007 and DOM-008 have closed, run the deletion in
   DOM-056: the probe and its bucket are temporary, and run on workers.dev for
   their life only.

### Deploy the Worker

Under your ruling of 2026-10-28 (`TODO/RULES.md` §5, ruling 14) the agent runs
these steps itself, with your login on your machine, and records the account
name `whoami` printed. Step 1's reading of the zone's rate-limit rules stays
yours (ruling 15, DOM-062). CI never deploys. You deploy from your machine, with your own login, the way
`pkgforge-dev/mirror-archlinux` does (the "Deploy" section of its Worker
document, docs/worker.md in that repository). From a
clean tree at the tip of `origin/main` that the gate passed:

1. `npx wrangler whoami` names the right account, and before the first deploy
   you read the `pkgforge.dev` zone's rate-limit rules (dashboard: Security, WAF,
   Rate limiting rules): none may cover `domains.pkgforge.dev`, because no
   consumer is gated (`TODO/RULES.md` §5, ruling 12).
2. From the Worker's directory, `npx wrangler deploy`. Its `wrangler.toml` binds
   the custom domain `domains.pkgforge.dev`.
3. `curl -sS https://domains.pkgforge.dev/` answers, and the entry's Prove
   passes.
4. Tell the session the version id that `wrangler deploy` printed. It adds a row
   to the Deploys table in `docs/resources.md`.

The Worker directory and its `wrangler.toml` land with the serve entries. Until
then there is nothing to deploy.

## 5. Receiving a handoff

A session ends with a summary table and a next prompt in chat. The record
(`TODO/PROGRESS.md`) says what is in flight; nothing else needs carrying over.

## 6. Validating each unit

An entry is done when its Prove command was run and its output is recorded in
the entry. Re-run the Prove yourself when you want to check a claim. For the
Worker, the Prove includes a `curl` against `domains.pkgforge.dev`. For the data,
it reads the artifacts from GHCR with no login at all, which is the test that a
package really is public.

## 7. Runbooks

These land with their entries:

- the first deploy of the Worker (§4);
- reading a workflow run that failed: `gh run list` and `gh run view`.

## 8. Ground rules

- The surfaces stay open: nobody is ever asked for a key (AGENTS.md absolute 8).
- Nothing is deleted from GHCR. Deleting a package is yours alone, and destroys
  data that is kept always (`docs/resources.md`).
- Every source goes into the outputs. Nobody asks you about a source's licence
  or terms again (`TODO/RULES.md` §5, ruling 4). The repository records only
  what each source gives technically.

## 9. Troubleshooting

- **The gate fails on a fresh clone.** Run `npm ci` first, then `npm run gate`.
  Each failing step is printed by name. Until `TODO/PROGRESS.md`,
  `TODO/INDEX.md` and the entry files exist, the record guard and the counts
  step fail by design.
- **A commit is refused with "a tool is credited".** The hook read a tool or
  vendor name, a generated-with line, or a co-author trailer that names a tool
  or comes from a no-reply address. A human co-author is allowed. Edit the
  message file and commit again.
- **A commit goes through with a trailer.** The hook is not installed or not
  executable. Fix it (§1) and amend nothing that was pushed; tell the session.
