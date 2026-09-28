import { indexOfIgnoreCase } from '../tag-blocks';
import { isDigit, isWhitespace, startsWithIgnoreCase, whitespaceEnd } from './scan';

// `get_mem` prints an observation as `=== Observation #N [type] ===` and
// labelled fields, which may share one line. Its renderers read the fields
// with lazy regexes whose lookahead retried a whitespace run from every
// position inside it: a field holding 240k spaces ran for over a minute. The
// header regex rescanned for `]` from every header that never closed one: 12k
// such headers took 1.1 s. The readers below scan each run once and return
// what the regexes returned.

const HASH = 35; // #
const PIPE = 124; // |
const BRACKET_OPEN = 91; // [
const BULLET = 0x2022; // •
const HYPHEN = 45; // -

/**
 * A field label that ends another field: the literal labels, and the two
 * regex fragments the tool field stops at. Each is written as its regex
 * source, which is what the old lookaheads held.
 */
export type Stop =
  | 'Title:'
  | 'Narrative:'
  | 'Tool:'
  | 'Prompt #'
  | 'Session:'
  | 'Created:'
  | 'Facts:'
  | 'Concepts:'
  | 'Files read:'
  | '\\|\\s*Prompt\\s*#'
  | 'Prompt\\s*#';

const ALL_LABELS: readonly Stop[] = [
  'Title:',
  'Narrative:',
  'Tool:',
  'Prompt #',
  'Session:',
  'Created:',
  'Facts:',
  'Concepts:',
  'Files read:',
];
const TOOL_STOPS: readonly Stop[] = [
  '\\|\\s*Prompt\\s*#',
  'Prompt\\s*#',
  'Session:',
  'Created:',
  'Concepts:',
  'Files read:',
];

/** Whether `stop` matches at `at`, ignoring ASCII case as the regexes' `i` flag did. */
function stopAt(text: string, at: number, stop: Stop): boolean {
  if (stop === 'Prompt\\s*#') {
    return (
      startsWithIgnoreCase(text, 'Prompt', at) &&
      text.charCodeAt(whitespaceEnd(text, at + 6)) === HASH
    );
  }
  if (stop === '\\|\\s*Prompt\\s*#') {
    return text.charCodeAt(at) === PIPE && stopAt(text, whitespaceEnd(text, at + 1), 'Prompt\\s*#');
  }
  return startsWithIgnoreCase(text, stop, at);
}

/**
 * The text after the first `label`, up to the first whitespace run that a stop
 * follows, as `new RegExp(`${label}\\s*([\\s\\S]*?)(?=\\s+(?:${stops})|$)`, 'i')`
 * captured it. A run that no stop follows belongs to the text, even at its end.
 */
export function fieldText(text: string, label: string, stops: readonly Stop[]): string | null {
  const at = indexOfIgnoreCase(text, label);
  if (at === -1) return null;
  const start = whitespaceEnd(text, at + label.length);
  let i = start;
  while (i < text.length) {
    if (!isWhitespace(text.charCodeAt(i))) {
      i++;
      continue;
    }
    // Every position in a whitespace run has the same lookahead: judge it once.
    const runEnd = whitespaceEnd(text, i);
    if (stops.some((stop) => stopAt(text, runEnd, stop))) return text.slice(start, i);
    i = runEnd;
  }
  return text.slice(start);
}

/**
 * The header's number, type, and the text after it, as
 * `/===\s*Observation\s*#(\d+)\s*\[([^\]]+)\]\s*===\s*([\s\S]*)$/i` captured them.
 */
export function observationHeader(text: string): [string, string, string] | null {
  // The next `]` at or after the last position it was searched from, and the
  // last `]` whose `\s*===` was checked, with where that `===` ends (-1: absent).
  let nextClose = -2;
  let checkedClose = -1;
  let checkedEnd = -1;
  for (let at = text.indexOf('==='); at !== -1; at = text.indexOf('===', at + 1)) {
    const word = whitespaceEnd(text, at + 3);
    if (!startsWithIgnoreCase(text, 'Observation', word)) continue;
    const hash = whitespaceEnd(text, word + 11);
    if (text.charCodeAt(hash) !== HASH) continue;
    let digits = hash + 1;
    while (isDigit(text.charCodeAt(digits))) digits++;
    if (digits === hash + 1) continue;
    const open = whitespaceEnd(text, digits);
    if (text.charCodeAt(open) !== BRACKET_OPEN) continue;
    if (nextClose < open + 1) nextClose = text.indexOf(']', open + 1);
    // No `]` after this header means none after a later one either.
    if (nextClose === -1) return null;
    // `[^\]]+` takes at least one character.
    if (nextClose === open + 1) continue;
    if (checkedClose !== nextClose) {
      checkedClose = nextClose;
      const equals = whitespaceEnd(text, nextClose + 1);
      checkedEnd = text.startsWith('===', equals) ? equals + 3 : -1;
    }
    if (checkedEnd === -1) continue;
    return [
      text.slice(hash + 1, digits),
      text.slice(open + 1, nextClose),
      text.slice(whitespaceEnd(text, checkedEnd)),
    ];
  }
  return null;
}

