import { describe, expect, test } from 'bun:test';
import { getUpgradeSheetIncludedItems } from './upgrade-sheet-included';

describe('getUpgradeSheetIncludedItems', () => {
  test('names the shared credit pool and carries no price or seat wording', () => {
    const items = getUpgradeSheetIncludedItems();
    expect(items[0]).toBe('Unlimited members, one shared credit pool');
    expect(items.join(' ')).not.toMatch(/\$|seat/i);
  });
});
