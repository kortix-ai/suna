/**
 * The `/connectors` and `/connect` key tables. Same `Binding` shape as
 * `keymap.ts`, so the help overlay (`?`) lists these rows. A binding not in
 * this table does not exist: no component here compares `key.name` inline,
 * except the masked credential capture, which reads characters.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, matchesChord } from '../../keymap.ts';

export const CONNECTORS_KEYS: readonly Binding[] = [
  { id: 'connectors.down', scope: 'connectors', chords: [{ key: 'j' }, { key: 'down' }], description: 'Move down.' },
  { id: 'connectors.up', scope: 'connectors', chords: [{ key: 'k' }, { key: 'up' }], description: 'Move up.' },
  { id: 'connectors.first', scope: 'connectors', chords: [{ key: 'g' }], description: 'Go to the first row.' },
  { id: 'connectors.last', scope: 'connectors', chords: [{ key: 'G' }], description: 'Go to the last row.' },
  { id: 'connectors.filter', scope: 'connectors', chords: [{ key: '/' }], description: 'Search your connectors and the catalogue.' },
  {
    id: 'connectors.open',
    scope: 'connectors',
    chords: [{ key: 'return' }, { key: 'right' }, { key: 'l' }],
    description: 'Open the selected connector or app; on an app, install it.',
  },
  {
    id: 'connectors.back',
    scope: 'connectors',
    chords: [{ key: 'escape' }, { key: 'left' }, { key: 'h' }],
    description: 'Back one step, or close the screen.',
  },
  { id: 'connectors.add', scope: 'connectors', chords: [{ key: 'a' }], description: 'Add an account to the connector.' },
  { id: 'connectors.signIn', scope: 'connectors', chords: [{ key: 's' }], description: 'Sign the selected account in, or reconnect it.' },
  { id: 'connectors.rename', scope: 'connectors', chords: [{ key: 'n' }], description: 'Rename the selected account.' },
  { id: 'connectors.access', scope: 'connectors', chords: [{ key: 'm' }], description: 'Change who can use the selected account.' },
  { id: 'connectors.default', scope: 'connectors', chords: [{ key: 'u' }], description: 'Use the selected account by default.' },
  { id: 'connectors.credential', scope: 'connectors', chords: [{ key: 'x' }], description: 'Set the credential of the selected account.' },
  { id: 'connectors.disconnect', scope: 'connectors', chords: [{ key: 'd' }], description: 'Disconnect the selected account (asks first).' },
  {
    id: 'connectors.remove',
    scope: 'connectors',
    chords: [{ key: 'd', shift: true }, { key: 'D' }],
    description: 'Remove the connector from the workspace (asks first).',
  },
  { id: 'connectors.copyId', scope: 'connectors', chords: [{ key: 'i' }], description: 'Copy the selected account’s connection ID.' },
  { id: 'connectors.web', scope: 'connectors', chords: [{ key: 'w' }], description: 'Open the connector in the web app.' },
  { id: 'connectors.openLink', scope: 'connectors', chords: [{ key: 'o' }], description: 'Open the sign-in link in the browser.' },
  { id: 'connectors.copy', scope: 'connectors', chords: [{ key: 'c' }], description: 'Copy the sign-in code, or the link.' },
  { id: 'connectors.confirm', scope: 'connectors', chords: [{ key: 'y' }], description: 'Confirm.' },
  { id: 'connectors.submit', scope: 'connectors', chords: [{ key: 'return' }], description: 'Submit.' },
  { id: 'connectors.cancel', scope: 'connectors', chords: [{ key: 'escape' }], description: 'Cancel.' },
  {
    id: 'connectors.mark',
    scope: 'connectors',
    chords: [{ key: 'space' }, { key: ' ' }],
    description: 'Select or clear a person, group or agent.',
  },
] as const;

export const CONNECT_KEYS: readonly Binding[] = [
  { id: 'connect.down', scope: 'connect', chords: [{ key: 'j' }, { key: 'down' }], description: 'Move down.' },
  { id: 'connect.up', scope: 'connect', chords: [{ key: 'k' }, { key: 'up' }], description: 'Move up.' },
  {
    id: 'connect.open',
    scope: 'connect',
    chords: [{ key: 'return' }, { key: 'right' }, { key: 'l' }],
    description: 'Open the selected choice.',
  },
  { id: 'connect.providers', scope: 'connect', chords: [{ key: '1' }], description: 'Open model providers.' },
  { id: 'connect.connectors', scope: 'connect', chords: [{ key: '2' }], description: 'Open connectors.' },
] as const;

function matches(table: readonly Binding[], event: KeyEvent, id: string): boolean {
  const binding = table.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}

export function matchesConnectorsBinding(event: KeyEvent, id: string): boolean {
  return matches(CONNECTORS_KEYS, event, id);
}

export function matchesConnectBinding(event: KeyEvent, id: string): boolean {
  return matches(CONNECT_KEYS, event, id);
}
