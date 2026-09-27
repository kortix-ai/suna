import { describe, expect, test } from 'bun:test';

import type { KeyEvent } from '@opentui/core';

import { TERMINAL_RESERVED_CHORDS, isReservedWhileTerminalFocused } from './keys.ts';

function key(name: string, modifiers: Partial<KeyEvent> = {}): KeyEvent {
  return {
    name,
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    sequence: name,
    number: false,
    raw: name,
    eventType: 'press',
    source: 'raw',
    ...modifiers,
  } as KeyEvent;
}

describe('TERMINAL_RESERVED_CHORDS', () => {
  test('is exactly Tab, Shift+Tab, Alt+T, Alt+P, Alt+L and Ctrl+Q', () => {
    expect(TERMINAL_RESERVED_CHORDS).toEqual([
      { key: 'tab' },
      { key: 'tab', shift: true },
      { key: 't', alt: true },
      { key: 'p', alt: true },
      { key: 'l', alt: true },
      { key: 'q', ctrl: true },
    ]);
  });

  test('Alt+L is the app’s in a raw terminal (ESC l) and under kitty', () => {
    expect(isReservedWhileTerminalFocused(key('l', { meta: true }))).toBe(true);
    expect(isReservedWhileTerminalFocused(key('l', { option: true, meta: true }))).toBe(true);
  });

  test('Ctrl+C, Alt+B and a plain letter stay the shell’s', () => {
    expect(isReservedWhileTerminalFocused(key('c', { ctrl: true }))).toBe(false);
    expect(isReservedWhileTerminalFocused(key('b', { meta: true }))).toBe(false);
    expect(isReservedWhileTerminalFocused(key('l'))).toBe(false);
  });
});
