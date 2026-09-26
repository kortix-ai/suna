import { describe, expect, test } from 'bun:test';
import {
  type GrepFileGroup,
  type ParsedSessionMessage,
  type ParsedSessionMeta,
  grepLineMatches,
  parseGrepOutput,
  parseSessionMessagesOutput,
  parseSessionMetadataOutput,
  splitSessionSections,
  toolsUsedLine,
} from './session-dump';
import { chooser, within } from './testing';

type GrepMatch = GrepFileGroup['matches'][number];

// The web and mobile renderers' parsers, verbatim, kept ONLY as parity oracles.
function legacyParseGrepOutput(
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
    const lineRegex = /Line\s+(\d+):\s*([\s\S]*?)(?=\s*(?:Line\s+\d+:|$))/g;
    let m: RegExpExecArray | null;
    while ((m = lineRegex.exec(rest)) !== null) {
      matches.push({
        line: Number.parseInt(m[1], 10),
        content: m[2].trim().replace(/;$/, ''),
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
function legacyParseSessionMetadataOutput(output: string): ParsedSessionMeta[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('===') || !trimmed.includes('"id"')) return null;

  const parts = trimmed.split(/^={2,}\s*(.*?)\s*={0,}\s*$/m);
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
function legacyParseSessionMessagesOutput(output: string): ParsedSessionMessage[] | null {
  const trimmed = output.trim();
  if (!trimmed.includes('--- Msg ')) return null;

  const msgRegex = /---\s*Msg\s+(\d+)\s+\[(\w+)\]\s+cost=\$?([\d.]+)\s*---/g;
  const matches = [...trimmed.matchAll(msgRegex)];
  if (matches.length < 1) return null;

  const messages: ParsedSessionMessage[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index! + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index! : trimmed.length;
    const rawContent = trimmed.slice(start, end).trim();

    const toolsMatch = rawContent.match(/^\s*Tools used:\s*(.+)$/m);
    const content = rawContent.replace(/^\s*Tools used:\s*.+$/m, '').trim();

    messages.push({
      index: Number.parseInt(m[1], 10),
      role: m[2].toLowerCase(),
      cost: Number.parseFloat(m[3]),
      content,
      tools: toolsMatch?.[1],
    });
  }

  return messages.length > 0 ? messages : null;
}

function legacyLines(rest: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const lineRegex = /Line\s+(\d+):\s*([\s\S]*?)(?=\s*(?:Line\s+\d+:|$))/g;
  let m: RegExpExecArray | null;
  while ((m = lineRegex.exec(rest)) !== null) out.push([m[1] ?? '', m[2] ?? '']);
  return out;
}
const legacySplit = (text: string) => text.split(/^={2,}\s*(.*?)\s*={0,}\s*$/m);
function legacyTools(text: string) {
  const m = /^\s*Tools used:\s*(.+)$/m.exec(text);
  return m ? { index: m.index, end: m.index + m[0].length, tools: m[1] ?? '' } : null;
}

const LINE_BREAKS = ['\n', '\n', '\r\n', '\r', 'LS', 'PS'].map((b) =>
  b === 'LS' ? String.fromCharCode(0x2028) : b === 'PS' ? String.fromCharCode(0x2029) : b,
);

describe('grepLineMatches', () => {
  test('returns what the regex exec loop returned on 3000 random blocks', () => {
    const { some } = chooser(31);
    const pieces = [
      'Line 1:',
      'Line 12:',
      'Line  3:',
      'Line\t4:',
      'Line\n5:',
      'Line 6',
      'Line x:',
      'LineLine 7:',
      'Line',
      ' ',
      '  ',
      '\n',
      '\t',
      '\u00a0',
      'foo',
      'bar;',
      ';',
      ':',
      '9',
    ];
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      const text = some(pieces, 10);
      const expected = legacyLines(text);
      expect(grepLineMatches(text)).toEqual(expected);
      if (expected.length > 0) found++;
    }
    expect(found).toBeGreaterThan(600);
  });
});

describe('splitSessionSections', () => {
  test('splits as the regex split did on 3000 random dumps', () => {
    const { pick, some } = chooser(32);
    const lines = [
      '==',
      '===',
      '=',
      '== x ==',
      '=== /a/b.json ===',
      '==x',
      ' ==',
      '===  ',
      '{"id":"a"}',
      'x',
      '',
      '== ',
      '==\t=',
      '= =',
      '== a = b',
      '== a =',
      '  ',
      '==',
    ];
    let split = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const count = pick([1, 2, 3, 4, 5, 6]);
      for (let line = 0; line < count; line++)
        text += some(lines, 2) + some([' ', '\t', '='], 2) + pick(LINE_BREAKS);
      text += some(lines, 2);
      const expected = legacySplit(text);
      expect(splitSessionSections(text)).toEqual(expected);
      if (expected.length > 1) split++;
    }
    expect(split).toBeGreaterThan(600);
  });
});

describe('toolsUsedLine', () => {
  test('finds what the regex found on 3000 random messages', () => {
    const { pick, some } = chooser(33);
    const pieces = [
      'Tools used:',
      'Tools used: read, bash',
      'Tools used',
      ' ',
      '\t',
      'x',
      'hello',
      'Tools used:  ',
    ];
    let found = 0;
    for (let i = 0; i < 3000; i++) {
      let text = '';
      const count = pick([1, 2, 3, 4]);
      for (let line = 0; line < count; line++) text += some(pieces, 3) + some(LINE_BREAKS, 2);
      const expected = legacyTools(text);
      expect(toolsUsedLine(text)).toEqual(expected);
      if (expected) found++;
    }
    expect(found).toBeGreaterThan(600);
  });
});

describe('the parsers return what the regex parsers returned', () => {
  test('parseGrepOutput on 3000 random grep outputs', () => {
    const { pick, some } = chooser(34);
    const content = ['foo', 'bar;', ' ', '  ', '\t', 'Line', 'Line 2:', ':', ';', 'x y'];
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      let text = pick([
        'Found 3 matches\n\n',
        'Found 1 match\n',
        'found 2 MATCHES',
        '',
        'Found x matches\n',
      ]);
      for (let block = 0, count = pick([1, 2, 3]); block < count; block++) {
        text +=
          pick(['/src/a.ts:', '/src/b c.ts:', 'src/c.ts:', '/d.ts :', '/e.ts:x']) +
          pick(['\n', ' ', '']);
        for (let line = 0, lines = pick([0, 1, 2, 3]); line < lines; line++) {
          text +=
            pick(['  Line 1: ', 'Line 22:', 'Line  3:\t', 'Line x: ']) +
            some(content, 3) +
            pick(['\n', ' ', '']);
        }
        text += pick(['\n\n', '\n\n\n', '\n']);
      }
      const expected = legacyParseGrepOutput(text);
      expect(parseGrepOutput(text)).toEqual(expected);
      if (expected) parsed++;
    }
    expect(parsed).toBeGreaterThan(600);
  });

  test('parseSessionMetadataOutput on 3000 random session dumps', () => {
    const { pick, some } = chooser(35);
    const json = [
      '{"id":"ses_1","time":{"created":1,"updated":2},"title":"First"}',
      '{"id":"ses_2","slug":"s","time":{"created":3,"updated":4}}',
      '{"id":"ses_1","time":{"created":1,"updated":2}}',
      '{"id":"x"}',
      '{"time":{}}',
      'not json',
    ];
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      let text = some([' ', '\n', 'x'], 2);
      for (let section = 0, count = pick([1, 2, 3]); section < count; section++) {
        text +=
          pick(['=== /tmp/a.json ===', '== b ==', '===', '==  c', '= d =', '=== e ===  ']) +
          some([' ', '\t', '='], 2);
        text += pick(LINE_BREAKS) + pick(json) + some([' ', '\n', '\n\n'], 2);
      }
      const expected = legacyParseSessionMetadataOutput(text);
      expect(parseSessionMetadataOutput(text)).toEqual(expected);
      if (expected) parsed++;
    }
    expect(parsed).toBeGreaterThan(600);
  });

  test('parseSessionMessagesOutput on 3000 random message logs', () => {
    const { pick, some } = chooser(36);
    const lines = [
      'hello',
      'Tools used: read, bash',
      'Tools used:',
      '  Tools used: edit',
      'Tools used',
      'bye',
      ' ',
      '',
    ];
    let parsed = 0;
    for (let i = 0; i < 3000; i++) {
      let text = some([' ', '\n', 'x'], 2);
      for (let message = 0, count = pick([1, 2, 3]); message < count; message++) {
        text += pick([
          '--- Msg 1 [user] cost=$0.01 ---',
          '--- Msg 2 [Assistant] cost=0 ---',
          '--- Msg x [user] cost=$1 ---',
        ]);
        for (let line = 0, n = pick([0, 1, 2, 3]); line < n; line++)
          text += pick(LINE_BREAKS) + some(lines, 2);
        text += some(['\n', ' ', '\t'], 2);
      }
      const expected = legacyParseSessionMessagesOutput(text);
      expect(parseSessionMessagesOutput(text)).toEqual(expected);
      if (expected) parsed++;
    }
    expect(parsed).toBeGreaterThan(600);
  });

  test('read real outputs', () => {
    const grep = 'Found 2 matches\n\n/src/a.ts:\n  Line 3: const a = 1;\n  Line 9: a();\n';
    expect(parseGrepOutput(grep)).toEqual({
      matchCount: 2,
      groups: [
        {
          filePath: '/src/a.ts',
          matches: [
            { line: 3, content: 'const a = 1' },
            { line: 9, content: 'a()' },
          ],
        },
      ],
    });
    const dump =
      '=== /tmp/s.json ===\n{"id":"ses_1","time":{"created":1,"updated":2},"title":"First"}';
    expect(parseSessionMetadataOutput(dump)).toEqual([
      {
        id: 'ses_1',
        slug: undefined,
        title: 'First',
        directory: undefined,
        time: { created: 1, updated: 2 },
        summary: undefined,
        filePath: '/tmp/s.json',
      },
    ]);
    const log = '--- Msg 1 [User] cost=$0.02 ---\nlist the files\nTools used: bash, read\n';
    expect(parseSessionMessagesOutput(log)).toEqual([
      { index: 1, role: 'user', cost: 0.02, content: 'list the files', tools: 'bash, read' },
    ]);
  });
});

