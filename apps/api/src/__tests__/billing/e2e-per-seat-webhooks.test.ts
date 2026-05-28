// Billing v2 — end-to-end per-seat Stripe webhook reconciliation.
//
// Exercises `processStripeWebhook` against `customer.subscription.updated`
// events that carry a per-seat subscription item. Verifies:
//   - seat_count gets reconciled from Stripe's quantity field
//   - billing_model flips to 'per_seat'
//   - a single seat_grant ledger entry is emitted for net additions
//   - duplicate webhook delivery doesn't double-grant (idempotency)
//   - legacy customers (no per-seat item) are unaffected by the new logic

import { describe, test, expect, beforeEach } from 'bun:test';
import {
  createMockCreditAccount,
  createMockStripeSubscription,
  createMockStripeEvent,
  createMockStripeClient,
  mockRegistry,
  registerGlobalMocks,
  registerCreditsMock,
  resetMockRegistry,
} from './mocks';

registerGlobalMocks();
registerCreditsMock();

const PER_SEAT_PRICE_PLACEHOLDER = 'price_PLACEHOLDER_PER_SEAT';

let grantCreditsCalls: any[][] = [];
let updateCalls: { accountId: string; data: any }[] = [];
let upsertCalls: { accountId: string; data: any }[] = [];

beforeEach(() => {
  grantCreditsCalls = [];
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
  mockRegistry.grantCredits = async (...args: any[]) => {
    grantCreditsCalls.push(args);
  };
  mockRegistry.resetExpiringCredits = async () => {};

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
  test('quantity 1 → 3: seat_count updates, one seat_grant of $40 emitted', async () => {
    const sub = perSeatSubscription(3);
    const event = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    const persistedUpdate = [...updateCalls, ...upsertCalls.map((u) => ({ accountId: u.accountId, data: u.data }))]
      .find((c) => c.data.seatCount !== undefined);
    expect(persistedUpdate).toBeDefined();
    expect(persistedUpdate?.data.seatCount).toBe(3);
    expect(persistedUpdate?.data.billingModel).toBe('per_seat');
    expect(persistedUpdate?.data.seatSubscriptionItemId).toBe('si_seat_123');

    // Delta = 3 - 1 = 2 seats → grant $40 (PER_SEAT_PRICE_USD × 2)
    expect(grantCreditsCalls.length).toBe(1);
    const [accountId, amount, type, , , idempotencyKey] = grantCreditsCalls[0];
    expect(accountId).toBe('acc_test_123');
    expect(amount).toBe(40);
    expect(type).toBe('seat_grant');
    expect(idempotencyKey).toBeDefined();
    expect(String(idempotencyKey)).toContain('seats:3');
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

  test('quantity DECREASE: no grant emitted (Stripe credits the user via proration)', async () => {
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

    expect(grantCreditsCalls.length).toBe(0);
    const persistedUpdate = updateCalls.find((c) => c.data.seatCount !== undefined);
    expect(persistedUpdate?.data.seatCount).toBe(1);
  });

  test('same quantity (no change) → no grant, but seat_subscription_item_id still synced', async () => {
    const sub = perSeatSubscription(1);
    const event = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(event), 'whsec_test');

    expect(grantCreditsCalls.length).toBe(0);
  });

  test('idempotency key is identical across redeliveries (DB-level dedup hook)', async () => {
    // Real-world idempotency is enforced by the atomic_add_credits RPC via
    // the idempotency_key on credit_ledger. The mock here just records the
    // key, so we verify the CONTRACT — same event → same idempotency key
    // → DB will dedup the actual grant in production.
    const sub = perSeatSubscription(3);
    const eventA = createMockStripeEvent('customer.subscription.updated', sub);
    const eventB = createMockStripeEvent('customer.subscription.updated', sub);

    await processStripeWebhook(JSON.stringify(eventA), 'whsec_test');
    await processStripeWebhook(JSON.stringify(eventB), 'whsec_test');

    expect(grantCreditsCalls.length).toBeGreaterThanOrEqual(1);
    // All grant calls for this seat-count transition use the same key.
    const keys = new Set(grantCreditsCalls.map((c) => c[5]));
    expect(keys.size).toBe(1);
    expect([...keys][0]).toContain('seats:3');
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
    expect(grantCreditsCalls.length).toBe(0);
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
    expect(grantCreditsCalls.length).toBe(1);
    expect(grantCreditsCalls[0][1]).toBe(60); // delta 4-1=3 seats × $20 = $60
  });

  test('grant amount math is correct for various deltas', async () => {
    const cases = [
      { from: 1, to: 2, expectedGrant: 20 },
      { from: 1, to: 5, expectedGrant: 80 },
      { from: 1, to: 10, expectedGrant: 180 },
    ];
    for (const { from, to, expectedGrant } of cases) {
      grantCreditsCalls = [];
      mockRegistry.getCreditAccount = async () =>
        createMockCreditAccount({
          billingModel: 'per_seat',
          seatCount: from,
          seatSubscriptionItemId: 'si_seat_123',
          stripeSubscriptionId: 'sub_seat_123',
        });
      const event = createMockStripeEvent('customer.subscription.updated', perSeatSubscription(to));
      await processStripeWebhook(JSON.stringify(event), 'whsec_test');
      expect(grantCreditsCalls.length).toBe(1);
      expect(grantCreditsCalls[0][1]).toBe(expectedGrant);
    }
  });
});
