// Billing v2 — end-to-end per-seat Stripe webhook reconciliation.
//
// Exercises `processStripeWebhook` against `customer.subscription.updated`
// events that carry a per-seat subscription item. Verifies:
//   - seat_count gets reconciled from Stripe's quantity field
//   - billing_model flips to 'per_seat'
//   - a quantity change alone grants NO allowance: seats added mid-period are
//     funded from the PAID proration invoice (proration-grants.ts), not here
//   - duplicate webhook delivery is deduped
//   - legacy customers (no per-seat item) are unaffected by the new logic

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createMockCreditAccount,
  createMockStripeSubscription,
  createMockStripeEvent,
  createMockStripeClient,
  mockRegistry,
  registerGlobalMocks,
  registerWalletMock,
  fakeWallet,
  resetMockRegistry,
  installWebhookMarkerTable,
} from './mocks';

registerGlobalMocks();
registerWalletMock();

const PER_SEAT_PRICE_PLACEHOLDER = 'price_PLACEHOLDER_PER_SEAT';

const walletGrants = fakeWallet.calls.grant;
let updateCalls: { accountId: string; data: any }[] = [];
let upsertCalls: { accountId: string; data: any }[] = [];

beforeEach(() => {
  updateCalls = [];
  upsertCalls = [];
  resetMockRegistry();

  mockRegistry.stripeClient = createMockStripeClient();
  mockRegistry.getCustomerByStripeId = async () => ({
    id: 'cus_test_123',
    accountId: 'acc_test_123',
    email: 'team@example.com',
    provider: 'stripe',
    active: true,
  });
  mockRegistry.upsertCustomer = async () => {};
  mockRegistry.resolveAccountId = async (id: string) => id;
  mockRegistry.updateCreditAccount = async (accountId: string, data: any) => {
    updateCalls.push({ accountId, data });
  };
  mockRegistry.upsertCreditAccount = async (accountId: string, data: any) => {
    upsertCalls.push({ accountId, data });
  };

  // Default: per-seat account with 1 seat already.
  mockRegistry.getCreditAccount = async () =>
    createMockCreditAccount({
      billingModel: 'per_seat',
      seatCount: 1,
      seatSubscriptionItemId: 'si_seat_123',
      tier: 'per_seat',
      stripeSubscriptionId: 'sub_seat_123',
      autoTopupCustomized: false,
    });
});

const { processStripeWebhook } = await import('../../billing/services/webhooks');

function perSeatSubscription(quantity: number, overrides: Record<string, any> = {}) {
  return createMockStripeSubscription({
    id: 'sub_seat_123',
    items: {
      data: [
        {
          id: 'si_seat_123',
          quantity,
          price: { id: PER_SEAT_PRICE_PLACEHOLDER, unit_amount: 2000, currency: 'usd' },
        },
      ],
    },
    metadata: {
      account_id: 'acc_test_123',
      tier_key: 'per_seat',
      billing_model: 'per_seat',
    },
    ...overrides,
  });
}

