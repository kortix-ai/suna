/**
 * `stripMarkupForToolOutput` (from `@kortix/shared`), which the mobile PTY
 * kill renderer (`pty-kill-tool.tsx`) uses to flatten tool output.
 */
import { describe, expect, test } from 'bun:test';

import { stripMarkupForToolOutput } from '@kortix/shared';

describe('stripMarkupForToolOutput (shared @kortix/shared)', () => {
  test('drops tags and collapses whitespace onto one line', () => {
    expect(stripMarkupForToolOutput('<pty_killed>\n  Killed  pty-1\n</pty_killed>')).toBe('Killed pty-1');
  });

  test('drops comments and keeps quoted `>` inside a tag', () => {
    expect(stripMarkupForToolOutput('a <!-- x --> <b title="1>2">b</b>')).toBe('a b');
  });

  test('an unterminated tag cuts the rest, as web does', () => {
    expect(stripMarkupForToolOutput('ok <broken')).toBe('ok');
  });
});
