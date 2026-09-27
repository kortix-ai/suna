import { describe, expect, test } from 'bun:test';

import {
  formatBashOutput,
  formatSessionTime,
  formatSessionTimeFallback,
  getToolDiagnosticsFrom,
  hasStructuredContent,
  normalizeToolOutput,
  parseConnectorOutput,
  parseDiagnosticsFromToolOutput,
  parseFilePaths,
  parseGrepOutput,
  parseSessionMessagesOutput,
  parseSessionMetadataOutput,
  parseStructuredOutput,
  parseTodos,
} from './tool-output-parsers';

// Ported from apps/web tool/shared/todo-helpers.test.tsx.
describe('parseTodos', () => {
  test('keeps well-formed todos and normalises an unknown status to pending', () => {
    expect(
      parseTodos([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'wat' },
        { content: 'c' },
      ]),
    ).toEqual([
      { content: 'a', status: 'completed', priority: undefined },
      { content: 'b', status: 'pending', priority: undefined },
      { content: 'c', status: 'pending', priority: undefined },
    ]);
  });

  test('drops anything without usable content, and never throws on junk', () => {
    expect(parseTodos([null, 7, {}, { content: '   ' }, 'nope'])).toEqual([]);
    expect(parseTodos(undefined)).toEqual([]);
    expect(parseTodos({ content: 'not an array' })).toEqual([]);
  });
});

describe('parseStructuredOutput', () => {
  test('warnings, installs, info, and plain sections', () => {
    const sections = parseStructuredOutput(
      'warning: something old\n  continues here\nUsing CPython 3.12\nInstalled 3 packages in 2ms\nhello\nworld',
    );
    expect(sections).toEqual([
      { type: 'warning', text: 'something old continues here' },
      { type: 'info', text: 'Using CPython 3.12' },
      { type: 'install', text: 'Installed 3 packages in 2ms' },
      { type: 'plain', text: 'hello\nworld' },
    ]);
  });

  test('a traceback yields the trace and a typed error summary', () => {
    const sections = parseStructuredOutput(
      'Traceback (most recent call last):\n  File "a.py", line 1, in <module>\nValueError: bad value',
    );
    expect(sections[0]).toEqual({
      type: 'traceback',
      lines: ['Traceback (most recent call last):', '  File "a.py", line 1, in <module>', 'ValueError: bad value'],
    });
    expect(sections[1]).toEqual({ type: 'error', summary: 'bad value', errorType: 'ValueError' });
  });

  test('normalize inserts newlines before markers in collapsed output', () => {
    expect(normalizeToolOutput('ok warning: x Traceback (most recent call last):')).toBe(
      'ok\nwarning: x\nTraceback (most recent call last):',
    );
    expect(hasStructuredContent('Traceback (most recent call last):')).toBe(true);
    expect(hasStructuredContent('all fine')).toBe(false);
  });
});

describe('parseFilePaths / parseGrepOutput', () => {
  test('path-like output (70%+) returns the paths', () => {
    expect(parseFilePaths('/a/b.ts\n./c.ts\n~/d.ts')).toEqual(['/a/b.ts', './c.ts', '~/d.ts']);
    expect(parseFilePaths('no paths here\nat all')).toBeNull();
    expect(parseFilePaths('')).toBeNull();
  });

  test('grep groups matches per file and reads the header count', () => {
    const parsed = parseGrepOutput(
      'Found 3 matches\n\n/src/a.ts:\n  Line 3: const a = 1;\n  Line 9: a++\n\n/src/b.ts:\n  Line 1: import a',
    );
    expect(parsed?.matchCount).toBe(3);
    expect(parsed?.groups).toEqual([
      { filePath: '/src/a.ts', matches: [{ line: 3, content: 'const a = 1' }, { line: 9, content: 'a++' }] },
      { filePath: '/src/b.ts', matches: [{ line: 1, content: 'import a' }] },
    ]);
  });
});

