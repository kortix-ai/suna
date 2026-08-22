import { describe, expect, test } from 'bun:test';
import { nextAuditReconciliationCursor } from './audit-reconciliation-worker';

describe('nextAuditReconciliationCursor', () => {
  test('repeats an account until every bounded source page is complete', () => {
    expect(
      nextAuditReconciliationCursor('account-before', {
        accountId: 'account-large',
        result: { inserted: 1_000, complete: false, by_source: { connector_calls: 1_000 } },
      }),
    ).toBe('account-before');
  });

  test('advances only after the current account is complete', () => {
    expect(
      nextAuditReconciliationCursor('account-before', {
        accountId: 'account-complete',
        result: { inserted: 12, complete: true, by_source: { provider_events: 12 } },
      }),
    ).toBe('account-complete');
  });

  test('resets the scan after the last account', () => {
    expect(nextAuditReconciliationCursor('account-last', { accountId: null, result: null })).toBe(
      null,
    );
  });
});
