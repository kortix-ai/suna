import { describe, expect, test } from 'bun:test';
import { HEAP_PRESSURE_BYTES, isInvoluntaryLoad } from './reload-forensics';

describe('isInvoluntaryLoad', () => {
  test('a discarded tab is involuntary — Chrome dropped it, the user did not', () => {
    expect(
      isInvoluntaryLoad({
        discarded: true,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: null,
      }),
    ).toBe(true);
  });

  test('a chunk that failed just before the reload is involuntary', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: 'Loading chunk 4821 failed',
        heapBeforeReload: null,
      }),
    ).toBe(true);
  });

  // A person pressing cmd+R looks identical to an automatic reload in the
  // navigation entry, so reporting every 'reload' would bury the real signal.
  test('a bare reload is NOT reported — it is indistinguishable from cmd+R', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: 200_000_000,
      }),
    ).toBe(false);
  });

  // A renderer that Chrome kills for memory reports NOTHING: not discarded, a
  // plain 'reload', no chunk error. The only fingerprint is what the tab was
  // holding a moment earlier, which is why the previous life records it.
  test('a reload preceded by heap pressure IS reported', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: HEAP_PRESSURE_BYTES,
      }),
    ).toBe(true);
  });

  test('heap pressure without a reload is not a reload report', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'navigate',
        recentChunkError: null,
        heapBeforeReload: HEAP_PRESSURE_BYTES * 2,
      }),
    ).toBe(false);
  });

  test('a missing heap sample never counts as pressure', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: null,
        heapBeforeReload: null,
      }),
    ).toBe(false);
  });

  test('an ordinary navigation is not reported', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'navigate',
        recentChunkError: null,
        heapBeforeReload: null,
      }),
    ).toBe(false);
  });
});
