// apps/mobile/lib/theme-colors.ts
import { useColorScheme } from 'nativewind';
import { accentColor, accentSoft } from '@/lib/ui/accent';

interface ThemeColors {
  /** Monochrome primary = foreground on background (web `--primary`). */
  primary: string;
  primaryForeground: string;
  primaryLight: string;
  /** Single interactive accent (kortix-blue). */
  accent: string;
  accentSoft: string;
}

const LIGHT: Omit<ThemeColors, 'accent' | 'accentSoft'> = {
  primary: '#121215',
  primaryForeground: '#F8F8F8',
  primaryLight: 'rgba(18,18,21,0.08)',
};
const DARK: Omit<ThemeColors, 'accent' | 'accentSoft'> = {
  primary: '#F8F8F8',
  primaryForeground: '#121215',
  primaryLight: 'rgba(248,248,248,0.08)',
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
 */
export const SHEET_BG_DARK = '#151515';
export const SHEET_BG_LIGHT = '#FFFFFF';
export function getSheetBg(isDark: boolean): string { return isDark ? SHEET_BG_DARK : SHEET_BG_LIGHT; }
export function getToggleTrackBg(isDark: boolean): string { return isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)'; }
export function getToggleActiveBg(isDark: boolean): string { return isDark ? 'rgba(255,255,255,0.14)' : '#FFFFFF'; }
