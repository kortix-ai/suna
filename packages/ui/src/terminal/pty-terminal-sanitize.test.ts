import { describe, expect, test } from 'bun:test';

import { isTerminalReport, sanitizeTerminalChunk } from './pty-terminal';

/**
 * Characterization tests for the terminal-output sanitizers, written before
 * the helpers move into `pty-terminal-sanitize.ts`. They pin the exact
 * sequences the component strips today; the file imports from `./pty-terminal`
 * both before and after the move (the component re-exports the moved
 * helpers), so this file is identical on both sides of the refactor.
 */

describe('sanitizeTerminalChunk', () => {
  test('strips the Cursor shell-integration OSC 697 payload and cursor JSON', () => {
    expect(sanitizeTerminalChunk('\x1b]697;{"cursor":12}\x07')).toBe('');
    expect(sanitizeTerminalChunk('\x1b]697;{"cursor":12}\x1b\\')).toBe('');
    expect(sanitizeTerminalChunk('a{"cursor":5}b')).toBe('ab');
  });

  test('strips capability-query echoes: color reports, DECRQM, CPR, DA', () => {
    expect(sanitizeTerminalChunk('\x1b]10;rgb:1a2b/3c4d/5e6f\x07')).toBe('');
    expect(sanitizeTerminalChunk('\x1b]4;1;rgb:ffff/0000/0000\x1b\\')).toBe('');
    expect(sanitizeTerminalChunk('\x1b[?2004;2$y')).toBe('');
    expect(sanitizeTerminalChunk('\x1b[3;5R')).toBe('');
    expect(sanitizeTerminalChunk('\x1b[?62c')).toBe('');
  });

  test('leaves ordinary shell output alone', () => {
    expect(sanitizeTerminalChunk('hello world\r\n$ ')).toBe('hello world\r\n$ ');
  });
});

describe('isTerminalReport', () => {
  test('recognizes the report sequences xterm auto-generates', () => {
    expect(isTerminalReport('\x1b[3;5R')).toBe(true);
    expect(isTerminalReport('\x1b[?2004;2$y')).toBe(true);
    expect(isTerminalReport('\x1b[?62c')).toBe(true);
    expect(isTerminalReport('\x1b]10;rgb:1a2b/3c4d/5e6f\x07')).toBe(true);
  });

  test('rejects real keystrokes and window-title sequences', () => {
    expect(isTerminalReport('ls\n')).toBe(false);
    expect(isTerminalReport('ls\x1b[3;5R')).toBe(false);
    expect(isTerminalReport('\x1b]0;title\x07')).toBe(false);
  });
});