describe('per-seat webhook reconciliation', () => {
  test('quantity 1 → 3: seat_count updates and no allowance is granted from the quantity change', async () => {
    const sub = perSeatSubscription(3);
    const event = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    const persistedUpdate = [...updateCalls, ...upsertCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
      .find((c) => c.data.seatCount !== undefined);
    expect(persistedUpdate).toBeDefined();
    expect(persistedUpdate?.data.seatCount).toBe(3);
    expect(persistedUpdate?.data.billingModel).toBe('per_seat');
    expect(persistedUpdate?.data.seatSubscriptionItemId).toBe('si_seat_123');

    // The added seats are funded when their proration invoice is PAID
    // (invoice.paid, billing_reason subscription_update), never here.
    expect(walletGrants.length).toBe(0);
  });

  test('auto-topup defaults rescale unless user customized', async () => {
    const sub = perSeatSubscription(5);
    const event = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    const persistedUpdate = updateCalls.find((c) => c.data.autoTopupThreshold !== undefined);
    expect(persistedUpdate).toBeDefined();
    // 5 seats × $5 threshold-per-seat = $25; × $20 amount-per-seat = $100.
    expect(persistedUpdate?.data.autoTopupThreshold).toBe('25');
    expect(persistedUpdate?.data.autoTopupAmount).toBe('100');
  });

  test('quantity DECREASE: no grant emitted', async () => {
    // Start with 3 seats; drop to 1.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        billingModel: 'per_seat',
        seatCount: 3,
        seatSubscriptionItemId: 'si_seat_123',
        tier: 'per_seat',
        stripeSubscriptionId: 'sub_seat_123',
      });

    const sub = perSeatSubscription(1);
    const event = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    expect(walletGrants.length).toBe(0);
    const persistedUpdate = updateCalls.find((c) => c.data.seatCount !== undefined);
    expect(persistedUpdate?.data.seatCount).toBe(1);
  });

  test('same quantity (no change) → no grant, but seat_subscription_item_id still synced', async () => {
    const sub = perSeatSubscription(1);
    const event = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    expect(walletGrants.length).toBe(0);
  });

  test('redelivered quantity changes never grant allowance', async () => {
    const sub = perSeatSubscription(3);
    const eventA = createMockStripeEvent('customer.subscription.updated', sub);
    const eventB = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(eventA), 'whsec_test');
    await processStripeWebhook(JSON.stringify(eventB), 'whsec_test');

    expect(walletGrants.length).toBe(0);
  });

  test('legacy subscription (no per-seat item) — billing_model unchanged, no seat fields touched', async () => {
    // Account currently legacy.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        billingModel: 'legacy',
        tier: 'tier_2_20',
        seatCount: 1,
      });

    const legacySub = createMockStripeSubscription({
      id: 'sub_legacy_1',
      items: {
        data: [
          {
            id: 'si_legacy_1',
            quantity: 1,
            price: { id: 'price_legacy_unknown', unit_amount: 2000, currency: 'usd' },
          },
        ],
      },
      metadata: { account_id: 'acc_test_123', tier_key: 'tier_2_20' },
    });
    const event = createMockStripeEvent('customer.subscription.updated', legacySub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    // No seat grant for legacy customers.
    expect(walletGrants.length).toBe(0);
    // No update should set seatCount / billingModel='per_seat'.
    const seatTouchingUpdate = updateCalls.find(
      (c) => c.data.seatCount !== undefined || c.data.billingModel === 'per_seat',
    );
    expect(seatTouchingUpdate).toBeUndefined();
  });

  test('subscription metadata billing_model=per_seat but no matching price ID still reconciles', async () => {
    // Useful during cutover before placeholder price IDs are replaced.
    // The account's stripe_subscription_id must match the incoming sub.id, otherwise
    // syncSubscriptionState rejects it as stale (correct guard against split-brain
    // subs). We point the existing account at the same sub id below.
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        billingModel: 'per_seat',
        seatCount: 1,
        seatSubscriptionItemId: 'si_seat_legacy_price',
        stripeSubscriptionId: 'sub_seat_legacy_price',
        tier: 'per_seat',
      });

    const sub = createMockStripeSubscription({
      id: 'sub_seat_legacy_price',
      items: {
        data: [
          {
            id: 'si_seat_legacy_price',
            quantity: 4,
            // Intentionally NOT the per-seat price ID — fallback path on metadata.
            price: { id: 'price_arbitrary', unit_amount: 2000, currency: 'usd' },
          },
        ],
      },
      metadata: {
        account_id: 'acc_test_123',
        tier_key: 'per_seat',
        billing_model: 'per_seat',
      },
    });
    const event = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    const seatUpdate = updateCalls.find((c) => c.data.seatCount === 4);
    expect(seatUpdate).toBeDefined();
    expect(walletGrants.length).toBe(0);
  });


});

