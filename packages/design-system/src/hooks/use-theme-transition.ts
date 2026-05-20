'use client';

import { useTheme as useNextTheme } from 'next-themes';
import { useCallback } from 'react';
import { flushSync } from 'react-dom';

/**
 * Drop-in for `useTheme` from next-themes. `setTheme` runs the swap through the
 * View Transitions API so the document crossfades softly between palettes —
 * matches the macOS Sequoia theme switch.
 *
 * The optional second arg is kept for forward compat with origin-based reveals;
 * it's ignored for the current crossfade animation.
 *
 * Falls through to an instant change on browsers without View Transitions or
 * when the user has reduced-motion preferences.
 */
export function useThemeTransition() {
  const next = useNextTheme();
  const { setTheme: setRaw } = next;

  const setTheme = useCallback(
    (
      value: string,
      _arg?: MouseEvent | React.MouseEvent | { origin?: { x: number; y: number } } | null,
    ) => {
      void _arg;
      if (typeof window === 'undefined') {
        setRaw(value);
        return;
      }
      const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      const startTransition = (document as { startViewTransition?: (cb: () => void) => unknown })
        .startViewTransition;
      if (typeof startTransition !== 'function' || reduced) {
        setRaw(value);
        return;
      }
      startTransition.call(document, () => {
        flushSync(() => setRaw(value));
      });
    },
    [setRaw],
  );

  return {
    ...next,
    setTheme,
  };
}
