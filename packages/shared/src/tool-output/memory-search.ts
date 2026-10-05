import {
  isDigit,
  isLineTerminator,
  isWhitespace,
  lineEnd,
  startsWithIgnoreCase,
  whitespaceEnd,
} from './scan';

// Memory search tools print `=== LTM Search: "query" (N results) ===`, then
// `[LTM/type] #id` blocks with an indented content line, or compact
// `#id [type] — text` hits. The renderers read them with regexes that
// rescanned from every start they tried: `===` followed by 240k newlines took
// 14.5 s, 30k `[LTM/a]#` starts took 8.6 s, and 240k `#` took 39.2 s. The
// readers below memoize what a start's outcome depends on and return what the
// regexes returned.

const QUOTE = 34; // "
const HASH = 35; // #
const PAREN_OPEN = 40; // (
const PAREN_CLOSE = 41; // )
const NEWLINE = 10; // \n
const BRACKET_OPEN = 91; // [
const BRACKET_CLOSE = 93; // ]
const EM_DASH = 0x2014; // —
const HYPHEN = 45; // -

/** `(N results) ===` after optional whitespace at `from`: the count and where the header ends. */
function resultCountAt(text: string, from: number): { count: string; end: number } | null {
  const open = whitespaceEnd(text, from);
  if (text.charCodeAt(open) !== PAREN_OPEN) return null;
  let digits = open + 1;
  while (isDigit(text.charCodeAt(digits))) digits++;
  if (digits === open + 1) return null;
  const word = whitespaceEnd(text, digits);
  if (!startsWithIgnoreCase(text, 'result', word)) return null;
  // `results?\)`: the `s` only when `)` follows it.
  let close = word + 6;
  if ((text.charCodeAt(close) | 32) === 115 && text.charCodeAt(close + 1) === PAREN_CLOSE) close++;
  if (text.charCodeAt(close) !== PAREN_CLOSE) return null;
  const equals = whitespaceEnd(text, close + 1);
  if (!text.startsWith('===', equals)) return null;
  return { count: text.slice(open + 1, digits), end: whitespaceEnd(text, equals + 3) };
}

/**
 * The search header, as
 * `/^===\s*([^:]+?Search):\s*"?([^"\n]*)"?\s*\((\d+)\s*results?\)\s*===\s*\n?/im`
 * matched it: its span, label, query, and result count.
 */
export function searchHeader(
  text: string,
): { index: number; end: number; label: string; query: string; count: string } | null {
  // `[^:]+?` cannot pass a colon, so the label ends at the first colon after
  // it. Everything after that colon depends only on the colon.
  let nextColon = -2;
  let checkedColon = -1;
  let checked: { end: number; query: string; count: string } | null = null;
  const afterColon = (colon: number) => {
    const space = whitespaceEnd(text, colon + 1);
    const queryStart = text.charCodeAt(space) === QUOTE ? space + 1 : space;
    let queryEnd = queryStart;
    while (queryEnd < text.length) {
      const code = text.charCodeAt(queryEnd);
      if (code === QUOTE || code === NEWLINE) break;
      queryEnd++;
    }
    // `([^"\n]*)` is greedy: the count at the end of its run first (after the
    // closing quote), then the last `(` inside the run that starts one.
    const atEnd = resultCountAt(
      text,
      text.charCodeAt(queryEnd) === QUOTE ? queryEnd + 1 : queryEnd,
    );
    if (atEnd) return { ...atEnd, query: text.slice(queryStart, queryEnd) };
    for (
      let open = text.lastIndexOf('(', queryEnd - 1);
      open >= queryStart;
      open = open > 0 ? text.lastIndexOf('(', open - 1) : -1
    ) {
      const found = resultCountAt(text, open);
      if (found) return { ...found, query: text.slice(queryStart, open) };
    }
    return null;
  };
  for (let at = text.indexOf('==='); at !== -1; at = text.indexOf('===', at + 1)) {
    if (at > 0 && !isLineTerminator(text.charCodeAt(at - 1))) continue;
    const labelStart = whitespaceEnd(text, at + 3);
    if (nextColon < labelStart) nextColon = text.indexOf(':', labelStart);
    // No colon after this header means none after a later one either.
    if (nextColon === -1) return null;
    if (!startsWithIgnoreCase(text, 'search', nextColon - 6)) continue;
    // The label takes at least one character before `Search`; `\s*` gives one back if it must.
    const start = Math.min(labelStart, nextColon - 7);
    if (start < at + 3) continue;
    if (checkedColon !== nextColon) {
      checkedColon = nextColon;
      checked = afterColon(nextColon);
    }
    if (!checked) continue;
    return {
      index: at,
      end: checked.end,
      label: text.slice(start, nextColon),
      query: checked.query,
      count: checked.count,
    };
  }
  return null;
}

