/**
 * Pure selection logic for the starter-suggestion rows under the hero
 * composer. There is no paging or shuffling anymore — the surface always
 * shows a fixed leading slice of whatever pool it was given (the
 * personalized set from the API, or the static fallback).
 */

/** The first `max` items of `pool`, in order. Never mutates `pool`. */
export function visibleSuggestions<T>(pool: T[], max: number): T[] {
  return pool.slice(0, max);
}
