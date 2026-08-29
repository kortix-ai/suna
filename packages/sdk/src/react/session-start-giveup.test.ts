import { describe, expect, test } from 'bun:test';
import { startGiveUpExpiryAtMs } from './session-start-giveup';

const BUDGET = 45_000;

describe('startGiveUpExpiryAtMs', () => {
  // The give-up verdict used to be computed only inside an effect keyed on the
  // query's own outputs, and the inconclusive stamp does not move while the
  // query is fetching. A /start that never settles therefore never armed the
  // clock and the session stayed "starting" forever (S8).
  test('a pending start has an expiry instant', () => {
    expect(startGiveUpExpiryAtMs({ inconclusiveSinceMs: 1_000, budgetMs: BUDGET })).toBe(46_000);
  });

  test('a settled start has no expiry', () => {
    expect(startGiveUpExpiryAtMs({ inconclusiveSinceMs: null, budgetMs: BUDGET })).toBeNull();
  });
});
