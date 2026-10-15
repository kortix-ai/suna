import { describe, expect, test } from 'bun:test';

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
