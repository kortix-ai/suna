/**
 * The one keymap.
 *
 * Every binding the TUI answers to is declared once, in a `Binding` row. The
 * help overlay (`?`) renders from these rows, so a binding that is not in a
 * table is not discoverable and must not exist. Handlers match with
 * `matchesBinding`, never by comparing `key.name` inline.
 *
 * ── Two tables, one surface ──
 * `KEYMAP` below holds what THIS file owns: the app-wide chords (quit, help,
 * focus, routes) and the generic list navigation `ui/list.tsx` binds. Every
 * feature folder owns its own `keys.ts` in the same shape. `allBindings()`
 * concatenates all of them, and that is what the help overlay, the README
 * generator and `matchesBinding` read.
 *
 * The concatenation is LAZY on purpose. Each feature `keys.ts` imports
 * `matchesChord` from this file, so the import graph is a cycle; a top-level
 * `[...KEYMAP, ...SIDEBAR_KEYS]` would throw `ReferenceError` whenever a
 * feature table happened to be the module the program entered through.
 * Building it on first call — always after every module has evaluated — has no
 * such ordering dependency.
 */

import type { KeyEvent } from '@opentui/core';

import { ACCOUNT_KEYS } from './features/account/keys.ts';
import { APPS_KEYS } from './features/apps/keys.ts';
import { CUSTOMIZE_KEYS } from './features/customize/keys.ts';
import { FILES_KEYS } from './features/files/keys.ts';
import { LOGIN_KEYS } from './features/login/keys.ts';
import { REVIEW_KEYS } from './features/review/keys.ts';
import { COMPOSER_KEYMAP } from './features/session/composer/keys.ts';
import { TRANSCRIPT_KEYS } from './features/session/transcript/keys.ts';
import { SIDEBAR_KEYS } from './features/sidebar/keys.ts';
import { TERMINAL_KEYMAP } from './features/terminal/keys.ts';

/**
 * Where a binding applies.
 *
 * `global` is active on every screen. `modal` is the generic list/picker/dialog
 * navigation `ui/list.tsx` and `ui/modal.tsx` bind — it is not a route. Every
 * other member is a focus region or a route and is owned by that feature's
 * `keys.ts`.
 */
export type KeyScope =
  | 'global'
  | 'sidebar'
  | 'transcript'
  | 'composer'
  | 'terminal'
  | 'files'
  | 'review'
  | 'apps'
  | 'customize'
  | 'login'
  | 'account'
  | 'modal';

/** Help-overlay section titles, in the order the overlay prints them. */
export const SCOPE_ORDER: readonly KeyScope[] = [
  'global',
  'sidebar',
  'transcript',
  'composer',
  'terminal',
  'files',
  'review',
  'apps',
  'customize',
  'account',
  'login',
  'modal',
] as const;

export const SCOPE_TITLE: Record<KeyScope, string> = {
  global: 'Anywhere',
  sidebar: 'Sidebar',
  transcript: 'Transcript',
  composer: 'Composer',
  terminal: 'Terminal panel',
  files: 'Files',
  review: 'Review',
  apps: 'Apps',
  customize: 'Customize',
  account: 'Account',
  login: 'Login',
  modal: 'Lists, pickers and dialogs',
};

/** A single chord: a key name plus the modifiers that must be held. */
export interface Chord {
  /** `KeyEvent.name`, lowercase (`'c'`, `'tab'`, `'up'`, `'escape'`, `'pageup'`). */
  key: string;
  ctrl?: boolean;
  shift?: boolean;
  /** Alt / Option. See `matchesChord` for the two flags a terminal reports it on. */
  alt?: boolean;
}

export interface Binding {
  /** Stable id a handler switches on. Unique across every table. */
  id: string;
  scope: KeyScope;
  chords: Chord[];
  /** Imperative, one line, for the help overlay. */
  description: string;
}

function chord(key: string, modifiers: Omit<Chord, 'key'> = {}): Chord {
  return { key, ...modifiers };
}

/**
 * The bindings this file owns.
 *
 * Feature bindings live in that feature's `keys.ts`; `allBindings()` joins
 * them. Nothing here may repeat an id a feature table declares.
 */
