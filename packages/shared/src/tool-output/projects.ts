/**
 * Parsers for Kortix orchestrator tool outputs (projects, connectors).
 *
 * Mobile re-exports these; apps/web `lib/utils/kortix-tool-output.ts` holds a
 * regex copy of the same code.
 */

import { isDigit, isLineTerminator, isWhitespace, lineEnd, whitespaceEnd } from './scan';

// The project and connector renderers read markdown table rows and
// `name (source)` lines with line-anchored regexes. Their lazy cells retried a
// whitespace run from every position inside it: a row holding 240k spaces ran
// for over a minute. `(proj-…)` and `name (source)` rescanned the rest of the
// output for every opener that never closed: 40k `(proj-` took 3.9 s, and 80k
// lines of `a(` took 9.3 s. The readers below search each delimiter once.
//
// The `label\s*(.+)$` lines were linear (0.4 ms at 240k characters), but here
// an export's parameter is library input to CodeQL, which reports them as
// `js/polynomial-redos`. `labelValue` reads them without a regex.

const PIPE = 124; // |
const STAR = 42; // *
const BACKTICK = 96; // `
const PAREN_OPEN = 40; // (

/** The first `character` at or after a position, remembered while the queries move forward. */
function nextOf(text: string, character: string): (at: number) => number {
  let from = Number.POSITIVE_INFINITY;
  let found = -1;
  return (at: number): number => {
    if (at >= from && (found === -1 || at <= found)) return found;
    from = at;
    found = text.indexOf(character, at);
    return found;
  };
}

/** Each line start in order, as `^` with the `m` flag matched them: after every line terminator. */
function* lineStarts(text: string): Generator<number> {
  let at = 0;
  while (at <= text.length) {
    yield at;
    while (at < text.length && !isLineTerminator(text.charCodeAt(at))) at++;
    at++;
  }
}

/** `$` with the `m` flag at `at`. */
function lineEndsAt(text: string, at: number): boolean {
  return at === text.length || isLineTerminator(text.charCodeAt(at));
}

/** The end of the whitespace before `end`, but not before `start`: where a lazy cell stops. */
function trimmedEnd(text: string, start: number, end: number): number {
  let i = end;
  while (i > start && isWhitespace(text.charCodeAt(i - 1))) i--;
  return i;
}

/**
 * The cells of every `| **name** | `path` | [sessions |] description |` row,
 * as the loop over
 * `/^\|\s*\*\*([^*]+)\*\*\s*\|\s*`([^`]+)`\s*\|\s*(\d+)\s*\|\s*([^|]*?)\s*\|$/gm`
 * (four columns) or the same without the sessions cell (three) read them.
 */
export function projectRows(text: string, columns: 3 | 4): string[][] {
  const rows: string[][] = [];
  const nextStar = nextOf(text, '*');
  const nextBacktick = nextOf(text, '`');
  const nextPipe = nextOf(text, '|');
  const rowAt = (start: number): { cells: string[]; end: number } | null => {
    const stars = whitespaceEnd(text, start + 1);
    if (text.charCodeAt(stars) !== STAR || text.charCodeAt(stars + 1) !== STAR) return null;
    // `[^*]+` runs to the first `*`, which must open the closing `**`.
    const nameEnd = nextStar(stars + 2);
    if (nameEnd === -1 || nameEnd === stars + 2 || text.charCodeAt(nameEnd + 1) !== STAR)
      return null;
    const pipe = whitespaceEnd(text, nameEnd + 2);
    if (text.charCodeAt(pipe) !== PIPE) return null;
    const tick = whitespaceEnd(text, pipe + 1);
    if (text.charCodeAt(tick) !== BACKTICK) return null;
    const pathEnd = nextBacktick(tick + 1);
    if (pathEnd === -1 || pathEnd === tick + 1) return null;
    let cellPipe = whitespaceEnd(text, pathEnd + 1);
    if (text.charCodeAt(cellPipe) !== PIPE) return null;
    const cells = [text.slice(stars + 2, nameEnd), text.slice(tick + 1, pathEnd)];
    if (columns === 4) {
      const digits = whitespaceEnd(text, cellPipe + 1);
      let digitsEnd = digits;
      while (isDigit(text.charCodeAt(digitsEnd))) digitsEnd++;
      if (digitsEnd === digits) return null;
      cellPipe = whitespaceEnd(text, digitsEnd);
      if (text.charCodeAt(cellPipe) !== PIPE) return null;
      cells.push(text.slice(digits, digitsEnd));
    }
    // `\s*([^|]*?)\s*\|$`: the last cell cannot pass a `|`, so it ends at the next one.
    const description = whitespaceEnd(text, cellPipe + 1);
    const close = nextPipe(description);
    if (close === -1 || !lineEndsAt(text, close + 1)) return null;
    cells.push(text.slice(description, trimmedEnd(text, description, close)));
    return { cells, end: close + 1 };
  };
  let from = 0;
  for (const start of lineStarts(text)) {
    if (start < from || text.charCodeAt(start) !== PIPE) continue;
    const row = rowAt(start);
    if (!row) continue;
    rows.push(row.cells);
    from = row.end;
  }
  return rows;
}

