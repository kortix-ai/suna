import { describe, expect, test } from 'bun:test';
import {
  compactHits,
  detailedBlocks,
  parseMemorySearchOutput,
  searchHeader,
} from './memory-search';
import { chooser, within } from './testing';

// The memory search renderers' parser (web memory-search-output.ts, mobile
// projects-memory-search-output.ts), verbatim, kept ONLY as the parity oracle.
type LegacySource = 'ltm' | 'obs' | 'unknown';

interface LegacyHit {
  id: string;
  type: string;
  source: LegacySource;
  confidence: number | null;
  content: string;
  files: string[];
}

interface LegacyOutput {
  matched: boolean;
  label: string;
  query: string;
  declaredResults: number | null;
  hits: LegacyHit[];
}

const LEGACY_EMPTY_RESULT: LegacyOutput = {
  matched: false,
  label: 'Memory Search',
  query: '',
  declaredResults: null,
  hits: [],
};

function legacy_asString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  return String(value);
}

function legacy_parseSource(value: unknown): LegacySource {
  const raw = legacy_asString(value).trim().toLowerCase();
  if (raw === 'ltm' || raw.includes('long') || raw.includes('semantic')) return 'ltm';
  if (raw === 'obs' || raw.includes('observation')) return 'obs';
  return 'unknown';
}

function legacy_parseArrayOutput(parsed: Record<string, unknown>): LegacyOutput | null {
  const listLike = (parsed.results ?? parsed.hits ?? parsed.memories) as unknown;
  if (!Array.isArray(listLike)) return null;

  const hits: LegacyHit[] = [];
  for (const item of listLike) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const idValue = row.id ?? row.memory_id ?? row.memoryId ?? row.key;
    const contentValue = row.content ?? row.text ?? row.caption ?? row.summary;
    const id = legacy_asString(idValue).trim();
    const content = legacy_asString(contentValue).trim();
    if (!id || !content) continue;

    const filesRaw = row.files ?? row.file_paths ?? row.filePaths;
    const files = Array.isArray(filesRaw)
      ? filesRaw.flatMap((file) => {
          const path = legacy_asString(file).trim();
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
      type: legacy_asString(row.type ?? row.kind ?? 'memory').trim() || 'memory',
      source: legacy_parseSource(row.source),
      confidence: Number.isFinite(confidence) ? confidence : null,
      content,
      files,
    });
  }

  const labelRaw = legacy_asString(parsed.label ?? parsed.title ?? '').trim();
  const sourceHint = legacy_parseSource(parsed.source);
  const label =
    labelRaw ||
    (sourceHint === 'ltm'
      ? 'LTM Search'
      : sourceHint === 'obs'
        ? 'Observation Search'
        : 'Memory Search');
  const query = legacy_asString(parsed.query ?? parsed.search_query ?? parsed.searchQuery).trim();
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

