'use client';

import { useState } from 'react';

export interface ContentRevisionState<T> {
  /** The last defined value seen. */
  value: T | undefined;
  revision: number;
}

/**
 * Advance the revision only when real content is replaced by different real
 * content. The first load is not a change, and a gap (an error, a refetch in
 * flight) keeps the last content so the next value is compared against it.
 */
export function nextContentRevision<T>(
  state: ContentRevisionState<T>,
  value: T | undefined,
): ContentRevisionState<T> {
  if (value === undefined || value === state.value) return state;
  if (state.value === undefined) return { value, revision: state.revision };
  return { value, revision: state.revision + 1 };
}

/**
 * A counter that moves each time `value` is replaced by a different value.
 * Keyed on by renderers that read their own bytes (xlsx, sqlite), which a
 * cache refetch cannot reach: when the content changed, they remount and read
 * again; when it did not, the reference is the same and nothing happens.
 */
export function useContentRevision<T>(value: T | undefined): number {
  const [state, setState] = useState<ContentRevisionState<T>>({ value, revision: 0 });
  const next = nextContentRevision(state, value);
  // Adjusting state during render — React re-renders before committing, so no
  // frame ever shows the old key with the new content.
  if (next !== state) setState(next);
  return next.revision;
}