/** The project id in `(proj-…)`, as `/\((proj-[^)]+)\)/` captured it. */
export function projectId(text: string): string | null {
  let nextClose = -2;
  for (let at = text.indexOf('(proj-'); at !== -1; at = text.indexOf('(proj-', at + 1)) {
    const start = at + 6;
    if (nextClose < start) nextClose = text.indexOf(')', start);
    // No `)` after this opener means none after a later one either.
    if (nextClose === -1) return null;
    // `[^)]+` takes at least one character.
    if (nextClose === start) continue;
    return text.slice(at + 1, nextClose);
  }
  return null;
}

/**
 * The three cells of every `| name | description | source |` row, as the loop
 * over `/^\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*([^|]*?)\s*\|$/gm` read them.
 */
export function connectorRows(text: string): string[][] {
  const rows: string[][] = [];
  const nextPipe = nextOf(text, '|');
  // `\s*([^|]+)` before the `|` at `pipe`: the cell runs to that `|`; when only
  // whitespace is left, `\s*` gives the cell its last character.
  const cellStart = (from: number, pipe: number): number => {
    const start = whitespaceEnd(text, from);
    if (start < pipe) return start;
    return pipe - 1 >= from ? pipe - 1 : -1;
  };
  const rowAt = (start: number): { cells: string[]; end: number } | null => {
    const first = nextPipe(start + 1);
    if (first === -1) return null;
    const nameStart = cellStart(start + 1, first);
    if (nameStart === -1) return null;
    const second = nextPipe(first + 1);
    if (second === -1) return null;
    const descriptionStart = cellStart(first + 1, second);
    if (descriptionStart === -1) return null;
    const source = whitespaceEnd(text, second + 1);
    const close = nextPipe(source);
    if (close === -1 || !lineEndsAt(text, close + 1)) return null;
    return {
      cells: [
        text.slice(nameStart, first),
        text.slice(descriptionStart, second),
        text.slice(source, trimmedEnd(text, source, close)),
      ],
      end: close + 1,
    };
  };
  let from = 0;
  for (const start of lineStarts(text)) {
    if (start < from || text.charCodeAt(start) !== PIPE) continue;
    const row = rowAt(start);
    if (!row) continue;
    rows.push(row.cells);
    from = row.end;
  }
  return rows;
}

