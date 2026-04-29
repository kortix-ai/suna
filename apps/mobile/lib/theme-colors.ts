/**
 * Theme accent color mapping.
 *
 * Each theme overrides the primary color used across the app.
 * Graphite uses the default foreground (black/white) as primary.
 */

import { useAppearanceStore, type AppearanceThemeId } from '@/stores/appearance-store';
import { useColorScheme } from 'nativewind';

interface ThemeColors {
  primary: string;
  primaryForeground: string;
  primaryLight: string; // primary at ~10% opacity for backgrounds
}

const LIGHT_THEMES: Record<AppearanceThemeId, ThemeColors> = {
  graphite: { primary: '#121215', primaryForeground: '#F8F8F8', primaryLight: 'rgba(18,18,21,0.08)' },
  teal:     { primary: '#22808D', primaryForeground: '#FFFFFF', primaryLight: 'rgba(34,128,141,0.1)' },
  amber:    { primary: '#D4A017', primaryForeground: '#FFFFFF', primaryLight: 'rgba(212,160,23,0.1)' },
  rose:     { primary: '#D14D72', primaryForeground: '#FFFFFF', primaryLight: 'rgba(209,77,114,0.1)' },
  violet:   { primary: '#7C5CFC', primaryForeground: '#FFFFFF', primaryLight: 'rgba(124,92,252,0.1)' },
  emerald:  { primary: '#2D9F6F', primaryForeground: '#FFFFFF', primaryLight: 'rgba(45,159,111,0.1)' },
  neon:     { primary: '#C8C800', primaryForeground: '#FFFFFF', primaryLight: 'rgba(232,224,0,0.1)' },
};

const DARK_THEMES: Record<AppearanceThemeId, ThemeColors> = {
  graphite: { primary: '#F8F8F8', primaryForeground: '#121215', primaryLight: 'rgba(248,248,248,0.08)' },
  teal:     { primary: '#3CBAC9', primaryForeground: '#FFFFFF', primaryLight: 'rgba(60,186,201,0.12)' },
  amber:    { primary: '#E8B830', primaryForeground: '#FFFFFF', primaryLight: 'rgba(232,184,48,0.12)' },
  rose:     { primary: '#E06B8E', primaryForeground: '#FFFFFF', primaryLight: 'rgba(224,107,142,0.12)' },
  violet:   { primary: '#9B82FD', primaryForeground: '#FFFFFF', primaryLight: 'rgba(155,130,253,0.12)' },
  emerald:  { primary: '#45C08A', primaryForeground: '#FFFFFF', primaryLight: 'rgba(69,192,138,0.12)' },
  neon:     { primary: '#E8E000', primaryForeground: '#121215', primaryLight: 'rgba(232,224,0,0.12)' },
};

export function useThemeColors(): ThemeColors {
  const themeId = useAppearanceStore((s) => s.themeId);
  const { colorScheme } = useColorScheme();
  const isDark = colorScheme === 'dark';
  return isDark ? DARK_THEMES[themeId] : LIGHT_THEMES[themeId];
}

export function getThemeColors(themeId: AppearanceThemeId, isDark: boolean): ThemeColors {
  return isDark ? DARK_THEMES[themeId] : LIGHT_THEMES[themeId];
}

/**
 * Bottom-sheet background colors. Single source of truth for every sheet/drawer
 * across the app — pass `isDark` and use the result as the BottomSheetModal
 * `backgroundStyle.backgroundColor`.
 */
export const SHEET_BG_DARK = '#151515';
export const SHEET_BG_LIGHT = '#FFFFFF';

export function getSheetBg(isDark: boolean): string {
  return isDark ? SHEET_BG_DARK : SHEET_BG_LIGHT;
}
