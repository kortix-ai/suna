/**
 * The Ports panel's own bindings (scope `ports`).
 *
 * The panel is a root-level overlay (see `ports-overlay.tsx`), so it owns the
 * keyboard outright while open — same as the switcher and the help overlay.
 * `Alt+P` (opening the panel) lives in `src/keymap.ts` itself, scope
 * `'global'`, since it must also work while the terminal panel is focused
 * (`features/terminal/keys.ts`'s `TERMINAL_RESERVED_CHORDS`).
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, matchesChord } from '../../keymap.ts';

export type PortsBindingId =
  | 'ports.toggle'
  | 'ports.open'
  | 'ports.copy'
  | 'ports.add'
  | 'ports.close';

export const PORTS_KEYS: readonly Binding[] = [
  {
    id: 'ports.toggle',
    scope: 'ports',
    chords: [{ key: 'return' }],
    description: 'Forward the selected port, or stop forwarding it.',
  },
  {
    id: 'ports.open',
    scope: 'ports',
    chords: [{ key: 'o' }],
    description: 'Open `http://localhost:<port>` in the browser.',
  },
  {
    id: 'ports.copy',
    scope: 'ports',
    chords: [{ key: 'y' }],
    description: 'Copy the local forwarded URL to the clipboard.',
  },
  {
    id: 'ports.add',
    scope: 'ports',
    chords: [{ key: 'a' }],
    description: 'Add a sandbox port to forward, by number.',
  },
  {
    id: 'ports.close',
    scope: 'ports',
    chords: [{ key: 'escape' }],
    description: 'Close the Ports panel. Open forwards keep running.',
  },
] as const;

/** True when `event` matches any chord of the ports binding with this id. */
export function matchesPortsBinding(event: KeyEvent, id: PortsBindingId): boolean {
  const binding = PORTS_KEYS.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((chord) => matchesChord(event, chord));
}
