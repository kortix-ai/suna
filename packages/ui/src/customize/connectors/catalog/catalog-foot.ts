/**
 * What the foot of the catalogue says about how much of it is on screen.
 *
 * A pure function because this line is the one place the page makes a claim
 * about a number the user cannot count, and every one of its states has been
 * wrong at least once: it has said "48 of 5,758" under a filtered grid showing
 * 6 cards, and it has said nothing at all on the source most projects actually
 * get. The rules below are asserted rather than eyeballed.
 */

export interface CatalogFootInput {
  /** Every entry rendered for the current query, across all loaded pages. */
  loaded: number;
  total: number;
  /** A text search is running, so `total` is the size of the RESULT set. */
  searching: boolean;
  hasMore: boolean;
  /** A request is in flight underneath a grid that has already painted. */
  isLoadingMore: boolean;
}

function count(value: number): string {
  return value.toLocaleString();
}

/**
 * The summary line, or `null` when there is nothing honest and useful to say.
 *
 */
export function catalogFootSummary(input: CatalogFootInput): string | null {
  if (input.loaded === 0) return null;

  // While a request is in flight the foot used to stack two lines — a spinner
  // reading "Loading more connectors…" over a separate "Showing 192 of 2,713".
  // Two lines saying overlapping things, and the one with the spinner was the
  // one with no information in it. Merged: the spinner says work is happening,
  // and the text says how far along it is.
  if (input.isLoadingMore) {
    return input.total > input.loaded
      ? `Loading more — ${count(input.loaded)} of ${count(input.total)}`
      : `Loading more — ${count(input.loaded)} so far`;
  }

  const noun = input.searching ? 'result' : 'connector';
  const plural = input.total === 1 ? noun : `${noun}s`;

  if (input.hasMore && input.total > input.loaded) {
    return `Showing ${count(input.loaded)} of ${count(input.total)} ${plural}`;
  }
  if (input.hasMore) {
    return `${count(input.loaded)} ${plural} loaded`;
  }
  return `All ${count(input.total)} ${plural}`;
}