/**
 * A `<tool> | Prompt #<id>` line's tool and prompt id, as
 * `/^([^|]+?)\s*\|\s*Prompt\s*#([^\s]+)$/i` captured them. `[^|]+?` cannot
 * pass the first `|`, so that `|` decides the match.
 */
export function inlineToolPrompt(line: string): [string, string] | null {
  const pipe = line.indexOf('|');
  // The tool takes at least one character before the `|`.
  if (pipe < 1) return null;
  // The lazy tool ends where only whitespace is left before the `|`.
  let toolEnd = pipe;
  while (toolEnd > 1 && isWhitespace(line.charCodeAt(toolEnd - 1))) toolEnd--;
  const word = whitespaceEnd(line, pipe + 1);
  if (!startsWithIgnoreCase(line, 'Prompt', word)) return null;
  const hash = whitespaceEnd(line, word + 6);
  if (line.charCodeAt(hash) !== HASH) return null;
  // `([^\s]+)$`: the rest of the line, not empty and without whitespace.
  if (hash + 1 >= line.length) return null;
  for (let i = hash + 1; i < line.length; i++) {
    if (isWhitespace(line.charCodeAt(i))) return null;
  }
  return [line.slice(0, toolEnd), line.slice(hash + 1)];
}

/**
 * The text split at each `-` or `•` bullet, with the whitespace around it, as
 * `text.split(/\s*[•-]\s+/)` split it.
 */
export function splitBullets(text: string): string[] {
  const parts: string[] = [];
  let pieceStart = 0;
  let i = 0;
  while (i < text.length) {
    // A split can start anywhere in a whitespace run that ends at a bullet:
    // the first position is where the regex matched.
    const bullet = whitespaceEnd(text, i);
    const code = text.charCodeAt(bullet);
    if ((code === BULLET || code === HYPHEN) && isWhitespace(text.charCodeAt(bullet + 1))) {
      parts.push(text.slice(pieceStart, i));
      pieceStart = whitespaceEnd(text, bullet + 1);
      i = pieceStart;
    } else {
      i = bullet === i ? i + 1 : bullet;
    }
  }
  parts.push(text.slice(pieceStart));
  return parts;
}

export interface ParsedObservationMemory {
  kind: 'observation';
  id: string;
  type: string;
  title: string;
  narrative: string;
  tool: string | null;
  prompt: string | null;
  session: string | null;
  created: string | null;
  facts: string[];
  concepts: string[];
  filesRead: string[];
}

export interface ParsedLtmMemory {
  kind: 'ltm';
  id: string;
  type: string;
  caption: string;
  content: string;
  session: string | null;
  created: string | null;
  updated: string | null;
  tags: string[];
}

export type ParsedMemoryEntry = ParsedObservationMemory | ParsedLtmMemory;

