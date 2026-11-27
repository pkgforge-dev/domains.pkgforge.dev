# domains.pkgforge.dev

An open-data project for certificate-transparency (CT) names and newly
registered and newly seen domains. The project is under development. Its
Cloudflare Worker at `domains.pkgforge.dev` exposes public service and index
metadata. Published data is available as OCI artifacts in GHCR and can be read
anonymously. The outputs are licensed 0BSD.

## Development quick start

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

## Query families in development

| a caller asks | and gets |
| --- | --- |
| reverse IP | the names seen on an address |
| subdomains | the names under a parent domain |
| CNAME targets | the names that point at a target |
| bulk downloads and daily CT dumps | the raw and derived data, as files |
| what is new | names newly registered or newly seen in the last 1 h, 6 h, 12 h, 1 day or N days, by any suffix or parent domain, with first and last seen per name per source |

The design specifies per-source first and last seen times for records and
provenance for the sources and storage tiers that answered. Implementation
progress is tracked in [TODO/PROGRESS.md](TODO/PROGRESS.md).

## How it is built

- **Many feeds, one answer.** Planned inputs include THC's ip.thc.org dumps, OpenINTEL
  Zonestream, the Let's Encrypt, Geomys and IPng names tiles, ISC, WhoisDS, NRD
  lists and open ccTLD zones, beside a reading of its own. The design uses
  overlapping coverage so feeds can back one another up.
  `docs/sources.md` catalogues them.
- **GHCR holds the data**, the way `pkgforge-dev/mirror-archlinux` does it:
  workflows push with their own `GITHUB_TOKEN`, and the raw feeds are kept
  always. The design reserves up to 5 GB for the planned R2 cache.
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
| [`docs/worker.md`](docs/worker.md) | the operator's Worker guide |
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
