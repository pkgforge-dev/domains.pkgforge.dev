// scripts/todo/prove.mjs — reads an entry's `- **Prove:**` line and decides
// whether it names an acceptance criterion that can fail.
//
// A Prove line whose only criterion is the record guard itself is VACUOUS: the
// guard checks the record's internal consistency, so it exits 0 whether or not
// the entry's claim holds. The guard is allowed as a secondary assertion beside
// a real criterion.
//
// A criterion is defined by what it names, never by its form:
//   1. a backticked COMMAND: a known program name with arguments, a path with
//      an executable extension, or a program with a flag;
//   2. prose that names a TEST: a mechanism producing a verdict (a suite, a
//      planted defect, a red-then-green, an exit code, a stated pass/fail).
// A document path or a bare word is context, not a criterion. HTML comments
// are removed before the line is read.
//
// Verdicts:
//   vacuous       cites the guard and nothing else that can fail   -> gate fails
//   unverifiable  names neither a command nor a test               -> reported
//   otherwise     names a criterion                                -> ok

export const GUARD_CITE = 'node scripts/todo/check.mjs';

const GUARD_RE = /(?:^|[\s`'"])(?:node\s+)?(?:scripts\/todo\/)?check(?:\.mjs)?(?=$|[\s`'";:,)])/;

const EXECUTABLE_EXT = /\.(?:mjs|cjs|js|mts|ts|sh|bash|py|ps1)(?=$|[\s`'"])/;

const PROGRAM_NAME =
  /^(?:node|npm|npx|pnpm|deno|bun|python3?|sh|bash|git|gh|oras|crane|docker|podman|cf|wrangler|tsc|curl|grep|rg|find|sed|awk|jq|diff|test|cat|ls|wc|sort|uniq|env|timeout|xargs|openssl|dig|nslookup)\b/;
const FLAG = /(^|\s)--?[A-Za-z][\w-]*/;

const TEST_NOUN =
  /\b(?:tests?|suite|spec|specs|assertions?|probes?|harness|fixtures?|red-?then-?green|planted|plant|resolves?|holds?|carries?|green|red|pass(?:es|ing)?|fail(?:s|ing|ure)?|exit\s+\d|non-?zero|returns?\s+\d{3}|answers?\s+\d{3}|differential|golden|equal|identical)\b/i;

function backticked(line) {
  return [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1].trim());
}

export function isCommandLike(token) {
  const first = token.split(/\s+/)[0] ?? '';
  if (/\s/.test(token) && PROGRAM_NAME.test(first)) return true;
  if (PROGRAM_NAME.test(token) && FLAG.test(token)) return true;
  const base = token.split(/[\\/]/).pop() ?? token;
  return EXECUTABLE_EXT.test(base);
}

export function proveCriterion(line) {
  const clean = line.replace(/<!--[\s\S]*?-->/g, ' ');
  const cited = backticked(clean);
  const mentionsGuard = cited.some((c) => GUARD_RE.test(c));
  const commands = cited.filter((c) => !GUARD_RE.test(c)).filter(isCommandLike);
  // The guard's own verdict ("exits 0", "green") trails it on every line that
  // cites it, so prose only counts as a criterion when the line cites no guard
  // or when it names a test word outside the guard's own verdict.
  const withoutGuardVerdict = clean.replace(/`[^`]*check(?:\.mjs)?[^`]*`\s*(?:exits?\s+0|is\s+green|green|passes)?/gi, ' ');
  const proseIsATest = TEST_NOUN.test(withoutGuardVerdict.replace(/`[^`]+`/g, ' '));
  const vacuous = mentionsGuard && commands.length === 0 && !proseIsATest;
  const unverifiable = !mentionsGuard && commands.length === 0 && !proseIsATest;
  return { mentionsGuard, commands, proseIsATest, vacuous, unverifiable };
}

export function proveLineOf(section) {
  const m = section.match(/^- \*\*Prove:\*\* (.*)$/m);
  return m ? m[0] : null;
}

// [{id, file, section}] -> [{id, file, prove, vacuous, unverifiable, commands}]
export function proveVerdicts(entries) {
  const out = [];
  for (const e of entries) {
    const line = proveLineOf(e.section);
    if (!line) continue;
    const r = proveCriterion(line);
    out.push({ id: e.id, file: e.file, prove: line.replace(/^- \*\*Prove:\*\* /, ''), ...r });
  }
  return out;
}