/** The name and source of every `name (source)` line, as `/^([^\s(]+)\s*\(([^)]+)\)/gm` read them. */
export function setupRows(text: string): string[][] {
  const rows: string[][] = [];
  const nextClose = nextOf(text, ')');
  let from = 0;
  for (const start of lineStarts(text)) {
    if (start < from || start >= text.length) continue;
    let nameEnd = start;
    while (nameEnd < text.length) {
      const code = text.charCodeAt(nameEnd);
      if (code === PAREN_OPEN || isWhitespace(code)) break;
      nameEnd++;
    }
    if (nameEnd === start) continue;
    const open = whitespaceEnd(text, nameEnd);
    if (text.charCodeAt(open) !== PAREN_OPEN) continue;
    const close = nextClose(open + 1);
    // No `)` after this line's `(` means none after a later line's either.
    if (close === -1) break;
    if (close === open + 1) continue;
    rows.push([text.slice(start, nameEnd), text.slice(open + 1, close)]);
    from = close + 1;
  }
  return rows;
}

/** Each position where `label` starts, in order: all of them, or only line starts (`^` with the `m` flag). */
function* labelStarts(text: string, label: string, anchored: boolean): Generator<number> {
  if (anchored) {
    for (const start of lineStarts(text)) if (text.startsWith(label, start)) yield start;
    return;
  }
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) yield at;
}

/**
 * The capture of `/label\s*(.+)$/m` (`space` `*`) or `/label\s+(.+)$/m`
 * (`space` `+`), with `^` in front when `anchored`: the rest of the line after
 * the whitespace that follows the first label where the regex matched.
 */
export function labelValue(
  text: string,
  label: string,
  space: '*' | '+',
  anchored: boolean,
): string | null {
  const least = space === '+' ? 1 : 0;
  for (const start of labelStarts(text, label, anchored)) {
    const from = start + label.length;
    const end = whitespaceEnd(text, from);
    if (end < text.length) {
      // `.+` takes the character after the run and the rest of its line.
      if (end - from >= least) return text.slice(end, lineEnd(text, end));
      continue;
    }
    // The run reaches the end of the text: the quantifier gives characters
    // back until `.+` can take one that is not a line terminator. Only line
    // terminators follow that one, so `.+` takes it alone.
    for (let at = end - 1; at >= from + least; at--) {
      if (!isLineTerminator(text.charCodeAt(at))) return text.charAt(at);
    }
  }
  return null;
}

// ============================================================================
// Project Tools
// ============================================================================

export interface ProjectEntry {
  name: string;
  path: string;
  sessions: number;
  description: string;
}

export function parseProjectListOutput(output: string): ProjectEntry[] {
  if (!output || typeof output !== 'string') return [];
  const projects: ProjectEntry[] = [];

  // Try 4-column format first: | **name** | `/path` | sessions | description |
  for (const [name, path, sessions, description] of projectRows(output, 4)) {
    projects.push({
      name: name.trim(),
      path: path.trim(),
      sessions: Number.parseInt(sessions, 10) || 0,
      description: description.trim() || '—',
    });
  }
  if (projects.length > 0) return projects;

  // Fallback: 3-column format: | **name** | `/path` | description |
  for (const [name, path, description] of projectRows(output, 3)) {
    projects.push({
      name: name.trim(),
      path: path.trim(),
      sessions: 0,
      description: description.trim() || '—',
    });
  }
  return projects;
}

export interface ProjectGetData {
  name: string;
  path: string;
  description: string | null;
  id: string;
  sessions: Array<{ status: string; count: number }>;
  contextExists: boolean;
  contextPath: string;
}

