/**
 * The keys of the `/agents`, `/workflows` and `/tasks` panels (scope
 * `agents`, widened locally like `features/loops/keys.ts` until `KeyScope` in
 * `src/keymap.ts` has the member). The panels take the keyboard while open;
 * the bottom title names the keys the selected row answers.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

export type AgentsKeyScope = KeyScope | 'agents';

export type AgentsBinding = Omit<Binding, 'scope'> & { scope: AgentsKeyScope };

const bind = (id: string, chords: Binding['chords'], description: string): AgentsBinding => ({
  id: `agents.${id}`,
  scope: 'agents',
  chords,
  description,
});

export const AGENTS_KEYS: readonly AgentsBinding[] = [
  bind('down', [{ key: 'j' }, { key: 'down' }, { key: 'n', ctrl: true }], 'Move down.'),
  bind('up', [{ key: 'k' }, { key: 'up' }, { key: 'p', ctrl: true }], 'Move up.'),
  bind(
    'peek',
    [{ key: 'return' }],
    "Peek at the agent's session over the transcript: watch, steer, stop. On a workflow run: show or hide its agents.",
  ),
  bind('open', [{ key: 'o' }], "Open the agent's session as the main one. /parent goes back."),
  bind('stop', [{ key: 'x' }], 'Stop the working agent, or the whole workflow run.'),
  bind('pause', [{ key: 'p' }], 'Pause the workflow run, or resume it. Running agents finish.'),
  bind('restart', [{ key: 'r' }], 'Restart a workflow agent that did not finish, while the run runs.'),
  bind('fold', [{ key: 'space' }, { key: 'right' }, { key: 'left' }], "Show or hide a workflow run's agents."),
  bind('approve', [{ key: 'a' }], 'Deliver the held message.'),
  bind('deny', [{ key: 'd' }], 'Deny the held message.'),
  bind('close', [{ key: 'escape' }], 'Close the panel.'),
] as const;

/** True when `event` matches any chord of the agents binding with this id. */
export function matchesAgentsBinding(event: KeyEvent, id: string): boolean {
  const binding = AGENTS_KEYS.find((entry) => entry.id === `agents.${id}`);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
