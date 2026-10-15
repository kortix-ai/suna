import type { AccountState } from '@kortix/sdk';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// The two purchase controls are hook-driven (Stripe, the billing account
// context); stand-ins say which one rendered.
mock.module('@/features/billing/credit-topup-section', () => ({
  CreditTopupSection: () => <span>buy-credits-control</span>,
}));
mock.module('@/features/billing/auto-topup-card', () => ({
  AutoTopupCard: () => <span>auto-topup-control</span>,
}));

const { TopupControls } = await import('./topup-controls');

/** Only the two fields the gate reads. */
function account(canManageBilling: boolean, canPurchaseCredits = true): AccountState {
  return {
    subscription: { can_purchase_credits: canPurchaseCredits },
    can_manage_billing: canManageBilling,
  } as unknown as AccountState;
}

const render = (state: AccountState | undefined) =>
  renderToStaticMarkup(
    <TopupControls state={state} heading="Add credits" fallback={<p>ask-an-owner</p>} />,
  );

// KRTX-1720: a member at $0 was offered packages, a custom amount and auto
// top-up. Buy answers a member 403.
describe('TopupControls', () => {
  test('an owner on a plan that buys credits gets the buy control and a collapsed auto top-up', () => {
    const markup = render(account(true));
    expect(markup).toContain('buy-credits-control');
    // Auto top-up sits behind a closed disclosure: its summary line shows, its card does not.
    expect(markup).toContain('Auto top-up: off');
    expect(markup).not.toContain('auto-topup-control');
    expect(markup).toContain('Add credits');
    expect(markup).not.toContain('ask-an-owner');
  });

  test('a member gets the fallback and no purchase control', () => {
    const markup = render(account(false));
    expect(markup).toBe('<p>ask-an-owner</p>');
  });

  test('nothing to buy while the account state loads (fail closed)', () => {
    expect(render(undefined)).toBe('<p>ask-an-owner</p>');
  });

  test('a plan that cannot buy credits offers no purchase control, even to an owner', () => {
    expect(render(account(true, false))).toBe('<p>ask-an-owner</p>');
  });
});
