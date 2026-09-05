import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PANE_META } from '@/features/accounts/hub/sections';

const webSource = join(import.meta.dir, '../..');
const transactionsTabPath = join(webSource, 'features/accounts/settings/transactions-tab.tsx');
const hubAccessPath = join(webSource, 'features/accounts/hub/use-account-hub-access.ts');

describe('account credit transactions surface', () => {
  test('renders session costs first and keeps the credit ledger available', () => {
    const source = readFileSync(transactionsTabPath, 'utf8');

    expect(source).toContain('defaultValue="session-costs"');
    expect(source).toContain('Session costs');
    expect(source).toContain('<CostExplorer />');
    expect(source).toContain('Credit ledger');
    expect(source).toContain('<CreditTransactions />');
  });

  test('describes session costs and exposes them when internal billing is disabled', () => {
    // The copy is catalog data now, so assert it as data rather than as text.
    expect(PANE_META.transactions?.description).toBe(
      'Session costs and credit ledger for this account.',
    );

    // The gate is still a source read: it is one line inside a hook whose
    // inputs (entitlements, membership, flags) are not worth standing up here.
    // What matters is that `billingActive` never re-enters the condition.
    const source = readFileSync(hubAccessPath, 'utf8');
    expect(source).toContain('transactions: canWriteAccount === true,');
    expect(source).not.toContain('transactions: canWriteAccount === true && billingActive');
  });
});
