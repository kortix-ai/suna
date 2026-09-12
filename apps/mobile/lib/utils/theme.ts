import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

/**
 * Adds an alpha channel to a THEME `hsl(H S% L%)` string, producing the
 * legacy comma form `hsla(H, S%, L%, alpha)`.
 *
 * It MUST be the comma form. React Native's color parser
 * (`@react-native/normalize-colors`) accepts space-separated `hsl(H S% L%)`
 * but REJECTS the CSS Color Level 4 slash-alpha syntax
 * `hsl(H S% L% / A)` — `normalizeColor()` returns null and the style is
 * dropped, so the element renders fully transparent with no error and no
 * warning. An earlier version of this function emitted the slash form; every
 * translucent surface in the app silently rendered nothing.
 * `lib/utils/theme.test.ts` pins this against the real parser.
 *
 * The single home for this — callers that need a translucent THEME/accent
 * color import it from here instead of reimplementing it locally.
 * `lib/theme-colors.ts` re-exports it for its existing internal callers.
 */
const HSL_PARTS = /^hsl\(\s*([\d.]+)\s+([\d.]+)%\s+([\d.]+)%\s*\)$/;

export function withAlpha(hslColor: string, alpha: number): string {
  const parts = HSL_PARTS.exec(hslColor.trim());
  if (!parts) {
    throw new Error(
      `withAlpha expects a THEME 'hsl(H S% L%)' string, received: ${hslColor}`
    );
  }
  const [, h, s, l] = parts;
  return `hsla(${h}, ${s}%, ${l}%, ${alpha})`;
}

/**
 * Every value here is a transcription of the matching token in global.css.
 * global.css is the single source of color — see
 * docs/superpowers/plans/2026-09-05-mobile-rnr-migration.md.
 * Do not introduce a value that has no token. Do not write a hex literal.
 * Verified against global.css by lib/utils/theme.test.ts, which reads
 * global.css at runtime and fails if either side drifts.
 */
export const THEME = {
  light: {
    background: 'hsl(0 0% 100%)', // --background
    foreground: 'hsl(180 0% 3.9%)', // --foreground
    card: 'hsl(0 0% 95.4%)', // --card
    cardForeground: 'hsl(180 0% 3.9%)', // --card-foreground
    popover: 'hsl(0 0% 100%)', // --popover
    popoverForeground: 'hsl(180 0% 3.9%)', // --popover-foreground
    primary: 'hsl(180 0% 9%)', // --primary
    primaryForeground: 'hsl(60 0% 98%)', // --primary-foreground
    secondary: 'hsl(0 0% 96.1%)', // --secondary
    secondaryForeground: 'hsl(180 0% 9%)', // --secondary-foreground
    muted: 'hsl(0 0% 96.1%)', // --muted
    mutedForeground: 'hsl(0 0% 45.1%)', // --muted-foreground
    accent: 'hsl(0 0% 96.1%)', // --accent
    accentForeground: 'hsl(180 0% 9%)', // --accent-foreground
    destructive: 'hsl(357.2 100% 45.3%)', // --destructive
    border: 'hsl(120 0% 89.8%)', // --border
    input: 'hsl(0 0% 94.9%)', // --input
    ring: 'hsl(0 0% 63.1%)', // --ring
    pane: 'hsl(0 0% 100%)', // --pane
    surface: 'hsl(0 0% 98.8%)', // --surface
    hover: 'hsla(0, 0%, 0%, 0.045)', // --hover
    active: 'hsla(0, 0%, 0%, 0.075)', // --active
    focusRing: 'hsl(0 0% 63.1%)', // --focus-ring (= var(--ring))
    foregroundStrong: 'hsl(180 0% 3.9%)', // --foreground-strong (= var(--foreground))
    foregroundWeak: 'hsl(0 0% 45.1%)', // --foreground-weak (= var(--muted-foreground))
    radius: '0.625rem', // --radius
  },
  dark: {
    background: 'hsl(180 0% 3.9%)', // --background
    foreground: 'hsl(60 0% 98%)', // --foreground
    card: 'hsl(180 0% 9%)', // --card
    cardForeground: 'hsl(60 0% 98%)', // --card-foreground
    popover: 'hsl(180 0% 9%)', // --popover
    popoverForeground: 'hsl(60 0% 98%)', // --popover-foreground
    primary: 'hsl(120 0% 89.8%)', // --primary
    primaryForeground: 'hsl(180 0% 9%)', // --primary-foreground
    secondary: 'hsl(0 0% 14.9%)', // --secondary
    secondaryForeground: 'hsl(60 0% 98%)', // --secondary-foreground
    muted: 'hsl(0 0% 14.9%)', // --muted
    mutedForeground: 'hsl(0 0% 63.1%)', // --muted-foreground
    accent: 'hsl(0 0% 14.9%)', // --accent
    accentForeground: 'hsl(60 0% 98%)', // --accent-foreground
    destructive: 'hsl(358.8 100% 69.6%)', // --destructive
    border: 'hsl(240 4% 15.9%)', // --border
    input: 'hsl(0 0% 14.9%)', // --input
    ring: 'hsl(0 0% 45.1%)', // --ring
    pane: 'hsl(0 0% 4.7%)', // --pane
    surface: 'hsl(0 0% 7.8%)', // --surface
    hover: 'hsla(0, 0%, 100%, 0.06)', // --hover
    active: 'hsla(0, 0%, 100%, 0.1)', // --active
    focusRing: 'hsl(0 0% 45.1%)', // --focus-ring (= var(--ring))
    foregroundStrong: 'hsl(60 0% 98%)', // --foreground-strong (= var(--foreground))
    foregroundWeak: 'hsl(0 0% 63.1%)', // --foreground-weak (= var(--muted-foreground))
    radius: '0.625rem', // --radius
  },
  /**
   * Brand accents. These do NOT invert — global.css declares each one
   * byte-identical in `:root` and `.dark:root` — so they live in one flat,
   * theme-invariant group instead of being duplicated into `light`/`dark`.
   * Read as `THEME.accent.green`, never `THEME.light.accent` /
   * `THEME.dark.accent` (those keys are the unrelated semantic `--accent`
   * token above, which DOES invert).
   */
  accent: {
    blue: 'hsl(210 93% 56.9%)', // --kortix-blue
    yellow: 'hsl(48 100% 40%)', // --kortix-yellow
    orange: 'hsl(37.1 78.7% 45.9%)', // --kortix-orange
    green: 'hsl(135 100% 28.5%)', // --kortix-green
    purple: 'hsl(270 51.3% 67.1%)', // --kortix-purple
    red: 'hsl(360 85.3% 62%)', // --kortix-red
  },
} as const;

/**
 * React Navigation chrome (headers, tab bars, etc.). Derived from THEME —
 * never restate a color literal here. `...DefaultTheme` / `...DarkTheme`
 * supply the non-color `fonts` contract React Navigation's `Theme` type
 * requires; `colors` is fully overridden from THEME so no untokened value
 * (e.g. the RN-default iOS blue) survives the spread.
 */
export const NAV_THEME: Record<'light' | 'dark', Theme> = {
  light: {
    ...DefaultTheme,
    colors: {
      background: THEME.light.background,
      border: THEME.light.border,
      card: THEME.light.card,
      notification: THEME.light.destructive,
      primary: THEME.light.primary,
      text: THEME.light.foreground,
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      background: THEME.dark.background,
      border: THEME.dark.border,
      card: THEME.dark.card,
      notification: THEME.dark.destructive,
      primary: THEME.dark.primary,
      text: THEME.dark.foreground,
    },
  },
};
