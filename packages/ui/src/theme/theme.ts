/**
 * @kortix/ui typed theme: a host's brand as data, compiled to the CSS
 * variables the components read (tokens.css / theme.css). Pure functions, no
 * React, safe on the server.
 *
 *   const css = themeToCss({ light: { primary: '#4f46e5' }, radius: '0.25rem' });
 *   <style>{css}</style>
 *
 * Every field is optional. An unset field keeps the Kortix default. `dark`
 * falls back to the Kortix dark default, never to your `light` value.
 */

/** Color tokens: theme key → CSS variable. Each one has a light and a dark value. */
export const THEME_COLOR_VARS = {
  background: '--background',
  pane: '--pane',
  surface: '--surface',
  foreground: '--foreground',
  foregroundStrong: '--foreground-strong',
  foregroundWeak: '--foreground-weak',
  card: '--card',
  cardForeground: '--card-foreground',
  popover: '--popover',
  popoverForeground: '--popover-foreground',
  primary: '--primary',
  primaryForeground: '--primary-foreground',
  secondary: '--secondary',
  secondaryForeground: '--secondary-foreground',
  muted: '--muted',
  mutedForeground: '--muted-foreground',
  accent: '--accent',
  accentForeground: '--accent-foreground',
  destructive: '--destructive',
  destructiveForeground: '--destructive-foreground',
  border: '--border',
  input: '--input',
  ring: '--ring',
  focusRing: '--focus-ring',
  hover: '--hover',
  active: '--active',
  selection: '--selection',
  selectionForeground: '--selection-foreground',
  sidebar: '--sidebar',
  sidebarForeground: '--sidebar-foreground',
  sidebarPrimary: '--sidebar-primary',
  sidebarPrimaryForeground: '--sidebar-primary-foreground',
  sidebarAccent: '--sidebar-accent',
  sidebarAccentForeground: '--sidebar-accent-foreground',
  sidebarRow: '--sidebar-row',
  sidebarRowControl: '--sidebar-row-control',
  sidebarBorder: '--sidebar-border',
  sidebarRing: '--sidebar-ring',
  brand: '--kortix-base',
  green: '--kortix-green',
  red: '--kortix-red',
  orange: '--kortix-orange',
  yellow: '--kortix-yellow',
  blue: '--kortix-blue',
  purple: '--kortix-purple',
  chart1: '--chart-1',
  chart2: '--chart-2',
  chart3: '--chart-3',
  chart4: '--chart-4',
  chart5: '--chart-5',
  terminalSurface: '--terminal-surface',
  terminalForeground: '--terminal-fg',
  terminalBorder: '--terminal-border',
} as const;

export type ThemeColor = keyof typeof THEME_COLOR_VARS;
/** Named colors, plus any `--custom` variable that differs per mode (a host's own `--brand`). */
export type ThemeColors = Partial<Record<ThemeColor, string>> & { [custom: `--${string}`]: string };

export type ThemeTextStep = 'xs' | 'sm' | 'md' | 'base' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | '5xl' | '6xl' | '7xl' | '8xl';
export type ThemeShadowStep = '2xs' | 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl';
export type ThemeDurationStep = 'fast' | 'normal' | 'moderate' | 'slow' | 'slower';
export type ThemeEasing = 'default' | 'in' | 'out' | 'inOut';

export interface KortixTheme {
  /** Colors in light mode. */
  light?: ThemeColors;
  /** Colors in dark mode (`.dark` on <html> or on the scope). */
  dark?: ThemeColors;
  /** Base radius. Every step derives from it: sm −4px, md −2px, lg =, xl +4px, 2xl +6px, bare `rounded` −6px. */
  radius?: string;
  /** Spacing unit. Every p-*, m-*, gap-*, size-* is a multiple of it (density). */
  spacing?: string;
  /** Font stacks. `sans` is the body and every heading; `mono` is code, ids and badges. */
  fonts?: { sans?: string; mono?: string };
  /** Font size per text-* step. Line height stays the Kortix ratio unless `lineHeights` sets it. */
  text?: Partial<Record<ThemeTextStep, string>>;
  lineHeights?: Partial<Record<ThemeTextStep, string>>;
  /** box-shadow per shadow-* step. `0 0 #0000` flattens a step; `none` would also drop a ring-* on the same element. */
  shadows?: Partial<Record<ThemeShadowStep, string>>;
  /** transition-duration per duration-* step. */
  durations?: Partial<Record<ThemeDurationStep, string>>;
  /** transition-timing-function per ease-* step. */
  easing?: Partial<Record<ThemeEasing, string>>;
  /** Any other @kortix/ui variable, in both modes (for example `--liquid-glass-blur`). */
  vars?: Record<`--${string}`, string>;
}

