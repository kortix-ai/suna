'use client';

import { type RefObject, useEffect, useRef } from 'react';

/**
 * A ref whose `.current` holds the latest `value` after every commit.
 * Synced in an effect, never mutated during render — the shared
 * replacement for the composer's hand-written mirror blocks (why a
 * mirror is needed: see composer-editor.tsx).
 */
export function useLatestRef<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  useEffect(() => {
    ref.current = value;
  }, [value]);
  return ref;
}
