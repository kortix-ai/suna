import { describe, expect, test } from 'bun:test';

import { describeTopup } from './credit-topup-section';

/**
 * The amount control's whole contract in one pure function: what the button
 * says, whether it can be pressed, and the single muted line under the row.
 *
 * The line matters as much as the button. The old control surfaced validation
 * by *appending* a line ("Minimum top-up is $5.") under a grid that already
 * had a custom-amount row, so the primary button moved down the page as you
 * typed. One always-present slot is why that cannot happen again — hence a
 * test that every state produces a non-empty hint.
 */
describe('describeTopup', () => {
  test('no amount chosen: nothing to buy, and the line explains the unit instead', () => {
    const { canBuy, hint, actionLabel } = describeTopup(null);
    expect(canBuy).toBe(false);
    expect(actionLabel).toBe('Add credits');
    expect(hint).toBe('Credits never expire. $1 = 100 credits.');
  });

  test('a preset amount: buyable, and the button names the exact charge', () => {
    const { canBuy, hint, actionLabel } = describeTopup(50);
    expect(canBuy).toBe(true);
    expect(actionLabel).toBe('Add $50');
    expect(hint).toContain('5,000 credits');
  });

  test('below the $5 Stripe floor: not buyable, and the line says why', () => {
    const { canBuy, hint, actionLabel } = describeTopup(3);
    expect(canBuy).toBe(false);
    expect(hint).toBe('Minimum top-up is $5.');
    // The label falls back rather than promising a charge that cannot happen.
    expect(actionLabel).toBe('Add credits');
  });

  test('$5 exactly is buyable — the floor is inclusive', () => {
    expect(describeTopup(5).canBuy).toBe(true);
  });

  test('above the $10,000 ceiling: not buyable, and it points at sales', () => {
    const { canBuy, hint } = describeTopup(10001);
    expect(canBuy).toBe(false);
    expect(hint).toBe('For more than $10,000, contact sales.');
  });

  test('$10,000 exactly is buyable — the ceiling is inclusive', () => {
    expect(describeTopup(10000).canBuy).toBe(true);
  });

  test('a purchase in flight blocks the button and says so', () => {
    const { canBuy, actionLabel } = describeTopup(50, true);
    expect(canBuy).toBe(false);
    expect(actionLabel).toBe('Processing');
  });

  test('fractional custom amounts round to the whole dollar that is actually charged', () => {
    const { actionLabel, hint } = describeTopup(24.6);
    expect(actionLabel).toBe('Add $25');
    expect(hint).toContain('2,500 credits');
  });

  test('every state produces a hint — the line is never empty, so the row never reflows', () => {
    for (const amount of [null, 0, 3, 5, 50, 10000, 10001]) {
      expect(describeTopup(amount).hint.length).toBeGreaterThan(0);
    }
  });
});
