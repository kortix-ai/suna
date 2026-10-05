import { describe, expect, test } from 'bun:test';
import { OLDER_PAGE_SIZE, olderHistoryControl } from './older-history';

describe('olderHistoryControl', () => {
  test('hidden when there is nothing older', () => {
    expect(olderHistoryControl({ hasOlder: false, isLoadingOlder: false, turnCount: 40 })).toBeNull();
  });

  test('hidden on an empty thread', () => {
    expect(olderHistoryControl({ hasOlder: true, isLoadingOlder: false, turnCount: 0 })).toBeNull();
  });

  test('offers the next page', () => {
    expect(olderHistoryControl({ hasOlder: true, isLoadingOlder: false, turnCount: 40 })).toEqual({
      label: 'Show 100 earlier messages',
      disabled: false,
    });
    expect(OLDER_PAGE_SIZE).toBe(100);
  });

  test('disabled while a page loads', () => {
    expect(olderHistoryControl({ hasOlder: true, isLoadingOlder: true, turnCount: 40 })).toEqual({
      label: 'Loading earlier messages…',
      disabled: true,
    });
  });
});
