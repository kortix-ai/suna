/**
 * The `/providers` screen's key table. Same `Binding` shape as `keymap.ts`, so
 * the help overlay (`?`) lists these rows. A binding not in this table does
 * not exist: no component here compares `key.name` inline, except the masked
 * key capture, which reads characters.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, matchesChord } from '../../keymap.ts';

export const PROVIDERS_KEYS: readonly Binding[] = [
  { id: 'providers.down', scope: 'providers', chords: [{ key: 'j' }, { key: 'down' }], description: 'Move down.' },
  { id: 'providers.up', scope: 'providers', chords: [{ key: 'k' }, { key: 'up' }], description: 'Move up.' },
  { id: 'providers.first', scope: 'providers', chords: [{ key: 'g' }], description: 'Go to the first row.' },
  { id: 'providers.last', scope: 'providers', chords: [{ key: 'G' }], description: 'Go to the last row.' },
  { id: 'providers.filter', scope: 'providers', chords: [{ key: '/' }], description: 'Search providers.' },
  {
    id: 'providers.open',
    scope: 'providers',
    chords: [{ key: 'return' }, { key: 'right' }, { key: 'l' }],
    description: 'Open the selected provider.',
  },
  {
    id: 'providers.back',
    scope: 'providers',
    chords: [{ key: 'escape' }, { key: 'left' }, { key: 'h' }],
    description: 'Back to the list, or close the screen.',
  },
  { id: 'providers.signIn', scope: 'providers', chords: [{ key: 's' }], description: 'Sign in with the subscription.' },
  { id: 'providers.key', scope: 'providers', chords: [{ key: 'k', shift: true }, { key: 'K' }], description: 'Add or replace the API key.' },
  { id: 'providers.add', scope: 'providers', chords: [{ key: 'a' }], description: 'Add an account or a key.' },
  { id: 'providers.reconnect', scope: 'providers', chords: [{ key: 'r' }], description: 'Reconnect the selected account.' },
  { id: 'providers.access', scope: 'providers', chords: [{ key: 'm' }], description: 'Change who can use the selected account.' },
  { id: 'providers.rotate', scope: 'providers', chords: [{ key: 'x' }], description: 'Rotate the selected key.' },
  { id: 'providers.delete', scope: 'providers', chords: [{ key: 'd' }], description: 'Remove or disconnect (asks first).' },
  { id: 'providers.toggle', scope: 'providers', chords: [{ key: 'e' }], description: 'Turn the provider on or off for this workspace.' },
  { id: 'providers.openLink', scope: 'providers', chords: [{ key: 'o' }], description: 'Open the sign-in link in the browser.' },
  { id: 'providers.copy', scope: 'providers', chords: [{ key: 'c' }], description: 'Copy the sign-in code, or the link.' },
  { id: 'providers.confirm', scope: 'providers', chords: [{ key: 'y' }], description: 'Confirm.' },
  { id: 'providers.submit', scope: 'providers', chords: [{ key: 'return' }], description: 'Submit.' },
  { id: 'providers.cancel', scope: 'providers', chords: [{ key: 'escape' }], description: 'Cancel.' },
  {
    id: 'providers.mark',
    scope: 'providers',
    chords: [{ key: 'space' }, { key: ' ' }],
    description: 'Select or clear a member.',
  },
] as const;

export function matchesProvidersBinding(event: KeyEvent, id: string): boolean {
  const binding = PROVIDERS_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
