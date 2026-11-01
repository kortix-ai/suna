/**
 * The Memory screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, scope `'memory'`. `KeyScope` has no
 * `'memory'` member yet, so the scope is widened locally (`MemoryBinding`) and
 * the integrator splices `MEMORY_KEYS` into the global table.
 *
 * Text typed into the search line is not a binding: it is read by `editText`.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

export type MemoryKeyScope = KeyScope | 'memory';

export type MemoryBinding = Omit<Binding, 'scope'> & { scope: MemoryKeyScope };

const bind = (id: string, chords: Binding['chords'], description: string): MemoryBinding => ({
  id: `memory.${id}`,
  scope: 'memory',
  chords,
  description,
});

export const MEMORY_KEYS: readonly MemoryBinding[] = [
  bind('down', [{ key: 'j' }, { key: 'down' }], 'Move down. In a page: scroll down.'),
  bind('up', [{ key: 'k' }, { key: 'up' }], 'Move up. In a page: scroll up.'),
  bind('first', [{ key: 'g' }], 'Go to the first page.'),
  bind('last', [{ key: 'G' }], 'Go to the last page.'),
  bind('pageDown', [{ key: 'pagedown' }, { key: 'space' }], 'Scroll a page down.'),
  bind('pageUp', [{ key: 'pageup' }], 'Scroll a page up.'),
  bind('read', [{ key: 'return' }], 'Read the selected page.'),
  bind('search', [{ key: '/' }], 'Search all pages the project lets you read.'),
  bind('type', [{ key: 't' }], 'Cycle the page-type filter.'),
  bind('open', [{ key: 'o' }], 'Open Memory in the browser.'),
  bind('refresh', [{ key: 'r' }], 'Reload the page list.'),
  bind('back', [{ key: 'escape' }], 'Close the page, clear the search, or leave the screen.'),
] as const;

/** True when `event` matches any chord of the Memory binding with this id. */
export function matchesMemoryBinding(event: KeyEvent, id: string): boolean {
  const binding = MEMORY_KEYS.find((entry) => entry.id === `memory.${id}`);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}

/** The fields of a key event `editText` reads. */
export interface TextKey {
  name?: string;
  sequence?: string;
  ctrl?: boolean;
  option?: boolean;
  meta?: boolean;
}

/**
 * Apply one key press to a single-line text value.
 *
 * Backspace deletes the last character; a printable character with no
 * modifier is appended. Returns `null` for any other key, so the caller can
 * tell "edited" from "not a text key".
 */
export function editText(value: string, key: TextKey): string | null {
  if (key.name === 'backspace') return value.slice(0, -1);
  if (key.ctrl || key.option || key.meta) return null;
  const text = key.sequence;
  if (!text || text.length !== 1) return null;
  const code = text.charCodeAt(0);
  if (code < 0x20 || code === 0x7f) return null;
  return value + text;
}