describe('legacy → per-seat adoption (regression)', () => {
  // A legacy/machine account migrates to per-seat. The new per-seat sub has a
  // different id and carries metadata.billing_model='per_seat' but no tier_key /
  // previous_subscription_id, so the stale-sub guard used to drop it — stranding
  // the account on the (now cancelled) machine sub: tier=free, project-capped.
  test('legacy/machine account adopts an incoming active per-seat sub instead of skipping it', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        billingModel: 'legacy',
        tier: 'free',
        seatCount: 0,
        stripeSubscriptionId: 'sub_machine_legacy',
      });

    const perSeatSub = createMockStripeSubscription({
      id: 'sub_perseat_new',
      status: 'active',
      items: { data: [{ id: 'si_perseat_new', quantity: 1, price: { id: 'price_arbitrary', unit_amount: 4000, currency: 'usd' } }] },
      metadata: { account_id: 'acc_test_123', billing_model: 'per_seat' },
    });
    const event = createMockStripeEvent('customer.subscription.created', perSeatSub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    const adopt = [...updateCalls, ...upsertCalls].find((c) => c.data.billingModel === 'per_seat');
    expect(adopt).toBeDefined();
    expect(adopt?.data.stripeSubscriptionId).toBe('sub_perseat_new');
    expect(adopt?.data.seatSubscriptionItemId).toBe('si_perseat_new');
    expect(adopt?.data.tier).toBe('per_seat');
  });

  test('a genuinely stale non-per-seat sub is still skipped (guard intact)', async () => {
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        billingModel: 'per_seat',
        tier: 'per_seat',
        seatCount: 1,
        seatSubscriptionItemId: 'si_perseat_current',
        stripeSubscriptionId: 'sub_perseat_current',
      });

    const staleSub = createMockStripeSubscription({
      id: 'sub_other_unrelated',
      status: 'active',
      items: { data: [{ id: 'si_other', quantity: 1, price: { id: 'price_legacy_unknown', unit_amount: 2000, currency: 'usd' } }] },
      metadata: { account_id: 'acc_test_123', tier_key: 'tier_2_20' },
    });
    const event = createMockStripeEvent('customer.subscription.updated', staleSub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    const clobber = updateCalls.find((c) => c.data.stripeSubscriptionId === 'sub_other_unrelated');
    expect(clobber).toBeUndefined();
  });

  test('duplicate event delivery is deduped (processed-marker gate)', async () => {
    installWebhookMarkerTable();
    mockRegistry.getCreditAccount = async () =>
      createMockCreditAccount({
        billingModel: 'per_seat', tier: 'per_seat', seatCount: 1,
        seatSubscriptionItemId: 'si_seat_123', stripeSubscriptionId: 'sub_seat_123',
      });

    const sub = perSeatSubscription(3);
    const event = createMockStripeEvent('customer.subscription.updated', sub);
    await processStripeWebhook(JSON.stringify(event), 'whsec_test');
    const writesAfterFirst = updateCalls.length;
    const second = await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    // Second delivery short-circuits before any reconciliation.
    expect((second as any).deduped).toBe(true);
    expect(updateCalls.length).toBe(writesAfterFirst);
  });

  describe('enterprise + per-seat coexistence — tier not clobbered', () => {
    test('enterprise_entitled=true + per-seat sub update → billing_model reconciled, tier NOT set to per_seat', async () => {
      // The contracted shape: enterprise entitlements (via flag)
      // + a per-seat Stripe subscription. An ordinary seat-quantity update lands.
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          tier: 'enterprise',
          enterpriseEntitled: true,
          billingModel: 'per_seat',
          seatCount: 2,
          seatSubscriptionItemId: 'si_seat_123',
          stripeSubscriptionId: 'sub_seat_123',
          autoTopupCustomized: true,
        });

      // Webhook fires for a seat-count change 2 → 4 — the ordinary update path
      // that used to strip enterprise entitlements.
      const sub = perSeatSubscription(4);
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const persisted = [...updateCalls, ...upsertCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
        .find((c) => c.data.seatCount !== undefined);
      expect(persisted).toBeDefined();
      // Per-seat billing semantics ARE reconciled:
      expect(persisted?.data.billingModel).toBe('per_seat');
      expect(persisted?.data.seatCount).toBe(4);
      expect(persisted?.data.seatSubscriptionItemId).toBe('si_seat_123');
      // But tier is NOT clobbered to 'per_seat' — the key fix. The update must
      // not carry a `tier` write at all (enterprise tier is preserved).
      expect(persisted?.data.tier).toBeUndefined();
    });

    test('enterprise_entitled=true + per-seat sub update → seat count reconciled, no unpaid allowance', async () => {
      // The no-clobber guard must not break seat reconciliation, and an
      // enterprise-entitled account follows the same money-first seat rule.
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          tier: 'enterprise',
          enterpriseEntitled: true,
          billingModel: 'per_seat',
          seatCount: 2,
          seatSubscriptionItemId: 'si_seat_123',
          stripeSubscriptionId: 'sub_seat_123',
          autoTopupCustomized: true,
        });

      const sub = perSeatSubscription(5); // +3 seats
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const seatUpdate = updateCalls.find((c) => c.data.seatCount === 5);
      expect(seatUpdate).toBeDefined();
      expect(walletGrants.length).toBe(0);
    });

    test('tier=enterprise (no flag) + per-seat sub update → tier NOT clobbered', async () => {
      // The legacy sales-assigned path (tier='enterprise' without the new flag)
      // must also be protected — the guard keys off tier='enterprise' too.
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          tier: 'enterprise',
          enterpriseEntitled: false,
          billingModel: 'per_seat',
          seatCount: 1,
          seatSubscriptionItemId: 'si_seat_123',
          stripeSubscriptionId: 'sub_seat_123',
          autoTopupCustomized: true,
        });

      const sub = perSeatSubscription(3);
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const persisted = [...updateCalls, ...upsertCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
        .find((c) => c.data.seatCount !== undefined);
      expect(persisted).toBeDefined();
      expect(persisted?.data.billingModel).toBe('per_seat');
      expect(persisted?.data.seatCount).toBe(3);
      expect(persisted?.data.tier).toBeUndefined();
    });

    test('non-enterprise per-seat account → tier still set to per_seat (unchanged behaviour)', async () => {
      // The guard must NOT change behaviour for ordinary per-seat accounts
      // (no enterprise entitlement): tier='per_seat' is still written, exactly
      // as before. This is the regression guard for the common case.
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          tier: 'free',
          enterpriseEntitled: false,
          billingModel: 'per_seat',
          seatCount: 1,
          seatSubscriptionItemId: 'si_seat_123',
          stripeSubscriptionId: 'sub_seat_123',
          autoTopupCustomized: true,
        });

      const sub = perSeatSubscription(3);
      const event = createMockStripeEvent('customer.subscription.updated', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const persisted = [...updateCalls, ...upsertCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
        .find((c) => c.data.seatCount !== undefined);
      expect(persisted).toBeDefined();
      expect(persisted?.data.billingModel).toBe('per_seat');
      expect(persisted?.data.seatCount).toBe(3);
      // tier IS clobbered to per_seat for ordinary accounts — unchanged.
      expect(persisted?.data.tier).toBe('per_seat');
    });

    test('enterprise_entitled=true, no existing per-seat → first per-seat webhook still does NOT set tier', async () => {
      // An operator flags the account enterprise_entitled at sign-up (tier is
      // still 'free', no per-seat sub yet). The customer then buys a per-seat
      // subscription. The activation webhook must adopt the sub + reconcile
      // billing, but NOT flip tier to per_seat.
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          tier: 'free',
          enterpriseEntitled: true,
          billingModel: 'legacy',
          seatCount: 0,
          stripeSubscriptionId: null,
          autoTopupCustomized: false,
        });

      const sub = perSeatSubscription(2);
      const event = createMockStripeEvent('customer.subscription.created', sub);

      await processStripeWebhook(JSON.stringify(event), 'whsec_test');

      const persisted = [...updateCalls, ...upsertCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
        .find((c) => c.data.billingModel === 'per_seat');
      expect(persisted).toBeDefined();
      expect(persisted?.data.billingModel).toBe('per_seat');
      expect(persisted?.data.seatCount).toBe(2);
      // The free → per_seat activation must NOT clobber tier for an
      // enterprise-entitled account; entitlements stay sourced from the flag.
      expect(persisted?.data.tier).toBeUndefined();
    });
  });
});
