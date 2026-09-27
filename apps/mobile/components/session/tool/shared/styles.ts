import { useMemo } from 'react';
import { useColorScheme } from 'nativewind';
import { webSpace } from '@/lib/session/user-message';
import { MONO_FONT_FAMILY } from '@/lib/utils/mono-font';
import { THEME, withAlpha } from '@/lib/utils/theme';

// ─── Shared styles ───────────────────────────────────────────────────────────

export const monoFont = MONO_FONT_FAMILY;

export function cardBorder(isDark: boolean) {
  return withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, 0.06);
}
export function cardBg(isDark: boolean) {
  // Light branch keeps a near-white card fill (not the transparent
  // light.foreground-alpha shape used elsewhere) — matches the original
  // white-at-80%-alpha value exactly.
  return isDark ? withAlpha(THEME.dark.foreground, 0.03) : withAlpha(THEME.light.primaryForeground, 0.8);
}
export function mutedBg(isDark: boolean) {
  return withAlpha(isDark ? THEME.dark.foreground : THEME.light.foreground, isDark ? 0.04 : 0.025);
}
export function fg(isDark: boolean) {
  return isDark ? THEME.dark.foreground : THEME.light.foreground;
}
// Deliberately swaps which theme gets which mutedForeground shade vs.
// mutedStrong() below: dark mode uses the *lighter*-appearing token here
// (mapped by value, not by theme name — see Trap 2) for the more
// de-emphasized/low-contrast muted color, matching the original hex pair.
export function muted(isDark: boolean) {
  return isDark ? THEME.light.mutedForeground : THEME.dark.mutedForeground;
}
export function mutedStrong(isDark: boolean) {
  return isDark ? THEME.dark.mutedForeground : THEME.light.mutedForeground;
}

// ─── Turn activity rows (web parity) ─────────────────────────────────────────
//
// The rows of an assistant turn (thinking, bursts, groups, file chips, tool
// rows) mirror apps/web's RENDERED pixels, so every length below is a web
// Tailwind class converted through `webSpace` (web `--spacing: 0.23rem`).
// One table, so a row and the card under it cannot disagree.

/** apps/web `text-sm` (0.875rem) and `text-xs` (0.8125rem), with the leading each row uses. */
export const TURN_TYPE = {
  /** `text-sm leading-[1.5]` — chain rows. */
  rowSm: { fontSize: 14, lineHeight: 21 },
  /** `text-sm` — tool-row title/subtitle outside a chain (web `--text-sm--line-height` 1.25rem). */
  sm: { fontSize: 14, lineHeight: 20 },
  /** `text-xs` — web 0.8125rem / 1rem. */
  xs: { fontSize: 13, lineHeight: 16 },
  /** `text-xs leading-relaxed` (1.625). */
  xsRelaxed: { fontSize: 13, lineHeight: 21.125 },
  /** `text-xs leading-[1.65]` — `ToolCode` / `ToolCodeCard` source panes. */
  xsCode: { fontSize: 13, lineHeight: 21.45 },
  /** `text-[0.8rem] leading-[1.55]` — `DiffView` (`kortix-diff-view`). */
  diff: { fontSize: 12.8, lineHeight: 19.84 },
  /** `text-[10px] font-medium tracking-wider uppercase` — `ToolSection` label (0.05em). */
  label10: { fontSize: 10, lineHeight: 15, letterSpacing: 0.5 },
  /** Activity sheet timeline entry: app body size on the reference's 24pt line pitch. */
  sheetEntry: { fontSize: 16, lineHeight: 24 },
} as const;

export const FONT_MEDIUM = 'Roobert-Medium';
export const FONT_SEMIBOLD = 'Roobert-SemiBold';

export const TURN_SPACE = {
  /** `size-4` — every leading row icon. */
  icon: webSpace(4),
  /** `size-3.5` — carets. */
  caret: webSpace(3.5),
  /** `size-3` — `StatusIcon`. */
  statusIcon: webSpace(3),
  /** `gap-3` — icon → label in chain rows; also `mt-3` / `space-y-3`. */
  gap3: webSpace(3),
  /** `gap-2` — burst summary title → caret; chip wrap gap. */
  gap2: webSpace(2),
  /** `gap-1.5` — tool row default gap; `mt-1.5` card seam. */
  gap1_5: webSpace(1.5),
  /** `py-0.5` — tool row vertical padding. */
  rowPadY: webSpace(0.5),
  /** `py-1` — tool row body padding. */
  bodyPadY: webSpace(1),
  /** `pl-7` — members / thought body / chips under a row label. */
  nestIndent: webSpace(7),
  /** `left-2` — chain rail x (centre of the size-4 icon). */
  railLeft: webSpace(2),
  /** `top-[1.6rem]` — chain rail clears the row icon. */
  railTop: 1.6 * 16,
  /** `max-h-54` — thought body cap. */
  thoughtMaxHeight: webSpace(54),
  /** `h-10` fade (`FadedScrollArea` `fadeSize="10"`). */
  fadeSize: webSpace(10),
  /** `max-h-96` — tool output body cap. */
  outputMaxHeight: webSpace(96),
  /** `p-3` — tool card inset. */
  cardPad: webSpace(3),
  /** `pr-11` — copy-button reserve. */
  copyReserve: webSpace(11),
  /** `top-1 right-1` — floating copy button. */
  copyInset: webSpace(1),
  /** `--tool-indent` default 1.375rem; 1.75rem inside a chain (`activity-step.tsx`). */
  toolIndent: 1.375 * 16,
  toolIndentChain: 1.75 * 16,
  /** File chip: `p-1.5 py-1 pr-3`, `size-9` well, `size-5` glyph. */
  chipPadLeft: webSpace(1.5),
  chipPadY: webSpace(1),
  chipPadRight: webSpace(3),
  chipWell: webSpace(9),
  chipGlyph: webSpace(5),
  /** `px-2 py-1.5` — error card rows; `p-1` — result card frame. */
  errorPadX: webSpace(2),
  errorPadY: webSpace(1.5),
  resultFramePad: webSpace(1),
  /** `rounded-md` / `rounded-sm` — web `--radius` 0.625rem − 2px / − 4px. */
  radiusMd: 8,
  radiusSm: 6,
} as const;

