import { describe, expect, test } from 'bun:test';

import { billingModalNeedsTopUp } from '@kortix/ui/internal/lib/billing/billing-gate-state';

import { billingModalLayout } from './global-upgrade-modal';

// "this whole add credits thing looks weird" (2026-10-15): plan first, top-up
// second, unless the account is out of credits, where the top-up is the question.
describe('billingModalLayout', () => {
  test('out of credits or payment failed: the top-up leads', () => {
    expect(billingModalLayout({ needsTopUp: true, hasSubscription: true, canPurchaseCredits: true })).toBe('topup-first');
    expect(billingModalLayout({ needsTopUp: true, hasSubscription: false, canPurchaseCredits: true })).toBe('topup-first');
  });

  test('an account that pays and is not blocked: the plan leads', () => {
    expect(billingModalLayout({ needsTopUp: false, hasSubscription: true, canPurchaseCredits: true })).toBe('plan-first');
  });

  test('an account that cannot buy credits picks a plan', () => {
    expect(billingModalLayout({ needsTopUp: false, hasSubscription: false, canPurchaseCredits: true })).toBe('plans');
    expect(billingModalLayout({ needsTopUp: true, hasSubscription: false, canPurchaseCredits: false })).toBe('plans');
  });
});

// Review finding 10: a Free workspace below the run floor that may buy
// credits (a further workspace with no free credits, or spent free credits)
// opened on the plans view, whose only ways out were "Continue on Free" and a
// $50 subscription. It now leads with the top-up.
describe('a 0-credit Free workspace opens top-up first', () => {
  const freeWorkspace = (total: number) => ({
    billing_state: 'no_subscription' as const,
    has_active_subscription: false,
    credits: { total, can_run: total >= 0.01 },
    tier: { can_purchase_credits: true, monthly_credits: 0 },
  });

  test('0 credits on Free: top-up first', () => {
    const state = freeWorkspace(0);
    expect(
      billingModalLayout({
        needsTopUp: billingModalNeedsTopUp(state, 'no_subscription'),
        hasSubscription: false,
        canPurchaseCredits: true,
      }),
    ).toBe('topup-first');
  });

  test('a funded Free workspace keeps the plans view', () => {
    const state = freeWorkspace(5);
    expect(billingModalNeedsTopUp(state, 'no_subscription')).toBe(false);
  });

  test('an account that cannot buy credits keeps the plans view', () => {
    const state = { ...freeWorkspace(0), tier: { can_purchase_credits: false, monthly_credits: 0 } };
    expect(billingModalNeedsTopUp(state, 'no_subscription')).toBe(false);
  });

  test('out of credits and payment failed still lead with the top-up', () => {
    expect(billingModalNeedsTopUp(freeWorkspace(0), 'out_of_credits')).toBe(true);
    expect(billingModalNeedsTopUp(null, 'payment_failed')).toBe(true);
  });
});
