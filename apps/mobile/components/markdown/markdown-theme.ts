import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME, withAlpha } from '@/lib/utils/theme';

/** Monospace family for code: Roobert Mono, as on web (`lib/utils/mono-font.ts`). */
export const MONO_FONT = MONO_FONT_FAMILY;

/**
 * Every colour the markdown renderer paints, derived from THEME tokens the way
 * web's classes derive from its CSS variables (`text-foreground/95` →
 * `withAlpha(foreground, 0.95)`).
 */
export function markdownPalette(isDark: boolean) {
  const t = isDark ? THEME.dark : THEME.light;
  return {
    /** `text-foreground/95` — paragraphs and list items. */
    text: withAlpha(t.foreground, 0.95),
    /** `text-foreground` — headings, strong, table cells. */
    strong: t.foreground,
    /** `text-foreground/90` — em. */
    em: withAlpha(t.foreground, 0.9),
    muted: t.mutedForeground,
    /** `decoration-muted-foreground/50` — del. */
    mutedDecoration: withAlpha(t.mutedForeground, 0.5),
    border: t.border,
    /** `text-kortix-blue`, underline `decoration-kortix-blue/40`. */
    link: THEME.accent.blue,
    linkDecoration: withAlpha(THEME.accent.blue, 0.4),
    /** `marker:text-muted-foreground/60` (ul) and `/80` (ol). */
    bulletMarker: withAlpha(t.mutedForeground, 0.6),
    orderedMarker: withAlpha(t.mutedForeground, 0.8),
    /** `thead bg-muted`. */
    tableHeader: t.muted,
    /** Code block frame: `bg-card dark:bg-muted`; body: `bg-popover`. */
    codeFrame: isDark ? t.muted : t.card,
    codeBody: t.popover,
    /**
     * Inline code chip fill: web `bg-inherit dark:bg-card`. `bg-inherit` takes
     * the parent's background, which is transparent in a message, so light
     * has no fill. The border is `border` (`border-border`).
     */
    inlineCodeBg: isDark ? t.card : 'transparent',
    /** Hex swatch: checkerboard `text-muted-foreground/30`, ring `ring-foreground/15`. */
    swatchChecker: withAlpha(t.mutedForeground, 0.3),
    swatchRing: withAlpha(t.foreground, 0.15),
    /** Image placeholder outline: `outline-black/10 dark:outline-white/10`. */
    imageOutline: withAlpha(t.foreground, 0.1),
  };
}

export type MarkdownPalette = ReturnType<typeof markdownPalette>;
