import { describe, expect, test } from 'bun:test';

import type { KeyEvent } from '@opentui/core';

import { type AppKeyState, type Focus, globalKeyAction, globalKeyBlocked } from './app-keys.ts';

/** A KeyEvent as OpenTUI's KeyHandler delivers it. */
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

function state(overrides: Partial<AppKeyState> = {}): AppKeyState {
  return {
    focus: 'sidebar',
    route: 'session',
    overlay: null,
    quitArmed: false,
    attaching: false,
    ...overrides,
  };
}

describe('globalKeyBlocked', () => {
  test('text input and the shell keep their own keys', () => {
    expect(globalKeyBlocked('composer')).toBe(true);
    expect(globalKeyBlocked('terminal')).toBe(true);
  });

  test('a list region does not', () => {
    for (const focus of ['sidebar', 'transcript', 'screen'] as Focus[]) {
      expect(globalKeyBlocked(focus)).toBe(false);
    }
  });
});

describe('help is global only when nothing is typing', () => {
  test('`?` opens help from the sidebar and the transcript', () => {
    expect(globalKeyAction(key('?'), state({ focus: 'sidebar' }))).toEqual({
      kind: 'overlay',
      overlay: 'help',
    });
    expect(globalKeyAction(key('?'), state({ focus: 'transcript' }))).toEqual({
      kind: 'overlay',
      overlay: 'help',
    });
  });

  test('`?` while the composer is focused does NOT open help', () => {
    expect(globalKeyAction(key('?'), state({ focus: 'composer' }))).toBeNull();
  });

  test('`?` while the terminal is focused does NOT open help', () => {
    expect(globalKeyAction(key('?'), state({ focus: 'terminal' }))).toBeNull();
  });

  test('`?` while an overlay is open does nothing — the overlay owns the keys', () => {
    expect(globalKeyAction(key('?'), state({ overlay: 'help' }))).toBeNull();
    expect(globalKeyAction(key('?'), state({ overlay: 'switcher' }))).toBeNull();
  });

  test('quit still works through an open overlay — `?` is not a trap', () => {
    for (const overlay of ['help', 'switcher'] as const) {
      expect(globalKeyAction(key('c', { ctrl: true }), state({ overlay }))).toEqual({
        kind: 'arm-quit',
      });
      expect(
        globalKeyAction(key('c', { ctrl: true }), state({ overlay, quitArmed: true })),
      ).toEqual({ kind: 'quit' });
      expect(globalKeyAction(key('q', { ctrl: true }), state({ overlay }))).toEqual({
        kind: 'quit',
      });
    }
  });

  test('attach mode stays opaque — Ctrl+C there belongs to opencode', () => {
    expect(globalKeyAction(key('c', { ctrl: true }), state({ attaching: true }))).toBeNull();
    expect(globalKeyAction(key('q', { ctrl: true }), state({ attaching: true }))).toBeNull();
  });
});

describe('quitting', () => {
  test('Ctrl+C arms, the second press leaves', () => {
    expect(globalKeyAction(key('c', { ctrl: true }), state())).toEqual({ kind: 'arm-quit' });
    expect(globalKeyAction(key('c', { ctrl: true }), state({ quitArmed: true }))).toEqual({
      kind: 'quit',
    });
  });

  test('Ctrl+Q leaves on the first press', () => {
    expect(globalKeyAction(key('q', { ctrl: true }), state())).toEqual({ kind: 'quit' });
  });

  test('Ctrl+C while the terminal is focused does NOT arm quit — it is the shell’s', () => {
    expect(globalKeyAction(key('c', { ctrl: true }), state({ focus: 'terminal' }))).toBeNull();
    expect(
      globalKeyAction(key('c', { ctrl: true }), state({ focus: 'terminal', quitArmed: true })),
    ).toBeNull();
  });

  test('Ctrl+Q still leaves from the terminal — it is reserved', () => {
    expect(globalKeyAction(key('q', { ctrl: true }), state({ focus: 'terminal' }))).toEqual({
      kind: 'quit',
    });
  });
});

describe('the terminal keeps every key that is not reserved', () => {
  const focus: Focus = 'terminal';

  test('reserved chords stay with the app', () => {
    expect(globalKeyAction(key('tab'), state({ focus }))).toEqual({ kind: 'focus', step: 1 });
    expect(globalKeyAction(key('tab', { shift: true }), state({ focus }))).toEqual({
      kind: 'focus',
      step: -1,
    });
    expect(globalKeyAction(key('t', { meta: true }), state({ focus }))).toEqual({
      kind: 'toggle-terminal',
    });
  });

  test('everything else falls through to the shell', () => {
    for (const event of [
      key('j'),
      key('escape'),
      key('p', { ctrl: true }),
      key('n', { ctrl: true }),
      key('f', { meta: true }),
      key('o', { meta: true }),
    ]) {
      expect(globalKeyAction(event, state({ focus }))).toBeNull();
    }
  });
});

describe('routes and navigation', () => {
  test('Alt chords open their screens under either terminal convention', () => {
    expect(globalKeyAction(key('f', { meta: true }), state())).toEqual({
      kind: 'route',
      route: 'files',
    });
    expect(globalKeyAction(key('r', { option: true }), state())).toEqual({
      kind: 'route',
      route: 'review',
    });
    expect(globalKeyAction(key('a', { meta: true }), state())).toEqual({
      kind: 'route',
      route: 'apps',
    });
    expect(globalKeyAction(key('c', { meta: true }), state())).toEqual({
      kind: 'route',
      route: 'customize',
    });
    expect(globalKeyAction(key('u', { meta: true }), state())).toEqual({
      kind: 'route',
      route: 'account',
    });
  });

  test('Ctrl+P, Ctrl+N, Ctrl+H and Alt+O are global', () => {
    expect(globalKeyAction(key('p', { ctrl: true }), state())).toEqual({
      kind: 'overlay',
      overlay: 'switcher',
    });
    expect(globalKeyAction(key('n', { ctrl: true }), state())).toEqual({ kind: 'new-session' });
    expect(globalKeyAction(key('h', { ctrl: true }), state())).toEqual({ kind: 'switch-host' });
    expect(globalKeyAction(key('o', { meta: true }), state())).toEqual({ kind: 'attach' });
  });

  test('Ctrl+N still works while the composer is focused: it is not a bare key', () => {
    expect(globalKeyAction(key('n', { ctrl: true }), state({ focus: 'composer' }))).toEqual({
      kind: 'new-session',
    });
  });
});

describe('Esc', () => {
  test('leaves a screen for the session', () => {
    expect(globalKeyAction(key('escape'), state({ route: 'files', focus: 'screen' }))).toEqual({
      kind: 'back',
    });
  });

  test('in the transcript it moves focus to the composer', () => {
    expect(globalKeyAction(key('escape'), state({ focus: 'transcript' }))).toEqual({
      kind: 'focus-composer',
    });
  });

  test('in the composer it is the composer’s: clear the draft, then stop', () => {
    expect(globalKeyAction(key('escape'), state({ focus: 'composer' }))).toBeNull();
  });

  test('in the sidebar it is the sidebar’s: cancel the filter or the confirm', () => {
    expect(globalKeyAction(key('escape'), state({ focus: 'sidebar' }))).toBeNull();
  });
});

describe('attach mode suspends the keyboard', () => {
  test('nothing is dispatched while opencode owns the terminal', () => {
    for (const event of [key('?'), key('escape'), key('c', { ctrl: true }), key('tab')]) {
      expect(globalKeyAction(event, state({ attaching: true }))).toBeNull();
    }
  });
});
