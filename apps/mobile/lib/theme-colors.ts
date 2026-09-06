// apps/mobile/lib/theme-colors.ts
//
// THEME-derived color shim for inline `style={{}}` props.
//
// `lib/utils/theme.ts` exports `THEME`, the single source of color truth —
// every value there is a transcription of a `global.css` token, pinned by
// `lib/utils/theme.test.ts`. Most of the app reads color through
// Tailwind/NativeWind `className`, which already resolves to THEME's CSS
// variables. This file exists ONLY because ~425 call sites across 70 files
// still read a color as a raw string inside an inline `style={{}}` prop —
// 73 `getSheetBg(isDark)` calls on gorhom BottomSheetModal
// `backgroundStyle`, and 352 `theme.primary` / `theme.accent` reads
// elsewhere — and a `className` cannot reach those props. Every value
// exported below is derived from THEME (or from `@/lib/ui/accent`, which
// is separately hex-free: `KORTIX_BLUE_HSL` matches `--kortix-blue`). This
// file is deleted once milestones M4/M5 convert those 70 consumers from
// inline style props to className styling — at that point THEME +
// Tailwind classes are the only color path left.
import { useColorScheme } from 'nativewind';
import { accentColor, accentSoft } from '@/lib/ui/accent';
import { THEME, withAlpha } from '@/lib/utils/theme';

// Re-exported for this file's existing internal/external callers. The
// canonical definition lives in `lib/utils/theme.ts` beside `THEME`, which
// survives this file's eventual deletion (see file header).
export { withAlpha };

interface ThemeColors {
  /** Monochrome primary = foreground on background (web `--primary`). */
  primary: string;
  primaryForeground: string;
  primaryLight: string;
  /** Single interactive accent (kortix-blue). */
  accent: string;
  accentSoft: string;
}

// `primary`/`primaryForeground` used to be a literal near-black-on-near-white
// (light) / near-white-on-near-black (dark) pair (sRGB 18,18,21 on 248,248,248
// and the inverse). THEME has no single named token that is exactly that pair
// in both directions, so each side below picks whichever THEME color its old
// hardcoded literal actually measures closest to (HSL lightness — both the
// old literal and THEME's grays are achromatic, so lightness alone
// determines the rendered color):
//   light primary    old L≈7.7%  -> THEME.light.primary            (L=9%,   delta 1.3pp)
//   light primaryFg  old L≈97.3% -> THEME.light.primaryForeground  (L=98%,  delta 0.7pp)
//   dark  primary    old L≈97.3% -> THEME.dark.foreground          (L=98%,  delta 0.7pp)
//     (NOT THEME.dark.primary, L=89.8%, delta 7.5pp — that would visibly
//     dim white text/icons to light gray.)
//   dark  primaryFg  old L≈7.7%  -> THEME.dark.primaryForeground   (L=9%,   delta 1.3pp)
const LIGHT: Omit<ThemeColors, 'accent' | 'accentSoft'> = {
  primary: THEME.light.primary,
  primaryForeground: THEME.light.primaryForeground,
  primaryLight: withAlpha(THEME.light.primary, 0.08),
};
const DARK: Omit<ThemeColors, 'accent' | 'accentSoft'> = {
  primary: THEME.dark.foreground,
  primaryForeground: THEME.dark.primaryForeground,
  primaryLight: withAlpha(THEME.dark.foreground, 0.08),
};

export function useThemeColors(): ThemeColors {
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  const base = isDark ? DARK : LIGHT;
  return { ...base, accent: accentColor(), accentSoft: accentSoft(isDark) };
}

/**
 * Bottom-sheet background colors. Single source of truth for every sheet/drawer
 * across the app — pass `isDark` and use the result as the BottomSheetModal
 * `backgroundStyle.backgroundColor`.
 *
 * Mapped to `--popover` (the elevated-surface token): light is an exact
 * match (both pure white, L=100%); dark's old literal (sRGB 21,21,21,
 * L≈8.2%) is within delta 0.8pp of popover's L=9% — imperceptible.
 * `--surface` (dark L=7.8%, delta 0.4pp) would be a hair closer but is not
 * exposed on THEME (`lib/utils/theme.ts` is out of scope for this change),
 * so `--popover` is the closest reachable token.
 */
export const SHEET_BG_DARK = THEME.dark.popover;
export const SHEET_BG_LIGHT = THEME.light.popover;
export function getSheetBg(isDark: boolean): string { return isDark ? SHEET_BG_DARK : SHEET_BG_LIGHT; }

// Toggle track/active backgrounds were literal white/black overlays in an
// alpha-channel color format (white-tinted for dark mode, black-tinted for
// light mode) at the app's original hover/press alpha steps. `--hover` /
// `--active` in global.css are the exact tokens for this, but neither is
// exposed on THEME (`lib/utils/theme.ts` is out of scope for this change),
// so the closest reachable equivalent is the same alpha step applied to
// THEME's achromatic foreground/background, which measure within ~2
// percentage points of true white/black:
//   dark track   old: white at 6% alpha  -> THEME.dark.foreground at 6% alpha  (L=98% vs 100%)
//   light track  old: black at 4% alpha  -> THEME.light.foreground at 4% alpha (L=3.9% vs 0%)
//   dark active  old: white at 14% alpha -> THEME.dark.foreground at 14% alpha (L=98% vs 100%)
//   light active old: solid opaque white -> THEME.light.background (L=100%, exact match, opaque)
export function getToggleTrackBg(isDark: boolean): string {
  return isDark ? withAlpha(THEME.dark.foreground, 0.06) : withAlpha(THEME.light.foreground, 0.04);
}
export function getToggleActiveBg(isDark: boolean): string {
  return isDark ? withAlpha(THEME.dark.foreground, 0.14) : THEME.light.background;
}
