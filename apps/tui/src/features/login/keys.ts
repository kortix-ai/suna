/**
 * The login screen's key table.
 *
 * Declared in the same shape as a `Binding` from `src/keymap.ts` and scoped
 * `'login'`, which `KeyScope` now carries — so `LOGIN_KEYS` is assignable to
 * `Binding[]` and `keymap.ts` splices it into the help overlay (`?`) directly.
 * The interface stays declared here rather than imported so this file has no
 * RUNTIME import of `keymap.ts` at all (see `match.ts` for the import cycle
 * that costs).
 *
 * A binding that is not in this table does not exist: the login screen never
 * compares `key.name` inline.
 */

import type { Chord } from '../../keymap.ts';

/** The scope these bindings live in. Local until `keymap.ts` widens `KeyScope`. */
export type LoginScope = 'login';

export interface LoginBinding {
  id: string;
  scope: LoginScope;
  chords: Chord[];
  description: string;
}

export const LOGIN_KEYS: readonly LoginBinding[] = [
  {
    id: 'login.down',
    scope: 'login',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down the host list.',
  },
  {
    id: 'login.up',
    scope: 'login',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up the host list.',
  },
  {
    id: 'login.select',
    scope: 'login',
    chords: [{ key: 'return' }],
    description: 'Use the selected host. A host with no token opens the token form.',
  },
  {
    id: 'login.add',
    scope: 'login',
    chords: [{ key: 'n' }],
    description: 'Add a host: name, API URL, and a token.',
  },
  {
    id: 'login.edit',
    scope: 'login',
    chords: [{ key: 'e' }],
    description: "Replace the selected host's token.",
  },
  {
    id: 'login.delete',
    scope: 'login',
    chords: [{ key: 'd' }],
    description: 'Remove the selected host (asks first).',
  },
  {
    id: 'login.confirm',
    scope: 'login',
    chords: [{ key: 'y' }],
    description: 'Confirm the removal.',
  },
  {
    id: 'login.deny',
    scope: 'login',
    chords: [{ key: 'n' }],
    description: 'Decline the removal.',
  },
  {
    id: 'login.field.next',
    scope: 'login',
    chords: [{ key: 'tab' }],
    description: 'Next form field.',
  },
  {
    id: 'login.field.prev',
    scope: 'login',
    chords: [{ key: 'tab', shift: true }],
    description: 'Previous form field.',
  },
  {
    id: 'login.submit',
    scope: 'login',
    chords: [{ key: 'return' }],
    description: 'Submit the form.',
  },
  {
    id: 'login.cancel',
    scope: 'login',
    chords: [{ key: 'escape' }],
    description: 'Leave the form, the confirm, or the screen.',
  },
  {
    id: 'login.quit',
    scope: 'login',
    chords: [
      { key: 'c', ctrl: true },
      { key: 'q', ctrl: true },
    ],
    description: 'Quit from the login screen at once. There is no app behind it to arm.',
  },
] as const;
