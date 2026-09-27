/**
 * The Links panel's own bindings (scope `links`).
 *
 * A root-level overlay like the Ports panel: it owns the keyboard while open.
 * `Alt+L` (opening it) lives in `src/keymap.ts`, scope `'global'`, because it
 * must work while the terminal panel is focused — that is where a CLI prints
 * the sign-in URL the user wants (`features/terminal/keys.ts`'s
 * `TERMINAL_RESERVED_CHORDS`).
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, matchesChord } from '../../keymap.ts';

export type LinksBindingId = 'links.open' | 'links.copy' | 'links.close';

export const LINKS_KEYS: readonly Binding[] = [
  {
    id: 'links.open',
    scope: 'links',
    chords: [{ key: 'return' }, { key: 'o' }],
    description: 'Open the selected URL in the browser.',
  },
  {
    id: 'links.copy',
    scope: 'links',
    chords: [{ key: 'y' }],
    description: 'Copy the selected URL to the clipboard.',
  },
  {
    id: 'links.close',
    scope: 'links',
    chords: [{ key: 'escape' }],
    description: 'Close the Links panel.',
  },
] as const;

/** True when `event` matches any chord of the links binding with this id. */
export function matchesLinksBinding(event: KeyEvent, id: LinksBindingId): boolean {
  const binding = LINKS_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
