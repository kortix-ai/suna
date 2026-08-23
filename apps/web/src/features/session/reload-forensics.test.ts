import { describe, expect, test } from 'bun:test';
import { isInvoluntaryLoad } from './reload-forensics';

describe('isInvoluntaryLoad', () => {
  test('a discarded tab is involuntary — Chrome dropped it, the user did not', () => {
    expect(
      isInvoluntaryLoad({ discarded: true, navigationType: 'reload', recentChunkError: null }),
    ).toBe(true);
  });

  test('a chunk that failed just before the reload is involuntary', () => {
    expect(
      isInvoluntaryLoad({
        discarded: false,
        navigationType: 'reload',
        recentChunkError: 'Loading chunk 4821 failed',
      }),
    ).toBe(true);
  });

  // A person pressing cmd+R looks identical to an automatic reload in the
  // navigation entry, so reporting every 'reload' would bury the real signal.
  test('a bare reload is NOT reported — it is indistinguishable from cmd+R', () => {
    expect(
      isInvoluntaryLoad({ discarded: false, navigationType: 'reload', recentChunkError: null }),
    ).toBe(false);
  });

  test('an ordinary navigation is not reported', () => {
    expect(
      isInvoluntaryLoad({ discarded: false, navigationType: 'navigate', recentChunkError: null }),
    ).toBe(false);
  });
});
