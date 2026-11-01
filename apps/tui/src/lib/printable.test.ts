import { describe, expect, test } from 'bun:test';

import { printable } from './printable.ts';

describe('printable', () => {
  test('a stored title cannot carry a terminal escape: C0, DEL and C1 controls become spaces', () => {
    // BEL ends the window-title OSC the TUI writes; ESC ] 0 ; then starts a title of the
    // attacker's choosing (measured: tmux pane title became "PWNED" through setTerminalTitle).
    expect(printable('session\x07\x1b]0;PWNED\x07')).toBe('session  ]0;PWNED ');
    expect(printable('a\x9b2Jb\x7fc')).toBe('a 2Jb c');
    expect(printable('multi\nline\ttitle')).toBe('multi line title');
  });

  test('ordinary text, including non-Latin and emoji, is unchanged', () => {
    expect(printable('Fix login · 修复 · ✅')).toBe('Fix login · 修复 · ✅');
  });
});
