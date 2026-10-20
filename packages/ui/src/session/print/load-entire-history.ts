/**
 * Pull the WHOLE conversation into the DOM before the browser prints it.
 *
 * The transcript is paged: `loadOlder()` prepends the previous page and
 * `hasOlder` says whether another one exists (`use-session-sync.ts`). Printing
 * without draining that first gives a PDF of the last page of a conversation
 * and nothing before it — silently, because the output looks complete.
 *
 * The loop reads its state through a callback rather than taking values,
 * because the caller's `hasOlder` is React state: it cannot change inside a
 * synchronous loop, so the hook passes a reader that looks at a ref an effect
 * keeps current. `settle` is the same reason — after each pull we hand control
 * back so React can commit and the refs can move.
 */

export interface LoadEntireHistoryState {
  /** Another page exists before the oldest message currently rendered. */
  hasOlder: boolean;
  /** A pull is already in flight. */
  isLoadingOlder: boolean;
}

export interface LoadEntireHistoryOptions {
  /** Current paging state — read fresh on every iteration. */
  readState: () => LoadEntireHistoryState;
  /** Ask for one more page. */
  loadOlder: () => Promise<unknown> | unknown;
  /** Yield to React between pulls so `readState` can observe the commit. */
  settle: () => Promise<void>;
  /**
   * Stop after this many pages.
   *
   * A bound, not a target. `hasOlder` is reported by the sync controller, and a
   * controller that answers `true` for a page it cannot actually deliver would
   * otherwise spin here forever with the user staring at "Preparing…". 200
   * pages is ~10,000 messages — past any conversation we have seen, and far
   * enough out that hitting it means something is wrong rather than that
   * someone has a long session.
   */
  maxPages?: number;
  /**
   * How many times to wait on an in-flight pull before giving up on that page.
   *
   * Waiting does not advance `pages`, so this is the bound that keeps a wedged
   * `isLoadingOlder` from spinning for ever. At the hook's one-frame `settle`
   * this is a fraction of a second of patience per page, which is all a
   * healthy overlapping pull needs.
   */
  maxWaitsPerPage?: number;
}

export interface LoadEntireHistoryResult {
  /** Pages pulled by this call. Zero means everything was already loaded. */
  pages: number;
  /** False when the bound or a stall stopped us before the true beginning. */
  exhausted: boolean;
}

export const DEFAULT_MAX_HISTORY_PAGES = 200;

/** See {@link LoadEntireHistoryOptions.maxWaitsPerPage}. */
export const DEFAULT_MAX_WAITS_PER_PAGE = 600;

/**
 * Pull pages until `hasOlder` is false.
 *
 * Never throws: a failed pull ends the drain and reports `exhausted: false`.
 * A print that is missing its oldest pages is worth having; an exception that
 * cancels the print is not, and the caller has no better recovery than to go
 * ahead with what is loaded.
 */
export async function loadEntireHistory(
  options: LoadEntireHistoryOptions,
): Promise<LoadEntireHistoryResult> {
  const maxPages = options.maxPages ?? DEFAULT_MAX_HISTORY_PAGES;
  const maxWaits = options.maxWaitsPerPage ?? DEFAULT_MAX_WAITS_PER_PAGE;
  let pages = 0;
  let waits = 0;

  while (pages < maxPages) {
    const state = options.readState();
    if (!state.hasOlder) return { pages, exhausted: true };
    // A pull started by the scroll sentinel is already doing this page. Wait
    // for it rather than racing a second request for the same cursor.
    //
    // BOUNDED, because this branch does not advance `pages`: a controller that
    // is wedged `isLoadingOlder` (a request that never settles — the sandbox
    // going away mid-read does exactly this) would otherwise spin here for
    // ever, and the only thing the user would see is "Preparing…" that never
    // becomes a print dialog.
    if (state.isLoadingOlder) {
      if (waits >= maxWaits) return { pages, exhausted: false };
      waits += 1;
      await options.settle();
      continue;
    }
    waits = 0;
    try {
      await options.loadOlder();
    } catch {
      return { pages, exhausted: false };
    }
    pages += 1;
    await options.settle();
  }

  return { pages, exhausted: !options.readState().hasOlder };
}