export function parseProjectGetOutput(output: string): ProjectGetData | null {
  if (!output || typeof output !== 'string') return null;

  const name = labelValue(output, '##', '+', true);
  const pathMatch = output.match(/\*\*Path:\*\*\s+`([^`]+)`/);
  const description = labelValue(output, '**Description:**', '+', false);
  const idMatch = output.match(/\*\*ID:\*\*\s+`([^`]+)`/);
  const contextMatch = output.match(/\*\*Context:\*\*\s+`([^`]+)`\s*(✓)?/);
  const contextExists = !!contextMatch?.[2];
  const contextPath = contextMatch?.[1] || '';

  // Sessions section
  const sessions: Array<{ status: string; count: number }> = [];
  const bulletRe = /^-\s+(running|completed|failed|pending):\s+(\d+)/gm;
  for (const [, status = '', count = ''] of output.matchAll(bulletRe)) {
    sessions.push({
      status,
      count: Number.parseInt(count, 10) || 0,
    });
  }

  return {
    name: name || 'Unknown Project',
    path: pathMatch?.[1] || '',
    description: description || null,
    id: idMatch?.[1] || '',
    sessions,
    contextExists,
    contextPath,
  };
}

export interface ProjectSelectData {
  name: string;
  path: string;
  success: boolean;
}

export function parseProjectSelectOutput(output: string): ProjectSelectData | null {
  if (!output || typeof output !== 'string') return null;
  const nameMatch = output.match(/Project\s+\*\*([^*]+)\*\*\s+selected/i);
  const pathMatch = output.match(/Path:\s+`([^`]+)`/);
  if (!nameMatch) return null;
  return {
    name: nameMatch[1],
    path: pathMatch?.[1] || '',
    success: output.includes('selected'),
  };
}

export interface ProjectCreateData {
  name: string;
  path: string;
  id: string;
  success: boolean;
}

export function parseProjectCreateOutput(output: string): ProjectCreateData | null {
  if (!output || typeof output !== 'string') return null;
  const nameMatch = output.match(/Project\s+\*\*([^*]+)\*\*\s+at/i);
  const pathMatch = output.match(/at\s+`([^`]+)`/);
  const id = projectId(output);
  if (!nameMatch) return null;
  return {
    name: nameMatch[1],
    path: pathMatch?.[1] || '',
    id: id || '',
    success: !output.toLowerCase().includes('failed'),
  };
}

// ============================================================================
// Connector Tools
// ============================================================================

export interface ConnectorEntry {
  name: string;
  description: string;
  source: string;
}

export function parseConnectorListOutput(output: string): ConnectorEntry[] {
  if (!output || typeof output !== 'string') return [];
  const connectors: ConnectorEntry[] = [];
  // Parse markdown table: | Name | Description | Source |
  for (const [nameCell, description, source] of connectorRows(output)) {
    const name = nameCell.trim();
    // Skip header row and separator row
    if (name === 'Name' || name.startsWith('---') || name.startsWith('–')) continue;
    connectors.push({
      name,
      description: description.trim(),
      source: source.trim(),
    });
  }
  return connectors;
}

export interface ConnectorGetData {
  name: string;
  description: string;
  source: string;
  env?: string;
  notes?: string;
}

export function parseConnectorGetOutput(output: string): ConnectorGetData | null {
  if (!output || typeof output !== 'string') return null;

  const name = labelValue(output, 'name:', '*', true);
  const description = labelValue(output, 'description:', '*', true);
  const source = labelValue(output, 'source:', '*', true);
  const env = labelValue(output, 'env:', '*', true);
  const notesMatch = output.match(/^notes:\s*\n([\s\S]*?)$/);

  if (name === null) return null;

  return {
    name: name.trim(),
    description: description?.trim() || '',
    source: source?.trim() || 'unknown',
    env: env?.trim(),
    notes: notesMatch?.[1].trim(),
  };
}

export interface ConnectorSetupData {
  count: number;
  connectors: string[];
  success: boolean;
}

export function parseConnectorSetupOutput(output: string): ConnectorSetupData | null {
  if (!output || typeof output !== 'string') return null;

  // Match "Created/updated X connectors:" or legacy "Scaffolded X connectors"
  const countMatch = output.match(/(?:Created\/updated|Scaffolded)\s+(\d+)\s+connectors/i);
  const count = countMatch ? Number.parseInt(countMatch[1], 10) : 0;

  const connectors: string[] = [];
  // Parse: name (source)
  for (const [name, source] of setupRows(output)) {
    connectors.push(`${name.trim()} (${source.trim()})`);
  }

  return {
    count,
    connectors,
    success: count > 0,
  };
}
