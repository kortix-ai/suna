import { describe, expect, test } from 'bun:test';

import { CLI_INSTALL_COMMAND, connectCommand } from './connect-hint.tsx';
import { TERMINAL_KEYMAP, isReservedWhileTerminalFocused, matchesTerminalBinding } from './keys.ts';

/** A `KeyEvent`-shaped literal. Only the fields `matchesChord` reads matter. */
function key(name: string, mods: { ctrl?: boolean; shift?: boolean; option?: boolean } = {}) {
  return {
    name,
    ctrl: Boolean(mods.ctrl),
    shift: Boolean(mods.shift),
    option: Boolean(mods.option),
    meta: false,
    sequence: name,
    raw: name,
    eventType: 'press',
    repeated: false,
    preventDefault: () => {},
  } as never;
}

describe('connect hint', () => {
  test('is the same pair of commands the web panel prints', () => {
    expect(CLI_INSTALL_COMMAND).toBe('curl -fsSL https://kortix.com/install | bash');
    expect(connectCommand('abc-123')).toBe('kortix sessions connect abc-123');
  });
});

describe('terminal keymap', () => {
  test('every binding is an Alt chord — a bare letter belongs to the shell', () => {
    for (const binding of TERMINAL_KEYMAP) {
      for (const chord of binding.chords) {
        expect(chord.alt).toBe(true);
      }
    }
  });

  test('matches its own chords and nothing else', () => {
    expect(matchesTerminalBinding(key('y', { option: true }), 'terminal.copyConnect')).toBe(true);
    expect(matchesTerminalBinding(key('y'), 'terminal.copyConnect')).toBe(false);
    expect(matchesTerminalBinding(key('x', { option: true }), 'terminal.close')).toBe(true);
    expect(matchesTerminalBinding(key('x'), 'terminal.close')).toBe(false);
    expect(matchesTerminalBinding(key('return', { option: true }), 'terminal.reconnect')).toBe(
      true,
    );
    expect(matchesTerminalBinding(key('return'), 'terminal.reconnect')).toBe(false);
  });

  test('the app keeps Tab, Shift+Tab, Alt+T and Ctrl+Q — the shell keeps Ctrl+C', () => {
    expect(isReservedWhileTerminalFocused(key('tab'))).toBe(true);
    expect(isReservedWhileTerminalFocused(key('tab', { shift: true }))).toBe(true);
    expect(isReservedWhileTerminalFocused(key('t', { option: true }))).toBe(true);
    expect(isReservedWhileTerminalFocused(key('q', { ctrl: true }))).toBe(true);
    // The one that must NOT be swallowed: a shell without Ctrl+C is not a shell.
    expect(isReservedWhileTerminalFocused(key('c', { ctrl: true }))).toBe(false);
    expect(isReservedWhileTerminalFocused(key('a'))).toBe(false);
    expect(isReservedWhileTerminalFocused(key('escape'))).toBe(false);
  });
});
