/**
 * The account screen's key table.
 *
 * Same shape and the same rule as `features/login/keys.ts`: scoped `'account'`
 * (a member of `KeyScope`), declared structurally so this file keeps no runtime
 * import of `keymap.ts`, and spliced into the help overlay by `keymap.ts`.
 */

import type { Chord } from '../../keymap.ts';

export type AccountScope = 'account';

export interface AccountBinding {
  id: string;
  scope: AccountScope;
  chords: Chord[];
  description: string;
}

export const ACCOUNT_KEYS: readonly AccountBinding[] = [
  {
    id: 'account.tab.next',
    scope: 'account',
    chords: [{ key: 'l' }, { key: 'right' }],
    description: 'Next tab.',
  },
  {
    id: 'account.tab.prev',
    scope: 'account',
    chords: [{ key: 'h' }, { key: 'left' }],
    description: 'Previous tab.',
  },
  {
    id: 'account.tab.members',
    scope: 'account',
    chords: [{ key: '1' }],
    description: 'Go to Members.',
  },
  {
    id: 'account.tab.invites',
    scope: 'account',
    chords: [{ key: '2' }],
    description: 'Go to Invites.',
  },
  {
    id: 'account.tab.roles',
    scope: 'account',
    chords: [{ key: '3' }],
    description: 'Go to Roles.',
  },
  {
    id: 'account.tab.billing',
    scope: 'account',
    chords: [{ key: '4' }],
    description: 'Go to Billing.',
  },
  {
    id: 'account.down',
    scope: 'account',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down the rows.',
  },
  {
    id: 'account.up',
    scope: 'account',
    chords: [{ key: 'k' }, { key: 'up' }],
    description: 'Move up the rows.',
  },
  {
    id: 'account.invite',
    scope: 'account',
    chords: [{ key: 'i' }],
    description: 'Invite a member by email (Invites tab).',
  },
  {
    id: 'account.cancelInvite',
    scope: 'account',
    chords: [{ key: 'x' }],
    description: 'Cancel the selected invite (asks first).',
  },
  {
    id: 'account.role',
    scope: 'account',
    chords: [{ key: 'r' }],
    description: 'Cycle the role on the invite form: member → admin → owner.',
  },
  {
    id: 'account.billingUrl',
    scope: 'account',
    chords: [{ key: 'u' }],
    description: 'Print the web billing URL. The TUI never runs checkout.',
  },
  {
    id: 'account.refresh',
    scope: 'account',
    chords: [{ key: 'R' }],
    description: 'Re-read every tab from the API.',
  },
  {
    id: 'account.confirm',
    scope: 'account',
    chords: [{ key: 'y' }],
    description: 'Confirm the cancellation.',
  },
  {
    id: 'account.deny',
    scope: 'account',
    chords: [{ key: 'n' }],
    description: 'Decline the cancellation.',
  },
  {
    id: 'account.back',
    scope: 'account',
    chords: [{ key: 'escape' }],
    description: 'Close the form, the confirm, or the screen.',
  },
] as const;
