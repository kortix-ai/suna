/**
 * The Audit screen's key table. Scope `'audit'`, widened locally because
 * `KeyScope` in `src/keymap.ts` has no such member yet. The integrator splices
 * `AUDIT_KEYS` into the global table.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

export type AuditKeyScope = KeyScope | 'audit';

export type AuditBinding = Omit<Binding, 'scope'> & { scope: AuditKeyScope };

const bind = (id: string, chords: Binding['chords'], description: string): AuditBinding => ({
  id: `audit.${id}`,
  scope: 'audit',
  chords,
  description,
});

export const AUDIT_KEYS: readonly AuditBinding[] = [
  bind('down', [{ key: 'j' }, { key: 'down' }], 'Move down.'),
  bind('up', [{ key: 'k' }, { key: 'up' }], 'Move up.'),
  bind('first', [{ key: 'g' }], 'Go to the newest event.'),
  bind('last', [{ key: 'G' }], 'Go to the oldest loaded event.'),
  bind('details', [{ key: 'return' }], 'Show the detail of the selected event.'),
  bind('filter', [{ key: 'f' }], 'Cycle the filter: all, approvals, agent, person, failed.'),
  bind('approve', [{ key: 'a' }], 'Approve the selected pending action (asks first).'),
  bind('deny', [{ key: 'x' }], 'Deny the selected pending action (asks first).'),
  bind('more', [{ key: 'm' }], 'Load older events.'),
  bind('refresh', [{ key: 'r' }], 'Reload the audit trail.'),
  bind('confirm', [{ key: 'y' }], 'Confirm the decision.'),
  bind('cancel', [{ key: 'n' }], 'Decline the decision.'),
  bind('back', [{ key: 'escape' }], 'Close the detail or the confirm, or leave the screen.'),
] as const;

/** True when `event` matches any chord of the Audit binding with this id. */
export function matchesAuditBinding(event: KeyEvent, id: string): boolean {
  const binding = AUDIT_KEYS.find((entry) => entry.id === `audit.${id}`);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
