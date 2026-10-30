import { describe, expect, test } from 'bun:test';

import { shouldLoadOnScroll } from './catalog-paging';

/**
 * This file used to assert three more paging mechanisms — an eager first-paint
 * page budget, a per-category auto-deepening chain, and a client-side reveal
 * window. All three were removed with the machinery they described: they
 * existed only so the client could accumulate enough pages to fake a category
 * filter, and the API performs that filter now
 * (`apps/api/src/connectors/pipedream-index.ts`).
 *
 * One mechanism is left, and it is the one the user drives.
 */
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
    // Pinned by arity: a ceiling would need a page count, and this predicate
    // takes only the sentinel and the query state. Reaching the foot of the
    // grid is the user asking for more, and answering it with a cap is the
    // regression this function exists to prevent.
    expect(shouldLoadOnScroll.length).toBe(2);
  });
});