describe('session helpers', () => {
  test('formatBashOutput pretty-prints JSON and leaves text as bash', () => {
    expect(formatBashOutput('{"a":1}')).toEqual({ content: '{\n  "a": 1\n}', lang: 'json' });
    expect(formatBashOutput(' ls ')).toEqual({ content: 'ls', lang: 'bash' });
    expect(formatBashOutput('')).toEqual({ content: '', lang: 'bash' });
  });

  test('parseSessionMetadataOutput reads === sections of session JSON', () => {
    const out = '=== /tmp/s1.json ===\n{"id":"ses_1","title":"One","time":{"created":1,"updated":2}}';
    expect(parseSessionMetadataOutput(out)).toEqual([
      {
        id: 'ses_1',
        slug: undefined,
        title: 'One',
        directory: undefined,
        time: { created: 1, updated: 2 },
        summary: undefined,
        filePath: '/tmp/s1.json',
      },
    ]);
    expect(parseSessionMetadataOutput('plain')).toBeNull();
  });

  test('parseSessionMessagesOutput splits messages and tools', () => {
    const out = '--- Msg 1 [User] cost=$0.0012 ---\nhello\n--- Msg 2 [assistant] cost=0 ---\nhi\nTools used: bash (completed)';
    expect(parseSessionMessagesOutput(out)).toEqual([
      { index: 1, role: 'user', cost: 0.0012, content: 'hello', tools: undefined },
      { index: 2, role: 'assistant', cost: 0, content: 'hi', tools: 'bash (completed)' },
    ]);
  });

  test('formatSessionTime is relative; the fallback is a UTC date', () => {
    const now = Date.now();
    expect(formatSessionTime(now)).toBe('just now');
    expect(formatSessionTime(now - 5 * 60_000)).toBe('5m ago');
    expect(formatSessionTime(now - 3 * 3_600_000)).toBe('3h ago');
    expect(formatSessionTimeFallback(Date.UTC(2026, 0, 5))).toBe('Jan 5');
  });
});

describe('parseConnectorOutput', () => {
  test('objects only', () => {
    expect(parseConnectorOutput('{"a":1}')).toEqual({ a: 1 });
    expect(parseConnectorOutput('nope')).toBeNull();
    expect(parseConnectorOutput('')).toBeNull();
  });
});

describe('diagnostics', () => {
  const output =
    'wrote file\n<file_diagnostics>\nError: /workspace/src/a.ts:3:5 [typescript][2322] Type mismatch\nWarn: /workspace/src/a.ts:7:1 [typescript][6133] (unnecessary) unused\nInfo: /workspace/src/b.ts:1:1 [x] note\n</file_diagnostics>';

  test('parses the tagged LSP lines, 0-indexed', () => {
    const parsed = parseDiagnosticsFromToolOutput(output);
    expect(parsed['/workspace/src/a.ts']).toEqual([
      { file: '/workspace/src/a.ts', line: 2, column: 4, severity: 1, message: 'Type mismatch', source: 'typescript' },
      { file: '/workspace/src/a.ts', line: 6, column: 0, severity: 2, message: 'unused', source: 'typescript' },
    ]);
  });

  test('getToolDiagnosticsFrom keeps errors and warnings for the file, max 5', () => {
    const diags = getToolDiagnosticsFrom(output, {}, 'src/a.ts');
    expect(diags.map((d) => [d.range.start.line, d.severity])).toEqual([
      [2, 1],
      [6, 2],
    ]);
    expect(getToolDiagnosticsFrom(output, {}, undefined)).toEqual([]);
  });

  test('falls back to metadata diagnostics (errors only)', () => {
    const metadata = {
      diagnostics: {
        '/a.ts': [
          { range: { start: { line: 1, character: 0 }, end: { line: 1, character: 2 } }, message: 'e', severity: 1 },
          { range: { start: { line: 2, character: 0 }, end: { line: 2, character: 2 } }, message: 'w', severity: 2 },
        ],
      },
    };
    expect(getToolDiagnosticsFrom('', metadata, '/a.ts').map((d) => d.message)).toEqual(['e']);
  });
});
