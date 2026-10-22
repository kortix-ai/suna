import type { KortixTheme } from '@kortix/ui/theme';

/**
 * Lumen Workspace's brand as a @kortix/ui theme. This file is the whole re-skin:
 * layout.tsx compiles it with `themeToCss` into one <style>. Every unset
 * field keeps the Kortix default.
 *
 * Lumen Workspace is lagoon teal on warm sand: tinted neutrals for every surface and
 * one accent. Dark mode is deep teal ink, not grey. `--brand` is Lumen Workspace's own
 * variable for its highlights (`bg-brand`, see globals.css). Contrast (WCAG):
 * body text 15.8 light / 16.4 dark, muted text >= 5.3, text on the accent
 * 5.0 light / 8.6 dark.
 *
 * The shape is Lumen Workspace's too, so it never reads as a recolored Kortix: softer
 * corners (0.875rem vs 0.625rem), stock Tailwind density (0.25rem vs
 * 0.23rem), warm diffuse shadows instead of flat grey ones, a slower
 * settle-in curve, and Instrument Serif for headings (`font-display`).
 */
/** Lumen Workspace's accent per mode. The brand mark's data URIs (brand-mark.tsx) reuse it. */
export const BRAND_COLOR = { light: 'oklch(0.52 0.1 200)', dark: 'oklch(0.74 0.12 190)' } as const;

const accent = {
  // Checked switches, checkboxes, radios, tabs, the brand/blue Button and
  // Badge variants, info alerts and status.
  blue: 'var(--brand)',
  // Focus rings. focusRing, sidebarRing, sidebarPrimary and brand follow it.
  ring: 'var(--brand)',
  // Primary actions: the default Button (New project, Save changes, Send).
  // Kortix's are ink on paper.
  action: 'var(--brand)',
  actionForeground: 'var(--brand-foreground)',
  selection: 'color-mix(in oklch, var(--brand) 30%, transparent)',
  selectionForeground: 'var(--foreground)',
  sidebarPrimaryForeground: 'var(--brand-foreground)',
} as const;

export const LUMEN_THEME: KortixTheme = {
  light: {
    '--brand': BRAND_COLOR.light,
    '--brand-foreground': 'oklch(0.99 0.005 85)',
    ...accent,
    background: 'oklch(0.985 0.008 85)',
    pane: 'oklch(0.975 0.01 82)',
    surface: 'oklch(0.975 0.01 82)',
    card: 'oklch(1 0 0)',
    popover: 'oklch(1 0 0)',
    foreground: 'oklch(0.24 0.025 55)',
    cardForeground: 'oklch(0.24 0.025 55)',
    popoverForeground: 'oklch(0.24 0.025 55)',
    // Progress, Slider, Calendar selection and the menu highlight.
    primary: BRAND_COLOR.light,
    primaryForeground: 'oklch(0.99 0.005 85)',
    muted: 'oklch(0.955 0.012 80)',
    mutedForeground: 'oklch(0.5 0.02 60)',
    secondary: 'oklch(0.955 0.012 80)',
    accent: 'oklch(0.95 0.016 80)',
    border: 'oklch(0.9 0.02 78)',
    input: 'oklch(0.9 0.02 78)',
    sidebar: 'oklch(0.97 0.012 82)',
    sidebarBorder: 'oklch(0.9 0.02 78)',
  },
  dark: {
    '--brand': BRAND_COLOR.dark,
    '--brand-foreground': 'oklch(0.18 0.03 215)',
    ...accent,
    background: 'oklch(0.175 0.014 215)',
    pane: 'oklch(0.19 0.015 215)',
    surface: 'oklch(0.19 0.015 215)',
    card: 'oklch(0.21 0.016 215)',
    popover: 'oklch(0.22 0.017 215)',
    foreground: 'oklch(0.95 0.01 85)',
    cardForeground: 'oklch(0.95 0.01 85)',
    popoverForeground: 'oklch(0.95 0.01 85)',
    primary: BRAND_COLOR.dark,
    primaryForeground: 'oklch(0.18 0.03 215)',
    muted: 'oklch(0.24 0.018 215)',
    mutedForeground: 'oklch(0.7 0.015 210)',
    secondary: 'oklch(0.24 0.018 215)',
    accent: 'oklch(0.26 0.02 210)',
    border: 'oklch(0.31 0.02 210)',
    input: 'oklch(0.31 0.02 210)',
    sidebar: 'oklch(0.16 0.014 215)',
    sidebarBorder: 'oklch(0.28 0.02 210)',
  },
  radius: '0.875rem',
  spacing: '0.25rem',
  // Warm umber shadows, diffuse rather than crisp.
  shadows: {
    xs: '0 1px 2px 0 oklch(0.3 0.04 60 / 0.06)',
    sm: '0 1px 2px 0 oklch(0.3 0.04 60 / 0.06), 0 2px 8px -2px oklch(0.3 0.04 60 / 0.08)',
    md: '0 2px 4px -1px oklch(0.3 0.04 60 / 0.06), 0 8px 20px -6px oklch(0.3 0.04 60 / 0.12)',
    lg: '0 4px 8px -2px oklch(0.3 0.04 60 / 0.06), 0 16px 36px -10px oklch(0.3 0.04 60 / 0.16)',
    xl: '0 8px 16px -4px oklch(0.3 0.04 60 / 0.08), 0 28px 56px -16px oklch(0.3 0.04 60 / 0.2)',
  },
  durations: { fast: '120ms', normal: '200ms', moderate: '280ms' },
  easing: { default: 'cubic-bezier(0.32, 0.72, 0, 1)', out: 'cubic-bezier(0.22, 1, 0.36, 1)' },
  fonts: {
    // Loaded by next/font in layout.tsx; the stacks behind it are the fallback.
    sans: 'var(--font-lumen-sans), "Avenir Next", system-ui, sans-serif',
    mono: 'var(--font-lumen-mono), Menlo, ui-monospace, monospace',
  },
};