export const KEYMAP: readonly Binding[] = [
  // — global —
  {
    id: 'quit',
    scope: 'global',
    chords: [chord('c', { ctrl: true }), chord('q', { ctrl: true })],
    description:
      'Quit. Ctrl+C asks once, then quits on the second press. Inside the terminal panel Ctrl+C ' +
      'belongs to the shell and only Ctrl+Q quits.',
  },
  {
    id: 'help',
    scope: 'global',
    chords: [chord('?')],
    description: 'Show this help. Not while a text input or the terminal has focus.',
  },
  {
    id: 'focus.next',
    scope: 'global',
    chords: [chord('tab')],
    description: 'Focus the next region: sidebar → transcript → composer → terminal.',
  },
  {
    id: 'focus.prev',
    scope: 'global',
    chords: [chord('tab', { shift: true })],
    description: 'Focus the previous region.',
  },
  {
    id: 'switcher',
    scope: 'global',
    chords: [chord('p', { ctrl: true })],
    description: 'Open the session switcher.',
  },
  {
    id: 'session.new',
    scope: 'global',
    chords: [chord('n', { ctrl: true })],
    description: 'Create a session in this project and open it.',
  },
  {
    id: 'panel.terminal',
    scope: 'global',
    chords: [chord('t', { alt: true })],
    description: 'Toggle the terminal panel.',
  },
  {
    id: 'screen.files',
    scope: 'global',
    chords: [chord('f', { alt: true })],
    description: 'Open the files screen.',
  },
  {
    id: 'screen.review',
    scope: 'global',
    chords: [chord('r', { alt: true })],
    description: 'Open the review screen.',
  },
  {
    id: 'screen.apps',
    scope: 'global',
    chords: [chord('a', { alt: true })],
    description: 'Open the apps screen.',
  },
  {
    id: 'screen.customize',
    scope: 'global',
    chords: [chord('c', { alt: true })],
    description: 'Open the customize screen.',
  },
  {
    id: 'screen.account',
    scope: 'global',
    chords: [chord('u', { alt: true })],
    description: 'Open the account screen: members, invites, billing.',
  },
  {
    id: 'attach',
    scope: 'global',
    chords: [chord('o', { alt: true })],
    description: 'Hand this session to the stock opencode TUI. Returning repaints the app.',
  },
  {
    // `Alt+H` is FIRST because `Ctrl+H` is the ASCII backspace byte (0x08).
    // A legacy terminal cannot tell the two apart, and OpenTUI's parser reports
    // the byte as `{ name: 'backspace', ctrl: false }` — measured — so the
    // Ctrl chord can never match there. It is kept for the kitty keyboard
    // protocol, which does report `{ name: 'h', ctrl: true }`.
    id: 'hosts',
    scope: 'global',
    chords: [chord('h', { alt: true }), chord('h', { ctrl: true })],
    description:
      'Switch host. Ctrl+H needs the kitty keyboard protocol: the byte it sends is Backspace.',
  },
  {
    id: 'back',
    scope: 'global',
    chords: [chord('escape')],
    description: 'Close the overlay, leave the screen, or move focus back to the composer.',
  },

  // — the generic list, picker and dialog navigation (`ui/list.tsx`) —
  {
    id: 'list.down',
    scope: 'modal',
    chords: [chord('j'), chord('down')],
    description: 'Move down.',
  },
  { id: 'list.up', scope: 'modal', chords: [chord('k'), chord('up')], description: 'Move up.' },
  { id: 'list.first', scope: 'modal', chords: [chord('g')], description: 'Go to the first row.' },
  { id: 'list.last', scope: 'modal', chords: [chord('G')], description: 'Go to the last row.' },
  {
    id: 'list.pageDown',
    scope: 'modal',
    chords: [chord('pagedown')],
    description: 'Page down.',
  },
  { id: 'list.pageUp', scope: 'modal', chords: [chord('pageup')], description: 'Page up.' },
  { id: 'list.open', scope: 'modal', chords: [chord('return')], description: 'Open the row.' },
] as const;

let merged: readonly Binding[] | null = null;
let byId: Map<string, Binding> | null = null;

/**
 * Every feature table, in help-overlay order.
 *
 * Read INSIDE the function, never at module scope: every one of these modules
 * imports `matchesChord` from this file, so whichever of them the program
 * enters through evaluates first and its export is still in the temporal dead
 * zone while this module body runs. A top-level `[...SIDEBAR_KEYS]` threw
 * `ReferenceError: Cannot access 'TERMINAL_KEYMAP' before initialization` the
 * moment a test imported `features/terminal/keys.ts` first.
 */
function featureTables(): readonly (readonly Binding[])[] {
  return [
    SIDEBAR_KEYS,
    TRANSCRIPT_KEYS,
    COMPOSER_KEYMAP,
    TERMINAL_KEYMAP,
    FILES_KEYS,
    REVIEW_KEYS,
    APPS_KEYS,
    CUSTOMIZE_KEYS,
    ACCOUNT_KEYS,
    LOGIN_KEYS,
  ];
}

/**
 * Every binding in the app: this file's table plus every feature's.
 *
 * Memoized on first call, which is always after every module has evaluated.
 */
