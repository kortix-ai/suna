import { describe, expect, test } from 'bun:test';
import { getUpgradeSheetIncludedItems } from './upgrade-sheet-included';

describe('getUpgradeSheetIncludedItems', () => {
  test('leads with the per-seat price when purchase is allowed (Android/web)', () => {
    const items = getUpgradeSheetIncludedItems(40, true);
    expect(items[0]).toBe('$40 of usage credit per teammate, every month');
  });

  test('iOS drops the price (App Store guideline 3.1.1) but keeps the same fact', () => {
    const items = getUpgradeSheetIncludedItems(40, false);
    expect(items[0]).toBe('Usage credit for every teammate, every month');
    expect(items[0]).not.toContain('$');
  });

  test('every other line is unchanged by the platform', () => {
    const withPurchase = getUpgradeSheetIncludedItems(40, true).slice(1);
    const withoutPurchase = getUpgradeSheetIncludedItems(40, false).slice(1);
    expect(withoutPurchase).toEqual(withPurchase);
    expect(withoutPurchase).toEqual([
      'Every model, drawn from one shared team wallet',
      'AI Computers to run code, browsers, and terminals',
      'Spend on compute, LLM, or both, with auto top-up',
      'Auto-prorated as teammates join or leave',
    ]);
  });
});
