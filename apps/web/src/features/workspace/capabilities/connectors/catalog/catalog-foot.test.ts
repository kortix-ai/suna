import { describe, expect, test } from 'bun:test';

import { catalogFootSummary, type CatalogFootInput } from './catalog-foot';

function foot(overrides: Partial<CatalogFootInput> = {}): CatalogFootInput {
  return {
    shown: 192,
    loaded: 192,
    total: 2713,
    categoryLabel: null,
    searching: false,
    hasMore: true,
    isLoadingMore: false,
    ...overrides,
  };
}

describe('catalogFootSummary', () => {
  test('browsing quotes the ratio, because nothing else says the catalogue is deep', () => {
    expect(catalogFootSummary(foot())).toBe('Showing 192 of 2,713 connectors');
  });

  test('browsing to the end quotes a plain total', () => {
    expect(catalogFootSummary(foot({ hasMore: false, loaded: 2713, shown: 2713 }))).toBe(
      'All 2,713 connectors',
    );
  });

  test('a focused category counts itself and never the catalogue', () => {
    // The regression this pins: the old line quoted `entries.length` of the
    // catalogue total underneath a grid showing a client-side slice, so a
    // 6-card Finance view claimed to be showing 192 of 5,758.
    expect(catalogFootSummary(foot({ categoryLabel: 'Finance', shown: 31 }))).toBe(
      '31 in Finance so far',
    );
    expect(
      catalogFootSummary(foot({ categoryLabel: 'Finance', shown: 31, hasMore: false })),
    ).toBe('All 31 in Finance');
  });

  test('a search counts results, not connectors', () => {
    expect(catalogFootSummary(foot({ searching: true, loaded: 40, total: 40, hasMore: false }))).toBe(
      'All 40 results',
    );
  });

  test('one result is not "1 results"', () => {
    expect(
      catalogFootSummary(foot({ searching: true, shown: 1, loaded: 1, total: 1, hasMore: false })),
    ).toBe('All 1 result');
  });

  test('while loading, one line carries both the state and the progress', () => {
    // It used to be two stacked lines: a spinner reading "Loading more
    // connectors…" over a separate "Showing 192 of 2,713". The line with the
    // spinner was the line with no information in it.
    expect(catalogFootSummary(foot({ isLoadingMore: true }))).toBe('Loading more — 192 of 2,713');
  });

  test('a loading category counts itself, not the catalogue', () => {
    expect(
      catalogFootSummary(foot({ isLoadingMore: true, categoryLabel: 'Finance', shown: 31 })),
    ).toBe('Loading more Finance — 31 so far');
  });

  test('loading with no reliable total still says how far it has got', () => {
    // Easy Connect on an older API build reports no count, so `total` falls
    // back to the loaded length — "192 of 192" while a request is in flight
    // would be a lie in the other direction.
    expect(catalogFootSummary(foot({ isLoadingMore: true, total: 192 }))).toBe(
      'Loading more — 192 so far',
    );
  });

  test('says nothing when there are no cards to describe', () => {
    // The empty state is already on screen saying it.
    expect(catalogFootSummary(foot({ shown: 0 }))).toBeNull();
  });

  test('never claims a total it cannot back up', () => {
    // Easy Connect on an older API build reports no count, so `total` falls
    // back to the loaded length — quoting "192 of 192" while more pages exist
    // would be a lie in the other direction.
    expect(catalogFootSummary(foot({ total: 192 }))).toBe('192 connectors loaded');
  });
});