function parseObservationReport(text: string): ParsedObservationMemory | null {
  if (!text.includes('Observation #')) return null;

  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const header = observationHeader(normalized);
  if (!header) return null;

  const [id, type, remainderRaw] = header;
  const remainder = remainderRaw.trim();

  const compactField = (label: string): string =>
    fieldText(remainder.replace(/\n+/g, ' '), label, ALL_LABELS)?.trim() ?? '';

  const title = compactField('Title:');
  const narrativeAndMeta = compactField('Narrative:');
  const factsAndMore = compactField('Facts:');
  const lines = narrativeAndMeta
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  let narrative = '';
  let tool: string | null = null;
  let prompt: string | null = null;
  let session: string | null = null;
  let created: string | null = null;

  for (const line of lines) {
    if (line.startsWith('Tool:')) {
      const inlineMeta = inlineToolPrompt(line.replace(/^Tool:\s*/i, ''));
      if (inlineMeta) {
        tool = inlineMeta[0].trim();
        prompt = inlineMeta[1].trim();
      } else {
        tool = line.replace(/^Tool:\s*/i, '').trim() || null;
      }
      continue;
    }
    if (line.startsWith('Prompt #')) {
      prompt = line.replace(/^Prompt\s*#/i, '').trim() || null;
      continue;
    }
    if (line.startsWith('Session:')) {
      session = line.replace(/^Session:\s*/i, '').trim() || null;
      continue;
    }
    if (line.startsWith('Created:')) {
      created = line.replace(/^Created:\s*/i, '').trim() || null;
      continue;
    }
    narrative = narrative ? `${narrative} ${line}` : line;
  }

  const facts: string[] = [];
  let concepts: string[] = [];
  let filesRead: string[] = [];

  for (const rawLine of factsAndMore.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith('- ') || line.startsWith('• ')) {
      facts.push(line.slice(2).trim());
      continue;
    }
    if (line.startsWith('Concepts:')) {
      concepts = line
        .replace(/^Concepts:\s*/i, '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
      continue;
    }
    if (line.startsWith('Files read:')) {
      filesRead = line
        .replace(/^Files read:\s*/i, '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  if (facts.length === 0 && factsAndMore.trim()) {
    facts.push(
      ...splitBullets(factsAndMore)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  if (!tool) {
    const tokenTool = remainder.match(/Tool:\s*([A-Za-z0-9_./:-]+)/i)?.[1]?.trim();
    if (tokenTool) {
      tool = tokenTool;
    } else {
      const toolMatch = fieldText(remainder, 'Tool:', TOOL_STOPS);
      tool =
        toolMatch
          ?.replace(/\bTool:\s*/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim() || null;
    }
  }

  if (!prompt) {
    prompt = remainder.match(/Prompt\s*#([^\s|]+)/i)?.[1]?.trim() || null;
  }

  if (!session) {
    session =
      fieldText(remainder, 'Session:', [
        'Created:',
        'Facts:',
        'Concepts:',
        'Files read:',
      ])?.trim() || null;
  }

  if (!created) {
    // `Facts:` belongs in this lookahead exactly as it does in `compactField`.
    // Without it, an observation that lists its facts AFTER `Created:` put the
    // whole fact block into the date — the view then rendered
    // "2026-07-01 Facts: - Removed duplicate middleware" in the one-line meta
    // row beside a calendar icon.
    created =
      fieldText(remainder, 'Created:', ['Facts:', 'Concepts:', 'Files read:'])?.trim() || null;
  }

  if (concepts.length === 0) {
    const compactConcepts = fieldText(remainder, 'Concepts:', ['Files read:']) ?? '';
    concepts = compactConcepts
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  if (filesRead.length === 0) {
    const compactFiles = remainder.match(/Files read:\s*([\s\S]*?)$/i)?.[1] ?? '';
    filesRead = compactFiles
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  const hasUsefulBody =
    !!narrative ||
    !!tool ||
    !!prompt ||
    !!session ||
    !!created ||
    facts.length > 0 ||
    concepts.length > 0 ||
    filesRead.length > 0;

  if (!title.trim() || !hasUsefulBody) return null;

  return {
    kind: 'observation',
    id,
    type,
    title: title.trim(),
    narrative,
    tool,
    prompt,
    session,
    created,
    facts,
    concepts,
    filesRead,
  };
}

function parseLtmFields(body: string): Map<string, string> {
  const labels = ['Caption:', 'Content:', 'Session:', 'Created:', 'Tags:'];
  const lower = body.toLowerCase();
  const positions = labels
    .map((label) => ({ label, index: lower.indexOf(label.toLowerCase()) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  const fields = new Map<string, string>();
  for (const [index, current] of positions.entries()) {
    const next = positions[index + 1];
    const start = current.index + current.label.length;
    fields.set(current.label, body.slice(start, next?.index ?? body.length).trim());
  }
  return fields;
}

function parseLtmEntry(text: string): ParsedLtmMemory | null {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  if (!normalized.includes('===') || !normalized.includes('LTM #')) return null;

  const upper = normalized.toUpperCase();
  const prefixIndex = upper.indexOf('LTM #');
  const typeStart = normalized.indexOf('[', prefixIndex + 5);
  const typeEnd = typeStart >= 0 ? normalized.indexOf(']', typeStart + 1) : -1;
  const headerEnd = typeEnd >= 0 ? normalized.indexOf('===', typeEnd + 1) : -1;
  if (prefixIndex < 0 || typeStart < 0 || typeEnd < 0 || headerEnd < 0) return null;
  const id = normalized.slice(prefixIndex + 5, typeStart).trim();
  const type = normalized.slice(typeStart + 1, typeEnd).trim();
  const body = normalized.slice(headerEnd + 3);
  const compactBody = body.replace(/\s+/g, ' ').trim();
  const fields = parseLtmFields(compactBody);
  const caption = fields.get('Caption:') ?? '';
  const content = fields.get('Content:') ?? '';
  const session = fields.get('Session:') || null;
  const createdAndUpdated = fields.get('Created:') ?? '';
  const created = createdAndUpdated.split('|')[0]?.trim() || null;
  let updated = createdAndUpdated.includes('|')
    ? createdAndUpdated.split('|')[1]?.trim() || null
    : null;
  while (updated?.toLowerCase().startsWith('updated:')) {
    updated = updated.slice('updated:'.length).trim() || null;
  }
  const tagsRaw = fields.get('Tags:') ?? '';
  const tags = tagsRaw
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);

  if (!id.trim() || !type.trim() || (!caption && !content)) return null;

  return {
    kind: 'ltm',
    id: id.trim(),
    type: type.trim(),
    caption,
    content,
    session,
    created,
    updated,
    tags,
  };
}

export function parseMemoryEntryOutput(text: string): ParsedMemoryEntry | null {
  return parseObservationReport(text) || parseLtmEntry(text);
}
