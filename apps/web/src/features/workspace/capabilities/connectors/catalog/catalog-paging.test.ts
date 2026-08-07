import { describe, expect, test } from 'bun:test';

import {
  CATALOG_AUTOLOAD_MAX_PAGES,
  CATALOG_FOCUS_TARGET,
  CATALOG_INITIAL_PAGES,
  CATALOG_INITIAL_REVEAL,
  CATALOG_REVEAL_STEP,
  canRevealMore,
  nextRevealCount,
  shouldAutoLoadPage,
  shouldLoadOnScroll,
  type CatalogPagingState,
} from './catalog-paging';

/** A state that WOULD page, so each test can knock out exactly one condition
 *  and attribute the `false` to it. */
function paging(overrides: Partial<CatalogPagingState> = {}): CatalogPagingState {
  return {
    enabled: true,
    loadedPages: 1,
    hasNextPage: true,
    isFetchingNextPage: false,
    isPlaceholderData: false,
    focus: null,
    initialPages: CATALOG_INITIAL_PAGES,
    maxPages: CATALOG_AUTOLOAD_MAX_PAGES,
    ...overrides,
  };
}

describe('shouldAutoLoadPage', () => {
  test('fills the first-paint budget while browsing everything', () => {
    for (let loadedPages = 1; loadedPages < CATALOG_INITIAL_PAGES; loadedPages++) {
      expect(shouldAutoLoadPage(paging({ loadedPages }))).toBe(true);
    }
  });

  test('stops at the first-paint budget when nothing is focused', () => {
    // The unfocused browse is a sectioned overview, not a list to exhaust.
    // Depth past this point is the scroll sentinel's job.
    expect(shouldAutoLoadPage(paging({ loadedPages: CATALOG_INITIAL_PAGES }))).toBe(false);
  });

  test('keeps deepening past the budget while a focused category is thin', () => {
    // The regression this undoes: "View all" on Finance opened 8 cards,
    // because 8 was all that fit in the 4 pages the page would ever load.
    expect(
      shouldAutoLoadPage(
        paging({
          loadedPages: CATALOG_INITIAL_PAGES,
          focus: { loaded: 8, target: CATALOG_FOCUS_TARGET },
        }),
      ),
    ).toBe(true);
  });

  test('stops once the focused category is full enough to scroll', () => {
    expect(
      shouldAutoLoadPage(
        paging({
          loadedPages: CATALOG_INITIAL_PAGES,
          focus: { loaded: CATALOG_FOCUS_TARGET, target: CATALOG_FOCUS_TARGET },
        }),
      ),
    ).toBe(false);
  });

  test('a rare category cannot walk the whole catalogue unattended', () => {
    // Three Crypto apps in 5,758 would never meet the target, so without the
    // ceiling every landing page would schedule the next for ~120 requests.
    expect(
      shouldAutoLoadPage(
        paging({
          loadedPages: CATALOG_AUTOLOAD_MAX_PAGES,
          focus: { loaded: 3, target: CATALOG_FOCUS_TARGET },
        }),
      ),
    ).toBe(false);
  });

  test('never fires before the first page lands', () => {
    // react-query reports `hasNextPage: false` on a pending fresh query, which
    // is indistinguishable from an exhausted one — `loadedPages` is the only
    // signal that separates them.
    expect(shouldAutoLoadPage(paging({ loadedPages: 0, hasNextPage: false }))).toBe(false);
    expect(shouldAutoLoadPage(paging({ loadedPages: 0 }))).toBe(false);
  });

  test('never pages off the previous query while a search is in flight', () => {
    // `data` still belongs to the previous key here, so `loadedPages` and
    // `hasNextPage` describe a query the user has already moved on from.
    expect(shouldAutoLoadPage(paging({ isPlaceholderData: true }))).toBe(false);
    expect(
      shouldAutoLoadPage(
        paging({ isPlaceholderData: true, focus: { loaded: 0, target: CATALOG_FOCUS_TARGET } }),
      ),
    ).toBe(false);
  });

  test('does not stack requests, and does not run off screen', () => {
    expect(shouldAutoLoadPage(paging({ isFetchingNextPage: true }))).toBe(false);
    expect(shouldAutoLoadPage(paging({ enabled: false }))).toBe(false);
    expect(shouldAutoLoadPage(paging({ hasNextPage: false }))).toBe(false);
  });
});

describe('the reveal window', () => {
  test('uncovers a couple of rows at a time, not a whole request', () => {
    // The grid grows by `CATALOG_REVEAL_STEP` while the network keeps fetching
    // in 48s. Tying the two together would mean either a 48-card jump per
    // scroll or ~450 round trips for the catalogue.
    expect(CATALOG_REVEAL_STEP).toBe(6);
    expect(nextRevealCount(24, 192)).toBe(30);
    expect(nextRevealCount(30, 192)).toBe(36);
  });

  test('never claims more than is loaded', () => {
    // The window is sliced against the loaded list, so an overshoot would just
    // render everything — but it would also make `canRevealMore` false one
    // step early and hand the scroll to the network before the buffer is out.
    expect(nextRevealCount(190, 192)).toBe(192);
    expect(nextRevealCount(192, 192)).toBe(192);
  });

  test('knows when uncovering can still answer a scroll', () => {
    expect(canRevealMore(24, 192)).toBe(true);
    expect(canRevealMore(192, 192)).toBe(false);
    expect(canRevealMore(192, 0)).toBe(false);
  });

  test('the first window is deep enough that the grid does not fill itself', () => {
    // The sentinel has 400px of lead. If the initial window ends above the
    // fold, the sentinel is on screen at rest and the grid uncovers itself
    // with nobody scrolling.
    expect(CATALOG_INITIAL_REVEAL).toBeGreaterThan(CATALOG_REVEAL_STEP * 2);
    expect(CATALOG_INITIAL_REVEAL % CATALOG_REVEAL_STEP).toBe(0);
  });
});

describe('shouldLoadOnScroll', () => {
  test('fetches when the foot of the grid comes into view', () => {
    expect(shouldLoadOnScroll(true, { hasMore: true, isLoadingMore: false })).toBe(true);
  });

  test('ignores a sentinel that is off screen', () => {
    expect(shouldLoadOnScroll(false, { hasMore: true, isLoadingMore: false })).toBe(false);
  });

  test('does not stack requests while one is in flight', () => {
    expect(shouldLoadOnScroll(true, { hasMore: true, isLoadingMore: true })).toBe(false);
  });

  test('stops at the end of the catalogue', () => {
    expect(shouldLoadOnScroll(true, { hasMore: false, isLoadingMore: false })).toBe(false);
  });

  test('carries no page ceiling — scrolling is an explicit request', () => {
    // This is the whole point of keeping it separate from `shouldAutoLoadPage`:
    // the automatic budget must never become the catalogue's size. The rule
    // takes no page count at all, so a ceiling cannot be added by accident.
    expect(shouldLoadOnScroll.length).toBe(2);
  });
});
