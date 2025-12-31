import { useCallback, useEffect, useRef } from 'react';

type AnyFn = (...args: any[]) => any;

/**
 * Leading-edge debounced callback.
 *
 * - Calls immediately on first invocation
 * - Ignores subsequent calls until `waitMs` has elapsed
 * - Also prevents re-entrancy while the wrapped function is executing
 *
 * Useful for "create resource" actions that must be single-flight even if users
 * tap/click multiple times quickly.
 */
export function useLeadingDebouncedCallback<TFn extends AnyFn>(fn: TFn, waitMs: number) {
  const fnRef = useRef(fn);
  const lastCallAtRef = useRef<number>(0);
  const inFlightRef = useRef(false);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    fnRef.current = fn;
  }, [fn]);

  useEffect(() => {
    return () => {
      if (releaseTimerRef.current) {
        clearTimeout(releaseTimerRef.current);
      }
    };
  }, []);

  return useCallback(
    async (...args: Parameters<TFn>): Promise<Awaited<ReturnType<TFn>> | undefined> => {
      const now = Date.now();

      if (inFlightRef.current) return undefined;
      if (now - lastCallAtRef.current < waitMs) return undefined;

      lastCallAtRef.current = now;
      inFlightRef.current = true;

      try {
        return await fnRef.current(...args);
      } finally {
        // Keep blocked for at least `waitMs`, even if `fn` resolves quickly
        const elapsed = Date.now() - now;
        const remaining = Math.max(0, waitMs - elapsed);

        if (releaseTimerRef.current) {
          clearTimeout(releaseTimerRef.current);
        }

        releaseTimerRef.current = setTimeout(() => {
          inFlightRef.current = false;
          releaseTimerRef.current = null;
        }, remaining);
      }
    },
    [waitMs],
  );
}

