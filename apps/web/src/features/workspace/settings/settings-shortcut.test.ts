import { describe, expect, test } from 'bun:test';

import {
  SETTINGS_SHORTCUT_KEY,
  matchesSettingsShortcut,
  type SettingsShortcutEvent,
} from './settings-shortcut';

function ev(overrides: Partial<SettingsShortcutEvent> = {}): SettingsShortcutEvent {
  return {
    key: ',',
    code: 'Comma',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    repeat: false,
    defaultPrevented: false,
    ...overrides,
  };
}

describe('matchesSettingsShortcut', () => {
  test('Cmd+, and Ctrl+, both open Settings', () => {
    // Both, on every platform: the macOS user presses Cmd, the Windows/Linux
    // user presses Ctrl, and neither collides with browser chrome.
    expect(matchesSettingsShortcut(ev({ metaKey: true }))).toBe(true);
    expect(matchesSettingsShortcut(ev({ ctrlKey: true }))).toBe(true);
  });

  test('a bare comma is just typing', () => {
    expect(matchesSettingsShortcut(ev())).toBe(false);
  });

  test('matches on the physical key when the layout types something else', () => {
    // A layout where `code: 'Comma'` produces `;`. The finger is on the same
    // key a Mac user presses, so the shortcut fires.
    expect(matchesSettingsShortcut(ev({ key: ';', code: 'Comma', metaKey: true }))).toBe(true);
  });

  test('matches on the character when the comma moved off the Comma key', () => {
    // AZERTY: `,` is on `code: 'KeyM'`. Matching the character keeps the
    // shortcut where that keyboard actually prints a comma.
    expect(matchesSettingsShortcut(ev({ key: ',', code: 'KeyM', metaKey: true }))).toBe(true);
  });

  test('another key with the modifier is not this shortcut', () => {
    expect(matchesSettingsShortcut(ev({ key: 'k', code: 'KeyK', metaKey: true }))).toBe(false);
  });

  test('Shift and Alt variants are left for other handlers', () => {
    expect(matchesSettingsShortcut(ev({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(matchesSettingsShortcut(ev({ metaKey: true, altKey: true }))).toBe(false);
  });

  test('a held key opens Settings once, not once per repeat', () => {
    expect(matchesSettingsShortcut(ev({ metaKey: true, repeat: true }))).toBe(false);
  });

  test('yields to a handler that already consumed the keystroke', () => {
    expect(matchesSettingsShortcut(ev({ metaKey: true, defaultPrevented: true }))).toBe(false);
  });

  test('the advertised key is the handled key', () => {
    // The Preferences list and the workspace switcher's Settings row print
    // this constant; the matcher compares against it. One source, so a keycap
    // cannot advertise a key nothing handles.
    expect(SETTINGS_SHORTCUT_KEY).toBe(',');
    expect(matchesSettingsShortcut(ev({ key: SETTINGS_SHORTCUT_KEY, code: undefined, ctrlKey: true }))).toBe(
      true,
    );
  });
});
