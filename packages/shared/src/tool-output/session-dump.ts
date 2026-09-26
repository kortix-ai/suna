import { isDigit, isLineTerminator, isWhitespace, lineEnd, whitespaceEnd } from './scan';

// `bash` output that dumps sessions (`=== <path> ===` sections of JSON and
// `--- Msg N [role] cost=$x ---` logs) and `grep` output (`/path:` blocks of
// `Line N: text`) are parsed on every render of the tool row. Their regexes
// retried a whitespace run from every position inside it, and `\s*` crossed
// lines: a grep match holding 240k spaces took 27.9 s, a section title holding
// 240k spaces ran for over 60 s, and 240k blank lines in a message took 44.5 s.
// The readers here scan each run once and return what the regexes returned.

const EQUALS = 61; // =
const COLON = 58; // :

export interface GrepMatch {
  line: number;
  content: string;
}

export interface GrepFileGroup {
  filePath: string;
  matches: GrepMatch[];
}

/** The `Line\s+\d+:` header at `at`: its digits and where it ends, or null. */
function lineHeader(text: string, at: number): { digits: string; end: number } | null {
  if (!text.startsWith('Line', at)) return null;
  const digitsStart = whitespaceEnd(text, at + 4);
  if (digitsStart === at + 4) return null;
  let i = digitsStart;
  while (i < text.length && isDigit(text.charCodeAt(i))) i++;
  if (i === digitsStart || text.charCodeAt(i) !== COLON) return null;
  return { digits: text.slice(digitsStart, i), end: i + 1 };
}

/**
 * Where `([\s\S]*?)(?=\s*(?:Line\s+\d+:|$))` stops when it starts at `from`:
 * the first position whose whitespace run ends at a header or at the end of
 * the text. Every position inside one run has the same answer, so a run is
 * judged once.
 */
function contentEnd(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    if (isWhitespace(text.charCodeAt(i))) {
      const runEnd = whitespaceEnd(text, i);
      if (runEnd === text.length || lineHeader(text, runEnd)) return i;
      i = runEnd;
    } else {
      if (lineHeader(text, i)) return i;
      i++;
    }
  }
  return text.length;
}

/**
 * Every `Line N: text` entry of a grep block as `[digits, text]`, as the loop
 * over `/Line\s+(\d+):\s*([\s\S]*?)(?=\s*(?:Line\s+\d+:|$))/g` read them.
 */
export function grepLineMatches(rest: string): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  let from = 0;
  for (;;) {
    let header: { digits: string; end: number } | null = null;
    for (let at = rest.indexOf('Line', from); at !== -1; at = rest.indexOf('Line', at + 1)) {
      header = lineHeader(rest, at);
      if (header) break;
    }
    if (!header) return entries;
    const start = whitespaceEnd(rest, header.end);
    const end = contentEnd(rest, start);
    entries.push([header.digits, rest.slice(start, end)]);
    from = end;
  }
}

/**
 * Where `\s*={0,}\s*$` (with the `m` flag) ends when it starts at `from`, or
 * -1. The regex backtracks in a fixed order: the whole whitespace, `=`, and
 * whitespace runs up to the end of the text; else the last line terminator
 * after the `=` run; else the last line terminator before it.
 */
function sectionTailEnd(text: string, from: number): number {
  let lead = from;
  let leadBreak = -1;
  while (lead < text.length && isWhitespace(text.charCodeAt(lead))) {
    if (isLineTerminator(text.charCodeAt(lead))) leadBreak = lead;
    lead++;
  }
  let equals = lead;
  while (text.charCodeAt(equals) === EQUALS) equals++;
  let trail = equals;
  let trailBreak = -1;
  while (trail < text.length && isWhitespace(text.charCodeAt(trail))) {
    if (isLineTerminator(text.charCodeAt(trail))) trailBreak = trail;
    trail++;
  }
  if (trail === text.length) return text.length;
  if (trailBreak !== -1) return trailBreak;
  return leadBreak;
}

/** The `^={2,}\s*(.*?)\s*={0,}\s*$` header (with the `m` flag) that starts at `at`, or null. */
function sectionHeaderAt(text: string, at: number): { end: number; title: string } | null {
  if (at > 0 && !isLineTerminator(text.charCodeAt(at - 1))) return null;
  if (text.charCodeAt(at) !== EQUALS || text.charCodeAt(at + 1) !== EQUALS) return null;
  let afterEquals = at + 2;
  while (text.charCodeAt(afterEquals) === EQUALS) afterEquals++;
  const titleStart = whitespaceEnd(text, afterEquals);
  // `(.*?)` cannot cross a line terminator, and the tail always matches there.
  const lastStop = lineEnd(text, titleStart);
  let i = titleStart;
  while (i < lastStop) {
    const code = text.charCodeAt(i);
    if (code === EQUALS || isWhitespace(code)) {
      // Every position in a run of `=` or of whitespace has the same tail.
      const end = sectionTailEnd(text, i);
      if (end !== -1) return { end, title: text.slice(titleStart, i) };
      if (code === EQUALS) {
        while (text.charCodeAt(i) === EQUALS) i++;
      } else {
        i = whitespaceEnd(text, i);
      }
    } else {
      i++;
    }
  }
  return { end: sectionTailEnd(text, lastStop), title: text.slice(titleStart, lastStop) };
}

/**
 * The text split at its `== title ==` header lines, each title kept between
 * the pieces, as `text.split(/^={2,}\s*(.*?)\s*={0,}\s*$/m)` split it.
 */
