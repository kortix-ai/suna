import type { KortixTheme } from '@kortix/ui/theme';

/**
 * Lumen's brand as a @kortix/ui theme. This file is the whole re-skin:
 * layout.tsx compiles it with `themeToCss` into one <style>. Every unset
 * field keeps the Kortix default.
 *
 * Lumen is ink-blue on white and paper: a law-library binding at night. The
 * page is white, media and alternate bands are paper (#F5F3EF), headlines are
 * ink (#141414) and body copy is grey. Ink-blue (#10233A) is a surface colour:
 * whole bands, the primary action, the send button. It is never decoration.
 * One warm "lamp" accent (#C89B4A) is earned: at most one element per view
 * (the glyph's light, a NEW chip). Dark mode is the brand surface itself.
 *
 * Shape: 4px on rectangles (cards, inputs, media), 999px on every pill
 * (marketing CTAs, chips, tabs), 10–12px on app windows. `--radius` 6px gives
 * rounded-md 4px, rounded-xl 10px, rounded-2xl 12px. Flat: no shadow except a
 * floating composer or popover.
 *
 * Contrast (WCAG): body ink on white 18.4, grey #6B6964 on white 5.6, white
 * on ink-blue 15.9; dark: #F2EFEA on #0B1520 16.6, muted #9BA5B1 7.3.
 */

/** Lumen's surface colour per mode. The brand mark's data URIs (brand-mark.tsx) reuse it. */
export const BRAND_COLOR = { light: '#10233A', dark: '#DCE4EE' } as const;
/** The lamp: the one warm accent. */
export const LAMP = { light: '#C89B4A', dark: '#D9B26A' } as const;

const accent = {
  // Checked switches, checkboxes, radios, tabs, the brand/blue Button and
  // Badge variants, info alerts and status.
  blue: 'var(--brand)',
  // Focus rings. focusRing, sidebarRing, sidebarPrimary and brand follow it.
  ring: 'var(--brand)',
  // Primary actions: the default Button (New matter, Save changes, Send).
  action: 'var(--brand)',
  actionForeground: 'var(--brand-foreground)',
  selection: 'color-mix(in oklab, var(--lamp) 32%, transparent)',
  selectionForeground: 'var(--foreground)',
  sidebarPrimaryForeground: 'var(--brand-foreground)',
} as const;

export const LUMEN_THEME: KortixTheme = {
  light: {
    '--brand': BRAND_COLOR.light,
    '--brand-foreground': '#FFFFFF',
    '--brand-700': '#183250',
    '--brand-900': '#0A1828',
    '--paper': '#F5F3EF',
    '--paper-deep': '#ECE9E3',
    '--lamp': LAMP.light,
    '--verified': '#2F7A5B',
    '--flag': '#B4442F',
    '--hairline': 'rgb(20 20 20 / 0.08)',
    ...accent,
    background: '#FFFFFF',
    pane: '#FBFAF8',
    surface: '#F5F3EF',
    card: '#FFFFFF',
    popover: '#FFFFFF',
    foreground: '#141414',
    foregroundStrong: '#0B0B0B',
    cardForeground: '#141414',
    popoverForeground: '#141414',
    // Progress, Slider, Calendar selection and the menu highlight.
    primary: BRAND_COLOR.light,
    primaryForeground: '#FFFFFF',
    muted: '#F3F1ED',
    mutedForeground: '#6B6964',
    secondary: '#F0EEEA',
    secondaryForeground: '#141414',
    accent: '#F0EEEA',
    accentForeground: '#141414',
    hover: 'rgb(20 20 20 / 0.04)',
    active: 'rgb(20 20 20 / 0.07)',
    border: '#E6E3DE',
    input: '#E2DFD9',
    destructive: '#B4442F',
    green: '#2F7A5B',
    red: '#B4442F',
    orange: '#B8742F',
    yellow: '#C89B4A',
    sidebar: '#F8F7F4',
    sidebarForeground: '#141414',
    sidebarAccent: '#EEECE7',
    sidebarAccentForeground: '#141414',
    sidebarBorder: '#E9E6E1',
    chart1: '#10233A',
    chart2: '#5B7491',
    chart3: '#A3B3C5',
    chart4: '#C89B4A',
    chart5: '#2F7A5B',
  },
  dark: {
    '--brand': BRAND_COLOR.dark,
    '--brand-foreground': '#0A1828',
    '--brand-700': '#183250',
    '--brand-900': '#07111D',
    '--paper': '#132131',
    '--paper-deep': '#0F1B29',
    '--lamp': LAMP.dark,
    '--verified': '#6CC09A',
    '--flag': '#E58A75',
    '--hairline': 'rgb(242 239 234 / 0.08)',
    ...accent,
    background: '#0B1520',
    pane: '#0E1925',
    surface: '#111D2B',
    card: '#111D2B',
    popover: '#14212F',
    foreground: '#F2EFEA',
    foregroundStrong: '#FFFFFF',
    cardForeground: '#F2EFEA',
    popoverForeground: '#F2EFEA',
    primary: BRAND_COLOR.dark,
    primaryForeground: '#0A1828',
    muted: '#162434',
    mutedForeground: '#9BA5B1',
    secondary: '#18273A',
    secondaryForeground: '#F2EFEA',
    accent: '#18273A',
    accentForeground: '#F2EFEA',
    hover: 'rgb(242 239 234 / 0.05)',
    active: 'rgb(242 239 234 / 0.09)',
    border: '#213044',
    input: '#26364B',
    destructive: '#E58A75',
    green: '#6CC09A',
    red: '#E58A75',
    orange: '#E0A060',
    yellow: '#D9B26A',
    sidebar: '#09121C',
    sidebarForeground: '#F2EFEA',
    sidebarAccent: '#152333',
    sidebarAccentForeground: '#F2EFEA',
    sidebarBorder: '#1B2839',
    chart1: '#DCE4EE',
    chart2: '#8FA5BF',
    chart3: '#4E6684',
    chart4: '#D9B26A',
    chart5: '#6CC09A',
  },
  radius: '0.375rem',
  spacing: '0.25rem',
  // Flat by default. A popover or the floating composer lifts with one soft shadow.
  shadows: {
    xs: '0 1px 1px 0 rgb(20 20 20 / 0.03)',
    sm: '0 1px 2px 0 rgb(20 20 20 / 0.04)',
    md: '0 8px 24px -6px rgb(20 20 20 / 0.08), 0 1px 2px 0 rgb(20 20 20 / 0.04)',
    lg: '0 20px 40px -12px rgb(20 20 20 / 0.12), 0 1px 3px 0 rgb(20 20 20 / 0.04)',
    xl: '0 32px 64px -20px rgb(20 20 20 / 0.18), 0 2px 4px 0 rgb(20 20 20 / 0.04)',
  },
  durations: { fast: '150ms', normal: '200ms', moderate: '400ms' },
  // One curve: a soft settle with no overshoot.
  easing: { default: 'cubic-bezier(0.12, 0.23, 0.5, 1)', out: 'cubic-bezier(0.12, 0.23, 0.5, 1)', inOut: 'cubic-bezier(0.45, 0, 0.55, 1)' },
  fonts: {
    // Loaded by next/font in layout.tsx; the stacks behind it are the fallback.
    sans: 'var(--font-lumen-sans), "Helvetica Neue", system-ui, sans-serif',
    mono: 'var(--font-lumen-mono), Menlo, ui-monospace, monospace',
  },
};
