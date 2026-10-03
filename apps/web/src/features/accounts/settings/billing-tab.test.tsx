import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

const reactQuery = await import('@tanstack/react-query');
const billingHooks = await import('@/hooks/billing');
let total = 2;
let billingEnabled = true;
type SubscriptionFixture = Record<string, unknown>;
let subscriptionState: SubscriptionFixture = { status: 'none' };
mock.module('@/features/providers/auth-provider', () => ({
  useAuth: () => ({ session: {}, isLoading: false }),
}));
mock.module('@tanstack/react-query', () => ({
  ...reactQuery,
  useQuery: () => ({
    data: { credits: { total }, subscription: subscriptionState },
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
    subscriptionState = { status: 'none' };
    const html = renderToStaticMarkup(createElement(BillingTab, {
      returnUrl: '/settings/plan', isActive: true, showWallet: false,
    }));
    expect(html).toContain('Available balance');
    expect(html).toContain(`>${dollars}</p>`);
    expect(html).toContain(`>${creditsLine}</p>`);
    expect(html).toContain('Subscribe');
  });
}

// The cancel control lives in the Billing portal card, beside Manage billing.
// The subscribed fixture needs only the fields the card and the cancel gate
// read: subscription_id, status, cancel_at_period_end and commitment.can_cancel.
const activeSubscription = (overrides: SubscriptionFixture = {}): SubscriptionFixture => ({
  status: 'active',
  subscription_id: 'sub_synthetic',
  provider: 'stripe',
  cancel_at_period_end: false,
  commitment: { has_commitment: false, can_cancel: true, commitment_type: null, months_remaining: null, commitment_end_date: null },
  ...overrides,
});

function renderBillingTab() {
  return renderToStaticMarkup(createElement(BillingTab, {
    returnUrl: '/settings/plan', isActive: true, showWallet: false,
  }));
}

test('a subscribed account that may cancel sees Cancel subscription beside Manage billing', () => {
  total = 0;
  billingEnabled = true;
  subscriptionState = activeSubscription();
  const html = renderBillingTab();
  expect(html).toContain('Manage billing');
  expect(html).toContain('Cancel subscription');
  expect(html).not.toContain('Resume subscription');
});

test('the cancel control is absent while an active commitment forbids cancellation', () => {
  total = 0;
  billingEnabled = true;
  subscriptionState = activeSubscription({
    commitment: { has_commitment: true, can_cancel: false, commitment_type: 'yearly_commitment', months_remaining: 9, commitment_end_date: '2027-08-01T00:00:00.000Z' },
  });
  const html = renderBillingTab();
  expect(html).toContain('Manage billing');
  expect(html).not.toContain('Cancel subscription');
  expect(html).not.toContain('Resume subscription');
});

test('a subscription that already cancels at period end offers Resume instead of Cancel', () => {
  total = 0;
  billingEnabled = true;
  subscriptionState = activeSubscription({ cancel_at_period_end: true });
  const html = renderBillingTab();
  expect(html).toContain('Resume subscription');
  expect(html).not.toContain('>Cancel subscription<');
});

test('an account without a subscription sees no cancel or resume control', () => {
  total = 0;
  billingEnabled = true;
  subscriptionState = { status: 'none' };
  const html = renderBillingTab();
  expect(html).not.toContain('Cancel subscription');
  expect(html).not.toContain('Resume subscription');
});