export type TurnPalette = ReturnType<typeof turnPalette>;

/** Every colour a turn row uses, derived from THEME tokens (web opacity modifiers → `withAlpha`). */
export function turnPalette(isDark: boolean) {
  const t = isDark ? THEME.dark : THEME.light;
  return {
    foreground: t.foreground,
    /** `text-foreground/80` — row labels. */
    foreground80: withAlpha(t.foreground, 0.8),
    /** `text-foreground/60` — thought body. */
    foreground60: withAlpha(t.foreground, 0.6),
    mutedForeground: t.mutedForeground,
    muted80: withAlpha(t.mutedForeground, 0.8),
    muted70: withAlpha(t.mutedForeground, 0.7),
    muted60: withAlpha(t.mutedForeground, 0.6),
    muted50: withAlpha(t.mutedForeground, 0.5),
    muted40: withAlpha(t.mutedForeground, 0.4),
    /** `bg-muted-foreground/15` — chain rail. */
    rail: withAlpha(t.mutedForeground, 0.15),
    background: t.background,
    backgroundClear: withAlpha(t.background, 0),
    popover: t.popover,
    muted: t.muted,
    /** `bg-muted/50`. */
    mutedHalf: withAlpha(t.muted, 0.5),
    border: t.border,
    success: t.success,
    warning: t.warning,
    destructive: t.destructive,
    destructive40: withAlpha(t.destructive, 0.4),
    destructive10: withAlpha(t.destructive, 0.1),
    /** `text-foreground/90`, `/70`. */
    foreground90: withAlpha(t.foreground, 0.9),
    foreground70: withAlpha(t.foreground, 0.7),
    muted30: withAlpha(t.mutedForeground, 0.3),
    muted0: withAlpha(t.mutedForeground, 0),
    card: t.card,
    /** `bg-muted/40`, `/30`, `/20`, `/10`, `/60`. */
    muted40Bg: withAlpha(t.muted, 0.4),
    muted30Bg: withAlpha(t.muted, 0.3),
    muted20Bg: withAlpha(t.muted, 0.2),
    muted10Bg: withAlpha(t.muted, 0.1),
    muted60Bg: withAlpha(t.muted, 0.6),
    /** `border-border/60`, `/50`, `/40`, `/30`, `/20`, `/10`. */
    border60: withAlpha(t.border, 0.6),
    border50: withAlpha(t.border, 0.5),
    border40: withAlpha(t.border, 0.4),
    border30: withAlpha(t.border, 0.3),
    border20: withAlpha(t.border, 0.2),
    border10: withAlpha(t.border, 0.1),
    /** `bg-muted-foreground/[0.04]` — pressed row. */
    pressed: withAlpha(t.mutedForeground, 0.04),
    // Web `components/ui/status.tsx` tones. `STATUS_TEXT.info` is
    // `text-blue-600 dark:text-blue-400`, which has no mobile token; the brand
    // `--kortix-blue` is the closest token and stands in for it.
    info: THEME.accent.blue,
    /** `STATUS_BG.*` — `bg-kortix-{green,yellow,blue}/10`, `bg-destructive/10`. */
    successBg: withAlpha(THEME.accent.green, 0.1),
    warningBg: withAlpha(THEME.accent.yellow, 0.1),
    infoBg: withAlpha(THEME.accent.blue, 0.1),
    /** `STATUS_BORDER.*` — `border-kortix-{green,yellow,blue}`, `border-destructive/30`. */
    successBorder: THEME.accent.green,
    warningBorder: THEME.accent.yellow,
    infoBorder: THEME.accent.blue,
    destructive30: withAlpha(t.destructive, 0.3),
    /** `text-kortix-green` / `text-kortix-orange` — todo glyphs. */
    kortixGreen: THEME.accent.green,
    kortixOrange: THEME.accent.orange,
    /** Diff rows: addition / deletion washes behind changed lines. */
    diffAddBg: withAlpha(t.success, 0.1),
    diffDelBg: withAlpha(t.destructive, 0.1),
  };
}

export function useTurnPalette(): TurnPalette {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  return useMemo(() => turnPalette(isDark), [isDark]);
}
