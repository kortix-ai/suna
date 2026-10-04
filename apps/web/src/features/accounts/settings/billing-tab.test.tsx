import { describe, expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const reactQuery = await import('@tanstack/react-query');
const billingHooks = await import('@/hooks/billing');
let total = 2;
let billingEnabled = true;
// The account-state the Plan pane renders. The free-account cases below never
// touch it; the subscription cases set it directly.
let accountStateData: Record<string, unknown> | null = null;
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ session: {}, isLoading: false }),
}));
mock.module('@tanstack/react-query', () => ({
  ...reactQuery,
  useQuery: () => ({
    data: accountStateData ?? { credits: { total }, subscription: { status: 'none' } },
    isLoading: false,
  }),
  useQueryClient: () => ({}),
}));
mock.module('@/hooks/billing', () => ({
  ...billingHooks,
  accountStateKeys: { state: () => ['billing'] },
  accountStateSelectors: { totalCredits: () => total },
  invalidateAccountState: () => {},
  useCreatePortalSession: () => ({ mutate: () => {}, isPending: false }),
  useCancelSubscription: () => ({ mutate: () => {}, isPending: false }),
  useReactivateSubscription: () => ({ mutate: () => {}, isPending: false }),
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
    accountStateData = null;
    const html = renderToStaticMarkup(createElement(BillingTab, {
      returnUrl: '/settings/plan', isActive: true, showWallet: false,
    }));
    expect(html).toContain('Available balance');
    expect(html).toContain(`>${dollars}</p>`);
    expect(html).toContain(`>${creditsLine}</p>`);
    expect(html).toContain('Subscribe');
  });
}

/**
 * The cancel control — the piece that was missing when the dogfood journey
 * found a billing portal with no way to stop paying (KRTX-1316). The backend
 * route, the guard and the mutation hook all existed; the pane just never
 * offered the action, so "cancel anytime" was a promise the app could not keep.
 *
 * These cases pin the four account states the control renders for, on the
 * SAME pane a paying customer sees (a subscribed Team account, `showWallet:
 * false`, billing enabled).
 */
describe('BillingTab — cancel control on a subscribed account', () => {
  function subscribedState(overrides: Record<string, unknown> = {}) {
    return {
      credits: { total: 100 },
      billing_model: 'per_seat',
      can_manage_billing: true,
      subscription: {
        status: 'active',
        subscription_id: 'sub_synthetic',
        cancel_at_period_end: false,
        can_purchase_credits: true,
        commitment: { has_commitment: false, can_cancel: true },
        ...overrides,
      },
    };
  }

  function renderPlan() {
    return renderToStaticMarkup(createElement(BillingTab, {
      returnUrl: '/settings/plan', isActive: true, showWallet: false,
    }));
  }

  test('an active subscription offers Cancel subscription beside Manage billing', () => {
    accountStateData = subscribedState();
    const html = renderPlan();
    expect(html).toContain('Cancel subscription');
    expect(html).toContain('Manage billing');
    expect(html).not.toContain('Reactivate subscription');
  });

  test('a pending cancellation offers Reactivate instead of a second Cancel', () => {
    accountStateData = subscribedState({ cancel_at_period_end: true });
    const html = renderPlan();
    expect(html).toContain('Reactivate subscription');
    expect(html).not.toContain('>Cancel subscription<');
  });

  test('an active commitment disables Cancel and says when it ends', () => {
    accountStateData = subscribedState({
      commitment: {
        has_commitment: true,
        can_cancel: false,
        commitment_end_date: '2027-10-03T00:00:00.000Z',
      },
    });
    const html = renderPlan();
    expect(html).toContain('Cancel subscription');
    expect(html).toContain('Your commitment runs through Oct 3, 2027');
    expect(html).toMatch(/<button[^>]*disabled[^>]*>[^<]*Cancel subscription/);
  });
});
