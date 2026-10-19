import type { KortixTheme } from '@kortix/ui/theme';

/**
 * Lumen's brand as a @kortix/ui theme. This file is the whole re-skin:
 * layout.tsx compiles it with `themeToCss` into one <style>. Every unset
 * field keeps the Kortix default.
 *
 * Lumen replaces the one Kortix accent (blue) with indigo, tints the
 * hairlines indigo, uses a tighter radius and its own type face. Neutrals
 * (--background, --foreground, --primary) stay Kortix ink. `--brand` is
 * Lumen's own variable for its highlights (`bg-brand`, see globals.css).
 */
const indigo = { light: 'oklch(0.585 0.22 277)', dark: 'oklch(0.62 0.2 277)' };

const accent = {
  '--brand-foreground': 'oklch(0.985 0 0)',
  // Checked switches, checkboxes, radios, tabs, the brand/blue Button and
  // Badge variants, info alerts and status.
  blue: 'var(--brand)',
  // Focus rings. focusRing, sidebarRing, sidebarPrimary and brand follow it.
  ring: 'var(--brand)',
  selection: 'color-mix(in oklch, var(--brand) 35%, transparent)',
  selectionForeground: 'var(--foreground)',
  sidebarPrimaryForeground: 'var(--brand-foreground)',
} as const;

export const LUMEN_THEME: KortixTheme = {
  light: { '--brand': indigo.light, ...accent, border: 'oklch(0.9 0.03 277)' },
  dark: { '--brand': indigo.dark, ...accent, border: 'oklch(0.32 0.06 277)' },
  radius: '0.25rem',
  fonts: {
    sans: '"Avenir Next", Avenir, "Segoe UI", system-ui, sans-serif',
    mono: 'Menlo, Consolas, ui-monospace, monospace',
  },
};
