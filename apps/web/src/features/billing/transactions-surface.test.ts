import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const webSource = join(import.meta.dir, '../..');
const transactionsTabPath = join(webSource, 'features/accounts/settings/transactions-tab.tsx');
const accountPagePath = join(webSource, 'app/(app)/accounts/[id]/page.tsx');

describe('account credit transactions surface', () => {
  test('renders session costs first and keeps the credit ledger available', () => {
    const source = readFileSync(transactionsTabPath, 'utf8');

    expect(source).toContain('defaultValue="session-costs"');
    expect(source).toContain('Session costs');
    expect(source).toContain('<SessionCostExplorer />');
    expect(source).toContain('Credit ledger');
    expect(source).toContain('<CreditTransactions />');
  });

  test('describes session costs and exposes them when internal billing is disabled', () => {
    const source = readFileSync(accountPagePath, 'utf8');

    expect(source).toContain('Session costs and credit ledger for this account.');
    expect(source).toContain('transactions: canWriteAccount === true,');
    expect(source).not.toContain('transactions: canWriteAccount === true && billingActive');
  });
});
