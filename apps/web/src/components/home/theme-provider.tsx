'use client';

import {
  applyInterfaceThemes,
  isThemedSurface,
  normalizeDarkTheme,
  normalizeLightTheme,
} from '@/lib/interface-themes';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import * as React from 'react';

/**
 * Mirrors the stored light and dark palettes onto `<html>` as
 * `data-light-theme` / `data-dark-theme` while a themed route is showing.
 * `INTERFACE_THEME_INIT_SCRIPT` sets them before first paint and
 * `ThemedSurface` on navigation; this keeps them current when the person picks
 * another theme.
 */
function ThemeChoiceSync() {
  const light = useUserPreferencesStore((s) => normalizeLightTheme(s.preferences.lightTheme));
  const dark = useUserPreferencesStore((s) => normalizeDarkTheme(s.preferences.darkTheme));

  React.useEffect(() => {
    const root = document.documentElement;
    // Only /new, /projects and /settings are themed; every other page keeps
    // the brand palette.
    if (!isThemedSurface(root)) return;
    applyInterfaceThemes(root, { light, dark });
  }, [light, dark]);

  return null;
}

export function ThemeProvider({
  children,
  ...props
}: React.ComponentProps<typeof NextThemesProvider>) {
  return (
    <NextThemesProvider {...props}>
      <ThemeChoiceSync />
      {children}
    </NextThemesProvider>
  );
}
