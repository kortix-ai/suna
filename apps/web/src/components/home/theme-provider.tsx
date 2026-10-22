'use client';

import {
  normalizeDarkTheme,
  normalizeLightTheme,
  syncInterfaceThemes,
} from '@/lib/interface-themes';
import { useUserPreferencesStore } from '@kortix/ui/internal/stores/user-preferences-store';
import { ThemeProvider as NextThemesProvider } from 'next-themes';
import { usePathname } from 'next/navigation';
import * as React from 'react';

/**
 * Mirrors the stored light and dark palettes onto `<html>` as
 * `data-light-theme` / `data-dark-theme` while a themed route (/new,
 * /projects/**, /settings) is showing, and clears them on every other page.
 * `INTERFACE_THEME_INIT_SCRIPT` covers the first paint of a page load; this
 * covers client-side navigation and a new pick. A layout effect, so the
 * change lands in the same frame as the route that caused it.
 */
function ThemeChoiceSync() {
  const light = useUserPreferencesStore((s) => normalizeLightTheme(s.preferences.lightTheme));
  const dark = useUserPreferencesStore((s) => normalizeDarkTheme(s.preferences.darkTheme));

  const pathname = usePathname();

  React.useLayoutEffect(() => {
    syncInterfaceThemes(document.documentElement, pathname, { light, dark });
  }, [pathname, light, dark]);

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