/** `\n\s*\[(?:LTM|obs)\/` at `at`, or the end of the text: where a detailed block may end. */
function blockEndsAt(text: string, at: number): boolean {
  if (at === text.length) return true;
  if (text.charCodeAt(at) !== NEWLINE) return false;
  const bracket = whitespaceEnd(text, at + 1);
  return text.startsWith('[LTM/', bracket) || text.startsWith('[obs/', bracket);
}

/**
 * Where `\s*(.+?)` followed by a block end matches from `from`, as [start,
 * end), or null. `(.+?)` cannot cross a line terminator, so it can only end at
 * one. The regex tries the text after the whitespace first; then it gives
 * whitespace back, so the text becomes the one whitespace character before
 * the end of the text, or before a line terminator, last first.
 */
function textToBlockEnd(text: string, from: number): [number, number] | null {
  const start = whitespaceEnd(text, from);
  if (start < text.length) {
    const end = lineEnd(text, start);
    if (blockEndsAt(text, end)) return [start, end];
  } else if (start - 1 >= from && !isLineTerminator(text.charCodeAt(start - 1))) {
    return [start - 1, start];
  }
  for (let at = start - 1; at > from; at--) {
    if (
      isLineTerminator(text.charCodeAt(at)) &&
      !isLineTerminator(text.charCodeAt(at - 1)) &&
      blockEndsAt(text, at)
    ) {
      return [at - 1, at];
    }
  }
  return null;
}

/**
 * Where a block's content ending at `end` is followed by what the regex
 * requires: `(?:\n\s{2,}Files:\s*(.+?))?` and then a block end. Returns the
 * files text's span (or null when there is none) and where the match ends.
 */
function afterContent(
  text: string,
  end: number,
): { files: [number, number] | null; end: number } | null {
  if (text.charCodeAt(end) === NEWLINE) {
    const label = whitespaceEnd(text, end + 1);
    if (label - end - 1 >= 2 && text.startsWith('Files:', label)) {
      const files = textToBlockEnd(text, label + 6);
      if (files) return { files, end: files[1] };
    }
  }
  return blockEndsAt(text, end) ? { files: null, end } : null;
}

/**
 * Every `[LTM/type] #id` block with its indented content, as the loop over
 * `/\[(LTM|obs)\/(\w+)\]\s*#([^\s]+)(?:\s*\(confidence:\s*([\d.]+)\))?\s*\n\s{2,}(.+?)(?:\n\s{2,}Files:\s*(.+?))?(?=\n\s*\[(?:LTM|obs)\/|$)/g`
 * read them: source, type, id, confidence, content, files.
 */
