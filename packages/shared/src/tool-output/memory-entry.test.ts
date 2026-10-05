import { describe, expect, test } from 'bun:test';
import {
  type Stop,
  fieldText,
  inlineToolPrompt,
  observationHeader,
  parseMemoryEntryOutput,
  splitBullets,
} from './memory-entry';
import { chooser, within } from './testing';

// The get_mem renderers' parser (web memory-entry-output.ts, mobile
// projects-memory-entry-output.ts), verbatim, kept ONLY as the parity oracle.
interface LegacyObservation {
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

interface LegacyLtm {
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

type LegacyEntry = LegacyObservation | LegacyLtm;

function legacy_parseObservationReport(text: string): LegacyObservation | null {
  if (!text.includes('Observation #')) return null;

  const normalized = text.replace(/\r\n?/g, '\n').trim();
  const header = normalized.match(/===\s*Observation\s*#(\d+)\s*\[([^\]]+)\]\s*===\s*([\s\S]*)$/i);
  if (!header) return null;

  const [, id, type, remainderRaw] = header;
  const remainder = remainderRaw.trim();

  const compactField = (label: string): string => {
    const allLabels = [
      'Title:',
      'Narrative:',
      'Tool:',
      'Prompt #',
      'Session:',
      'Created:',
      'Facts:',
      'Concepts:',
      'Files read:',
    ].join('|');
    const re = new RegExp(`${label}\\s*([\\s\\S]*?)(?=\\s+(?:${allLabels})|$)`, 'i');
    return remainder.replace(/\n+/g, ' ').match(re)?.[1]?.trim() ?? '';
  };

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
      const inlineMeta = line
        .replace(/^Tool:\s*/i, '')
        .match(/^([^|]+?)\s*\|\s*Prompt\s*#([^\s]+)$/i);
      if (inlineMeta) {
        tool = inlineMeta[1].trim();
        prompt = inlineMeta[2].trim();
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
      ...factsAndMore
        .split(/\s*[•-]\s+/)
        .map((item) => item.trim())
        .filter(Boolean),
    );
  }

  if (!tool) {
    const tokenTool = remainder.match(/Tool:\s*([A-Za-z0-9_./:-]+)/i)?.[1]?.trim();
    if (tokenTool) {
      tool = tokenTool;
    } else {
      const toolMatch = remainder.match(
        /Tool:\s*([\s\S]*?)(?=\s+\|\s*Prompt\s*#|\s+Prompt\s*#|\s+Session:|\s+Created:|\s+Concepts:|\s+Files read:|$)/i,
      );
      tool =
        toolMatch?.[1]
          ?.replace(/\bTool:\s*/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim() || null;
    }
  }

  if (!prompt) {
    prompt = remainder.match(/Prompt\s*#([^\s|]+)/i)?.[1]?.trim() || null;
  }

  if (!session) {
    const sessionMatch = remainder.match(
      /Session:\s*([\s\S]*?)(?=\s+Created:|\s+Facts:|\s+Concepts:|\s+Files read:|$)/i,
    );
    session = sessionMatch?.[1]?.trim() || null;
  }

  if (!created) {
    // `Facts:` belongs in this lookahead exactly as it does in `compactField`.
    // Without it, an observation that lists its facts AFTER `Created:` put the
    // whole fact block into the date — the view then rendered
    // "2026-07-01 Facts: - Removed duplicate middleware" in the one-line meta
    // row beside a calendar icon.
    const createdMatch = remainder.match(
      /Created:\s*([\s\S]*?)(?=\s+Facts:|\s+Concepts:|\s+Files read:|$)/i,
    );
    created = createdMatch?.[1]?.trim() || null;
  }

  if (concepts.length === 0) {
    const compactConcepts =
      remainder.match(/Concepts:\s*([\s\S]*?)(?=\s+Files read:|$)/i)?.[1] ?? '';
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

function legacy_parseLtmFields(body: string): Map<string, string> {
  const labels = ['Caption:', 'Content:', 'Session:', 'Created:', 'Tags:'];
  const lower = body.toLowerCase();
  const positions = labels
    .map((label) => ({ label, index: lower.indexOf(label.toLowerCase()) }))
    .filter((entry) => entry.index >= 0)
    .sort((a, b) => a.index - b.index);
  const fields = new Map<string, string>();
  for (let index = 0; index < positions.length; index += 1) {
    const current = positions[index]!;
    const next = positions[index + 1];
    const start = current.index + current.label.length;
    fields.set(current.label, body.slice(start, next?.index ?? body.length).trim());
  }
  return fields;
}

function legacy_parseLtmEntry(text: string): LegacyLtm | null {
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
  const fields = legacy_parseLtmFields(compactBody);
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

function legacyParseMemoryEntryOutput(text: string): LegacyEntry | null {
  return legacy_parseObservationReport(text) || legacy_parseLtmEntry(text);
}

const LS = String.fromCharCode(0x2028);
const BULLET = String.fromCharCode(0x2022);
const LABELS: Stop[] = [
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
// The label and stop lists the parser passes to fieldText.
const FIELDS: Array<[string, readonly Stop[]]> = [
  ['Title:', LABELS],
  ['Narrative:', LABELS],
  ['Facts:', LABELS],
  [
    'Tool:',
    ['\\|\\s*Prompt\\s*#', 'Prompt\\s*#', 'Session:', 'Created:', 'Concepts:', 'Files read:'],
  ],
  ['Session:', ['Created:', 'Facts:', 'Concepts:', 'Files read:']],
  ['Created:', ['Facts:', 'Concepts:', 'Files read:']],
  ['Concepts:', ['Files read:']],
];

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

/** `base` with up to `max` insertions from `noise`. */
function mutate(
  c: ReturnType<typeof chooser>,
  base: string,
  noise: readonly string[],
  max = 3,
): string {
  let text = base;
  for (let k = 0, n = c.pick([0, 1, 2, 3].slice(0, max + 1)); k < n; k++) {
    const at = Math.floor(c.next() * (text.length + 1));
    text = text.slice(0, at) + c.pick(noise) + text.slice(at);
  }
  return text;
}

describe('the memory entry readers return what their regexes returned', () => {
  test('observationHeader', () =>
    fuzz(
      81,
      (c) =>
        mutate(
          c,
          c.pick([
            '=== Observation #12 [discovery] ===\nTitle: x',
            '===observation#3[a]=== y',
            '== Observation #1 [b] ===',
            '=== OBSERVATION #7 [c d] ===',
            '=== Observation #1 [] === === Observation #2 [x] ===',
          ]),
          ['=', '===', ' ', '\n', '[', ']', '#', '1', 'x', '=== Observation #2 [e] ===', '\t'],
        ),
      (text) => {
        const expected = text.match(
          /===\s*Observation\s*#(\d+)\s*\[([^\]]+)\]\s*===\s*([\s\S]*)$/i,
        );
        const actual = observationHeader(text);
        expect(actual).toEqual(
          expected ? [expected[1] ?? '', expected[2] ?? '', expected[3] ?? ''] : null,
        );
        return expected !== null;
      },
    ));

  test('fieldText, for every label and stop list the parser uses', () =>
    fuzz(
      82,
      (c) => {
        const tokens = [
          'Title:',
          'title:',
          'Narrative:',
          'Tool:',
          'TOOL:',
          'Prompt #',
          'Prompt#2',
          '| Prompt #5',
          '|Prompt  #',
          'Prompt',
          'Session:',
          'Created:',
          'Facts:',
          'Concepts:',
          'Files read:',
          'files READ:',
          'Files  read:',
          'x',
          'y z',
          ' ',
          '  ',
          '\t',
          '\n',
          LS,
          '|',
          '#',
        ];
        return c.some(tokens, 10);
      },
      (text) => {
        let found = false;
        for (const [label, stops] of FIELDS) {
          const expected =
            text.match(
              new RegExp(`${label}\\s*([\\s\\S]*?)(?=\\s+(?:${stops.join('|')})|$)`, 'i'),
            )?.[1] ?? null;
          expect(fieldText(text, label, stops)).toBe(expected);
          if (expected) found = true;
        }
        return found;
      },
    ));

  test('inlineToolPrompt', () =>
    fuzz(
      83,
      (c) =>
        mutate(
          c,
          c.pick([
            'bash | Prompt #3',
            'read|prompt#x1',
            'a  |  Prompt  #  7',
            'edit | Prompt #',
            ' | Prompt #3',
            '\t\t|prompt #x',
          ]),
          [' ', '\t', '|', '#', 'x', 'Prompt', LS, '\n'],
        ),
      (line) => {
        const m = line.match(/^([^|]+?)\s*\|\s*Prompt\s*#([^\s]+)$/i);
        expect(inlineToolPrompt(line)).toEqual(m ? [m[1] ?? '', m[2] ?? ''] : null);
        return m !== null;
      },
    ));

  test('splitBullets', () =>
    fuzz(
      84,
      (c) =>
        c.some([' ', '  ', '\t', BULLET, '-', 'a', 'b c', `- `, `${BULLET} `, '\n', LS, 'x-y'], 10),
      (text) => {
        const expected = text.split(/\s*[•-]\s+/);
        expect(splitBullets(text)).toEqual(expected);
        return expected.length > 1;
      },
    ));
});

describe('parseMemoryEntryOutput', () => {
  const REPORT = [
    '=== Observation #12 [discovery] ===',
    'Title: Fixed the login flow',
    'Narrative: The login broke after the upgrade.',
    'Tool: bash | Prompt #3',
    'Session: ses_1',
    'Created: 2026-01-01 10:00',
    'Facts:',
    '- the token expired',
    `${BULLET} the cache was stale`,
    'Concepts: auth, login',
    'Files read: a.ts, b.ts',
  ];
  const LTM = [
    '=== LTM #5 [preference] ===',
    'Caption: Short answers',
    'Content: The user prefers short answers.',
    'Session: ses_2',
    'Created: 2026-01-02 | Updated: 2026-01-03',
    'Tags: style, tone',
  ];

  test('returns what the regex parser returned on 3000 random memory outputs', () =>
    fuzz(
      85,
      (c) => {
        const lines = c.pick([REPORT, REPORT, LTM]);
        // Keep the header, then a random subset of the fields in a random order.
        const fields = lines.slice(1).filter(() => c.next() < 0.7);
        for (let i = fields.length - 1; i > 0; i--) {
          const j = Math.floor(c.next() * (i + 1));
          [fields[i], fields[j]] = [fields[j] as string, fields[i] as string];
        }
        const joins = ['\n', '\n', ' ', '  ', '\r\n', '\t', ' | '];
        let text = lines[0] as string;
        for (const field of fields) text += c.pick(joins) + field;
        return mutate(
          c,
          text,
          ['Tool:', 'Prompt #', '|', '-', BULLET, ' ', '\n', 'Created:', 'x'],
          2,
        );
      },
      (text) => {
        const expected = legacyParseMemoryEntryOutput(text);
        expect(parseMemoryEntryOutput(text)).toEqual(expected);
        return expected !== null;
      },
    ));

  test('reads a real observation', () => {
    // compactField joins the lines with spaces first, so a multi-line fact list
    // reaches the fact reader as one line: it becomes one fact. That was the
    // regex parser's result too; this change keeps it.
    expect(parseMemoryEntryOutput(REPORT.join('\n'))).toMatchObject({
      kind: 'observation',
      id: '12',
      type: 'discovery',
      title: 'Fixed the login flow',
      tool: 'bash',
      prompt: '3',
      facts: [`the token expired ${BULLET} the cache was stale`],
      filesRead: ['a.ts', 'b.ts'],
    });
  });
});

describe('no memory entry can freeze the renderer', () => {
  within('12k observation headers that never close their [ (240k characters)', () =>
    parseMemoryEntryOutput('=== Observation #1 ['.repeat(12_000)),
  );
  within('a title holding 240k spaces', () =>
    parseMemoryEntryOutput(
      `=== Observation #1 [x] === Title: a${' '.repeat(240_000)}b Narrative: n`,
    ),
  );
  within('a tool line holding 240k spaces before its |', () =>
    parseMemoryEntryOutput(
      `=== Observation #1 [x] ===\nTitle: t\nNarrative: Tool: a${' '.repeat(240_000)}x | y`,
    ),
  );
  within('facts holding 240k spaces and no bullet', () =>
    parseMemoryEntryOutput(`=== Observation #1 [x] === Title: t Facts: a${' '.repeat(240_000)}b`),
  );
  within('a compact tool field holding 240k spaces', () =>
    parseMemoryEntryOutput(
      `=== Observation #1 [x] === Title: t Session: s Tool: a${' '.repeat(240_000)}b`,
    ),
  );
});
