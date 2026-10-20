'use client';

import { useEffect, useState } from 'react';

/**
 * Whether `next` should bypass the debounce timer.
 *
 * Clearing the query is the one case that must be immediate: it closes the
 * menu, and a 150ms lag there reads as the UI hanging.
 */
export function shouldEmit(next: string, current: string): boolean {
  if (next === current) return false;
  return next.length === 0;
}

export function useDebouncedValue(value: string, ms: number): string {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    if (shouldEmit(value, debounced)) {
      setDebounced(value);
      return;
    }
    if (value === debounced) return;
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, debounced, ms]);

  return debounced;
}
