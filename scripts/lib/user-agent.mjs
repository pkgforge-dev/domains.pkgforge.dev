// scripts/lib/user-agent.mjs — the one User-Agent every reader sends.
// TODO/RULES.md section 5, ruling 11: the contact is domains@pkgforge.dev, a
// constant in the tree, not a secret and not a repository variable. Its home is
// packages/core/src/contact.ts, which the Worker imports from @domains/core;
// this file re-exports it by path, so a script that runs with nothing installed
// from npm still reads it.
export { USER_AGENT } from '../../packages/core/src/contact.ts';
