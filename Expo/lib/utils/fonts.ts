/**
 * Roobert Font Configuration
 * 
 * This file defines all Roobert font variants used in the app.
 * Maps font weights to their corresponding Roobert font files.
 */

export const ROOBERT_FONTS = {
  'Roobert-Light': require('@/assets/font/Roobert/Roobert-Light.ttf'),
  'Roobert-Regular': require('@/assets/font/Roobert/Roobert-Regular.ttf'),
  'Roobert-Medium': require('@/assets/font/Roobert/Roobert-Medium.ttf'),
  'Roobert-SemiBold': require('@/assets/font/Roobert/Roobert-SemiBold.ttf'),
  'Roobert-Bold': require('@/assets/font/Roobert/Roobert-Bold.ttf'),
  'Roobert-Heavy': require('@/assets/font/Roobert/Roobert-Heavy.ttf'),
};

/**
 * Font family names for use in styles
 */
export const FONT_FAMILY = {
  light: 'Roobert-Light',
  regular: 'Roobert-Regular',
  medium: 'Roobert-Medium',
  semibold: 'Roobert-SemiBold',
  bold: 'Roobert-Bold',
  heavy: 'Roobert-Heavy',
} as const;

/**
 * Get font family based on font weight
 */
export function getRoobertFont(weight?: 'light' | 'regular' | 'medium' | 'semibold' | 'bold' | 'heavy'): string {
  switch (weight) {
    case 'light':
      return FONT_FAMILY.light;
    case 'medium':
      return FONT_FAMILY.medium;
    case 'semibold':
      return FONT_FAMILY.semibold;
    case 'bold':
      return FONT_FAMILY.bold;
    case 'heavy':
      return FONT_FAMILY.heavy;
    case 'regular':
    default:
      return FONT_FAMILY.regular;
  }
}

