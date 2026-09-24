import { describe, expect, test } from 'bun:test';
import {
  conversationHeader,
  digitsBefore,
  parseSessionGetOutput,
  sessionTitle,
  spacedPair,
  todosBody,
} from './session-get';
import { chooser, within } from './testing';

// The session_get renderers' parser (web session-get-tool.tsx, mobile
// agents-session.ts), verbatim, and its regexes, kept ONLY as parity oracles.
interface LegacySessionGet {
  title: string;
  id: string;
  created: string;
  updated: string;
  changes: string;
  parent: string | null;
  todos: Array<{ status: string; text: string }>;
  msgCount: string;
  toolCount: string;
  compression: string | null;
  conversation: string;
  hasConversation: boolean;
}

function legacyParseSessionGetOutput(output: string, sid: string): LegacySessionGet | null {
  if (!output) return null;
  const titleMatch = output.match(/^=== SESSION:\s*(.+?)\s*===$/m);
  const idMatch = output.match(/^ID:\s*(ses_\S+)/m);
  const createdMatch = output.match(/Created:\s*(\S+ \S+)/);
  const updatedMatch = output.match(/Updated:\s*(\S+ \S+)/);
  const changesMatch = output.match(/^Changes:\s*(.+)/m);
  const parentMatch = output.match(/^Parent:\s*(ses_\S+)/m);

  const todosSection = output.match(/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m);
  const todos: Array<{ status: string; text: string }> = [];
  if (todosSection) {
    for (const line of todosSection[1].split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === '(none)') continue;
      const sm = trimmed.match(/^\[(\w+)\]\s*(.*)/);
      if (sm) todos.push({ status: sm[1], text: sm[2] });
      else todos.push({ status: 'pending', text: trimmed });
    }
  }

  const convHeader = output.match(/=== CONVERSATION \((.+?)\) ===/);
  const msgCount = convHeader?.[1]?.match(/(\d+) msgs?/)?.[1] || '0';
  const toolCount = convHeader?.[1]?.match(/(\d+) tool calls?/)?.[1] || '0';
  const compressionMatch = output.match(/=== COMPRESSION ===\n(.+)/m);

  const convStart = convHeader ? output.indexOf(convHeader[0]) + convHeader[0].length : -1;
  const convEnd = compressionMatch ? output.indexOf('=== COMPRESSION ===') : output.length;
  const conversation = convStart > 0 ? output.slice(convStart, convEnd).trim() : '';

  return {
    title: titleMatch?.[1] ?? 'Unknown Session',
    id: idMatch?.[1] ?? sid,
    created: createdMatch?.[1] ?? '',
    updated: updatedMatch?.[1] ?? '',
    changes: changesMatch?.[1] ?? '',
    parent: parentMatch?.[1] ?? null,
    todos,
    msgCount,
    toolCount,
    compression: compressionMatch?.[1]?.trim() ?? null,
    conversation,
    hasConversation: !!convHeader,
  };
}

const legacyTitle = (text: string) => text.match(/^=== SESSION:\s*(.+?)\s*===$/m)?.[1] ?? null;
const legacyPair = (text: string, label: 'Created:' | 'Updated:') =>
  (label === 'Created:'
    ? text.match(/Created:\s*(\S+ \S+)/)
    : text.match(/Updated:\s*(\S+ \S+)/))?.[1] ?? null;
const legacyTodos = (text: string) =>
  text.match(/^Todos:\n([\s\S]*?)(?=\n(?:Lineage|Storage|===))/m)?.[1] ?? null;
function legacyConversation(text: string) {
  const m = text.match(/=== CONVERSATION \((.+?)\) ===/);
  return m ? { index: m.index ?? 0, end: (m.index ?? 0) + m[0].length, inner: m[1] ?? '' } : null;
}
const legacyDigits = (text: string, suffix: ' msg' | ' tool call') =>
  (suffix === ' msg' ? text.match(/(\d+) msgs?/) : text.match(/(\d+) tool calls?/))?.[1] ?? null;

const LS = String.fromCharCode(0x2028);
const BREAKS = ['\n', '\n', '\r\n', '\r', LS];

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

