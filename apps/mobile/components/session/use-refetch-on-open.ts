import { useEffect, useRef } from 'react';

/**
 * Runs `refetch` once, `delayMs` after `open` turns true. `refetch` is read
 * through a ref: a new function identity must not re-arm the timer, or each
 * refetch's re-render would schedule the next fetch while the drawer is open.
 */
export function useRefetchOnOpen(open: boolean, refetch: () => unknown, delayMs: number) {
  const latest = useRef(refetch);
  latest.current = refetch;
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(() => void latest.current(), delayMs);
    return () => clearTimeout(timer);
  }, [open, delayMs]);
}