export function splitSessionSections(text: string): string[] {
  if (text.length === 0) return [text];
  const parts: string[] = [];
  let pieceStart = 0;
  let at = 0;
  while (at < text.length) {
    // A header is at least `==`, so it never ends where the last piece ended:
    // the split rule for an empty match at that point never applies.
    const header = sectionHeaderAt(text, at);
    if (!header) {
      at++;
      continue;
    }
    parts.push(text.slice(pieceStart, at), header.title);
    pieceStart = header.end;
    at = pieceStart;
  }
  parts.push(text.slice(pieceStart));
  return parts;
}

/**
 * The first `Tools used: …` line, as `/^\s*Tools used:\s*(.+)$/m` matched it:
 * the match's span and its captured tool list. The span starts at the first
 * line start from which only whitespace precedes `Tools used:`.
 */
export function toolsUsedLine(text: string): { index: number; end: number; tools: string } | null {
  const label = 'Tools used:';
  for (let at = text.indexOf(label); at !== -1; at = text.indexOf(label, at + 1)) {
    // Walk back over the whitespace before the label to the first line start in it.
    let runStart = at;
    let firstBreak = -1;
    while (runStart > 0 && isWhitespace(text.charCodeAt(runStart - 1))) {
      runStart--;
      if (isLineTerminator(text.charCodeAt(runStart))) firstBreak = runStart;
    }
    let index: number;
    if (runStart === 0) index = 0;
    else if (firstBreak !== -1) index = firstBreak + 1;
    else continue;
    const listStart = whitespaceEnd(text, at + label.length);
    if (listStart < text.length) {
      const end = lineEnd(text, listStart);
      return { index, end, tools: text.slice(listStart, end) };
    }
    // Only whitespace follows: `\s*` gives back its last character that `.` accepts.
    for (let last = text.length - 1; last >= at + label.length; last--) {
      if (!isLineTerminator(text.charCodeAt(last)))
        return { index, end: last + 1, tools: text[last] ?? '' };
    }
    // No later label exists: only whitespace follows this one.
    return null;
  }
  return null;
}
/** One session from a `=== <path> ===` section of JSON. */
export interface ParsedSessionMeta {
  id: string;
  slug?: string;
  title: string;
  directory?: string;
  time: { created: number; updated: number };
  summary?: { additions: number; deletions: number; files: number };
  filePath?: string;
}
/** One `--- Msg N [role] cost=$x ---` entry of a session log. */
export interface ParsedSessionMessage {
  index: number;
  role: string;
  cost: number;
  content: string;
  tools?: string;
}

/** `grep` output as file groups of numbered matches, or null when it has none. */
export function parseGrepOutput(
  output: string,
): { matchCount: number; groups: GrepFileGroup[] } | null {
  if (!output) return null;
  const text = String(output).trim();
  const headerMatch = text.match(/^Found\s+(\d+)\s+match/i);
  const matchCount = headerMatch ? Number.parseInt(headerMatch[1], 10) : 0;
  const body = headerMatch ? text.slice(headerMatch[0].length).trim() : text;
  if (!body) return null;

  const groups: GrepFileGroup[] = [];
  const blocks = body.split(/\n\n+/);

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;
    const fileMatch = trimmed.match(/^(\/[^:]+?):\s*/);
    if (!fileMatch) continue;
    const filePath = fileMatch[1];
    const rest = trimmed.slice(fileMatch[0].length);
    const matches: GrepMatch[] = [];
    for (const [line, content] of grepLineMatches(rest)) {
      matches.push({
        line: Number.parseInt(line, 10),
        content: content.trim().replace(/;$/, ''),
      });
    }
    if (matches.length > 0) groups.push({ filePath, matches });
  }

  if (groups.length === 0) return null;
  return {
    matchCount: matchCount || groups.reduce((sum, g) => sum + g.matches.length, 0),
    groups,
  };
}

/** The sessions of a `bash` output that dumps session JSON by section, or null. */
export function parseSessionMetadataOutput(output: string): ParsedSessionMeta[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('===') || !trimmed.includes('"id"')) return null;

  const parts = splitSessionSections(trimmed);
  const sessions: ParsedSessionMeta[] = [];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i].trim();
    if (!part) continue;

    try {
      const parsed = JSON.parse(part);
      if (parsed && typeof parsed === 'object' && parsed.id && parsed.time) {
        const header = i > 0 ? parts[i - 1]?.trim() : undefined;
        sessions.push({
          id: parsed.id,
          slug: parsed.slug,
          title: parsed.title || parsed.slug || 'Untitled',
          directory: parsed.directory,
          time: parsed.time,
          summary: parsed.summary,
          filePath: header || undefined,
        });
      }
    } catch {}
  }

  if (sessions.length === 0) return null;
  return sessions;
}

/** The messages of a `bash` output that prints a session log, or null. */
export function parseSessionMessagesOutput(output: string): ParsedSessionMessage[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('--- Msg ')) return null;

  const msgRegex = /---\s*Msg\s+(\d+)\s+\[(\w+)\]\s+cost=\$?([\d.]+)\s*---/g;
  const matches = [...trimmed.matchAll(msgRegex)];
  if (matches.length < 1) return null;

  const messages: ParsedSessionMessage[] = [];
  for (const [i, m] of matches.entries()) {
    const start = (m.index ?? 0) + m[0].length;
    const end = matches[i + 1]?.index ?? trimmed.length;
    const rawContent = trimmed.slice(start, end).trim();

    const toolsLine = toolsUsedLine(rawContent);
    const content = (
      toolsLine
        ? rawContent.slice(0, toolsLine.index) + rawContent.slice(toolsLine.end)
        : rawContent
    ).trim();

    messages.push({
      index: Number.parseInt(m[1], 10),
      role: m[2].toLowerCase(),
      cost: Number.parseFloat(m[3]),
      content,
      tools: toolsLine?.tools,
    });
  }

  return messages.length > 0 ? messages : null;
}
