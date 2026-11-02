// packages/core/src/contact.ts — the one User-Agent every reader of this project
// sends (TODO/RULES.md section 5, ruling 11): the contact is domains@pkgforge.dev,
// a constant in the tree, not a secret and not a repository variable.
//
// The Worker imports it from @domains/core. scripts/lib/user-agent.mjs
// re-exports it by path, because some workflows run the scripts with nothing
// installed from npm (ref-refresh.yml, measure-feeds.yml, measure-thc-day.yml,
// measure-thc-monthly.yml), where no @domains package resolves. This file
// imports nothing, so that re-export loads no other module.
export const USER_AGENT = "domains.pkgforge.dev/1.0 (+https://github.com/pkgforge-dev/domains.pkgforge.dev; contact: domains@pkgforge.dev)";