export function detailedBlocks(
  body: string,
): Array<[string, string, string, string | undefined, string, string | undefined]> {
  const blocks: Array<[string, string, string, string | undefined, string, string | undefined]> =
    [];
  const n = body.length;
  // The last non-whitespace run measured: an id inside it ends at the same place.
  let runStart = -1;
  let runEnd = -1;
  const solidEnd = (from: number): number => {
    if (from >= runStart && from < runEnd) return runEnd;
    let i = from;
    while (i < n && !isWhitespace(body.charCodeAt(i))) i++;
    runStart = from;
    runEnd = i;
    return i;
  };

  // `\s*\n\s{2,}(.+?)` and what follows it, from `from`: the content span and
  // the rest, or null. The content needs a newline with two whitespace
  // characters after it; the regex takes the text after the whitespace first,
  // then gives whitespace back as above.
  const contentFrom = (from: number) => {
    let start = from;
    let firstNewline = -1;
    while (start < n && isWhitespace(body.charCodeAt(start))) {
      if (firstNewline === -1 && body.charCodeAt(start) === NEWLINE) firstNewline = start;
      start++;
    }
    if (firstNewline === -1) return null;
    if (start < n && firstNewline <= start - 3) {
      const end = lineEnd(body, start);
      const rest = afterContent(body, end);
      if (rest) return { content: [start, end] as [number, number], ...rest };
    }
    if (start === n && firstNewline <= n - 4 && !isLineTerminator(body.charCodeAt(n - 1))) {
      return { content: [n - 1, n] as [number, number], files: null, end: n };
    }
    for (let at = start - 1; at >= firstNewline + 4; at--) {
      if (!isLineTerminator(body.charCodeAt(at)) || isLineTerminator(body.charCodeAt(at - 1)))
        continue;
      const rest = afterContent(body, at);
      if (rest) return { content: [at - 1, at] as [number, number], ...rest };
    }
    return null;
  };

  type Rest = {
    confidence: [number, number] | null;
    content: [number, number];
    files: [number, number] | null;
    end: number;
  };
  // `\(confidence:\s*([\d.]+)\)` at `open`, then the content: or null.
  const withConfidence = (open: number): Rest | null => {
    if (!body.startsWith('(confidence:', open)) return null;
    const digits = whitespaceEnd(body, open + 12);
    let digitsEnd = digits;
    while (isDigit(body.charCodeAt(digitsEnd)) || body.charCodeAt(digitsEnd) === 46) digitsEnd++;
    if (digitsEnd === digits || body.charCodeAt(digitsEnd) !== PAREN_CLOSE) return null;
    const rest = contentFrom(digitsEnd + 1);
    return rest ? { confidence: [digits, digitsEnd], ...rest } : null;
  };
  // What follows an id whose run ends at `runEndAt`, for the whole run: the
  // optional confidence first (it is greedy), then without it. Then the id
  // gives back characters: only a shorter id that ends where `(confidence:`
  // starts inside the run can match, so the run keeps the last such position
  // that leads to a match. Both depend only on the run, not on the start.
  let checkedEnd = -1;
  let whole: Rest | null = null;
  let inner: { at: number; rest: Rest } | null = null;
  const checkRun = (runEndAt: number, runStartAt: number) => {
    checkedEnd = runEndAt;
    whole = withConfidence(whitespaceEnd(body, runEndAt));
    if (!whole) {
      const rest = contentFrom(runEndAt);
      whole = rest ? { confidence: null, ...rest } : null;
    }
    inner = null;
    for (
      let at = body.indexOf('(confidence:', runStartAt);
      at !== -1 && at < runEndAt;
      at = body.indexOf('(confidence:', at + 1)
    ) {
      const rest = withConfidence(at);
      if (rest) inner = { at, rest };
    }
  };

  let from = 0;
  for (let at = body.indexOf('[', from); at !== -1; at = body.indexOf('[', from)) {
    from = at + 1;
    const source = body.startsWith('LTM/', at + 1)
      ? 'LTM'
      : body.startsWith('obs/', at + 1)
        ? 'obs'
        : null;
    if (!source) continue;
    let typeEnd = at + 5;
    while (typeEnd < n && /\w/.test(body[typeEnd] ?? '')) typeEnd++;
    if (typeEnd === at + 5 || body.charCodeAt(typeEnd) !== BRACKET_CLOSE) continue;
    const hash = whitespaceEnd(body, typeEnd + 1);
    if (body.charCodeAt(hash) !== HASH) continue;
    const idRunEnd = solidEnd(hash + 1);
    if (idRunEnd === hash + 1) continue;
    if (checkedEnd !== idRunEnd) checkRun(idRunEnd, runStart);
    let idEnd = idRunEnd;
    let found: Rest | null = whole;
    const shorter = inner as { at: number; rest: Rest } | null;
    if (!found && shorter && shorter.at > hash + 1) {
      idEnd = shorter.at;
      found = shorter.rest;
    }
    if (!found) continue;
    const { confidence, content, files, end } = found;
    blocks.push([
      source,
      body.slice(at + 5, typeEnd),
      body.slice(hash + 1, idEnd),
      confidence ? body.slice(confidence[0], confidence[1]) : undefined,
      body.slice(content[0], content[1]),
      files ? body.slice(files[0], files[1]) : undefined,
    ]);
    from = end;
  }
  return blocks;
}

/**
 * Every compact `#id [type] — text` hit, as the loop over
 * `/#([^\s\]]+)\s*\[([^\]]+)\]\s*[—-]\s*([\s\S]*?)(?=(?:\s+#([^\s\]]+)\s*\[)|$)/g`
 * read them: id, type, text.
 */