export function allBindings(): readonly Binding[] {
  if (!merged) merged = [...KEYMAP, ...featureTables().flat()];
  return merged;
}

function bindingIndex(): Map<string, Binding> {
  if (!byId) {
    byId = new Map<string, Binding>();
    for (const binding of allBindings()) if (!byId.has(binding.id)) byId.set(binding.id, binding);
  }
  return byId;
}

/** The binding with this id, from any table, or undefined. */
export function bindingFor(id: string): Binding | undefined {
  return bindingIndex().get(id);
}

/**
 * One key plus its shift state, in the single form both sides compare in.
 *
 * A terminal reports a capital letter two ways: name `G` with `shift:false`
 * (raw mode) or name `g` with `shift:true` (kitty protocol). Both mean the
 * same chord, so an uppercase single letter always normalizes to
 * lowercase + shift. Without this, `chord('G')` also matched a plain `g` —
 * `list.last` then swallowed `list.first`.
 */
function normalizeKey(name: string, shift: boolean): { key: string; shift: boolean } {
  if (name.length === 1 && name >= 'A' && name <= 'Z')
    return { key: name.toLowerCase(), shift: true };
  return { key: name.toLowerCase(), shift };
}

/**
 * Shift is part of the identity of a named key (`Tab` vs `Shift+Tab`) and of a
 * letter or digit, but not of punctuation: `?` is shift+`/` on a US layout and
 * arrives as name `?` with `shift` set on some terminals and clear on others.
 */
function shiftIsSignificant(key: string): boolean {
  return key.length > 1 || /[a-z0-9]/i.test(key);
}

/**
 * True when the event carries Alt/Option, under EITHER terminal convention.
 *
 * A raw terminal sends Alt as an ESC prefix: `Alt+T` is the two bytes
 * `ESC t`, which OpenTUI's `parseKeypress` reports as
 * `{ name: 't', meta: true, option: false }` (`metaKeyCodeRe` branch,
 * `@opentui/core/chunk-bun-37s3zwb6.js:5447`). The kitty keyboard protocol
 * reports the same press as `{ option: true, meta: true }`
 * (`:5019`). Testing `option` alone — which this matcher did through wave 1 —
 * means no `alt` chord ever fires outside kitty, so `Alt+T`, `Alt+F`, `Alt+O`
 * and the whole terminal-panel table were dead in Terminal.app and iTerm2.
 */
export function altPressed(event: KeyEvent): boolean {
  return Boolean(event.option) || Boolean(event.meta);
}

/** True when `event` is this chord. */
export function matchesChord(event: KeyEvent, target: Chord): boolean {
  if (!event.name) return false;
  const pressed = normalizeKey(event.name, Boolean(event.shift));
  const wanted = normalizeKey(target.key, Boolean(target.shift));
  if (pressed.key !== wanted.key) return false;
  if (Boolean(target.ctrl) !== Boolean(event.ctrl)) return false;
  if (Boolean(target.alt) !== altPressed(event)) return false;
  if (shiftIsSignificant(wanted.key) && pressed.shift !== wanted.shift) return false;
  return true;
}

/** True when `event` matches any chord of the binding with this id. */
export function matchesBinding(event: KeyEvent, id: string): boolean {
  const binding = bindingFor(id);
  if (!binding) return false;
  return binding.chords.some((target) => matchesChord(event, target));
}

/** Every binding in one scope, across every table. */
export function bindingsForScope(scope: KeyScope): Binding[] {
  return allBindings().filter((binding) => binding.scope === scope);
}

/** Render one chord the way the help overlay and hints print it. */
export function formatChord(target: Chord): string {
  const parts: string[] = [];
  if (target.ctrl) parts.push('Ctrl');
  if (target.alt) parts.push('Alt');
  // An uppercase letter prints as itself (`G`); anything else shifted prints
  // its modifier (`Shift+Tab`).
  const upper = target.key.length === 1 && target.key >= 'A' && target.key <= 'Z';
  if (target.shift && !upper) parts.push('Shift');
  const NAMES: Record<string, string> = {
    return: 'Enter',
    escape: 'Esc',
    pageup: 'PgUp',
    pagedown: 'PgDn',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    tab: 'Tab',
    space: 'Space',
    linefeed: 'Ctrl+J',
  };
  parts.push(NAMES[target.key] ?? target.key);
  return parts.join('+');
}

export function formatBinding(binding: Binding): string {
  return binding.chords.map(formatChord).join(' / ');
}

/** The chord list for one binding id, as a status-bar hint prints it. */
export function hintFor(id: string): string {
  const binding = bindingFor(id);
  return binding ? formatBinding(binding) : '';
}
