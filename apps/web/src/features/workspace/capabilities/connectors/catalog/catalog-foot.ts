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
  /** Cards actually rendered — the filtered count when a category is focused,
   *  not the loaded count. */
  shown: number;
  /** Every entry loaded for the current query, across all pages. */
  loaded: number;
  /** The catalogue's true size for this query, or `loaded` when the source
   *  publishes no count. */
  total: number;
  /** The focused category's heading, or `null` while browsing everything. */
  categoryLabel: string | null;
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
 * Four shapes, one per thing the number can mean:
 *
 *   - **Focused category** — the total describes the whole catalogue, not this
 *     category, so quoting it here would be a non-sequitur. The line counts
 *     what is on screen and says whether more is coming.
 *   - **Search** — `total` is the result count, so the ratio is real.
 *   - **Browsing, more to come** — the ratio, which is the only thing on this
 *     page that tells the user the catalogue is thousands deep rather than the
 *     couple of hundred cards they can see.
 *   - **Browsing, exhausted** — a plain total.
 *
 * `null` when the catalogue is empty (the empty state is already saying it) and
 * when a filtered view has everything (the grid is complete and its size is
 * self-evident from the cards).
 */
export function catalogFootSummary(input: CatalogFootInput): string | null {
  if (input.shown === 0) return null;

  // While a request is in flight the foot used to stack two lines — a spinner
  // reading "Loading more connectors…" over a separate "Showing 192 of 2,713".
  // Two lines saying overlapping things, and the one with the spinner was the
  // one with no information in it. Merged: the spinner says work is happening,
  // and the text says how far along it is.
  if (input.isLoadingMore) {
    if (input.categoryLabel !== null) {
      return `Loading more ${input.categoryLabel} — ${count(input.shown)} so far`;
    }
    return input.total > input.loaded
      ? `Loading more — ${count(input.loaded)} of ${count(input.total)}`
      : `Loading more — ${count(input.loaded)} so far`;
  }

  if (input.categoryLabel !== null) {
    return input.hasMore
      ? `${count(input.shown)} in ${input.categoryLabel} so far`
      : `All ${count(input.shown)} in ${input.categoryLabel}`;
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
