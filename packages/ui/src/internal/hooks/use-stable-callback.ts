'use client';

import { useCallback, useInsertionEffect, useRef } from 'react';

/**
 * A function whose identity never changes and which always calls the latest
 * `fn` the component rendered with.
 *
 * For handlers passed into memoized children that are only invoked from
 * events (a click, a reply), never during render. `useCallback` alone keeps
 * the identity only while its dependencies hold, and a handler that closes
 * over the live transcript changes on every streamed delta — which re-rendered
 * every memoized turn in the transcript at the stream's rate.
 *
 * The ref is updated in an insertion effect, so it is current before any
 * layout effect or event handler of the same commit runs.
 */
export function useStableCallback<Args extends unknown[], Result>(
  fn: (...args: Args) => Result,
): (...args: Args) => Result {
  const ref = useRef(fn);
  useInsertionEffect(() => {
    ref.current = fn;
  });
  return useCallback((...args: Args) => ref.current(...args), []);
}
