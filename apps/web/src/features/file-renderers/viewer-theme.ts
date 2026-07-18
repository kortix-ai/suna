'use client';

import { useState } from 'react';
import { useTheme } from 'next-themes';

/**
 * Dark-mode wiring for the Extend UI document viewers (xlsx/docx).
 * Follows the app theme by default; the viewer's own toolbar toggle
 * only overrides rendering locally, never the global theme.
 */
export function useViewerDarkMode(): [boolean, (isDark: boolean) => void] {
  const { resolvedTheme } = useTheme();
  const [override, setOverride] = useState<boolean | null>(null);
  const isDark = override ?? resolvedTheme === 'dark';
  return [isDark, setOverride];
}
