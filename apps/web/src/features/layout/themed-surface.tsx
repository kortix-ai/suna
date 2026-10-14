'use client';

import {
  applyInterfaceThemes,
  clearInterfaceThemes,
  normalizeDarkTheme,
  normalizeLightTheme,
} from '@/lib/interface-themes';
import { useUserPreferencesStore } from '@/stores/user-preferences-store';
import { useLayoutEffect } from 'react';

/**
 * Turns the person's interface theme on for the route that mounts it and off
 * again when they leave. A full page load is already themed by
 * INTERFACE_THEME_INIT_SCRIPT (inlined by the same layout); this covers
 * client-side navigation in and out of /new, /projects/** and /settings.
 * `ThemeChoiceSync` keeps the attributes current while it is mounted.
 */
export function ThemedSurface() {
  useLayoutEffect(() => {
    const root = document.documentElement;
    const { lightTheme, darkTheme } = useUserPreferencesStore.getState().preferences;
    applyInterfaceThemes(root, {
      light: normalizeLightTheme(lightTheme),
      dark: normalizeDarkTheme(darkTheme),
    });
    return () => clearInterfaceThemes(root);
  }, []);
  return null;
}
