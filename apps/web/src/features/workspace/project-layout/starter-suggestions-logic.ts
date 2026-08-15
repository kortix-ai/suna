/**
 * Pure selection logic for the starter-suggestion rows under the hero
 * composer. There is no paging or shuffling anymore — the surface always
 * shows a fixed leading slice of whatever pool it was given (the
 * personalized set from the API, or the static fallback).
 */

import type { StarterSuggestionAction } from '@kortix/sdk';

/** The first `max` items of `pool`, in order. Never mutates `pool`. */
export function visibleSuggestions<T>(pool: T[], max: number): T[] {
  return pool.slice(0, max);
}

export type SuggestionRowKind = 'prompt' | 'connector' | 'action';

interface SuggestionRowKindItem {
  action?: StarterSuggestionAction;
  connector?: { slug: string; name: string; img_src: string | null } | null;
}

/**
 * Which row shape a starter-suggestion item renders as.
 *
 * - `prompt`: no `action` — the row prefills the composer.
 * - `connector`: `action === 'connectors'` AND the item carries a
 *   server-validated `connector` record AND the viewer can write project
 *   connectors — renders the in-place Connect row + modal instead of
 *   navigating away.
 * - `action`: every other action row, including a `connectors` item with no
 *   `connector` record, or one the viewer can't write — navigates to the
 *   matching capability page or settings tab, same as before.
 */
export function suggestionRowKind(
  item: SuggestionRowKindItem,
  canConnect: boolean,
): SuggestionRowKind {
  if (!item.action) return 'prompt';
  if (item.action === 'connectors' && item.connector != null && canConnect) return 'connector';
  return 'action';
}