describe('no tool output can freeze the grep and session renderers', () => {
  within('grep: one match whose content holds 240k spaces', () =>
    parseGrepOutput(`/a.ts:\nLine 1: x${' '.repeat(240_000)}y`),
  );
  within('grep: one match whose content alternates 120k words and spaces', () =>
    parseGrepOutput(`/a.ts:\nLine 1: ${'x '.repeat(120_000)}`),
  );
  within('session dump: a header whose title holds 240k spaces', () =>
    parseSessionMetadataOutput(`=== a${' '.repeat(240_000)}x "id"`),
  );
  within('session dump: a header followed by 120k blank lines of spaces', () =>
    parseSessionMetadataOutput(`=== a${' \n'.repeat(120_000)}x "id"`),
  );
  within('session dump: 60k header lines', () =>
    parseSessionMetadataOutput(`${'===\n'.repeat(60_000)}"id"`),
  );
  within('messages: 240k blank lines after the header', () =>
    parseSessionMessagesOutput(`--- Msg 1 [user] cost=$0 ---\nhi${'\n'.repeat(240_000)}x`),
  );
  within('messages: 120k lines that each hold one space', () =>
    parseSessionMessagesOutput(`--- Msg 1 [user] cost=$0 ---\nhi${' \n'.repeat(120_000)}x`),
  );
});
