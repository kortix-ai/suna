import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const reactQuery = await import('@tanstack/react-query');
const billingHooks = await import('@/hooks/billing');
let total = 2;
let billingEnabled = true;
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ session: {}, isLoading: false }),
}));
mock.module('@tanstack/react-query', () => ({
  ...reactQuery,
  useQuery: () => ({ data: { credits: { total }, subscription: { status: 'none' } }, isLoading: false }),
  useQueryClient: () => ({}),
}));
mock.module('@/hooks/billing', () => ({
  ...billingHooks,
  accountStateKeys: { state: () => ['billing'] },
  accountStateSelectors: { totalCredits: () => total },
  invalidateAccountState: () => {},
  useCreatePortalSession: () => ({ mutate: () => {}, isPending: false }),
}));
mock.module('@/lib/config', () => ({ isBillingEnabled: () => billingEnabled }));
mock.module('@/stores/billing-account-context', () => ({
  useBillingAccountId: () => 'synthetic-account',
  useBillingAccountResolved: () => true,
}));

const { BillingTab } = await import('./billing-tab');

// The expected copy is spelled out per case — the "owed" suffix included — so
// the test never branches on the balance itself (billing-source-rules forbids a
// balance-vs-literal comparison outside the decision layer, tests included).
const cases: [number, string, string][] = [
  [2, '$2.00', '200 credits'],
  [0, '$0.00', '0 credits'],
  [-1, '-$1.00', '100 credits owed'],
];
for (const [balance, dollars, creditsLine] of cases) {
  test(`Plan shows the free account's ${balance} dollar balance before checkout`, () => {
    total = balance;
    billingEnabled = true;
    const html = renderToStaticMarkup(createElement(BillingTab, {
      returnUrl: '/settings/plan', isActive: true, showWallet: false,
    }));
    expect(html).toContain('Available balance');
    expect(html).toContain(`>${dollars}</p>`);
    expect(html).toContain(`>${creditsLine}</p>`);
    expect(html).toContain('Subscribe');
  });
}
