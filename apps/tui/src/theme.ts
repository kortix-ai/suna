/**
 * Terminal design tokens.
 *
 * The rule from CLAUDE.md's frontend standard, translated to a terminal:
 * monochrome surfaces, one earned accent, no decorative color. Every color a
 * component draws comes from this file — a component never writes a hex
 * literal inline, exactly as a web surface never writes `bg-emerald-500`.
 *
 * Values are 24-bit hex strings. OpenTUI parses them through `RGBA.fromHex`
 * (`@opentui/core` `lib/RGBA.d.ts`), so any renderable prop that takes a color
 * (`fg`, `bg`, `borderColor`, `titleColor`, …) accepts them directly.
 */

export interface Theme {
  /** Primary text. */
  fg: string;
  /** Secondary text: timestamps, hints, inactive rows. */
  dim: string;
  /** Tertiary text: disabled, placeholder. */
  faint: string;
  /** The one accent. Selection, focus, the active row marker. */
  accent: string;
  /** Text drawn on top of `accent`. */
  onAccent: string;
  /** Panel border, unfocused. */
  border: string;
  /** Panel border, focused. */
  borderFocus: string;
  /** App background. */
  bg: string;
  /** Raised surface: modal, selected row, composer. */
  surface: string;
  /** Errors and destructive confirmations. */
  danger: string;
  /** Completed / healthy states. Used for glyphs only, never as a fill. */
  ok: string;
  /** In-progress states. Used for glyphs only, never as a fill. */
  busy: string;
}

const DARK: Theme = {
  fg: '#e6e6e6',
  dim: '#9b9b9b',
  faint: '#6b6b6b',
  accent: '#ffffff',
  onAccent: '#0b0b0b',
  border: '#3a3a3a',
  borderFocus: '#8a8a8a',
  bg: '#0b0b0b',
  surface: '#1a1a1a',
  danger: '#e06c6c',
  ok: '#8fbf8f',
  busy: '#d8c07a',
};

const LIGHT: Theme = {
  fg: '#1a1a1a',
  dim: '#5c5c5c',
  faint: '#8a8a8a',
  accent: '#0b0b0b',
  onAccent: '#ffffff',
  border: '#cfcfcf',
  borderFocus: '#6b6b6b',
  bg: '#fbfbfb',
  surface: '#eeeeee',
  danger: '#b23c3c',
  ok: '#3f7f52',
  busy: '#8a6d1f',
};

export type ThemeName = 'dark' | 'light';

/**
 * The terminal cannot be asked for its background color portably, so the theme
 * follows `COLORFGBG` (set by most terminals: `"<fg>;<bg>"`, bg 15 = light) and
 * falls back to dark. `KORTIX_TUI_THEME=light|dark` forces it.
 */
export function resolveThemeName(env: Record<string, string | undefined> = process.env): ThemeName {
  const forced = env.KORTIX_TUI_THEME?.toLowerCase();
  if (forced === 'light' || forced === 'dark') return forced;
  const colorfgbg = env.COLORFGBG;
  if (colorfgbg) {
    const background = colorfgbg.split(';').at(-1);
    if (background === '15' || background === '7') return 'light';
  }
  return 'dark';
}

export function themeFor(name: ThemeName): Theme {
  return name === 'light' ? LIGHT : DARK;
}

/** The theme for this process. Resolved once — a terminal does not restyle. */
export const theme: Theme = themeFor(resolveThemeName());

/** Status glyphs. One column wide, so a list never reflows when state changes. */
export const glyph = {
  running: '●',
  stopped: '○',
  failed: '!',
  child: '·',
  selected: '▌',
  expanded: '▾',
  collapsed: '▸',
} as const;

/** Braille spinner frames, 80 ms apart. Same set opencode and the CLI use. */
export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
export const SPINNER_INTERVAL_MS = 80;
