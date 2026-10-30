/**
 * One rule for every capability detail modal: **intent drives `open`, data
 * drives contents.**
 *
 * Every capabilities page had it the other way round —
 *
 *   open={records.find((r) => r.id === selection) !== null}
 *
 * — which hands the query control of the modal. Two failures come straight out
 * of that, and both are the "random modal" glitch:
 *
 *  1. **It opens itself.** `/connectors?c=slack` is a real entry point: a deep
 *     link, and the OAuth 2.0 return leg, which is a full page load by design
 *     (see `connectors-page.tsx` on why `?c=` survives it). On the first
 *     render the list is still loading, so the lookup misses and the modal is
 *     shut. The page paints. Then data lands and a modal animates open on its
 *     own, a beat after the user thought the page had settled.
 *
 *  2. **It closes itself.** `invalidate()` refetches four keys on every
 *     rename, toggle and connect. One failure empties `data`, the lookup
 *     misses, and a modal the user is working in disappears. Skills and
 *     commands have the same exposure through a background agent editing
 *     `kortix.yaml`: a changed `path` is indistinguishable from a deleted one.
 *
 * The fix is to keep the two concerns apart. `open` follows the SELECTION,
 * which only the user changes. The record is content: absent means show a
 * placeholder, not close. The modal closes for exactly one data-driven reason
 * — the query SUCCEEDED and the record genuinely is not in it — which is a
 * real deletion, not a refetch, an error, or a slow first paint.
 *
 * `isSuccess` (not `!isLoading`) is what makes that distinction hold: a query
 * that has exhausted its retries reports `isLoading === false` while `data`
 * stays undefined, so a `!isLoading` test would read a network failure as a
 * deletion and close the modal — the exact bug this replaces.
 */
export interface DetailSelection<TRecord> {
  /** True whenever the user has something selected. Drives `open`, alone. */
  open: boolean;
  /** The record to render, or `null` while it is still being resolved. */
  record: TRecord | null;
  /** Selected, but the record has not arrived yet — render a placeholder. */
  isResolving: boolean;
  /** Selected, the query succeeded, and the record is genuinely gone. The
   *  caller clears the selection on this — the one honest auto-close. */
  isMissing: boolean;
}

export function detailSelection<TRecord>(input: {
  /** What the user picked: a slug, a path, any stable id. `null` = nothing. */
  selection: string | null;
  /** The looked-up record, or `null`/`undefined` when not found. */
  record: TRecord | null | undefined;
  /** Has the query that owns `record` returned data at least once? */
  isSuccess: boolean;
}): DetailSelection<TRecord> {
  const open = input.selection !== null;
  const record = input.record ?? null;
  const unresolved = open && record === null;

  return {
    open,
    record,
    isResolving: unresolved && !input.isSuccess,
    isMissing: unresolved && input.isSuccess,
  };
}
