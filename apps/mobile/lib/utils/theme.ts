import { DarkTheme, DefaultTheme, type Theme } from 'expo-router/react-navigation';

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
 * Converts a THEME `hsl(H S% L%)` string to `#rrggbb`, or `#rrggbbaa` when
 * `alpha` (0–1) is given — the native equivalent of `withAlpha`.
 *
 * For native renderers that cannot read hsl: `@expo/ui` SwiftUI modifiers
 * (`background`, `tint`, …) decode colours natively and drop both
 * `hsl(...)` and UIKit semantic names like `secondarySystemFill` without an
 * error — the view just renders unfilled (seen on PlatformButton). The token
 * stays the source; this only changes its notation.
 */
export function toHexColor(hslColor: string, alpha?: number): string {
  const parts = HSL_PARTS.exec(hslColor.trim());
  if (!parts) {
    throw new Error(`toHexColor expects a THEME 'hsl(H S% L%)' string, received: ${hslColor}`);
  }
  if (alpha !== undefined && !(alpha >= 0 && alpha <= 1)) {
    throw new Error(`toHexColor expects alpha between 0 and 1, received: ${alpha}`);
  }
  const h = Number(parts[1]) / 360;
  const s = Number(parts[2]) / 100;
  const l = Number(parts[3]) / 100;

  const hueToChannel = (p: number, q: number, tIn: number) => {
    let t = tIn;
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };

  let r = l;
  let g = l;
  let b = l;
  if (s !== 0) {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hueToChannel(p, q, h + 1 / 3);
    g = hueToChannel(p, q, h);
    b = hueToChannel(p, q, h - 1 / 3);
  }

  const channel = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `#${channel(r)}${channel(g)}${channel(b)}${alpha === undefined ? '' : channel(alpha)}`;
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
    foreground: 'hsl(0 0% 0%)', // --foreground
    card: 'hsl(0 0% 95.7%)', // --card
    cardForeground: 'hsl(0 0% 0%)', // --card-foreground
    popover: 'hsl(0 0% 100%)', // --popover
    popoverForeground: 'hsl(0 0% 0%)', // --popover-foreground
    primary: 'hsl(0 0% 0%)', // --primary
    primaryForeground: 'hsl(0 0% 100%)', // --primary-foreground
    secondary: 'hsl(0 0% 92.6%)', // --secondary
    secondaryForeground: 'hsl(0 0% 0%)', // --secondary-foreground
    muted: 'hsl(0 0% 92.6%)', // --muted
    mutedForeground: 'hsl(0 0% 40%)', // --muted-foreground
    accent: 'hsl(0 0% 95.7%)', // --accent
    accentForeground: 'hsl(0 0% 0%)', // --accent-foreground
    destructive: 'hsl(357.2 100% 45.3%)', // --destructive
    destructiveForeground: 'hsl(60 0% 98%)', // --destructive-foreground
    border: 'hsl(0 0% 88.6%)', // --border
    input: 'hsl(0 0% 92.6%)', // --input
    ring: 'hsl(204 100% 50%)', // --ring
    pane: 'hsl(0 0% 100%)', // --pane
    surface: 'hsl(0 0% 98.8%)', // --surface
    hover: 'hsla(0, 0%, 0%, 0.045)', // --hover
    active: 'hsla(0, 0%, 0%, 0.075)', // --active
    focusRing: 'hsl(204 100% 50%)', // --focus-ring (= var(--ring))
    chromeBackground: 'hsl(0 0% 95.7%)', // --chrome-background (= var(--sidebar))
    foregroundStrong: 'hsl(0 0% 0%)', // --foreground-strong (= var(--foreground))
    foregroundWeak: 'hsl(0 0% 40%)', // --foreground-weak (= var(--muted-foreground))
    sidebar: 'hsl(0 0% 95.7%)', // --sidebar
    sidebarForeground: 'hsl(0 0% 0%)', // --sidebar-foreground
    sidebarPrimary: 'hsl(204 100% 50%)', // --sidebar-primary
    sidebarPrimaryForeground: 'hsl(0 0% 100%)', // --sidebar-primary-foreground
    sidebarAccent: 'hsl(0 0% 92.6%)', // --sidebar-accent
    sidebarAccentForeground: 'hsl(0 0% 0%)', // --sidebar-accent-foreground
    sidebarBorder: 'hsl(0 0% 88.6%)', // --sidebar-border
    sidebarRing: 'hsl(204 100% 50%)', // --sidebar-ring
    success: 'hsl(160 100% 29.9%)', // --success (web emerald-600)
    warning: 'hsl(30.1 100% 44.2%)', // --warning (web amber-600)
    radius: '0.625rem', // --radius
  },
  dark: {
    background: 'hsl(0 0% 4.3%)', // --background
    foreground: 'hsl(0 0% 100%)', // --foreground
    card: 'hsl(0 0% 7.8%)', // --card
    cardForeground: 'hsl(0 0% 100%)', // --card-foreground
    popover: 'hsl(0 0% 7.8%)', // --popover
    popoverForeground: 'hsl(0 0% 100%)', // --popover-foreground
    primary: 'hsl(0 0% 100%)', // --primary
    primaryForeground: 'hsl(0 0% 3.5%)', // --primary-foreground
    secondary: 'hsl(0 0% 11%)', // --secondary
    secondaryForeground: 'hsl(0 0% 100%)', // --secondary-foreground
    muted: 'hsl(0 0% 11%)', // --muted
    mutedForeground: 'hsl(0 0% 60%)', // --muted-foreground
    accent: 'hsl(0 0% 7.8%)', // --accent
    accentForeground: 'hsl(0 0% 100%)', // --accent-foreground
    destructive: 'hsl(358.8 100% 69.6%)', // --destructive
    destructiveForeground: 'hsl(60 0% 98%)', // --destructive-foreground
    border: 'hsl(0 0% 14.9%)', // --border
    input: 'hsl(0 0% 11%)', // --input
    ring: 'hsl(204 100% 50%)', // --ring
    pane: 'hsl(0 0% 4.7%)', // --pane
    surface: 'hsl(0 0% 7.8%)', // --surface
    hover: 'hsla(0, 0%, 100%, 0.06)', // --hover
    active: 'hsla(0, 0%, 100%, 0.1)', // --active
    focusRing: 'hsl(204 100% 50%)', // --focus-ring (= var(--ring))
    chromeBackground: 'hsl(0 0% 7.8%)', // --chrome-background (= var(--sidebar))
    foregroundStrong: 'hsl(0 0% 100%)', // --foreground-strong (= var(--foreground))
    foregroundWeak: 'hsl(0 0% 60%)', // --foreground-weak (= var(--muted-foreground))
    sidebar: 'hsl(0 0% 7.8%)', // --sidebar
    sidebarForeground: 'hsl(0 0% 100%)', // --sidebar-foreground
    sidebarPrimary: 'hsl(204 100% 50%)', // --sidebar-primary
    sidebarPrimaryForeground: 'hsl(0 0% 100%)', // --sidebar-primary-foreground
    sidebarAccent: 'hsl(0 0% 11%)', // --sidebar-accent
    sidebarAccentForeground: 'hsl(0 0% 100%)', // --sidebar-accent-foreground
    sidebarBorder: 'hsl(0 0% 10.2%)', // --sidebar-border
    sidebarRing: 'hsl(204 100% 50%)', // --sidebar-ring
    success: 'hsl(161.2 100% 41.6%)', // --success (web emerald-400)
    warning: 'hsl(43.6 100% 50%)', // --warning (web amber-400)
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
    green: 'hsl(135 70.5% 33.8%)', // --kortix-green
    purple: 'hsl(270 51.3% 67.1%)', // --kortix-purple
    red: 'hsl(360 85.3% 62%)', // --kortix-red
  },
} as const;

/**
 * Motion tokens — a transcription of apps/web/src/app/globals.css
 * `--duration-*` / `--ease-*`, pinned by lib/utils/theme.test.ts.
 *
 * React Native cannot read CSS variables for animation timing, so these are
 * plain numbers. Durations are milliseconds. Easings are cubic-bezier control
 * points `[x1, y1, x2, y2]`; spread them into Reanimated:
 * `withTiming(v, { duration: MOTION.duration.normal, easing: Easing.bezier(...MOTION.easing.default) })`.
 */
export const MOTION = {
  duration: {
    fast: 100, // --duration-fast
    normal: 150, // --duration-normal
    moderate: 200, // --duration-moderate
    slow: 300, // --duration-slow
    slower: 500, // --duration-slower
  },
  easing: {
    default: [0.2, 0, 0, 1], // --ease-default
    in: [0.4, 0, 1, 1], // --ease-in
    out: [0, 0, 0.2, 1], // --ease-out
    inOut: [0.4, 0, 0.2, 1], // --ease-in-out
  },
} as const satisfies {
  duration: Record<string, number>;
  easing: Record<string, readonly [number, number, number, number]>;
};

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
