import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { BillingTabView } from './billing-tab';

/** Section titles in document order, read from the h2/h3s the pane emits. */
const headings = (html: string): string[] =>
  [...html.matchAll(/<h([23])[^>]*>([^<]*)<\/h\1>/g)].map((m) => m[2]);

describe('BillingTabView', () => {
  test('balance renders first, then the credits card — two headings for the whole pane', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        canPurchaseCredits
        billingEnabled
        accountOverviewSlot={<div>account-overview</div>}
        autoTopupSlot={<div>auto-topup</div>}
        creditTopupSlot={<div>credit-topup</div>}
      />,
    );
    expect(headings(out)).toEqual(['Billing', 'Add credits']);
    expect(out.indexOf('account-overview')).toBeLessThan(out.indexOf('Add credits'));
  });

  // The old pane put Auto top-up and Buy credits behind two headings, each
  // wrapping a padded SettingsRowGroup around a component that repeated the
  // heading inside it. One card, one heading, one hairline now.
  test('add credits and auto top-up share one bordered card — no settings-row-group nesting', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        canPurchaseCredits
        billingEnabled
        accountOverviewSlot={<div>account-overview</div>}
        autoTopupSlot={<div>auto-topup</div>}
        creditTopupSlot={<div>credit-topup</div>}
      />,
    );
    expect(out).not.toContain('data-slot="settings-row-group"');
    expect(headings(out)).not.toContain('Auto top-up');
    expect(headings(out)).not.toContain('Buy credits');
    // Both slots land inside the same card, top-up first, in that order.
    expect(out.indexOf('credit-topup')).toBeLessThan(out.indexOf('auto-topup'));
  });

  // The portal is one link out to Stripe, so it lives in the pane header's
  // action slot rather than owning a section and a row group of its own.
  test('the billing portal is a header action, not a section', () => {
    const out = renderToStaticMarkup(
      <BillingTabView billingEnabled accountOverviewSlot={<div>account-overview</div>} />,
    );
    expect(out).toContain('>Manage billing<');
    expect(headings(out)).not.toContain('Billing portal');
    expect(out).not.toContain('Invoices and payment methods');
    // It is in the header: it precedes the pane's first content block.
    expect(out.indexOf('Manage billing')).toBeLessThan(out.indexOf('account-overview'));
  });

  // Behaviour change, called out in the file's header comment: showTeamCheckout
  // is true for every account without an active subscription, so hiding the
  // whole pane behind it hid a free user's own balance from them.
  test('the team-checkout branch keeps the balance card and adds the upgrade card under it', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        showTeamCheckout
        billingEnabled
        accountOverviewSlot={<div>account-overview</div>}
      />,
    );
    expect(headings(out)).toEqual(['Billing', 'Kortix Team']);
    expect(out).toContain('account-overview');
    expect(out.indexOf('account-overview')).toBeLessThan(out.indexOf('Kortix Team'));
  });

  test('the team-checkout card carries the Subscribe action, and the header still carries the portal', () => {
    const out = renderToStaticMarkup(<BillingTabView showTeamCheckout />);
    expect(out).toContain('Subscribe to Team');
    expect(out).toContain('Manage billing');
  });

  test('loading renders the pane heading and skeletons only, no section headings', () => {
    const out = renderToStaticMarkup(
      <BillingTabView isLoading accountOverviewSlot={<div>x</div>} />,
    );
    expect(headings(out)).toEqual(['Billing']);
    expect(out).not.toContain('account-overview');
  });

  test('an error renders the pane heading and a banner with the message, no section headings', () => {
    const out = renderToStaticMarkup(
      <BillingTabView error="Failed to load subscription data" accountOverviewSlot={<div>x</div>} />,
    );
    expect(headings(out)).toEqual(['Billing']);
    expect(out).toContain('Failed to load subscription data');
    expect(out).toContain('role="alert"');
  });

  test('the credits-ran-out banner renders above the balance card when flagged', () => {
    const out = renderToStaticMarkup(
      <BillingTabView showCreditsRanOutBanner accountOverviewSlot={<div>account-overview</div>} />,
    );
    const bannerIndex = out.indexOf('You ran out of credits');
    const overviewIndex = out.indexOf('account-overview');
    expect(bannerIndex).toBeGreaterThan(-1);
    expect(overviewIndex).toBeGreaterThan(-1);
    expect(bannerIndex).toBeLessThan(overviewIndex);
  });

  test('the credits-ran-out banner is absent by default', () => {
    const out = renderToStaticMarkup(<BillingTabView accountOverviewSlot={<div>x</div>} />);
    expect(out).not.toContain('You ran out of credits');
  });

  test('the credits card is absent without canPurchaseCredits', () => {
    const out = renderToStaticMarkup(
      <BillingTabView
        billingEnabled
        accountOverviewSlot={<div>x</div>}
        autoTopupSlot={<div>auto-topup</div>}
        creditTopupSlot={<div>credit-topup</div>}
      />,
    );
    expect(headings(out)).not.toContain('Add credits');
    expect(out).not.toContain('auto-topup');
    expect(out).not.toContain('credit-topup');
  });

  test('the portal action is entirely absent when billing is disabled — no broken Stripe control on self-host', () => {
    const out = renderToStaticMarkup(
      <BillingTabView billingEnabled={false} accountOverviewSlot={<div>x</div>} />,
    );
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
    // Mutating controls disappear.
    expect(headings(out)).not.toContain('Add credits');
    expect(out).not.toContain('auto-topup');
    expect(out).not.toContain('credit-topup');
    expect(out).not.toContain('Manage billing');
    // Said once, at the foot of the pane.
    expect(out).toContain('Only account owners can manage billing.');
    expect(out.match(/Only account owners can manage billing\./g)).toHaveLength(1);
  });

  test('billing.write renders every mutating control — add credits, auto top-up, and the portal action', () => {
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
    expect(headings(out)).toEqual(['Billing', 'Add credits']);
    expect(out).toContain('auto-topup');
    expect(out).toContain('credit-topup');
    expect(out).toContain('>Manage billing<');
    expect(out).not.toContain('Only account owners can manage billing.');
  });

  test('team-checkout: without billing.write the upgrade card is replaced by the owner-only note', () => {
    const out = renderToStaticMarkup(<BillingTabView showTeamCheckout canManageBilling={false} />);
    expect(out).not.toContain('Subscribe to Team');
    expect(out).not.toContain('Manage billing');
    expect(out).toContain('Only account owners can manage billing.');
  });
});
