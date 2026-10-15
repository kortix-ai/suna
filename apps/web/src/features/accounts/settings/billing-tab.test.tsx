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
mock.module('@/features/billing/use-change-credit-plan', () => ({
  useChangeCreditPlan: () => ({ change: () => {}, isPending: false }),
}));
mock.module('@/lib/config', () => ({ isBillingEnabled: () => billingEnabled }));
mock.module('@/stores/billing-account-context', () => ({
  useBillingAccountId: () => 'synthetic-account',
  useBillingAccountResolved: () => true,
}));

const { BillingTab } = await import('./billing-tab');

/**
 * The Plan pane of an account with no paid subscription: the plan card names
 * Free, shows its 200 credits, and offers the tier select with a Subscribe
 * action. The wallet (balance, spend) belongs to the Credits pane and the
 * wallet-first view, so the Plan pane must not print it.
 */
describe('BillingTab — plan pane without a paid subscription', () => {
  function freeState(overrides: Record<string, unknown> = {}) {
    return {
      credits: { total: 2 },
      can_manage_billing: true,
      plan: { key: 'free', family: 'free', label: 'Free', sublabel: null, monthly_usd: null },
      subscription: { status: 'none' },
      ...overrides,
    };
  }

  function renderPlan() {
    return renderToStaticMarkup(
      createElement(BillingTab, { returnUrl: '/settings/plan', isActive: true, showWallet: false }),
    );
  }

  test('shows the Free plan with its monthly credits and the tier select on the most popular tier', () => {
    billingEnabled = true;
    accountStateData = freeState();
    const html = renderPlan();
    expect(html).toContain('Current plan');
    expect(html).toContain('>Free</p>');
    expect(html).toContain('200 credits / month');
    expect(html).toContain('Monthly credits');
    expect(html).toContain('Subscribe for $200 / month');
    expect(html).toContain('20,000 credits / month');
    expect(html).not.toContain('Available balance');
  });

  test('the tier select marks the most popular tier and estimates agent hours', () => {
    accountStateData = freeState();
    const html = renderPlan();
    expect(html).toContain('Most popular');
    expect(html).toContain('≈ 1,830 agent-computer hours a month.'); // agentHoursForCredits(20_000)
    expect(html).not.toContain('Starter');
  });

  test('a member who may not change billing sees who to ask, not the picker', () => {
    accountStateData = freeState({ can_manage_billing: false });
    const html = renderPlan();
    expect(html).toContain('Only account owners can change the plan.');
    expect(html).not.toContain('Subscribe for');
  });

  test('billing off renders no plan changer', () => {
    billingEnabled = false;
    accountStateData = freeState();
    const html = renderPlan();
    expect(html).not.toContain('Subscribe for');
    billingEnabled = true;
  });

  test('wallet-first view keeps the balance and adds the plan changer under it', () => {
    total = 2;
    accountStateData = freeState();
    const html = renderToStaticMarkup(
      createElement(BillingTab, { returnUrl: '/settings/plan', isActive: true }),
    );
    expect(html).toContain('Subscribe for');
  });
});

/**
 * The cancel control — the piece that was missing when the dogfood journey
 * found a billing portal with no way to stop paying (KRTX-1316). The backend
 * route, the guard and the mutation hook all existed; the pane just never
 * offered the action, so "cancel anytime" was a promise the app could not keep.
 *
 * These cases pin the four account states the control renders for, on the
 * SAME pane a paying customer sees (a subscribed Credits account, `showWallet:
 * false`, billing enabled).
 */
describe('BillingTab — cancel control on a subscribed account', () => {
  function subscribedState(overrides: Record<string, unknown> = {}) {
    return {
      credits: { total: 100 },
      can_manage_billing: true,
      plan: { key: 'credits', family: 'credits', label: 'Credits', sublabel: null, monthly_usd: 100 },
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

  test('an active subscription shows its monthly amount and offers Update beside Cancel', () => {
    accountStateData = subscribedState();
    const html = renderPlan();
    expect(html).toContain('>Credits</p>');
    expect(html).toContain('$100/mo');
    expect(html).toContain('10,000 credits / month');
    expect(html).toContain('Update plan');
    expect(html).toContain('Cancel subscription');
  });

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
