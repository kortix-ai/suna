/**
 * Interface themes = a `next-themes` mode plus one chosen palette per mode.
 *
 * `next-themes` keeps owning `light | dark | system` and the `.dark` class, so
 * every `resolvedTheme === 'dark'` read in the app keeps working unchanged.
 * The palette is the second axis: which light theme and which dark theme.
 * `<html>` carries them as `data-light-theme` / `data-dark-theme`, and
 * `globals.css` swaps the neutral ramp on those attributes.
 *
 * Both choices are stored at once, so "System" follows the OS with whichever
 * light and dark theme the person picked last. With nothing picked, System
 * resolves to Pure light and Pure dark.
 */

import { locales } from '@/i18n/config';

import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  type DarkThemeId,
  type LightThemeId,
} from '@kortix/ui/internal/lib/interface-theme-defaults';
import terminalThemes from './kortix-themes.generated.json';

export { DEFAULT_DARK_THEME, DEFAULT_LIGHT_THEME, type DarkThemeId, type LightThemeId };

export type ThemeMode = 'light' | 'dark' | 'system';

/**
 * Terminal themes: one generated entry per curated terminalcolors.com palette
 * (`kortix-themes.generated.json`, CSS in `app/kortix-themes.generated.css`).
 * The curated list — the popular, well-made palettes only — is
 * `scripts/kortix-themes/sources.txt`. A stored id that is no longer listed
 * falls back to the default palette (`normalizeLightTheme` / `normalizeDarkTheme`).
 * `family` groups variants in the picker (e.g. Catppuccin Mocha / Latte).
 */
export interface TerminalTheme {
  id: string;
  name: string;
  family: string;
  familyName: string;
  mode: 'light' | 'dark';
  background: string;
  foreground: string;
  accent: string;
}
export const TERMINAL_THEMES: readonly TerminalTheme[] = terminalThemes as TerminalTheme[];

/** The Kortix-designed palettes, listed before the terminal themes. */
export const KORTIX_LIGHT_THEME_IDS = ['light', 'pure-light'] as const;
export const KORTIX_DARK_THEME_IDS = ['dark', 'pure-dark'] as const;

/** Light palettes, in picker order. */
export const LIGHT_THEME_IDS: readonly string[] = [
  ...KORTIX_LIGHT_THEME_IDS,
  ...TERMINAL_THEMES.filter((t) => t.mode === 'light').map((t) => t.id),
];

/** Dark palettes, in picker order. */
export const DARK_THEME_IDS: readonly string[] = [
  ...KORTIX_DARK_THEME_IDS,
  ...TERMINAL_THEMES.filter((t) => t.mode === 'dark').map((t) => t.id),
];

/** Ids stored by earlier builds that now live under a terminal-theme id. */
const LEGACY_THEME_IDS: Record<string, string> = { jellybean: 'jellybeans-default' };

/** The rows of the theme picker, in display order. */
export const INTERFACE_THEME_IDS: readonly string[] = [
  'system',
  ...LIGHT_THEME_IDS,
  ...DARK_THEME_IDS,
];
export type InterfaceThemeId = string;

export interface ThemeChoice {
  light: LightThemeId;
  dark: DarkThemeId;
}

export const DEFAULT_THEME_CHOICE: ThemeChoice = {
  light: DEFAULT_LIGHT_THEME,
  dark: DEFAULT_DARK_THEME,
};

const LIGHT_SET = new Set<unknown>(LIGHT_THEME_IDS);
const DARK_SET = new Set<unknown>(DARK_THEME_IDS);

export function isLightThemeId(value: unknown): value is LightThemeId {
  return LIGHT_SET.has(value);
}

export function isDarkThemeId(value: unknown): value is DarkThemeId {
  return DARK_SET.has(value);
}

export function isInterfaceThemeId(value: unknown): value is InterfaceThemeId {
  return value === 'system' || LIGHT_SET.has(value) || DARK_SET.has(value);
}

/** Legacy or unknown persisted values fall back to the default palette. */
export function normalizeLightTheme(value: unknown): LightThemeId {
  const id = typeof value === 'string' ? (LEGACY_THEME_IDS[value] ?? value) : value;
  return isLightThemeId(id) ? id : DEFAULT_LIGHT_THEME;
}

export function normalizeDarkTheme(value: unknown): DarkThemeId {
  const id = typeof value === 'string' ? (LEGACY_THEME_IDS[value] ?? value) : value;
  return isDarkThemeId(id) ? id : DEFAULT_DARK_THEME;
}

