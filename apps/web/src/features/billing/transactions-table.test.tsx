// The credit ledger is rendered in two places — account settings (Billing →
// Credit ledger) and the admin account sheet — from two different endpoints.
// One presentational table serves both, so the operator view cannot drift from
// what the customer sees. These tests pin the shared piece and the fact that
// both callers actually use it.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { NextIntlClientProvider } from 'next-intl';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CreditTransactionsTable,
  creditTransactionBadge,
  type CreditTransactionRow,
} from './transactions-table';

const dir = import.meta.dir;
const creditTransactionsSource = readFileSync(join(dir, 'credit-transactions.tsx'), 'utf8');
const adminPageSource = readFileSync(
  join(dir, '../../app/admin/accounts/page.tsx'),
  'utf8',
);

describe('creditTransactionBadge', () => {
  test('names the ledger types an operator reads most', () => {
    expect(creditTransactionBadge('admin_grant').label).toBe('Admin Grant');
    expect(creditTransactionBadge('compute_debit').label).toBe('Sandbox');
    expect(creditTransactionBadge('token_deduction').label).toBe('LLM');
    expect(creditTransactionBadge('expired').variant).toBe('destructive');
  });

  test('an unknown type renders as itself instead of disappearing', () => {
    // New ledger types ship from the API before the UI knows them; showing the
    // raw key beats showing nothing.
    expect(creditTransactionBadge('some_new_type')).toEqual({
      label: 'some_new_type',
      variant: 'outline',
    });
  });
});

describe('the shared ledger table is the only implementation', () => {
  test('the customer credit ledger renders through it', () => {
    expect(creditTransactionsSource).toContain('CreditTransactionsTable');
    // The table markup moved wholesale: the caller must not keep a second copy.
    expect(creditTransactionsSource).not.toContain('<TableHeader>');
  });

  test('the admin sheet renders the same table, not a hand-rolled list', () => {
    expect(adminPageSource).toContain('CreditTransactionsTable');
    expect(adminPageSource).toContain('adminLedgerRows');
  });

  test('a row carries everything both endpoints can supply', () => {
    const row: CreditTransactionRow = {
      id: 'led_1',
      createdAt: '2026-08-11T10:00:00.000Z',
      type: 'admin_grant',
      description: 'goodwill',
      isExpiring: true,
      amount: 25,
      balanceAfter: 27.5,
    };
    expect(row.amount).toBe(25);
    // `isExpiring` is optional: an endpoint that does not report it leaves the
    // Credit type cell empty rather than claiming "Permanent".
    const partial: CreditTransactionRow = {
      id: 'led_2',
      createdAt: null,
      type: 'usage',
      description: null,
      amount: -1,
      balanceAfter: 26.5,
    };
    expect(partial.isExpiring).toBeUndefined();
  });
});

/** The two translated headers need the provider; nothing here asserts on them. */
const render = (rows: CreditTransactionRow[]) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={{}} onError={() => {}}>
      <CreditTransactionsTable rows={rows} />
    </NextIntlClientProvider>,
  );

describe('CreditTransactionsTable renders a ledger row', () => {
  const grant: CreditTransactionRow = {
    id: 'led_1',
    createdAt: '2026-08-11T10:00:00.000Z',
    type: 'admin_grant',
    description: 'goodwill',
    isExpiring: true,
    amount: 25,
    balanceAfter: 27.5,
  };

  test('the six columns are there, in order', () => {
    const html = render([grant]);
    for (const header of ['Date', 'Type', 'Description', 'Credits']) {
      expect(html).toContain(`>${header}<`);
    }
    expect(html.indexOf('>Date<')).toBeLessThan(html.indexOf('>Type<'));
    expect(html.indexOf('>Type<')).toBeLessThan(html.indexOf('>Description<'));
  });

  test('a credit is labelled, signed, green, and shows the balance after', () => {
    const html = render([grant]);
    expect(html).toContain('Admin Grant');
    expect(html).toContain('goodwill');
    expect(html).toContain('Expiring');
    expect(html).toContain('+25.00');
    expect(html).toContain('27.50');
    expect(html).toContain('text-kortix-green');
  });

  test('a debit is red and keeps its minus sign', () => {
    const html = render([{ ...grant, id: 'led_2', type: 'compute_debit', amount: -1.25 }]);
    expect(html).toContain('Sandbox');
    expect(html).toContain('-1.25');
    expect(html).toContain('text-kortix-red');
    expect(html).not.toContain('text-kortix-green');
  });

  test('a row with no description or credit type still renders', () => {
    const html = render([
      { id: 'led_3', createdAt: null, type: 'usage', description: null, amount: 0, balanceAfter: 0 },
    ]);
    expect(html).toContain('No description');
    expect(html).toContain('—');
    expect(html).not.toContain('Permanent');
  });

  test('an empty ledger renders the header and no rows', () => {
    const html = render([]);
    expect(html).toContain('>Date<');
    expect(html).not.toContain('<tr class');
  });

  // The bordered `bg-popover rounded-md` surface belongs to the Table
  // primitive; a second wrapper around it was a doubled ring at the same
  // radius, which is exactly the nested rounding the design system bans.
  test('the table is not wrapped in a second bordered box', () => {
    const html = render([grant]);
    expect(html.match(/rounded-md/g)?.length ?? 0).toBe(1);
  });
});
