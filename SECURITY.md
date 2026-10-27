# SECURITY.md

The threat model of domains.pkgforge.dev. Writing it is the security audit; a
change that moves a boundary below updates this file in the same commit.

## The threat model

The Worker and the data are open by design (AGENTS.md absolute 8): any caller
on the internet can query the Worker and pull the GHCR artifacts, with no key.
The data is public. What must hold anyway:

⚠ Nothing is built yet. Each row below is a requirement on the surface it names,
and the entry that builds that surface proves it. The row says what stops the
threat once the surface exists.

| threat | what stops it |
| --- | --- |
| a caller floods the Worker | no per-caller limit exists, by design. Cost is bounded by caching, by where the data lives (GHCR and the R2 cache, which answer without a feed), and by stated limits on the size of one answer. Cloudflare's own platform limits apply |
| a feed carries hostile content: an oversized record, a malformed line, a name built to break a parser or a page | every feed is parsed by a reader that validates the shape and the size of a record, and a record that fails is counted and dropped, never repaired. A name is data: it is never executed, and a response that carries names sets `content-type` and `x-content-type-options: nosniff` so no browser treats it as markup |
| one source lies or is poisoned | a record names every source that carries it, so a claim is attributable and never silent. No answer rests on a single source where a second exists. Provenance is a statement about where a name was seen, not about whether it is safe |
| an answer names a source or tier it did not use | a defect: provenance headers say which sources and tiers answered (AGENTS.md absolute 11), and a test holds each header against a fixture |
| a workflow's token is abused | each workflow declares `permissions:` for the narrowest set it needs, holds no repository secret, and cannot reach Cloudflare. A workflow triggered by a pull request from a fork gets no write token, and none checks out a fork's code with one |
| a third-party action runs hostile code with the job's token | each action is pinned by commit and read before it is added; the job's permissions are the limit of the damage, and the token expires with the job |
| a package in GHCR is replaced or poisoned | only this repository's workflows push to the packages, with their own token. A reader verifies the digest it pulled, and an artifact names the feed digests it was built from |
| a credential reaches the tree, a log or an issue | there is no credential to leak: CI uses `GITHUB_TOKEN`, and the Worker is deployed with the operator's login. `scripts/scan-secrets.mjs` refuses credential shapes in every tracked file, and `docs/security/secrets.md` says what to do if one gets in |
| the Worker is deployed from a stale or ungated tree | the operator deploys from a clean tree at the tip of `origin/main` that the gate passed (`HUMAN.md` §4) |
| the Worker calls a source live and inherits its outage or its load | the Worker answers from GHCR and the R2 cache, and never calls THC's live API (AGENTS.md absolute 15) |
| an old Worker version with old bindings stays public | `workers_dev = false` and `preview_urls = false` on every Worker that serves callers. A measurement Worker is the one exception: the probe (`domains-probe`) and the drill (`domains-drill`) run on workers.dev for their life, with `preview_urls = false`, hold no data of value, bind only a temporary bucket, and are deleted when their entries close. Each deletion is a row of `docs/resources.md` under Retired |
| an outside ingester (a VPS) feeds a hostile or false segment | the VPS holds no token and writes nothing to GHCR. It serves its segments over HTTPS, and a workflow pulls them, checks their sha256, runs the verifier and pushes them with its own `GITHUB_TOKEN`. A segment that fails is refused, and a compromised VPS cannot move the root or `state` |
| a caller's queries are logged and linked to them | the Worker keeps no per-caller state, because no caller is gated or limited. Any analytics are aggregate, and no caller address is stored |

## Who holds what

| secret | held by | where | blast radius |
| --- | --- | --- | --- |
| the wrangler login | the operator | their machine, never read by an agent | the Cloudflare account, as the operator |
| `GITHUB_TOKEN` of a workflow | GitHub, for one job | the job | the job's `permissions:`, for the job's length |
| any repository or Worker secret | nobody: none exists | not applicable | not applicable |

## Trust boundaries

- **Caller to Worker:** untrusted input; every path, parameter and header.
- **Source to workflow:** an untrusted third party. A feed can be late, wrong,
  hostile or gone, and the reader treats every byte as data.
- **Workflow to GHCR:** authenticated by the job's own token, and only this
  repository's workflows hold one.
- **Worker to GHCR and R2:** reads only, anonymously for GHCR.
- **Operator to Cloudflare:** the operator's own login, from their machine.

## The invariants

1. No surface authenticates or rate-limits a caller (`TODO/RULES.md` §5,
   `AGENTS.md` absolute 8).
2. No secret value appears in the tree, a log, an event, an issue or a response.
3. No credential crosses between GitHub and Cloudflare.
4. Provenance never claims a source, a tier or a verbatim body that was not
   used.
5. Nothing is deleted from GHCR.

## Known limits

- A name seen in a source is a record of an observation on a date. It is not a
  statement that the name is safe, registered to a person, or in use.
- Redundancy has a floor: a name only one source carries is attributable to that
  source alone, and losing that source loses that name.
- The freshness of an answer is the freshness of the slowest source behind it.
  `docs/architecture.md` states each source's measured delay, with the machine
  and the date.
- What a source does with a request this project makes to it is outside this
  repository's control.
