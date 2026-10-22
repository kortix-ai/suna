import { BillingAccountProvider } from '@kortix/ui/internal/stores/billing-account-context';
import { QueryClient } from '@tanstack/react-query';
import { afterEach, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ user: { id: 'synthetic-user' } }),
}));
mock.module('@kortix/ui/internal/lib/onboarding/last-project-cookie', () => ({
  latestProjectPath: () => '/projects/start',
}));
const syncedAccounts: Array<string | undefined> = [];
const sdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({
  ...sdk,
  syncSubscription: async (accountId?: string) => {
    syncedAccounts.push(accountId);
  },
}));
const { useBillingReturnUrl, BILLING_RETURNS } = await import('./billing-return');
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
  else Reflect.deleteProperty(globalThis, 'window');
});

test.each(['team_signup', 'credit_purchase', 'enterprise_contract'] as const)(
  '%s returns to the purchased account billing view',
  (param) => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { origin: 'http://localhost:13000' } },
    });
    let destination = '';
    function Checkout() {
      destination = useBillingReturnUrl()(param);
      return null;
    }
    renderToStaticMarkup(
      <BillingAccountProvider accountId="synthetic-purchased-account">
        <Checkout />
      </BillingAccountProvider>,
    );
    const url = new URL(destination);
    expect(url.origin).toBe('http://localhost:13000');
    expect(url.searchParams.get('accountId')).toBe('synthetic-purchased-account');
    expect(url.searchParams.get('accountTab')).toBe('billing');
    expect(url.searchParams.get(param)).toBe('success');
  },
);

test('unscoped checkout keeps its marker for the server to attach the resolved account', () => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { location: { origin: 'http://localhost:13000' } },
  });
  let destination = '';
  function Checkout() {
    destination = useBillingReturnUrl()('team_signup');
    return null;
  }
  renderToStaticMarkup(
    <BillingAccountProvider accountId={null}>
      <Checkout />
    </BillingAccountProvider>,
  );
  const url = new URL(destination);
  expect(url.pathname).toBe('/projects/start');
  expect(url.searchParams.has('accountId')).toBe(false);
  expect(url.searchParams.get('team_signup')).toBe('success');
});

test.each(['team_signup', 'credit_purchase', 'enterprise_contract'] as const)(
  '%s refreshes the purchased account cache',
  async (param) => {
    const queryClient = new QueryClient();
    const accountKey = ['account-state', 'state', { accountId: 'synthetic-purchased-account' }];
    queryClient.setQueryData(accountKey, { synthetic: true });
    const entry = BILLING_RETURNS.find((entry) => entry.param === param);
    expect(entry).toBeDefined();
    await entry?.settle(queryClient, 'synthetic-purchased-account');
    expect(queryClient.getQueryState(accountKey)?.isInvalidated).toBe(true);
    if (param === 'team_signup') expect(syncedAccounts.at(-1)).toBe('synthetic-purchased-account');
    queryClient.clear();
  },
);