export interface ThemeCssVars {
  light: Record<string, string>;
  dark: Record<string, string>;
}

const EASING_VARS: Record<ThemeEasing, string> = {
  default: '--ease-default',
  in: '--ease-in',
  out: '--ease-out',
  inOut: '--ease-in-out',
};

/**
 * tokens.css defines these as var() references, resolved where they are
 * declared. In a scoped subtree they must be re-declared, or they keep the
 * page's value: an overridden `ring` would not reach `focusRing`. Only an alias
 * whose source the theme sets, and that the theme does not set itself, is emitted.
 */
const ALIASES: Record<'light' | 'dark', [ThemeColor, ThemeColor][]> = {
  light: [
    ['foregroundStrong', 'foreground'],
    ['foregroundWeak', 'mutedForeground'],
    ['focusRing', 'ring'],
    ['sidebarPrimary', 'ring'],
    ['sidebarRing', 'ring'],
    ['brand', 'ring'],
    ['sidebarRow', 'card'],
    ['sidebarRowControl', 'sidebarAccent'],
  ],
  dark: [
    ['foregroundStrong', 'foreground'],
    ['foregroundWeak', 'mutedForeground'],
    ['focusRing', 'ring'],
    ['sidebarPrimary', 'ring'],
    ['sidebarRing', 'ring'],
    ['brand', 'ring'],
    ['sidebarRow', 'sidebarAccent'],
  ],
};

function sharedVars(theme: KortixTheme): Record<string, string> {
  const out: Record<string, string> = {};
  const put = (name: string, value: string | undefined) => {
    if (value !== undefined) out[name] = value;
  };
  put('--radius', theme.radius);
  put('--spacing', theme.spacing);
  put('--font-family-sans', theme.fonts?.sans);
  put('--font-family-mono', theme.fonts?.mono);
  for (const [k, v] of Object.entries(theme.text ?? {})) put(`--text-${k}`, v);
  for (const [k, v] of Object.entries(theme.lineHeights ?? {})) put(`--text-${k}--line-height`, v);
  for (const [k, v] of Object.entries(theme.shadows ?? {})) put(`--shadow-${k}`, v);
  for (const [k, v] of Object.entries(theme.durations ?? {})) put(`--duration-${k}`, v);
  for (const [k, v] of Object.entries(theme.easing ?? {})) put(EASING_VARS[k as ThemeEasing], v);
  for (const [k, v] of Object.entries(theme.vars ?? {})) put(k, v);
  return out;
}

function colorVars(colors: ThemeColors | undefined, mode: 'light' | 'dark'): Record<string, string> {
  const out: Record<string, string> = {};
  const set = colors ?? {};
  for (const [key, value] of Object.entries(set)) {
    const name = key.startsWith('--') ? key : THEME_COLOR_VARS[key as ThemeColor];
    if (!name) throw new Error(`@kortix/ui theme: unknown color "${key}"`);
    if (value !== undefined) out[name] = value;
  }
  for (const [alias, source] of ALIASES[mode]) {
    if (set[source] !== undefined && set[alias] === undefined) {
      out[THEME_COLOR_VARS[alias]] = `var(${THEME_COLOR_VARS[source]})`;
    }
  }
  return out;
}

/** The theme as CSS variables per mode. Mode-independent values appear in both. */
export function themeToCssVars(theme: KortixTheme): ThemeCssVars {
  const shared = sharedVars(theme);
  return {
    light: { ...shared, ...colorVars(theme.light, 'light') },
    dark: { ...shared, ...colorVars(theme.dark, 'dark') },
  };
}

const block = (selector: string, vars: Record<string, string>) => {
  const body = Object.entries(vars)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n');
  return body ? `${selector} {\n${body}\n}` : '';
};

/**
 * The theme as a stylesheet. `selector` (default `:root`) is the element that
 * carries the variables. Light applies outside `.dark`, dark inside it or on
 * it. Both blocks out-rank tokens.css, so source order does not matter.
 */
export function themeToCss(theme: KortixTheme, selector = ':root'): string {
  const { light, dark } = themeToCssVars(theme);
  return [
    block(`${selector}:not(.dark, .dark *)`, light),
    block(`${selector}.dark, .dark ${selector}`, dark),
  ]
    .filter(Boolean)
    .join('\n');
}
