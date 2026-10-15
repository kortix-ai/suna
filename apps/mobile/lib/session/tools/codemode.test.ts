import { describe, expect, test } from 'bun:test';

import {
  codemodeCallArg,
  codemodeCalls,
  codemodeResult,
  codemodeSummary,
  codemodeTitle,
} from './codemode';

describe('codemodeCalls (web codemode-tool.tsx)', () => {
  test('reads the live pi record: id, args as JSON text, ok/cancelled', () => {
    expect(
      codemodeCalls({
        calls: [
          { id: 'c1', name: 'read', args: '{"path":"/a.ts"}', status: 'ok', durationMs: 12 },
          { id: 'c2', name: 'bash', args: '"ls"', status: 'running' },
          { id: 'c3', name: 'write', status: 'cancelled' },
        ],
      }),
    ).toEqual([
      { id: 'c1', name: 'read', arg: 'a.ts', status: 'ok', durationMs: 12 },
      { id: 'c2', name: 'bash', arg: 'ls', status: 'running' },
      { id: 'c3', name: 'write', arg: '', status: 'cancelled' },
    ]);
  });

  test('reads the session log at rest: call_id, input, complete/interrupted', () => {
    expect(
      codemodeCalls({
        calls: [
          {
            call_id: 'c1',
            name: 'grep',
            input: { pattern: 'x' },
            status: 'complete',
            duration_ms: 1200,
          },
          { call_id: 'c2', name: 'bash', status: 'interrupted' },
        ],
      }),
    ).toEqual([
      { id: 'c1', name: 'grep', arg: '"x"', status: 'ok', durationMs: 1200 },
      { id: 'c2', name: 'bash', arg: '', status: 'cancelled' },
    ]);
  });

  test('a blocked call whose error is a pi refusal reads refused, not error', () => {
    expect(
      codemodeCalls({
        calls: [
          { id: 'c1', name: 'bash', status: 'error', error: 'The project policy denies this call' },
          {
            id: 'c2',
            name: 'bash',
            status: 'error',
            error: 'Call bash directly, not from a script',
          },
          { id: 'c3', name: 'bash', status: 'error', error: 'Segmentation fault' },
        ],
      }).map((c) => c.status),
    ).toEqual(['refused', 'refused', 'error']);
  });

  test('no calls or a non-array metadata reads as none', () => {
    expect(codemodeCalls({})).toEqual([]);
    expect(codemodeCalls({ calls: 'nope' })).toEqual([]);
  });

  test('an unparsable args string stays as written', () => {
    expect(codemodeCallArg('bash', '{truncated')).toBe('{truncated');
  });
});

describe('codemodeTitle', () => {
  test('live runs shimmer "Running script"; a failure says so; a settled call "Ran script"', () => {
    expect(codemodeTitle('running', true)).toBe('Running script');
    expect(codemodeTitle('created', true)).toBe('Running script');
    expect(codemodeTitle('error', true)).toBe('Script failed');
    expect(codemodeTitle('completed', false)).toBe('Ran script');
    expect(codemodeTitle('completed', true)).toBe('Ran script');
  });
});

describe('codemodeSummary', () => {
  test('the count, then the distinct call names', () => {
    expect(codemodeSummary([])).toBe('');
    expect(codemodeSummary([{ id: 'c1', name: 'read', arg: '', status: 'ok' }])).toBe(
      '1 tool call · read',
    );
    expect(
      codemodeSummary([
        { id: 'c1', name: 'read', arg: '', status: 'ok' },
        { id: 'c2', name: 'read', arg: '', status: 'ok' },
        { id: 'c3', name: 'bash', arg: '', status: 'ok' },
      ]),
    ).toBe('3 tool calls · read · bash');
  });
});

describe('codemodeResult', () => {
  test('strips the completed/failed header, wall time and Output: lines', () => {
    expect(codemodeResult('Script completed\nWall time 1.2 s\nOutput:\nhello')).toBe('hello');
    expect(codemodeResult('Script failed\nOutput:\nboom')).toBe('boom');
    expect(codemodeResult('plain text')).toBe('plain text');
    expect(codemodeResult('')).toBe('');
  });
});
