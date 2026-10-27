# domains.pkgforge.dev

Certificate-transparency (CT) names and newly registered and newly seen domains,
as open data. The data lives in GHCR as OCI artifacts that anyone pulls with no
login, and one Cloudflare Worker at `domains.pkgforge.dev` answers queries over
it. Callers need no key, no account and no quota, and nothing rate-limits them.
The outputs are licensed 0BSD.

## Quick start

```bash
npm ci
npm run gate
```

`npm run gate` runs every mechanical check: the record guard, the tests, the
formatter and linter, and the text and secret sweeps. See `TODO/RULES.md` §1 for
the steps.

## Requirements

- Node.js, the version in `.node-version`, with npm (`packageManager` in `package.json`)
- `gh` for this repository's issues and workflow runs
- `npx wrangler login` for anything that touches the Cloudflare account (the
  operator's; `HUMAN.md`)

## What it answers

| a caller asks | and gets |
| --- | --- |
| reverse IP | the names seen on an address |
| subdomains | the names under a parent domain |
| CNAME targets | the names that point at a target |
| bulk downloads and daily CT dumps | the raw and derived data, as files |
| what is new | names newly registered or newly seen in the last 1 h, 6 h, 12 h, 1 day or N days, by any suffix or parent domain, with first and last seen per name per source |

Every record carries an explicit definition and its provenance: which sources
carry it, and when each first and last saw it. A header or field names the
sources and tiers that actually answered. `docs/architecture.md` defines each
query.

## How it is built

- **Many feeds, one answer.** It ingests THC's ip.thc.org dumps, OpenINTEL
  Zonestream, the Let's Encrypt, Geomys and IPng names tiles, ISC, WhoisDS, NRD
  lists and open ccTLD zones, beside a reading of its own. Losing any one source
  loses no answer. `docs/sources.md` catalogues them.
- **GHCR holds the data**, the way `pkgforge-dev/mirror-archlinux` does it:
  workflows push with their own `GITHUB_TOKEN`, and the raw feeds are kept
  always. R2 holds at most 5 GB, as a cache.
- **No machine of its own.** There is no VPS ingesting hundreds of GB a day. One
  is added only if ever needed, or when a core source shuts down.
- **No token.** CI holds no Cloudflare credential, and the Worker is deployed
  with the operator's local wrangler login.

## What it does not do

- It never gates a caller: no client API keys, accounts or rate limits.
- It never calls THC's live API to answer a caller. Reverse IP and CNAME come
  from THC's data mirrored into GHCR.
- It never deletes from GHCR.

State and the work order are in `TODO/PROGRESS.md`; every resource is in
`docs/resources.md`.

## Documentation

| document | what it holds |
| --- | --- |
| [`AGENTS.md`](AGENTS.md) | the router for every session: absolutes, start, gate, routing |
| [`docs/architecture.md`](docs/architecture.md) | the design |
| [`docs/sources.md`](docs/sources.md) | the source catalogue |
| [`docs/resources.md`](docs/resources.md) | every cloud resource and its undo |
| [`TODO/PROGRESS.md`](TODO/PROGRESS.md) | the record and the work order |
| [`TODO/RULES.md`](TODO/RULES.md) | how the repository is worked on, and the operator's rulings |
| [`HUMAN.md`](HUMAN.md) | the operator's side |
| [`SECURITY.md`](SECURITY.md) | the threat model |

## Contributing

Read `AGENTS.md` in full first; it is the same router for people and agents.

## Licence

0BSD. See [`LICENSE`](LICENSE).
