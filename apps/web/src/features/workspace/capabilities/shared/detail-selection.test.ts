import { describe, expect, test } from 'bun:test';

import { detailSelection } from './detail-selection';

/**
 * These cases ARE the two glitches, written down. Each one is a state the old
 * `open={records.find(...) !== null}` expression got wrong, and the name says
 * what the user saw when it did.
 */

const RECORD = { slug: 'slack' };

describe('detailSelection — open follows intent, never the query', () => {
  test('nothing selected is closed, whatever the query is doing', () => {
    expect(detailSelection({ selection: null, record: null, isSuccess: false }).open).toBe(false);
    expect(detailSelection({ selection: null, record: null, isSuccess: true }).open).toBe(false);
    // Even a stale record hanging around cannot open a modal nobody asked for.
    expect(detailSelection({ selection: null, record: RECORD, isSuccess: true }).open).toBe(false);
  });

  test('GLITCH "it opened by itself": a deep link is open on the FIRST render', () => {
    // `/connectors?c=slack` — a deep link, or the OAuth return leg. The list
    // has not loaded, so the lookup misses. The old expression rendered the
    // page closed and then animated a modal open once data arrived.
    const state = detailSelection({ selection: 'slack', record: null, isSuccess: false });

    expect(state.open).toBe(true);
    expect(state.isResolving).toBe(true);
    expect(state.record).toBeNull();
    // Nothing is missing yet — the query has not spoken.
    expect(state.isMissing).toBe(false);
  });

  test('the same selection stays open once the record arrives — no reopen', () => {
    const resolving = detailSelection({ selection: 'slack', record: null, isSuccess: false });
    const resolved = detailSelection({ selection: 'slack', record: RECORD, isSuccess: true });

    expect(resolving.open).toBe(true);
    expect(resolved.open).toBe(true);
    // `open` never flips, so Radix never replays the open animation and the
    // focus trap is continuous across the load.
    expect(resolved.isResolving).toBe(false);
    expect(resolved.record).toBe(RECORD);
  });
});

describe('detailSelection — only a confirmed deletion closes it', () => {
  test('GLITCH "it closed on me": a failed refetch does NOT close the modal', () => {
    // `invalidate()` refetches four keys on every rename/toggle/connect. One
    // 500 empties `data`, so the lookup misses — and react-query reports
    // `isLoading === false` once retries are exhausted. A `!isLoading` test
    // reads that as a deletion; `isSuccess` does not.
    const state = detailSelection({ selection: 'slack', record: null, isSuccess: false });

    expect(state.open).toBe(true);
    expect(state.isMissing).toBe(false);
    expect(state.isResolving).toBe(true);
  });

  test('a genuine deletion is the one auto-close', () => {
    const state = detailSelection({ selection: 'slack', record: null, isSuccess: true });

    expect(state.isMissing).toBe(true);
    expect(state.isResolving).toBe(false);
    // Still `open` here — the caller clears the selection in response to
    // `isMissing`, which is what closes it. Flipping `open` here as well would
    // race that update and cut the exit animation.
    expect(state.open).toBe(true);
  });

  test('undefined and null records are the same absence', () => {
    const withUndefined = detailSelection({
      selection: 'slack',
      record: undefined,
      isSuccess: true,
    });
    const withNull = detailSelection({ selection: 'slack', record: null, isSuccess: true });

    expect(withUndefined).toEqual(withNull);
  });

  test('a present record is never missing and never resolving', () => {
    const state = detailSelection({ selection: 'slack', record: RECORD, isSuccess: true });

    expect(state).toEqual({
      open: true,
      record: RECORD,
      isResolving: false,
      isMissing: false,
    });
  });

  test('a record present before the query settles still renders', () => {
    // Placeholder/previous data: the record is in hand while a refetch runs.
    // Nothing about that should show a placeholder.
    const state = detailSelection({ selection: 'slack', record: RECORD, isSuccess: false });

    expect(state.isResolving).toBe(false);
    expect(state.record).toBe(RECORD);
  });

  test('isResolving and isMissing are mutually exclusive, always', () => {
    for (const selection of [null, 'slack']) {
      for (const record of [null, RECORD]) {
        for (const isSuccess of [false, true]) {
          const state = detailSelection({ selection, record, isSuccess });
          expect(state.isResolving && state.isMissing).toBe(false);
          // Neither can be true without something selected.
          if (!state.open) {
            expect(state.isResolving).toBe(false);
            expect(state.isMissing).toBe(false);
          }
        }
      }
    }
  });
});