function legacyParseMemorySearchOutput(rawOutput: unknown): LegacyOutput {
  if (rawOutput && typeof rawOutput === 'object') {
    const parsedObject = legacy_parseArrayOutput(rawOutput as Record<string, unknown>);
    if (parsedObject) return parsedObject;
  }

  const output = legacy_asString(rawOutput);
  if (!output.trim()) return LEGACY_EMPTY_RESULT;

  let parsedJson: unknown = null;
  try {
    parsedJson = JSON.parse(output);
  } catch {
    parsedJson = null;
  }

  if (parsedJson && typeof parsedJson === 'object') {
    const parsedObject = legacy_parseArrayOutput(parsedJson as Record<string, unknown>);
    if (parsedObject) return parsedObject;
  }

  const normalized = output.replace(/\r\n?/g, '\n').trim();
  let label = 'Memory Search';
  let query = '';
  let declaredResults: number | null = null;
  let body = normalized;
  let matched = false;

  const headerMatch = normalized.match(
    /^===\s*([^:]+?Search):\s*"?([^"\n]*)"?\s*\((\d+)\s*results?\)\s*===\s*\n?/im,
  );
  if (headerMatch) {
    matched = true;
    label = headerMatch[1].trim();
    query = headerMatch[2].trim();
    declaredResults = Number(headerMatch[3]);
    body = normalized.slice((headerMatch.index ?? 0) + headerMatch[0].length).trim();
  }

  const hits: LegacyHit[] = [];

  const detailedBlockRe =
    /\[(LTM|obs)\/(\w+)\]\s*#([^\s]+)(?:\s*\(confidence:\s*([\d.]+)\))?\s*\n\s{2,}(.+?)(?:\n\s{2,}Files:\s*(.+?))?(?=\n\s*\[(?:LTM|obs)\/|$)/g;
  let detailMatch: RegExpExecArray | null = detailedBlockRe.exec(body);
  while (detailMatch) {
    matched = true;
    hits.push({
      source: detailMatch[1].toLowerCase() === 'ltm' ? 'ltm' : 'obs',
      type: detailMatch[2],
      id: detailMatch[3],
      confidence: detailMatch[4] ? Number(detailMatch[4]) : null,
      content: detailMatch[5].trim().replace(/\s+/g, ' '),
      files: detailMatch[6]
        ? detailMatch[6]
            .split(',')
            .map((file) => file.trim())
            .filter(Boolean)
        : [],
    });
    detailMatch = detailedBlockRe.exec(body);
  }

  if (hits.length === 0) {
    const compactRe =
      /#([^\s\]]+)\s*\[([^\]]+)\]\s*[\u2014-]\s*([\s\S]*?)(?=(?:\s+#([^\s\]]+)\s*\[)|$)/g;
    let compactMatch: RegExpExecArray | null = compactRe.exec(body);
    const inferredSource = legacy_parseSource(label);
    while (compactMatch) {
      matched = true;
      hits.push({
        source: inferredSource,
        type: compactMatch[2].trim(),
        id: compactMatch[1].trim(),
        confidence: null,
        content: compactMatch[3].replace(/\s+/g, ' ').trim(),
        files: [],
      });
      compactMatch = compactRe.exec(body);
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

const LS = String.fromCharCode(0x2028);
const DASH = String.fromCharCode(0x2014);

function legacyHeader(text: string) {
  const m = text.match(
    /^===\s*([^:]+?Search):\s*"?([^"\n]*)"?\s*\((\d+)\s*results?\)\s*===\s*\n?/im,
  );
  return m
    ? {
        index: m.index ?? 0,
        end: (m.index ?? 0) + m[0].length,
        label: m[1] ?? '',
        query: m[2] ?? '',
        count: m[3] ?? '',
      }
    : null;
}
function legacyDetailed(body: string) {
  const re =
    /\[(LTM|obs)\/(\w+)\]\s*#([^\s]+)(?:\s*\(confidence:\s*([\d.]+)\))?\s*\n\s{2,}(.+?)(?:\n\s{2,}Files:\s*(.+?))?(?=\n\s*\[(?:LTM|obs)\/|$)/g;
  return [...body.matchAll(re)].map((m) => m.slice(1));
}
function legacyCompact(body: string) {
  const re = /#([^\s\]]+)\s*\[([^\]]+)\]\s*[\u2014-]\s*([\s\S]*?)(?=(?:\s+#([^\s\]]+)\s*\[)|$)/g;
  return [...body.matchAll(re)].map((m) => [m[1] ?? '', m[2] ?? '', m[3] ?? '']);
}

/** Runs `check` on 3000 texts from `make` and proves at least 600 of them matched. */
function fuzz(
  seed: number,
  make: (c: ReturnType<typeof chooser>) => string,
  check: (text: string) => boolean,
) {
  const c = chooser(seed);
  let matched = 0;
  for (let i = 0; i < 3000; i++) if (check(make(c))) matched++;
  expect(matched).toBeGreaterThan(600);
}

/** One of `bases` with up to three insertions from `noise`. */
function mutate(
  c: ReturnType<typeof chooser>,
  bases: readonly string[],
  noise: readonly string[],
): string {
  let text = c.pick(bases);
  for (let k = 0, n = c.pick([0, 1, 2, 3]); k < n; k++) {
    const at = Math.floor(c.next() * (text.length + 1));
    text = text.slice(0, at) + c.pick(noise) + text.slice(at);
  }
  return text;
}