export function compactHits(body: string): Array<[string, string, string]> {
  const hits: Array<[string, string, string]> = [];
  const n = body.length;
  // The last run of characters that are neither whitespace nor `]` measured.
  let runStart = -1;
  let runEnd = -1;
  const idEnd = (from: number): number => {
    if (from >= runStart && from < runEnd) return runEnd;
    let i = from;
    while (i < n) {
      const code = body.charCodeAt(i);
      if (code === BRACKET_CLOSE || isWhitespace(code)) break;
      i++;
    }
    runStart = from;
    runEnd = i;
    return i;
  };
  // The first `[` and `]` at or after a position, remembered while the
  // queries move forward.
  const next = (character: string) => {
    let from = Number.POSITIVE_INFINITY;
    let found = -1;
    return (at: number): number => {
      if (at >= from && (found === -1 || at <= found)) return found;
      from = at;
      found = body.indexOf(character, at);
      return found;
    };
  };
  const nextOpen = next('[');
  const nextClose = next(']');

  let innerFor = -1;
  let innerOpen = -1;
  // `#([^\s\]]+)\s*\[` at `at`: the id may end at its run's end, before
  // whitespace and `[`, or at any `[` inside the run. Returns the id end and
  // the `[` of the longest id first.
  const idAt = (at: number): Array<[number, number]> => {
    if (body.charCodeAt(at) !== HASH) return [];
    const end = idEnd(at + 1);
    if (end === at + 1) return [];
    const choices: Array<[number, number]> = [];
    const bracket = whitespaceEnd(body, end);
    if (body.charCodeAt(bracket) === BRACKET_OPEN) choices.push([end, bracket]);
    // A `[` inside the run: every one of them closes at the same `]`, so only
    // the last whose type is not empty can match. It depends only on the run.
    if (innerFor !== end) {
      innerFor = end;
      const close = nextClose(end);
      innerOpen = body.lastIndexOf('[', end - 1);
      if (innerOpen !== -1 && innerOpen + 1 === close)
        innerOpen = innerOpen > 0 ? body.lastIndexOf('[', innerOpen - 1) : -1;
    }
    if (innerOpen >= at + 2) choices.push([innerOpen, innerOpen]);
    return choices;
  };
  // The lookahead `(?=\s+#([^\s\]]+)\s*\[)` at the end of a whitespace run.
  const hitStartsAt = (at: number): boolean => {
    if (body.charCodeAt(at) !== HASH) return false;
    const end = idEnd(at + 1);
    if (end === at + 1) return false;
    if (body.charCodeAt(whitespaceEnd(body, end)) === BRACKET_OPEN) return true;
    const open = nextOpen(at + 2);
    return open !== -1 && open < end;
  };
  // `([\s\S]*?)` up to the first whitespace run that a hit start follows, or the end.
  const textEnd = (from: number): number => {
    for (let i = from; i < n; i++) {
      if (!isWhitespace(body.charCodeAt(i))) continue;
      const runEndAt = whitespaceEnd(body, i);
      if (hitStartsAt(runEndAt)) return i;
      i = runEndAt - 1;
    }
    return n;
  };

  let from = 0;
  for (let at = body.indexOf('#', from); at !== -1; at = body.indexOf('#', from)) {
    from = at + 1;
    for (const [end, bracket] of idAt(at)) {
      const close = nextClose(bracket + 1);
      if (close === -1 || close === bracket + 1) continue;
      const dash = whitespaceEnd(body, close + 1);
      const code = body.charCodeAt(dash);
      if (code !== EM_DASH && code !== HYPHEN) continue;
      const start = whitespaceEnd(body, dash + 1);
      const stop = textEnd(start);
      hits.push([body.slice(at + 1, end), body.slice(bracket + 1, close), body.slice(start, stop)]);
      from = stop;
      break;
    }
  }
  return hits;
}

export type MemorySearchHitSource = 'ltm' | 'obs' | 'unknown';

export interface ParsedMemorySearchHit {
  id: string;
  type: string;
  source: MemorySearchHitSource;
  confidence: number | null;
  content: string;
  files: string[];
}

export interface ParsedMemorySearchOutput {
  matched: boolean;
  label: string;
  query: string;
  declaredResults: number | null;
  hits: ParsedMemorySearchHit[];
}

const EMPTY_RESULT: ParsedMemorySearchOutput = {
  matched: false,
  label: 'Memory Search',
  query: '',
  declaredResults: null,
  hits: [],
};

function asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function parseSource(value: unknown): MemorySearchHitSource {
  const raw = asString(value).trim().toLowerCase();
  if (raw === 'ltm' || raw.includes('long') || raw.includes('semantic')) return 'ltm';
  if (raw === 'obs' || raw.includes('observation')) return 'obs';
  return 'unknown';
}

function parseArrayOutput(parsed: Record<string, unknown>): ParsedMemorySearchOutput | null {
  const listLike = (parsed.results ?? parsed.hits ?? parsed.memories) as unknown;
  if (!Array.isArray(listLike)) return null;

  const hits: ParsedMemorySearchHit[] = [];
  for (const item of listLike) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const idValue = row.id ?? row.memory_id ?? row.memoryId ?? row.key;
    const contentValue = row.content ?? row.text ?? row.caption ?? row.summary;
    const id = asString(idValue).trim();
    const content = asString(contentValue).trim();
    if (!id || !content) continue;

    const filesRaw = row.files ?? row.file_paths ?? row.filePaths;
    const files = Array.isArray(filesRaw)
      ? filesRaw.flatMap((file) => {
          const path = asString(file).trim();
          return path ? [path] : [];
        })
      : [];

    const confidenceValue = row.confidence;
    const confidence =
      typeof confidenceValue === 'number'
        ? confidenceValue
        : typeof confidenceValue === 'string' && confidenceValue.trim()
          ? Number(confidenceValue)
          : null;

    hits.push({
      id,
      type: asString(row.type ?? row.kind ?? 'memory').trim() || 'memory',
      source: parseSource(row.source),
      confidence: Number.isFinite(confidence) ? confidence : null,
      content,
      files,
    });
  }

  const labelRaw = asString(parsed.label ?? parsed.title ?? '').trim();
  const sourceHint = parseSource(parsed.source);
  const label =
    labelRaw ||
    (sourceHint === 'ltm'
      ? 'LTM Search'
      : sourceHint === 'obs'
        ? 'Observation Search'
        : 'Memory Search');
  const query = asString(parsed.query ?? parsed.search_query ?? parsed.searchQuery).trim();
  const declared = parsed.total ?? parsed.count ?? parsed.results_count;
  const declaredResults =
    typeof declared === 'number'
      ? declared
      : typeof declared === 'string' && declared.trim()
        ? Number(declared)
        : null;

  return {
    matched: true,
    label,
    query,
    declaredResults: Number.isFinite(declaredResults) ? declaredResults : null,
    hits,
  };
}

export function parseMemorySearchOutput(rawOutput: unknown): ParsedMemorySearchOutput {
  if (rawOutput && typeof rawOutput === 'object') {
    const parsedObject = parseArrayOutput(rawOutput as Record<string, unknown>);
    if (parsedObject) return parsedObject;
  }

  const output = asString(rawOutput);
  if (!output.trim()) return EMPTY_RESULT;

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(output);
  } catch {
    parsedJson = null;
  }

  if (parsedJson && typeof parsedJson === 'object') {
    const parsedObject = parseArrayOutput(parsedJson as Record<string, unknown>);
    if (parsedObject) return parsedObject;
  }

  const normalized = output.replace(/\r\n?/g, '\n').trim();
  let label = 'Memory Search';
  let query = '';
  let declaredResults: number | null = null;
  let body = normalized;
  let matched = false;

  const header = searchHeader(normalized);
  if (header) {
    matched = true;
    label = header.label.trim();
    query = header.query.trim();
    declaredResults = Number(header.count);
    body = normalized.slice(header.end).trim();
  }

  const hits: ParsedMemorySearchHit[] = [];

  for (const [source, type, id, confidence, content, files] of detailedBlocks(body)) {
    matched = true;
    hits.push({
      source: source.toLowerCase() === 'ltm' ? 'ltm' : 'obs',
      type,
      id,
      confidence: confidence ? Number(confidence) : null,
      content: content.trim().replace(/\s+/g, ' '),
      files: files
        ? files
            .split(',')
            .map((file) => file.trim())
            .filter(Boolean)
        : [],
    });
  }

  if (hits.length === 0) {
    const inferredSource = parseSource(label);
    for (const [id, type, content] of compactHits(body)) {
      matched = true;
      hits.push({
        source: inferredSource,
        type: type.trim(),
        id: id.trim(),
        confidence: null,
        content: content.replace(/\s+/g, ' ').trim(),
        files: [],
      });
    }
  }

  return {
    matched,
    label,
    query,
    declaredResults,
    hits,
  };
}
