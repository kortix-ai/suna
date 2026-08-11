// The admin ledger endpoint and the customer transactions endpoint describe the
// same `credit_ledger` rows with different field names and different types
// (admin ships numeric strings). This mapping is the whole adapter, so the admin
// sheet can render the customer-facing table instead of a second list.
import { describe, expect, test } from 'bun:test';
import type { AdminLedgerEntry } from '@/hooks/admin/use-admin-accounts';
import { adminLedgerRows } from './ledger-rows';

const entry = (over: Partial<AdminLedgerEntry> = {}): AdminLedgerEntry => ({
  id: 'led_1',
  amount: '25.00',
  balanceAfter: '27.50',
  type: 'admin_grant',
  description: 'goodwill',
  isExpiring: true,
  createdAt: '2026-08-11T10:00:00.000Z',
  createdBy: 'user_1',
  ...over,
});

describe('adminLedgerRows', () => {
  test('numeric strings become numbers the table can format and color', () => {
    const [row] = adminLedgerRows([entry()]);
    expect(row).toEqual({
      id: 'led_1',
      createdAt: '2026-08-11T10:00:00.000Z',
      type: 'admin_grant',
      description: 'goodwill',
      isExpiring: true,
      amount: 25,
      balanceAfter: 27.5,
    });
  });

  test('a debit keeps its sign', () => {
    const [row] = adminLedgerRows([entry({ amount: '-1.25', balanceAfter: '26.25' })]);
    expect(row.amount).toBe(-1.25);
    expect(row.balanceAfter).toBe(26.25);
  });

  test('an unparseable amount reads as 0 rather than NaN in the UI', () => {
    const [row] = adminLedgerRows([entry({ amount: 'nonsense', balanceAfter: null as never })]);
    expect(row.amount).toBe(0);
    expect(row.balanceAfter).toBe(0);
  });

  test('a null isExpiring stays absent, so the Credit type cell stays empty', () => {
    const [row] = adminLedgerRows([entry({ isExpiring: null })]);
    expect(row.isExpiring).toBeUndefined();
  });

  test('an empty ledger maps to an empty list', () => {
    expect(adminLedgerRows([])).toEqual([]);
  });
});