const HEADERS = [
  '=== LTM Search: "auth" (3 results) ===\n[LTM/fact] #1\n  content',
  '=== Observation Search: login (1 result) ===',
  '===Memory Search:"q"(12 results)===\n\nbody',
  'x\n=== Semantic search: "a b" (0 results) ===  \n',
  '=== search: x (2 results) ===',
  '===\n  LTM Search: "(1 results) ===" (2 results) === tail',
];
const DETAILED = [
  '[LTM/fact] #ltm_1 (confidence: 0.92)\n  Prefers short answers\n  Files: a.ts, b.ts\n[obs/discovery] #7\n  Fixed login',
  '[obs/change] #a1\n   text here',
  '[LTM/pref] #x\n  one\n[LTM/pref] #y (confidence:1)\n  two  ',
  '[LTM/a] #b(confidence: 1)\n  c\n  Files:\n',
  '[obs/x]#y\n\n   z\n   Files: f\n  [obs/q] #r\n  s',
  // Blocks that reach the regex's whitespace give-backs: a files list that is
  // one space before the next block, content that is only indentation at the
  // end, and a blank indented line before the next block.
  '[LTM/a] #b\n  c\n  Files: \n[LTM/d] #e\n  f',
  '[LTM/a] #b\n   ',
  '[LTM/a] #b\n   \n  [LTM/c] #d\nzzz',
];
const COMPACT = [
  `#12 [fact] ${DASH} prefers short answers #13 [pref] - dark mode`,
  '#a[b]-c #d [e] - f',
  `#x [y] ${DASH} z\n#w [v] - u`,
  '#a[b[c] - d #e[f] - g',
  '#q [r] -   ',
];

describe('the memory search readers return what their regexes returned', () => {
  test('searchHeader', () =>
    fuzz(
      101,
      (c) =>
        mutate(c, HEADERS, [
          '=',
          ':',
          '"',
          '(',
          ')',
          ' ',
          '\n',
          LS,
          'Search',
          'result',
          '3',
          'x',
          '===',
          'Search:',
        ]),
      (text) => {
        const expected = legacyHeader(text);
        expect(searchHeader(text)).toEqual(expected);
        return expected !== null;
      },
    ));

  test('detailedBlocks', () =>
    fuzz(
      102,
      (c) =>
        mutate(c, DETAILED, [
          '\n',
          '  ',
          ' ',
          '[LTM/',
          '[obs/',
          '#',
          '(confidence: 0.5)',
          'Files:',
          LS,
          'x',
          ']',
          '\n  ',
        ]),
      (text) => {
        const expected = legacyDetailed(text);
        expect(detailedBlocks(text) as Array<Array<string | undefined>>).toEqual(expected);
        return expected.length > 0;
      },
    ));

  test('compactHits', () =>
    fuzz(
      103,
      (c) => mutate(c, COMPACT, ['#', '[', ']', ' ', '\n', DASH, '-', 'x', '#q [r]', '  ', '\t']),
      (text) => {
        const expected = legacyCompact(text);
        expect(compactHits(text) as string[][]).toEqual(expected);
        return expected.length > 0;
      },
    ));
});

describe('parseMemorySearchOutput', () => {
  test('returns what the regex parser returned on 3000 random search outputs', () =>
    fuzz(
      104,
      (c) => {
        const header = c.pick([...HEADERS.map((h) => h.split('\n')[0] as string), '', 'Results:']);
        const body = c.pick([...DETAILED, ...COMPACT, '']);
        const text = `${header}${c.pick(['\n', '\r\n', ' ', ''])}${body}`;
        return c.next() < 0.1
          ? JSON.stringify({ results: [{ id: 'a', content: text }], query: 'q' })
          : mutate(c, [text], ['\n', ' ', '#', '[', ']', '-']);
      },
      (text) => {
        const expected = legacyParseMemorySearchOutput(text);
        expect(parseMemorySearchOutput(text)).toEqual(expected);
        return expected.matched;
      },
    ));
});

describe('no memory search output can freeze the renderer', () => {
  within('a header followed by 240k newlines and no colon', () =>
    parseMemorySearchOutput(`===${'\n'.repeat(240_000)}!`),
  );
  within('30k "[LTM/a]#" block starts with no whitespace (240k characters)', () =>
    parseMemorySearchOutput('[LTM/a]#'.repeat(30_000)),
  );
  within('240k "#" compact starts', () => parseMemorySearchOutput('#'.repeat(240_000)));
  within('a compact hit whose content holds 240k spaces', () =>
    parseMemorySearchOutput(`#a [b] ${DASH} ${' '.repeat(240_000)}x`),
  );
  within('a detailed hit whose content line holds 240k characters and never ends a block', () =>
    parseMemorySearchOutput(`[LTM/a] #b\n  ${'x'.repeat(240_000)}${LS}`),
  );
});