describe('the session_get readers return what their regexes returned', () => {
  test('sessionTitle', () =>
    fuzz(
      41,
      ({ pick, some }) => {
        let text = some(['x', ' ', '\n'], 2);
        for (let line = 0, n = pick([1, 2, 3]); line < n; line++) {
          text += pick(['=== SESSION:', '=== SESSION:', ' === SESSION:', '=== SESSION']);
          text +=
            some([' ', '\t', 'a', 'b c', '=', '==', '===', ' ', 'a', pick(BREAKS)], 4) +
            pick(['===', '===', '===', ' ===', '', '= =']);
          text += pick([...BREAKS, ' ', '']);
        }
        return text;
      },
      (text) => {
        const expected = legacyTitle(text);
        expect(sessionTitle(text)).toBe(expected);
        return expected !== null;
      },
    ));

  test('spacedPair', () =>
    fuzz(
      42,
      ({ some }) =>
        some(
          [
            'Created:',
            'Updated:',
            'Created: 2026-01-01 12:00',
            'Updated:\t2026-01-02 13:00',
            ' ',
            '  ',
            '\t',
            '\n',
            '2026-01-01',
            '12:00',
            'a',
            'Created:x',
          ],
          8,
        ),
      (text) => {
        const created = legacyPair(text, 'Created:');
        const updated = legacyPair(text, 'Updated:');
        expect(spacedPair(text, 'Created:')).toBe(created);
        expect(spacedPair(text, 'Updated:')).toBe(updated);
        return created !== null || updated !== null;
      },
    ));

  test('todosBody', () =>
    fuzz(
      43,
      ({ pick, some }) =>
        some(['x', '\n', ' '], 2) +
        pick(['Todos:\n', 'Todos:\n', ' Todos:\n', 'Todos:']) +
        some(
          [
            '[done] a',
            '(none)',
            '\n',
            '\nLineage',
            '\nStorage',
            '\n===',
            'x',
            '\r',
            'Todos:\n',
            '\nLine',
            '\nLineage',
          ],
          5,
        ),
      (text) => {
        const expected = legacyTodos(text);
        expect(todosBody(text)).toBe(expected);
        return expected !== null;
      },
    ));

  test('conversationHeader', () =>
    fuzz(
      44,
      ({ some }) =>
        some(
          [
            '=== CONVERSATION (',
            '=== CONVERSATION (3 msgs, 1 tool call) ===',
            ') ===',
            ')',
            '3 msgs',
            ', ',
            '\n',
            'x',
            ') ==',
            '\r',
            '=== CONVERSATION (',
          ],
          6,
        ),
      (text) => {
        const expected = legacyConversation(text);
        expect(conversationHeader(text)).toEqual(expected);
        return expected !== null;
      },
    ));

  test('digitsBefore', () =>
    fuzz(
      45,
      ({ some }) =>
        some(['12', '3', ' msgs', ' msg', ' tool calls', ' tool call', 'x', ' ', 'msg', '0'], 6),
      (text) => {
        const msgs = legacyDigits(text, ' msg');
        const tools = legacyDigits(text, ' tool call');
        expect(digitsBefore(text, ' msg')).toBe(msgs);
        expect(digitsBefore(text, ' tool call')).toBe(tools);
        return msgs !== null || tools !== null;
      },
    ));
});

describe('parseSessionGetOutput', () => {
  test('returns what the regex parser returned on 3000 random session_get outputs', () =>
    fuzz(
      46,
      ({ pick, some }) => {
        const lines = [
          '=== SESSION: Fix the build ===',
          '=== SESSION:  ===',
          'ID: ses_abc123',
          'Created: 2026-01-01 12:00',
          'Updated: 2026-01-02 13:00',
          'Changes: +3 -1',
          'Parent: ses_parent',
          'Todos:',
          '[done] write tests',
          '[pending] ship',
          '(none)',
          'Lineage: root',
          'Storage: 3 MB',
          '=== CONVERSATION (4 msgs, 2 tool calls) ===',
          'user: hi',
          '=== COMPRESSION ===',
          'compressed 2 turns',
          '',
          '  ',
        ];
        let text = '';
        for (let line = 0, n = pick([3, 6, 9, 12]); line < n; line++)
          text += pick(lines) + pick(BREAKS);
        return text + some(['x', ' '], 2);
      },
      (text) => {
        const expected = legacyParseSessionGetOutput(text, 'ses_input');
        expect(parseSessionGetOutput(text, 'ses_input')).toEqual(expected);
        return expected !== null && expected.title !== 'Unknown Session';
      },
    ));
});

describe('no session_get output can freeze the renderer', () => {
  within('a title holding 240k spaces', () =>
    parseSessionGetOutput(`=== SESSION: a${' '.repeat(240_000)}x`, ''),
  );
  within('30k "Created:" labels and no space (240k characters)', () =>
    parseSessionGetOutput('Created:'.repeat(30_000), ''),
  );
  within('34k "Todos:" sections that never end (238k characters)', () =>
    parseSessionGetOutput('Todos:\n'.repeat(34_000), ''),
  );
  within('13k conversation headers that never close on one line (234k characters)', () =>
    parseSessionGetOutput('=== CONVERSATION ('.repeat(13_000), ''),
  );
  within('a conversation header holding 240k digits', () =>
    parseSessionGetOutput(`=== CONVERSATION (${'1'.repeat(240_000)} x) ===`, ''),
  );
});
