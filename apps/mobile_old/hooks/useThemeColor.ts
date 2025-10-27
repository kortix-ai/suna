import { Colors } from '@/constants/Colors';
import { useMemo } from 'react';
import { useColorScheme } from './useColorScheme';

export interface ThemeColors {
  // Base colors
  primary: string;
  background: string;
  foreground: string;
  card: string;
  sidebar: string;
  border: string;
  input: string;
  ring: string;
  muted: string;
  mutedForeground: string;
  popover: string;
  popoverForeground: string;
  secondary: string;
  secondaryForeground: string;
  accent: string;
  accentForeground: string;
  destructive: string;
  destructiveForeground: string;
  
  // Computed variations for performance
  primaryWithOpacity: (opacity: number) => string;
  backgroundWithOpacity: (opacity: number) => string;
  mutedWithOpacity: (opacity: number) => string;
  
  // Common UI color combinations
  messageBubble: string;
  aiMessage: string;
  userMessage: string;
  placeholderText: string;
  disabledText: string;
  activeButton: string;
  inactiveButton: string;
  
  // Shadow and elevation
  shadowColor: string;
  overlayColor: string;
}

// Main theme hook
export const useTheme = (): ThemeColors => {
  const colorScheme = useColorScheme();
  const colors = Colors[colorScheme ?? 'light'];

  return useMemo(() => {
    // Helper to convert hex to rgba
    const hexToRgba = (hex: string, opacity: number): string => {
      const r = parseInt(hex.slice(1, 3), 16);
      const g = parseInt(hex.slice(3, 5), 16);
      const b = parseInt(hex.slice(5, 7), 16);
      return `rgba(${r}, ${g}, ${b}, ${opacity})`;
    };

    // Helper for opacity variations
    const withOpacity = (color: string) => (opacity: number) => {
      if (color.startsWith('#')) {
        return hexToRgba(color, opacity);
      }
      // Handle rgb/rgba colors
      if (color.startsWith('rgb')) {
        return color.replace(/rgb\(/, 'rgba(').replace(/\)$/, `, ${opacity})`);
      }
      return color;
    };

    const theme: ThemeColors = {
      // Base colors from existing system
      primary: colors.primary,
      background: colors.background,
      foreground: colors.foreground,
      card: colors.card,
      sidebar: colors.sidebar,
      border: colors.border,
      input: colors.input,
      ring: colors.ring,
      muted: colors.muted,
      mutedForeground: colors.mutedForeground,
      popover: colors.popover,
      popoverForeground: colors.popoverForeground,
      secondary: colors.secondary,
      secondaryForeground: colors.secondaryForeground,
      accent: colors.accent,
      accentForeground: colors.accentForeground,
      destructive: colors.destructive,
      destructiveForeground: colors.destructiveForeground,

      // Performance optimized opacity functions
      primaryWithOpacity: withOpacity(colors.primary),
      backgroundWithOpacity: withOpacity(colors.background),
      mutedWithOpacity: withOpacity(colors.mutedForeground),

      // Pre-computed common UI combinations
      messageBubble: withOpacity(colors.primary)(0.1), // 10% opacity bubble
      aiMessage: colors.foreground,
      userMessage: colors.foreground,
      placeholderText: colors.mutedForeground,
      disabledText: withOpacity(colors.mutedForeground)(0.5),
      activeButton: withOpacity(colors.primary)(0.9),
      inactiveButton: withOpacity(colors.mutedForeground)(0.25),

      // Shadow and overlay colors
      shadowColor: colorScheme === 'dark' ? '#000000' : '#000000',
      overlayColor: withOpacity(colors.background)(0.8),
    };

    return theme;
  }, [colors, colorScheme]);
};

// Legacy function for backwards compatibility (if needed)
export function useThemeColor(
  props: { light?: string; dark?: string },
  colorName: keyof typeof Colors.light & keyof typeof Colors.dark
) {
  const theme = useColorScheme() ?? 'light';
  const colorFromProps = props[theme];

  if (colorFromProps) {
    return colorFromProps;
  } else {
    return Colors[theme][colorName];
  }
}

// Convenience hook for style objects
export const useThemedStyles = <T extends Record<string, any>>(
  styleFactory: (theme: ThemeColors) => T
): T => {
  const theme = useTheme();
  return useMemo(() => styleFactory(theme), [theme, styleFactory]);
}; 