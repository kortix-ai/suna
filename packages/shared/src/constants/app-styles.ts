type ColorScheme = 'light' | 'dark';

export const APP_COLORS = {
  light: {
    background: '#FFFFFF',
    foreground: '#000000',
  },
  dark: {
    background: '#000000',
    foreground: '#FFFFFF',
  },
};

/**
 * Official background colors from platform design systems
 * iOS: Human Interface Guidelines (systemBackground)
 * Android: Material Design 3 (surface)
 */
export const getBackgroundColor = (
  platform: 'ios' | 'android' | 'web' | 'windows' | 'macos' | string, 
  colorScheme: ColorScheme | undefined
) => {
  const scheme = colorScheme || 'light';
  
  // iOS/macOS - systemBackground colors
  if (platform === 'ios' || platform === 'macos') {
    return scheme === 'dark' 
      ? '#000000'  // systemBackground dark (pure black for OLED)
      : '#FFFFFF'; // systemBackground light (pure white)
  }
  
  // Android - Material Design 3 surface colors
  if (platform === 'android') {
    return scheme === 'dark'
      ? '#121212'  // MD3 surface dark (elevated black)
      : '#FFFBFE'; // MD3 surface light (warm white)
  }
  
  // Web/Other fallback
  return scheme === 'dark' ? '#000000' : '#FFFFFF';
};

/**
 * Official drawer/sheet background colors
 * iOS: systemGroupedBackground (used for sheets, modals, settings)
 * Android: surfaceContainer (elevated surface for drawers)
 */
export const getDrawerBackgroundColor = (
  platform: 'ios' | 'android' | 'web' | 'windows' | 'macos' | string,
  colorScheme: ColorScheme | undefined
) => {
  const scheme = colorScheme || 'light';
  
  // iOS/macOS - systemGroupedBackground
  if (platform === 'ios' || platform === 'macos') {
    return scheme === 'dark'
      ? '#1C1C1E'  // systemGroupedBackground dark (elevated gray)
      : '#F2F2F7'; // systemGroupedBackground light (light gray)
  }
  
  // Android - Material Design 3 surfaceContainer
  if (platform === 'android') {
    return scheme === 'dark'
      ? '#1D1B20'  // MD3 surfaceContainer dark
      : '#F3EDF7'; // MD3 surfaceContainer light
  }
  
  // Web/Other fallback - slightly elevated
  return scheme === 'dark' ? '#1A1A1A' : '#F5F5F5';
};


export const APP_STYLES = {
  borderRadius: {
    small: 4,
    medium: 8,
    large: 16,
  },
};

/**
 * Official card/elevated surface background colors
 * iOS: secondarySystemGroupedBackground (cards on grouped backgrounds)
 * Android: surfaceContainerHigh (elevated cards)
 */
export const getCardBackgroundColor = (
  platform: 'ios' | 'android' | 'web' | 'windows' | 'macos' | string,
  colorScheme: ColorScheme | undefined
) => {
  const scheme = colorScheme || 'light';
  
  // iOS/macOS - secondarySystemGroupedBackground
  if (platform === 'ios' || platform === 'macos') {
    return scheme === 'dark'
      ? '#2C2C2E'  // secondarySystemGroupedBackground dark
      : '#FFFFFF'; // secondarySystemGroupedBackground light (white on gray)
  }
  
  // Android - Material Design 3 surfaceContainerHigh
  if (platform === 'android') {
    return scheme === 'dark'
      ? '#2B2930'  // MD3 surfaceContainerHigh dark
      : '#ECE6F0'; // MD3 surfaceContainerHigh light
  }
  
  // Web/Other fallback
  return scheme === 'dark' ? '#1F1F1F' : '#FFFFFF';
};

/**
 * Official border radius from platform design systems
 * iOS: Human Interface Guidelines (highly rounded - 10-40pt range)
 * Android: Material Design 3 (shape scale: 4, 8, 12, 16, 28dp)
 */
export const getBorderRadius = (
  platform: 'ios' | 'android' | 'web' | 'windows' | 'macos' | string,
  size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl' | 'full'
) => {
  const isApple = platform === 'ios' || platform === 'macos';
  
  const radii = {
    xs: isApple ? 4 : 4,       // Chips, tags - 4dp (same)
    sm: isApple ? 10 : 8,      // Buttons - iOS: 10pt, Android: 8dp
    md: isApple ? 14 : 12,     // Cards - iOS: 14pt (rounder), Android: 12dp
    lg: isApple ? 20 : 16,     // Large cards - iOS: 20pt, Android: 16dp
    xl: isApple ? 28 : 28,     // Modals - 28dp (same, MD3 extra-large)
    '2xl': isApple ? 34 : 28,  // Large sheets - iOS: 34pt (very round), Android: 28dp
    '3xl': isApple ? 38 : 28,  // Bottom sheets - iOS: 38pt, Android: 28dp
    '4xl': isApple ? 40 : 28,  // Presentation modals - iOS: 40pt (max), Android: 28dp
    full: 9999,                // Pill/capsule shape (same)
  };
  
  return radii[size];
};

/**
 * Official spacing from platform design systems
 * iOS: Human Interface Guidelines (8pt grid system)
 * Android: Material Design 3 (4dp base unit, 8dp grid)
 */
export const getPadding = (
  platform: 'ios' | 'android' | 'web' | 'windows' | 'macos' | string,
  size: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' | '3xl' | '4xl'
) => {
  const isApple = platform === 'ios' || platform === 'macos';
  
  const paddings = {
    xs: 4,                   // Tight spacing - 4pt/dp
    sm: 8,                   // Standard spacing - 8pt/dp
    md: isApple ? 16 : 12,   // Medium - iOS: 16pt (8pt grid), Android: 12dp
    lg: isApple ? 24 : 16,   // Large - iOS: 24pt, Android: 16dp
    xl: isApple ? 32 : 24,   // Extra large - iOS: 32pt, Android: 24dp
    '2xl': isApple ? 40 : 32,  // 2X large - iOS: 40pt, Android: 32dp
    '3xl': isApple ? 48 : 40,  // 3X large - iOS: 48pt, Android: 40dp
    '4xl': isApple ? 64 : 48,  // 4X large - iOS: 64pt, Android: 48dp
  };

  return paddings[size];
};
