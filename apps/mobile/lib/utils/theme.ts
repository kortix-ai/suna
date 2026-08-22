import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';

/**
 * Theme values aligned with global.css Kortix brand palette.
 * These drive React Navigation chrome (headers, tab bars, etc.).
 */
export const THEME = {
  light: {
    background: 'hsl(0 0% 96%)',            // #F5F5F5 – Kortix light bg
    foreground: 'hsl(218 12% 7%)',           // #121215 – Kortix Black
    card: 'hsl(210 20% 98%)',                // #F9FAFB
    cardForeground: 'hsl(218 12% 7%)',       // #121215
    popover: 'hsl(0 0% 100%)',               // #FFFFFF
    popoverForeground: 'hsl(218 12% 7%)',    // #121215
    primary: 'hsl(218 12% 7%)',              // #121215
    primaryForeground: 'hsl(240 11% 97%)',   // #F8F8F8
    secondary: 'hsl(220 13% 91%)',           // #E5E7EB
    secondaryForeground: 'hsl(218 12% 7%)',  // #121215
    muted: 'hsl(0 0% 93%)',
    mutedForeground: 'hsl(220 9% 46%)',
    accent: 'hsl(220 13% 91%)',              // #E5E7EB
    accentForeground: 'hsl(218 12% 7%)',     // #121215
    destructive: 'hsl(0 84.2% 60.2%)',
    border: 'hsl(210 3% 87%)',               // #DCDDDE
    input: 'hsl(0 0% 100%)',                 // #FFFFFF
    ring: 'hsl(218 12% 7%)',                 // #121215
    radius: '0.625rem',
  },
  dark: {
    background: 'hsl(240 8% 8%)',            // #121215 – Kortix Black
    foreground: 'hsl(240 11% 97%)',          // #F8F8F8 – Kortix White
    card: 'hsl(240 4% 9%)',                  // #161618
    cardForeground: 'hsl(240 11% 97%)',      // #F8F8F8
    popover: 'hsl(220 6% 9%)',               // #161618
    popoverForeground: 'hsl(240 11% 97%)',   // #F8F8F8
    primary: 'hsl(240 11% 97%)',             // #F8F8F8
    primaryForeground: 'hsl(218 12% 7%)',    // #121215
    secondary: 'hsl(220 4% 17%)',            // #2A2A2C
    secondaryForeground: 'hsl(240 11% 97%)', // #F8F8F8
    muted: 'hsl(240 2% 14%)',               // #232324
    mutedForeground: 'hsl(0 0% 60%)',
    accent: 'hsl(220 4% 17%)',               // #2A2A2C
    accentForeground: 'hsl(240 11% 97%)',    // #F8F8F8
    destructive: 'hsl(0 70.9% 59.4%)',
    border: 'hsl(240 1% 14%)',               // #232324
    input: 'hsl(220 6% 9%)',                 // #161618
    ring: 'hsl(240 11% 97%)',                // #F8F8F8
    radius: '0.625rem',
  },
};

export const NAV_THEME: Record<'light' | 'dark', Theme> = {
  light: {
    ...DefaultTheme,
    colors: {
      background: '#FFFFFF',
      border: '#E5E5E5',
      card: '#F4F4F4',
      notification: THEME.light.destructive,
      primary: '#2E90FA',
      text: '#0A0A0A',
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      background: '#0A0A0A',
      border: '#262626',
      card: '#1A1A1A',
      notification: THEME.dark.destructive,
      primary: '#2E90FA',
      text: '#FAFAFA',
    },
  },
};
