import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { BillingTabView } from './billing-tab';

/** Section titles in document order, read from the h2s SettingsSectionHeader emits. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h2[^>]*>([^<]*)<\/h2>/g)].map((m) => m[1]);

describe('BillingTabView', () => {
  test('plan, wallet, and spend render before Auto top-up, Buy credits, and Billing portal', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        canPurchaseCredits
        billingEnabled
        accountOverviewSlot={<div>account-overview</div>}
        autoTopupSlot={<div>auto-topup</div>}
        creditTopupSlot={<div>credit-topup</div>}
      />,
    );
    expect(headings(out)).toEqual([
      'Plan, wallet and spend',
      'Auto top-up',
      'Buy credits',
      'Billing portal',
    ]);
  });

  test('the team-checkout branch shows only the Kortix Team section, nothing from the main branch', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        showTeamCheckout
        canPurchaseCredits
        billingEnabled
        accountOverviewSlot={<div>account-overview</div>}
      />,
    );
    expect(headings(out)).toEqual(['Kortix Team']);
    expect(out).not.toContain('account-overview');
  });

  test('the team-checkout section carries a Subscribe and a Manage billing action', () => {
    const out = renderToStaticMarkup(<BillingTabView showTeamCheckout />);
    expect(out).toContain('Subscribe to Team');
    expect(out).toContain('Manage billing');
  });

  test('loading renders skeletons only, no section headings', () => {
    const out = renderToStaticMarkup(<BillingTabView isLoading accountOverviewSlot={<div>x</div>} />);
    expect(headings(out)).toEqual([]);
    expect(out).not.toContain('account-overview');
  });

  test('an error renders a banner with the message, no section headings', () => {
    const out = renderToStaticMarkup(
      <BillingTabView error="Failed to load subscription data" accountOverviewSlot={<div>x</div>} />,
    );
    expect(headings(out)).toEqual([]);
    expect(out).toContain('Failed to load subscription data');
    expect(out).toContain('role="alert"');
  });

  test('the credits-ran-out banner renders above Plan, wallet & spend when flagged', () => {
    const out = renderToStaticMarkup(
      <BillingTabView showCreditsRanOutBanner accountOverviewSlot={<div>account-overview</div>} />,
    );
    expect(out).toContain('You ran out of credits');
    const bannerIndex = out.indexOf('You ran out of credits');
    const planIndex = out.indexOf('Plan, wallet and spend');
    expect(bannerIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeGreaterThan(-1);
    expect(bannerIndex).toBeLessThan(planIndex);
  });

  test('the credits-ran-out banner is absent by default', () => {
    const out = renderToStaticMarkup(<BillingTabView accountOverviewSlot={<div>x</div>} />);
    expect(out).not.toContain('You ran out of credits');
  });

  test('Auto top-up and Buy credits are absent without canPurchaseCredits', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        billingEnabled
        accountOverviewSlot={<div>x</div>}
        autoTopupSlot={<div>auto-topup</div>}
        creditTopupSlot={<div>credit-topup</div>}
      />,
    );
    expect(headings(out)).not.toContain('Auto top-up');
    expect(headings(out)).not.toContain('Buy credits');
    expect(out).not.toContain('auto-topup');
    expect(out).not.toContain('credit-topup');
  });

  test('Billing portal is entirely absent when billing is disabled — no broken Stripe control on self-host', () => {
    const out = renderToStaticMarkup(
      <BillingTabView billingEnabled={false} accountOverviewSlot={<div>x</div>} />,
    );
    expect(headings(out)).not.toContain('Billing portal');
    expect(out).not.toContain('Manage billing');
  });

  test('the claim-per-seat and seat-management slots render only when supplied', () => {
    const withSlots = renderToStaticMarkup(
      <BillingTabView
        accountOverviewSlot={<div>x</div>}
        claimPerSeatSlot={<div>claim-per-seat</div>}
        seatManagementSlot={<div>seat-management</div>}
      />,
    );
    expect(withSlots).toContain('claim-per-seat');
    expect(withSlots).toContain('seat-management');

    const withoutSlots = renderToStaticMarkup(<BillingTabView accountOverviewSlot={<div>x</div>} />);
    expect(withoutSlots).not.toContain('claim-per-seat');
    expect(withoutSlots).not.toContain('seat-management');
  });

  // Fix round 1, finding 1 — account.write (read) vs billing.write (write).
  // `account.write` alone must still show every read-only section; only
  // `billing.write` should unlock the mutating controls. See this file's
  // header comment.
  test('account.write without billing.write renders the read-only view — no mutating controls, an owner-only note instead', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        canManageBilling={false}
        canPurchaseCredits
        billingEnabled
        accountOverviewSlot={<div>account-overview</div>}
        seatManagementSlot={<div>seat-management</div>}
        autoTopupSlot={<div>auto-topup</div>}
        creditTopupSlot={<div>credit-topup</div>}
      />,
    );
    // Read-only content stays fully visible.
    expect(out).toContain('account-overview');
    expect(out).toContain('seat-management');
    expect(headings(out)).toContain('Plan, wallet and spend');
    // Mutating sections/controls disappear.
    expect(headings(out)).not.toContain('Auto top-up');
    expect(headings(out)).not.toContain('Buy credits');
    expect(out).not.toContain('auto-topup');
    expect(out).not.toContain('credit-topup');
    // Billing portal section stays visible (an admin can see it exists) but
    // its action button is replaced by the owner-only note.
    expect(headings(out)).toContain('Billing portal');
    expect(out).not.toContain('>Manage billing<');
    expect(out).toContain('Only account owners can manage billing.');
  });

  test('billing.write renders every mutating control — auto top-up, buy credits, and the billing portal button', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        canManageBilling
        canPurchaseCredits
        billingEnabled
        accountOverviewSlot={<div>account-overview</div>}
        autoTopupSlot={<div>auto-topup</div>}
        creditTopupSlot={<div>credit-topup</div>}
      />,
    );
    expect(headings(out)).toEqual([
      'Plan, wallet and spend',
      'Auto top-up',
      'Buy credits',
      'Billing portal',
    ]);
    expect(out).toContain('auto-topup');
    expect(out).toContain('credit-topup');
    expect(out).toContain('>Manage billing<');
    expect(out).not.toContain('Only account owners can manage billing.');
  });

  test('team-checkout: billing.write shows the Subscribe and Manage billing actions', () => {
    const out = renderToStaticMarkup(<BillingTabView showTeamCheckout canManageBilling />);
    expect(out).toContain('Subscribe to Team');
    expect(out).toContain('Manage billing');
    expect(out).not.toContain('Only account owners can manage billing.');
  });

  test('team-checkout: without billing.write, the actions are replaced by the owner-only note', () => {
    const out = renderToStaticMarkup(<BillingTabView showTeamCheckout canManageBilling={false} />);
    expect(out).not.toContain('Subscribe to Team');
    expect(out).not.toContain('Manage billing');
    expect(out).toContain('Only account owners can manage billing.');
  });
});