/** The picker row that is selected for a stored mode + palette choice. */
export function interfaceThemeFor(mode: string | undefined, choice: ThemeChoice): InterfaceThemeId {
  if (mode === 'light') return choice.light;
  if (mode === 'dark') return choice.dark;
  return 'system';
}

/**
 * What choosing a picker row writes. `System` changes only the mode, so the
 * palette chosen for each side survives the round trip.
 */
export function resolveInterfaceTheme(
  id: InterfaceThemeId,
):
  | { mode: 'system' }
  | { mode: 'light'; light: LightThemeId }
  | { mode: 'dark'; dark: DarkThemeId } {
  if (isLightThemeId(id)) return { mode: 'light', light: id };
  if (isDarkThemeId(id)) return { mode: 'dark', dark: id };
  return { mode: 'system' };
}

/** Writes both palette attributes onto `<html>` (or any element, for tests). */
export function applyInterfaceThemes(element: Element, choice: ThemeChoice): void {
  element.setAttribute('data-light-theme', choice.light);
  element.setAttribute('data-dark-theme', choice.dark);
}

/** The persisted key of `useUserPreferencesStore`, which holds both choices. */
export const USER_PREFERENCES_STORAGE_KEY = 'kortix-user-preferences';

/**
 * Themed routes. Interface themes are a product setting: only /new,
 * /projects/** and /settings render them. Every other page — auth, marketing,
 * pricing, SEO, checkout, connections, invites, system pages — leaves `<html>`
 * without the palette attributes, so no palette block in globals.css matches
 * and the generated kortix-brand palette applies. `.dark` still follows the
 * person everywhere.
 *
 * The decision is made from the URL at the root, never by a component inside
 * the route: `(app)` renders its auth / MFA gate (the Kortix mark) before any
 * route layout mounts, and that first paint must already be themed.
 * Public URLs carry no locale prefix; the optional one is accepted anyway.
 */
const THEMED_ROUTE_SOURCE = `^/(?:(?:${locales.join('|')})/)?(?:new|projects|settings)(?:/|$)`;
const THEMED_ROUTE = new RegExp(THEMED_ROUTE_SOURCE);

export function isThemedPath(pathname: string | null | undefined): boolean {
  return typeof pathname === 'string' && THEMED_ROUTE.test(pathname);
}

export function isThemedSurface(element: Element): boolean {
  return element.hasAttribute('data-light-theme');
}

/** Leaves a themed route: drops both palette attributes. */
export function clearInterfaceThemes(element: Element): void {
  element.removeAttribute('data-light-theme');
  element.removeAttribute('data-dark-theme');
}

/** Themes `<html>` on a themed route and clears it everywhere else. */
export function syncInterfaceThemes(
  element: Element,
  pathname: string | null | undefined,
  choice: ThemeChoice,
): void {
  if (isThemedPath(pathname)) applyInterfaceThemes(element, choice);
  else clearInterfaceThemes(element);
}

/** `value` as a JS literal that is safe inside an inline `<script>`: `<`, `>`, `/` and line separators are escaped. */
const scriptLiteral = (value: unknown): string =>
  JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`);

/**
 * Inlined in the root layout's `<head>` so a themed route's first paint —
 * including the auth gate's loading mark — already shows the stored palette.
 * Does nothing off the themed routes. Reads the zustand-persisted preferences
 * blob directly; any failure (no storage, bad JSON, unknown id) leaves the
 * defaults. Keep it dependency-free: it is inlined as a string.
 */
export const INTERFACE_THEME_INIT_SCRIPT = `(function(){try{var d=document.documentElement;if(!new RegExp(${scriptLiteral(
  THEMED_ROUTE_SOURCE,
)}).test(location.pathname))return;var L=${scriptLiteral(LIGHT_THEME_IDS)},D=${scriptLiteral(
  DARK_THEME_IDS,
)},s={};try{var r=localStorage.getItem('${USER_PREFERENCES_STORAGE_KEY}'),p=r?JSON.parse(r):null;s=(p&&p.state&&p.state.preferences)||{};}catch(e){}d.setAttribute('data-light-theme',L.indexOf(s.lightTheme)>=0?s.lightTheme:'${DEFAULT_LIGHT_THEME}');d.setAttribute('data-dark-theme',D.indexOf(s.darkTheme)>=0?s.darkTheme:'${DEFAULT_DARK_THEME}');}catch(e){}})();`;
