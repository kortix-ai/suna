import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_MAX_HISTORY_PAGES,
  type LoadEntireHistoryState,
  loadEntireHistory,
} from './load-entire-history';

/** A controller that serves `pages` more pages and then reports exhaustion. */
function controller(pages: number, opts: { stuckLoading?: boolean } = {}) {
  const state: LoadEntireHistoryState = {
    hasOlder: pages > 0,
    isLoadingOlder: opts.stuckLoading === true,
  };
  let remaining = pages;
  let calls = 0;
  let settles = 0;
  return {
    get calls() {
      return calls;
    },
    get settles() {
      return settles;
    },
    readState: () => ({ ...state }),
    loadOlder: async () => {
      calls += 1;
      remaining -= 1;
      state.hasOlder = remaining > 0;
    },
    settle: async () => {
      settles += 1;
    },
  };
}

describe('loadEntireHistory', () => {
  test('pulls until hasOlder goes false', async () => {
    const c = controller(3);
    const result = await loadEntireHistory(c);
    expect(result).toEqual({ pages: 3, exhausted: true });
    expect(c.calls).toBe(3);
  });

  test('does nothing when the whole history is already loaded', async () => {
    const c = controller(0);
    const result = await loadEntireHistory(c);
    expect(result).toEqual({ pages: 0, exhausted: true });
    expect(c.calls).toBe(0);
  });

  test('settles between pulls so React can commit before the next read', async () => {
    const c = controller(2);
    await loadEntireHistory(c);
    // One settle per pull — without it `readState` re-reads a stale ref and
    // the loop either stops early or pulls the same cursor twice.
    expect(c.settles).toBe(2);
  });

  test('waits for a pull the scroll sentinel already started', async () => {
    let isLoadingOlder = true;
    let hasOlder = true;
    let calls = 0;
    let settles = 0;
    const result = await loadEntireHistory({
      readState: () => ({ hasOlder, isLoadingOlder }),
      loadOlder: async () => {
        calls += 1;
        hasOlder = false;
      },
      settle: async () => {
        settles += 1;
        // The sentinel's pull lands, and it was the last page.
        if (settles === 1) {
          isLoadingOlder = false;
          hasOlder = false;
        }
      },
    });
    expect(result).toEqual({ pages: 0, exhausted: true });
    // We never issued a competing request for the same cursor.
    expect(calls).toBe(0);
  });

  test('gives up rather than spinning on a wedged in-flight pull', async () => {
    const c = controller(5, { stuckLoading: true });
    const result = await loadEntireHistory({ ...c, maxWaitsPerPage: 4 });
    expect(result).toEqual({ pages: 0, exhausted: false });
    expect(c.settles).toBe(4);
    expect(c.calls).toBe(0);
  });

  test('stops at maxPages and reports that it did not reach the beginning', async () => {
    const c = controller(50);
    const result = await loadEntireHistory({ ...c, maxPages: 3 });
    expect(result).toEqual({ pages: 3, exhausted: false });
    expect(c.calls).toBe(3);
  });

  test('a failed pull ends the drain instead of throwing', async () => {
    // Printing what is loaded beats cancelling the print — the caller has no
    // better recovery, and the user asked for a PDF.
    let hasOlder = true;
    const result = await loadEntireHistory({
      readState: () => ({ hasOlder, isLoadingOlder: false }),
      loadOlder: async () => {
        throw new Error('transcript read failed');
      },
      settle: async () => {
        hasOlder = false;
      },
    });
    expect(result).toEqual({ pages: 0, exhausted: false });
  });

  test('the default page bound is high enough to be a guard, not a limit', () => {
    expect(DEFAULT_MAX_HISTORY_PAGES).toBeGreaterThanOrEqual(100);
  });
});
