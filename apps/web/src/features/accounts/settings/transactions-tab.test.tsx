import { legacySectionRedirect } from '@/features/workspace/settings/settings-tabs';
import { hubParamsFromUrl } from '@/stores/account-panel-store';
import { expect, mock, test } from 'bun:test';
import { NextIntlClientProvider } from 'next-intl';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import en from '../../../../translations/en.json';

let destination = legacySectionRedirect('', 'credits', 'synthetic') ?? '';

mock.module('@/features/accounts/hub/account-hub-location', () => ({
  useHubSearchParams: () => hubParamsFromUrl(new URLSearchParams(destination.split('?')[1])),
}));
mock.module('@/features/billing/cost-explorer/cost-explorer', () => ({
  CostExplorer: () => createElement('p', null, 'Session cost results'),
}));
mock.module('@/features/billing/credit-transactions', () => ({
  default: () => createElement('p', null, 'Credit ledger results'),
}));
mock.module('@/features/billing/account-overview', () => ({
  AccountOverviewTab: () => createElement('p', null, 'Available balance'),
}));
const { TransactionsTab } = await import('./transactions-tab');

test('the transactions destination opens the credit ledger with the balance', () => {
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <TransactionsTab />
    </NextIntlClientProvider>,
  );
  expect(html).toContain('Credit ledger results');
  expect(html).toContain('Available balance');
  expect(html).not.toContain('Session cost results');
  expect(html).toContain('Session costs');
});

test('ordinary transactions links still open session costs', () => {
  destination = legacySectionRedirect('', 'transactions', 'synthetic') ?? '';
  const html = renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en} timeZone="UTC">
      <TransactionsTab />
    </NextIntlClientProvider>,
  );
  expect(html).toContain('Session cost results');
  expect(html).not.toContain('Credit ledger results');
});
