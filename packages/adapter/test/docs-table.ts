// The tables of docs/sources.md, as the docs test reads them.
//
//   parseSourcesDoc(markdown)  →  { rows, plain }
//
// `rows` holds each table row whose first cell is a backticked id, with its
// `Bit` cell and its `Labels` cell. Columns are found by their header, never by
// position. `plain` holds the first cell of each row of a table with no `Bit`
// column (the "Inputs without a bit" table), where a source with no bit has its
// row. The parser refuses, with DocsError, what it cannot read for certain: a
// backticked id in a table with no Bit column, a row whose cell count differs
// from its header's, a Bit cell that is neither a number nor `none`, a Labels
// cell without one of F, K, B and P, and an id listed twice.
//
// A Labels cell reads `F \`ct\`, K \`ct_name\`, B \`ct-first\`, P day`; B may list
// several bases joined by `or`, or read `B none` for a source that writes no
// newness evidence. An item none of F, K, B and P names is kept in `extra`
// (`\`partial: true\``).
import type { Source } from "../src/types.ts";

export interface Labels {
  readonly family: string;
  readonly kind: string;
  readonly basis: readonly string[];
  readonly precision: string;
  readonly extra: readonly string[];
}

export interface DocRow {
  readonly id: string;
  readonly bit: number | null;
  // Null for a row with no bit: its Labels cell is prose.
  readonly labels: Labels | null;
  readonly line: number;
}

export class DocsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DocsError";
  }
}

// The cells of a table line. A pipe inside a code span or escaped as `\|` is text.
export function cells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]!;
    if (ch === "\\" && body[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "`") {
      code = !code;
      cell += ch;
    } else if (ch === "|" && !code) {
      out.push(cell.trim());
      cell = "";
    } else cell += ch;
  }
  out.push(cell.trim());
  return out;
}

const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const BACKTICKED = /^`([^`]+)`$/;

export function parseLabels(cell: string, where: string): Labels {
  let family: string | null = null;
  let kind: string | null = null;
  let basis: string[] | null = null;
  let precision: string | null = null;
  const extra: string[] = [];
  for (const item of cell.split(/,\s*/)) {
    let m: RegExpExecArray | null;
    if ((m = /^F `([^`]+)`$/.exec(item))) family = m[1]!;
    else if ((m = /^K `([^`]+)`$/.exec(item))) kind = m[1]!;
    else if ((m = /^B (`[^`]+`(?: or `[^`]+`)*)$/.exec(item))) basis = [...m[1]!.matchAll(/`([^`]+)`/g)].map((x) => x[1]!);
    else if (item === "B none") basis = [];
    else if ((m = /^P (day|second)$/.exec(item))) precision = m[1]!;
    else extra.push(item);
  }
  if (family === null || kind === null || basis === null || precision === null) throw new DocsError(`${where}: the Labels cell ${JSON.stringify(cell)} does not name each of F, K, B and P`);
  return { family, kind, basis, precision, extra };
}

export function parseSourcesDoc(markdown: string): { rows: DocRow[]; plain: string[] } {
  const lines = markdown.split(/\r?\n/);
  const rows: DocRow[] = [];
  const plain: string[] = [];
  const seen = new Map<string, number>();
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i]!.trimStart().startsWith("|") || !SEPARATOR.test(lines[i + 1]!.trim())) continue;
    const header = cells(lines[i]!);
    const bitAt = header.indexOf("Bit");
    const labelsAt = header.indexOf("Labels");
    let j = i + 2;
    for (; j < lines.length && lines[j]!.trimStart().startsWith("|"); j++) {
      const line = j + 1;
      const row = cells(lines[j]!);
      const id = BACKTICKED.exec(row[0]!)?.[1];
      if (id === undefined) {
        if (bitAt === -1) plain.push(row[0]!);
        continue;
      }
      if (bitAt === -1) throw new DocsError(`docs/sources.md:${line}: the id ${id} is backticked in a table with no Bit column`);
      if (row.length !== header.length) throw new DocsError(`docs/sources.md:${line}: ${row.length} cells under a header of ${header.length}`);
      const first = seen.get(id);
      if (first !== undefined) throw new DocsError(`docs/sources.md:${line}: ${id} is also on line ${first}`);
      seen.set(id, line);
      const bitCell = row[bitAt]!;
      let bit: number | null;
      if (/^\d+$/.test(bitCell)) bit = Number(bitCell);
      else if (bitCell === "none") bit = null;
      else throw new DocsError(`docs/sources.md:${line}: the Bit cell of ${id} is ${JSON.stringify(bitCell)}, not a number or none`);
      const labels = bit !== null && labelsAt !== -1 ? parseLabels(row[labelsAt]!, `docs/sources.md:${line}`) : null;
      rows.push({ id, bit, labels, line });
    }
    i = j - 1;
  }
  return { rows, plain };
}

// Where a registry source and its row of docs/sources.md disagree: no row, or
// another bit, family, kind, basis or precision. A source with no bit has its
// row in a table with no Bit column.
export function compareWithDocs(sources: readonly Source[], doc: { rows: readonly DocRow[]; plain: readonly string[] }): string[] {
  const byId = new Map(doc.rows.map((r) => [r.id, r]));
  const out: string[] = [];
  for (const s of sources) {
    const row = byId.get(s.id);
    if (s.bit === null) {
      if (row !== undefined && row.bit !== null) out.push(`${s.id}: no bit in source.json, bit ${row.bit} in docs/sources.md`);
      else if (row === undefined && !doc.plain.includes(s.id)) out.push(`${s.id}: no row in docs/sources.md`);
      continue;
    }
    if (row === undefined) {
      out.push(`${s.id}: no row in docs/sources.md`);
      continue;
    }
    if (row.bit !== s.bit) out.push(`${s.id}: bit ${s.bit} in source.json, ${row.bit} in docs/sources.md`);
    const l = row.labels;
    if (l === null) continue;
    if (l.family !== s.family) out.push(`${s.id}: family ${s.family} in source.json, ${l.family} in docs/sources.md`);
    if (l.kind !== s.kind) out.push(`${s.id}: kind ${s.kind} in source.json, ${l.kind} in docs/sources.md`);
    if (l.precision !== s.precision) out.push(`${s.id}: precision ${s.precision} in source.json, ${l.precision} in docs/sources.md`);
    if ([...l.basis].sort().join(",") !== [...s.basis].sort().join(",")) out.push(`${s.id}: basis ${s.basis.join(" or ")} in source.json, ${l.basis.join(" or ")} in docs/sources.md`);
  }
  return out;
}
