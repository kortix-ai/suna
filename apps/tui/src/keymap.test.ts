import { describe, expect, test } from 'bun:test';

import type { KeyEvent } from '@opentui/core';

import { ACCOUNT_KEYS } from './features/account/keys.ts';
import { APPS_KEYS } from './features/apps/keys.ts';
import { CUSTOMIZE_KEYS } from './features/customize/keys.ts';
import { FILES_KEYS } from './features/files/keys.ts';
import { LOGIN_KEYS } from './features/login/keys.ts';
import { REVIEW_KEYS } from './features/review/keys.ts';
import { COMPOSER_KEYMAP } from './features/session/composer/keys.ts';
import { TRANSCRIPT_KEYS } from './features/session/transcript/keys.ts';
import { SIDEBAR_KEYS } from './features/sidebar/keys.ts';
import { TERMINAL_KEYMAP } from './features/terminal/keys.ts';
import {
  KEYMAP,
  SCOPE_ORDER,
  SCOPE_TITLE,
  allBindings,
  bindingFor,
  bindingsForScope,
  formatBinding,
  formatChord,
  hintFor,
  matchesBinding,
  matchesChord,
} from './keymap.ts';

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

describe('KEYMAP table', () => {
  test('every id is unique', () => {
    const ids = KEYMAP.map((binding) => binding.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('every binding has at least one chord and a description', () => {
    for (const binding of KEYMAP) {
      expect(binding.chords.length).toBeGreaterThan(0);
      expect(binding.description.length).toBeGreaterThan(0);
      for (const chord of binding.chords) expect(chord.key.length).toBeGreaterThan(0);
    }
  });

  // Only the GLOBAL scope has to be chord-unique. A feature scope answers
  // different keys in different modes on purpose — the sidebar's `n` is `new
  // session` in the list and `no` in the delete confirm — so a per-scope
  // uniqueness rule there would be false.
  test('no two global bindings answer the same chord', () => {
    const seen = new Map<string, string>();
    for (const binding of allBindings().filter((entry) => entry.scope === 'global')) {
      for (const chord of binding.chords) {
        const id = [
          chord.key.length === 1 && chord.key >= 'A' && chord.key <= 'Z'
            ? `${chord.key.toLowerCase()}+shift`
            : `${chord.key.toLowerCase()}${chord.shift ? '+shift' : ''}`,
          chord.ctrl ? 'ctrl' : '',
          chord.alt ? 'alt' : '',
        ].join('|');
        expect(seen.get(id) ?? binding.id).toBe(binding.id);
        seen.set(id, binding.id);
      }
    }
  });

  test('every binding the app dispatches on is present', () => {
    // The ids app.tsx switches on. A rename here is a missing key at runtime.
    const required = [
      'quit',
      'help',
      'focus.next',
      'focus.prev',
      'panel.terminal',
      'back',
      'list.up',
      'list.down',
      'list.open',
    ];
    for (const id of required) expect(KEYMAP.some((binding) => binding.id === id)).toBe(true);
  });
});

describe('allBindings', () => {
  const TABLES: [string, readonly { id: string }[]][] = [
    ['sidebar', SIDEBAR_KEYS],
    ['transcript', TRANSCRIPT_KEYS],
    ['composer', COMPOSER_KEYMAP],
    ['terminal', TERMINAL_KEYMAP],
    ['files', FILES_KEYS],
    ['review', REVIEW_KEYS],
    ['apps', APPS_KEYS],
    ['customize', CUSTOMIZE_KEYS],
    ['account', ACCOUNT_KEYS],
    ['login', LOGIN_KEYS],
  ];

  test('every feature table is included, whole', () => {
    const ids = new Set(allBindings().map((binding) => binding.id));
    for (const [name, table] of TABLES) {
      for (const binding of table) {
        expect(`${name}:${binding.id}:${ids.has(binding.id)}`).toBe(`${name}:${binding.id}:true`);
      }
    }
  });

  test('the count is exactly this file plus every feature table', () => {
    const expected = KEYMAP.length + TABLES.reduce((sum, [, table]) => sum + table.length, 0);
    expect(allBindings().length).toBe(expected);
  });

  test('no id is declared twice across the whole app', () => {
    const ids = allBindings().map((binding) => binding.id);
    const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
    expect(duplicates).toEqual([]);
  });

  test('every scope in the table has a title and a place in the help order', () => {
    for (const binding of allBindings()) {
      expect(SCOPE_TITLE[binding.scope]).toBeString();
      expect(SCOPE_ORDER).toContain(binding.scope);
    }
  });

  test('bindingFor and hintFor reach a feature binding, not just a global one', () => {
    expect(bindingFor('terminal.close')?.scope).toBe('terminal');
    expect(hintFor('terminal.close')).toBe('Alt+x');
    expect(hintFor('no.such.binding')).toBe('');
  });

  test('bindingsForScope spans every table', () => {
    expect(bindingsForScope('terminal').length).toBe(TERMINAL_KEYMAP.length);
    expect(bindingsForScope('modal').length).toBeGreaterThan(0);
  });

  // The whole app must be reachable from the one table the help overlay reads.
  test('memoization returns the same array', () => {
    expect(allBindings()).toBe(allBindings());
  });
});

describe('matchesChord', () => {
  test('matches the plain key', () => {
    expect(matchesChord(key('j'), { key: 'j' })).toBe(true);
  });

  test('a modifier on the event does not match a modifier-less chord', () => {
    expect(matchesChord(key('c', { ctrl: true }), { key: 'c' })).toBe(false);
    expect(matchesChord(key('t', { option: true }), { key: 't' })).toBe(false);
  });

  test('ctrl and alt must both be present to match', () => {
    expect(matchesChord(key('c', { ctrl: true }), { key: 'c', ctrl: true })).toBe(true);
    expect(matchesChord(key('t', { option: true }), { key: 't', alt: true })).toBe(true);
    expect(matchesChord(key('t'), { key: 't', alt: true })).toBe(false);
  });

  // A raw terminal ESC-prefixes Alt and reports it as `meta` with `option`
  // clear (`parseKeypress`'s metaKeyCodeRe branch); the kitty protocol sets
  // both. Matching `option` alone left every Alt chord dead in Terminal.app.
  test('Alt matches on meta as well as option', () => {
    expect(matchesChord(key('t', { meta: true }), { key: 't', alt: true })).toBe(true);
    expect(matchesChord(key('t', { option: true, meta: true }), { key: 't', alt: true })).toBe(
      true,
    );
    expect(matchesBinding(key('t', { meta: true }), 'panel.terminal')).toBe(true);
    expect(matchesBinding(key('o', { meta: true }), 'attach')).toBe(true);
    expect(matchesBinding(key('x', { meta: true }), 'terminal.close')).toBe(true);
  });

  test('a meta press does NOT match a chord that wants no Alt', () => {
    expect(matchesChord(key('t', { meta: true }), { key: 't' })).toBe(false);
    expect(matchesBinding(key('?', { meta: true }), 'help')).toBe(false);
  });

  test('Alt+Enter is the composer newline under both conventions', () => {
    expect(matchesChord(key('return', { meta: true }), { key: 'return', alt: true })).toBe(true);
    expect(matchesChord(key('return', { option: true }), { key: 'return', alt: true })).toBe(true);
  });

  test('g and G are different chords', () => {
    expect(matchesChord(key('g'), { key: 'g' })).toBe(true);
    expect(matchesChord(key('g'), { key: 'G' })).toBe(false);
    expect(matchesChord(key('g', { shift: true }), { key: 'g' })).toBe(false);
  });

  test('both terminal spellings of a capital letter match', () => {
    // raw mode: name `G`, shift clear. kitty protocol: name `g`, shift set.
    expect(matchesChord(key('G'), { key: 'G' })).toBe(true);
    expect(matchesChord(key('g', { shift: true }), { key: 'G' })).toBe(true);
  });

  test('shift is ignored for punctuation, where terminals disagree', () => {
    expect(matchesChord(key('?', { shift: true }), { key: '?' })).toBe(true);
    expect(matchesChord(key('?'), { key: '?' })).toBe(true);
    expect(matchesChord(key('/'), { key: '/' })).toBe(true);
  });

  test('a named key compares shift: Tab is not Shift+Tab', () => {
    expect(matchesChord(key('tab'), { key: 'tab' })).toBe(true);
    expect(matchesChord(key('tab'), { key: 'tab', shift: true })).toBe(false);
    expect(matchesChord(key('tab', { shift: true }), { key: 'tab' })).toBe(false);
  });
});

describe('matchesBinding', () => {
  test('Ctrl+C and Ctrl+Q both quit', () => {
    expect(matchesBinding(key('c', { ctrl: true }), 'quit')).toBe(true);
    expect(matchesBinding(key('q', { ctrl: true }), 'quit')).toBe(true);
    expect(matchesBinding(key('c'), 'quit')).toBe(false);
  });

  test('Tab and Shift+Tab are different bindings', () => {
    expect(matchesBinding(key('tab'), 'focus.next')).toBe(true);
    expect(matchesBinding(key('tab'), 'focus.prev')).toBe(false);
    expect(matchesBinding(key('tab', { shift: true }), 'focus.prev')).toBe(true);
  });

  test('an unknown id never matches', () => {
    expect(matchesBinding(key('x'), 'no.such.binding')).toBe(false);
  });
});

describe('formatting', () => {
  test('prints modifiers and friendly names', () => {
    expect(formatChord({ key: 'c', ctrl: true })).toBe('Ctrl+c');
    expect(formatChord({ key: 't', alt: true })).toBe('Alt+t');
    expect(formatChord({ key: 'return' })).toBe('Enter');
    expect(formatChord({ key: 'escape' })).toBe('Esc');
    expect(formatChord({ key: 'up' })).toBe('↑');
  });

  test('joins a multi-chord binding', () => {
    const quit = KEYMAP.find((binding) => binding.id === 'quit');
    expect(quit && formatBinding(quit)).toBe('Ctrl+c / Ctrl+q');
    expect(formatChord({ key: 'tab', shift: true })).toBe('Shift+Tab');
    expect(formatChord({ key: 'G' })).toBe('G');
  });
});
