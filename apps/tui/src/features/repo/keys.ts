/**
 * The Repo screen's key table.
 *
 * Same `Binding` shape as `src/keymap.ts`, so the integrator can splice this
 * array into the global KEYMAP and the help overlay (`?`) renders these rows
 * with no extra work. `KeyScope` has no `'repo'` member yet, so the scope is
 * widened locally (`RepoBinding`).
 *
 * A binding that is not in this table does not exist: the Repo screen never
 * compares `key.name` inline.
 *
 * `h` opens the history pane (the web's shortcut), so collapsing a directory
 * is the left arrow only. While the branch picker is open an `<input>` owns
 * the letter keys, so the picker moves with the arrow keys alone.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type KeyScope, matchesChord } from '../../keymap.ts';

/** `KeyScope` plus the scope this feature owns. */
export type RepoKeyScope = KeyScope | 'repo';

/** A `Binding` whose scope may be `'repo'`. */
export interface RepoBinding extends Omit<Binding, 'scope'> {
  scope: RepoKeyScope;
}

export const REPO_KEYS: readonly RepoBinding[] = [
  {
    id: 'repo.down',
    scope: 'repo',
    chords: [{ key: 'j' }, { key: 'down' }],
    description: 'Move down.',
  },
  { id: 'repo.up', scope: 'repo', chords: [{ key: 'k' }, { key: 'up' }], description: 'Move up.' },
  { id: 'repo.first', scope: 'repo', chords: [{ key: 'g' }], description: 'Go to the first row.' },
  { id: 'repo.last', scope: 'repo', chords: [{ key: 'G' }], description: 'Go to the last row.' },
  {
    id: 'repo.open',
    scope: 'repo',
    chords: [{ key: 'return' }],
    description: 'Open the file, or expand/collapse the directory.',
  },
  {
    id: 'repo.expand',
    scope: 'repo',
    chords: [{ key: 'l' }, { key: 'right' }],
    description: 'Expand the directory.',
  },
  {
    id: 'repo.collapse',
    scope: 'repo',
    chords: [{ key: 'left' }],
    description: 'Collapse the directory, or jump to its parent.',
  },
  {
    id: 'repo.history',
    scope: 'repo',
    chords: [{ key: 'h' }],
    description: 'Show or hide the commits of the repository or the selected file.',
  },
  {
    id: 'repo.branch',
    scope: 'repo',
    chords: [{ key: 'b' }],
    description: 'Pick the branch to read.',
  },
  {
    id: 'repo.filter',
    scope: 'repo',
    chords: [{ key: '/' }],
    description: 'Filter the loaded rows by name. Esc clears it.',
  },
  {
    id: 'repo.toggleHidden',
    scope: 'repo',
    chords: [{ key: '.' }],
    description: 'Show or hide dot-prefixed entries (.kortix always shows).',
  },
  {
    id: 'repo.refresh',
    scope: 'repo',
    chords: [{ key: 'r' }],
    description: 'Re-read the open directories and the history.',
  },
  {
    id: 'repo.openWeb',
    scope: 'repo',
    chords: [{ key: 'o' }],
    description: 'Open the repository in the web app.',
  },
  {
    id: 'repo.copy',
    scope: 'repo',
    chords: [{ key: 'y' }],
    description: 'Copy the selected path, or the selected commit hash in history.',
  },
  {
    id: 'repo.viewerDown',
    scope: 'repo',
    chords: [{ key: 'J' }, { key: 'pagedown' }],
    description: 'Scroll the file down.',
  },
  {
    id: 'repo.viewerUp',
    scope: 'repo',
    chords: [{ key: 'K' }, { key: 'pageup' }],
    description: 'Scroll the file up.',
  },
  {
    id: 'repo.pickDown',
    scope: 'repo',
    chords: [{ key: 'down' }],
    description: 'Move down in the branch picker.',
  },
  {
    id: 'repo.pickUp',
    scope: 'repo',
    chords: [{ key: 'up' }],
    description: 'Move up in the branch picker.',
  },
  {
    id: 'repo.back',
    scope: 'repo',
    chords: [{ key: 'escape' }],
    description: 'Close the picker, the history or the filter, then leave the screen.',
  },
] as const;

/** True when `event` matches any chord of the Repo binding with this id. */
export function matchesRepoBinding(event: KeyEvent, id: string): boolean {
  const binding = REPO_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
