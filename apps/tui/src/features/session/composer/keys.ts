/**
 * The composer's key table.
 *
 * Declared here rather than in `src/keymap.ts` because the composer is the one
 * region whose keys are consumed by a focused renderable: they arrive through
 * `<textarea>`'s `onKeyDown`, which runs ONLY while the textarea is focused and
 * can `preventDefault()` the built-in editing action (OpenTUI dispatch order —
 * `docs/opentui-api-reference.md` §2.4). The integrator merges this table into
 * the help overlay; the shapes (`Binding`, `Chord`) are the repo's.
 *
 * Two verified terminal facts shape the table. Both come from
 * `createTestRenderer` + `mockInput`, printed in the wave-1 report:
 *
 *  1. **Alt arrives as `meta`, not `option`, in a raw terminal.** `Alt+M` is
 *     the two bytes `ESC m`, which `parseKeypress` reports as
 *     `{ name: 'm', meta: true, option: false }`. `src/keymap.ts`'s
 *     `matchesChord` tests `event.option` only, so an `alt` chord there cannot
 *     match outside the kitty keyboard protocol. `matchesComposerBinding` below
 *     accepts EITHER flag.
 *  2. **Shift+Enter is not a distinct key without the kitty protocol.** Raw
 *     mode sends a bare `\r` for both Enter and Shift+Enter, so a legacy
 *     terminal cannot tell them apart. `Ctrl+J` (byte `\n`, reported as
 *     `name: 'linefeed'`) is the portable newline and is bound alongside it.
 */

import type { KeyEvent } from '@opentui/core';

import { type Binding, type Chord, formatBinding } from '../../../keymap.ts';

function chord(key: string, modifiers: Omit<Chord, 'key'> = {}): Chord {
  return { key, ...modifiers };
}

export const COMPOSER_KEYMAP: readonly Binding[] = [
  {
    id: 'composer.send',
    scope: 'composer',
    chords: [chord('return')],
    description: 'Send the draft. While the agent works, queue it instead.',
  },
  {
    id: 'composer.newline',
    scope: 'composer',
    chords: [
      chord('j', { ctrl: true }),
      chord('return', { alt: true }),
      chord('return', { shift: true }),
    ],
    description: 'Insert a newline. Shift+Enter needs the kitty keyboard protocol.',
  },
  {
    id: 'composer.cancel',
    scope: 'composer',
    chords: [chord('escape')],
    description: 'Clear the draft, or (empty and busy) stop the agent on a second press.',
  },
  {
    id: 'composer.commands',
    scope: 'composer',
    chords: [chord('/')],
    description: 'Open the command picker. Only at column 0.',
  },
  {
    id: 'composer.model',
    scope: 'composer',
    chords: [chord('m', { alt: true })],
    description: 'Pick the model.',
  },
  {
    id: 'composer.effort',
    scope: 'composer',
    chords: [chord('e', { alt: true })],
    description: 'Pick the thinking effort.',
  },
  {
    id: 'composer.agent',
    scope: 'composer',
    chords: [chord('g', { alt: true })],
    description: 'Pick the agent.',
  },
] as const;

/** True when the event carries Alt/Option, under either terminal convention. */
export function altPressed(event: KeyEvent): boolean {
  return Boolean(event.option) || Boolean(event.meta);
}

/**
 * A capital letter arrives two ways (`src/keymap.ts` documents it): name `G`
 * with `shift:false` in raw mode, name `g` with `shift:true` under kitty.
 */
function normalizeKey(name: string, shift: boolean): { key: string; shift: boolean } {
  if (name.length === 1 && name >= 'A' && name <= 'Z') {
    return { key: name.toLowerCase(), shift: true };
  }
  return { key: name.toLowerCase(), shift };
}

/** Shift identifies a named key or a letter/digit, never punctuation. */
function shiftIsSignificant(key: string): boolean {
  return key.length > 1 || /[a-z0-9]/i.test(key);
}

export function matchesComposerChord(event: KeyEvent, target: Chord): boolean {
  if (!event.name) return false;
  const pressed = normalizeKey(event.name, Boolean(event.shift));
  const wanted = normalizeKey(target.key, Boolean(target.shift));
  if (pressed.key !== wanted.key) return false;
  if (Boolean(target.ctrl) !== Boolean(event.ctrl)) return false;
  if (Boolean(target.alt) !== altPressed(event)) return false;
  if (shiftIsSignificant(wanted.key) && pressed.shift !== wanted.shift) return false;
  return true;
}

export function matchesComposerBinding(event: KeyEvent, id: string): boolean {
  const binding = COMPOSER_KEYMAP.find((entry) => entry.id === id);
  if (!binding) return false;
  return binding.chords.some((target) => matchesComposerChord(event, target));
}

/**
 * `Ctrl+J` reaches the app as the linefeed BYTE, so it is reported as
 * `{ name: 'linefeed', ctrl: false }` and no `ctrl` chord can match it. The
 * textarea's own default binding (`{ name: 'linefeed', action: 'newline' }`)
 * already inserts the newline for it, so the composer only has to NOT consume
 * the key — this predicate is what tells the handler to stand down.
 */
export function isLinefeedNewline(event: KeyEvent): boolean {
  return event.name === 'linefeed';
}

/** The chord list for one binding, as the footer and the help overlay print it. */
export function composerHint(id: string): string {
  const binding = COMPOSER_KEYMAP.find((entry) => entry.id === id);
  return binding ? formatBinding(binding) : '';
}
