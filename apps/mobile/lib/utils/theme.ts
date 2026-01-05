import { DarkTheme, DefaultTheme, type Theme } from '@react-navigation/native';
 
// Kortix Brand Styleguide Colors
export const THEME = {
  light: {
    background: 'hsl(0 0% 96.5%)',        // #f6f6f6 - Brand app background
    foreground: 'hsl(218 12% 7%)',        // #121215 - Kortix Black
    card: 'hsl(330 14% 98.4%)',           // #fbf9fa - Brand card/input background
    cardForeground: 'hsl(218 12% 7%)',    // #121215 - Card text
    popover: 'hsl(0 0% 100%)',            // #FFFFFF - Popover background
    popoverForeground: 'hsl(218 12% 7%)', // #121215 - Popover text
    primary: 'hsl(218 12% 7%)',           // #121215 - Primary (black)
    primaryForeground: 'hsl(240 11% 97%)',// #F8F8F8 - Text on primary
    secondary: 'hsl(220 13% 91%)',        // #E5E7EB - Secondary surfaces
    secondaryForeground: 'hsl(218 12% 7%)',// #121215 - Text on secondary
    muted: 'hsl(240 5% 90%)',             // #e4e4e7 - Brand menu active state
    mutedForeground: 'hsl(220 9% 46%)',   // Muted text
    accent: 'hsl(220 13% 91%)',           // #E5E7EB - Accent
    accentForeground: 'hsl(218 12% 7%)',  // #121215 - Text on accent
    destructive: 'hsl(0 84.2% 60.2%)',
    border: 'hsl(0 0% 2% / 0.14)',        // #050505 @ 14% opacity - Brand border
    input: 'hsl(330 14% 98.4%)',          // #fbf9fa - Brand input background
    ring: 'hsl(218 12% 7%)',              // #121215 - Focus rings
    radius: '0.625rem',
    chart1: 'hsl(12 76% 61%)',
    chart2: 'hsl(173 58% 39%)',
    chart3: 'hsl(197 37% 24%)',
    chart4: 'hsl(43 74% 66%)',
    chart5: 'hsl(27 87% 67%)',
  },
  dark: {
    background: 'hsl(0 0% 9%)',           // #171717 - neutral-900
    foreground: 'hsl(240 11% 97%)',       // #F8F8F8 - Kortix White
    card: 'hsl(240 2% 14%)',              // #232324 - Dark card/input background
    cardForeground: 'hsl(240 11% 97%)',   // #F8F8F8 - Card text
    popover: 'hsl(220 6% 9%)',            // #161618 - Popover background
    popoverForeground: 'hsl(240 11% 97%)',// #F8F8F8 - Popover text
    primary: 'hsl(240 11% 97%)',          // #F8F8F8 - Primary (white)
    primaryForeground: 'hsl(218 12% 7%)', // #121215 - Text on primary
    secondary: 'hsl(220 4% 17%)',         // #2A2A2C - Secondary surfaces
    secondaryForeground: 'hsl(240 11% 97%)',// #F8F8F8 - Text on secondary
    muted: 'hsl(240 4% 26%)',             // #3f3f46 - Dark menu active state
    mutedForeground: 'hsl(0 0% 60%)',     // Muted text
    accent: 'hsl(220 4% 17%)',            // #2A2A2C - Accent
    accentForeground: 'hsl(240 11% 97%)', // #F8F8F8 - Text on accent
    destructive: 'hsl(0 70.9% 59.4%)',
    border: 'hsl(0 0% 98% / 0.14)',       // #fafafa @ 14% opacity - Dark border
    input: 'hsl(240 2% 14%)',             // #232324 - Dark input background
    ring: 'hsl(240 11% 97%)',             // #F8F8F8 - Focus rings
    radius: '0.625rem',
    chart1: 'hsl(220 70% 50%)',
    chart2: 'hsl(160 60% 45%)',
    chart3: 'hsl(30 80% 55%)',
    chart4: 'hsl(280 65% 60%)',
    chart5: 'hsl(340 75% 55%)',
  },
};
 
export const NAV_THEME: Record<'light' | 'dark', Theme> = {
  light: {
    ...DefaultTheme,
    colors: {
      background: THEME.light.background,
      border: THEME.light.border,
      card: THEME.light.card,
      notification: THEME.light.destructive,
      primary: THEME.light.primary,
      text: THEME.light.foreground,
    },
  },
  dark: {
    ...DarkTheme,
    colors: {
      background: THEME.dark.background,
      border: THEME.dark.border,
      card: THEME.dark.card,
      notification: THEME.dark.destructive,
      primary: THEME.dark.primary,
      text: THEME.dark.foreground,
    },
  },
};