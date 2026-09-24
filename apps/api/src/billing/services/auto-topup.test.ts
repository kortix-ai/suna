import { beforeEach, describe, expect, mock, test } from 'bun:test';

let account: Record<string, unknown> | null = null;
let customer: { id: string } | null = { id: 'cus_test' };
let stripeCustomer: Record<string, unknown> = {};
let listedPaymentMethods: Array<{ id: string; type: string }> = [];
let listedPaymentMethodParams: Record<string, unknown> | null = null;
const updates: Array<Record<string, unknown>> = [];
const paymentIntents: Array<Record<string, unknown>> = [];
const grants: unknown[][] = [];
let nextIntentStatus = 'succeeded';
let existingIntents: Array<Record<string, unknown>> = [];
let listIntentsFails = false;
const intentUpdates: Array<{ id: string; params: Record<string, unknown> }> = [];

mock.module('../../config', () => ({
  config: new Proxy(
    {},
    {
      get: (target: Record<PropertyKey, unknown>, key) => {
        if (key === 'KORTIX_BILLING_INTERNAL_ENABLED') return true;
        return target[key];
      },
    },
  ),
}));

mock.module('../repositories/credit-accounts', () => ({
  getCreditAccount: async () => account,
  updateCreditAccount: async (_accountId: string, update: Record<string, unknown>) => {
    updates.push(update);
  },
}));

mock.module('../repositories/customers', () => ({
  getCustomerByAccountId: async () => customer,
}));

mock.module('./credits', () => ({
  grantCredits: async (...args: unknown[]) => {
    grants.push(args);
  },
}));

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    customers: { retrieve: async () => stripeCustomer },
    paymentMethods: {
      list: async (params: Record<string, unknown>) => {
        listedPaymentMethodParams = params;
        // Honour Stripe's `type` filter so a card-only query genuinely hides a
        // Link method — without this the test would pass against the old,
        // card-filtered implementation and lock in nothing.
        const type = typeof params.type === 'string' ? params.type : null;
        return {
          data: type ? listedPaymentMethods.filter((pm) => pm.type === type) : listedPaymentMethods,
        };
      },
    },
    paymentIntents: {
      create: async (params: Record<string, unknown>) => {
        paymentIntents.push(params);
        return { id: 'pi_test', status: nextIntentStatus };
      },
      list: async () => {
        if (listIntentsFails) throw new Error('stripe list unavailable');
        return { data: existingIntents };
      },
      update: async (id: string, params: Record<string, unknown>) => {
        intentUpdates.push({ id, params });
        return { id };
      },
    },
  }),
}));

const { checkAndTriggerAutoTopup, getAutoTopupSetupStatus, NO_PAYMENT_METHOD_REASON } =
  await import('./auto-topup');

function creditAccount(overrides: Record<string, unknown> = {}) {
  return {
    accountId: 'acct-1',
    tier: 'per_seat',
    balance: '0.01',
    autoTopupEnabled: true,
    autoTopupThreshold: '5',
    autoTopupAmount: '20',
    autoTopupConsecutiveFailures: 0,
    autoTopupLastCharged: null,
    ...overrides,
  };
}

beforeEach(() => {
  account = creditAccount();
  customer = { id: 'cus_test' };
  stripeCustomer = {
    invoice_settings: { default_payment_method: null },
    subscriptions: { data: [] },
  };
  listedPaymentMethods = [];
  listedPaymentMethodParams = null;
  updates.length = 0;
  paymentIntents.length = 0;
  grants.length = 0;
  nextIntentStatus = 'succeeded';
  existingIntents = [];
  listIntentsFails = false;
  intentUpdates.length = 0;
});

describe('auto-topup payment-method discovery — non-card checkouts', () => {
  test('a Stripe Link customer (no card, no customer-level default) is charged on the subscription default', async () => {
    stripeCustomer = {
      invoice_settings: { default_payment_method: null },
      subscriptions: { data: [{ status: 'active', default_payment_method: 'pm_link' }] },
    };
    listedPaymentMethods = [{ id: 'pm_link', type: 'link' }];

    await checkAndTriggerAutoTopup('acct-1');

    expect(paymentIntents).toHaveLength(1);
    expect(paymentIntents[0]?.payment_method).toBe('pm_link');
  });

  test('the payment-method list is NOT filtered to cards', async () => {
    await checkAndTriggerAutoTopup('acct-1');
    expect(listedPaymentMethodParams).not.toBeNull();
    expect(listedPaymentMethodParams).not.toHaveProperty('type');
  });

  test('a cancelled subscription’s payment method is not used', async () => {
    stripeCustomer = {
      invoice_settings: { default_payment_method: null },
      subscriptions: { data: [{ status: 'canceled', default_payment_method: 'pm_dead' }] },
    };
    listedPaymentMethods = [];

    await checkAndTriggerAutoTopup('acct-1');
    expect(paymentIntents).toHaveLength(0);
  });

  test('setup status reports a Link-only customer as having a payment method', async () => {
    stripeCustomer = {
      invoice_settings: { default_payment_method: null },
      subscriptions: { data: [{ status: 'active', default_payment_method: 'pm_link' }] },
    };
    listedPaymentMethods = [{ id: 'pm_link', type: 'link' }];

    const status = await getAutoTopupSetupStatus('acct-1');
    expect(status.has_payment_method).toBe(true);
    expect(status.payment_method_source).toBe('subscription_default');
  });
});

describe('auto-topup with no payment method — the skip must be observable', () => {
  test('a skip records a failure + reason instead of returning silently', async () => {
    stripeCustomer = {
      invoice_settings: { default_payment_method: null },
      subscriptions: { data: [] },
    };
    listedPaymentMethods = [];

    await checkAndTriggerAutoTopup('acct-1');

    expect(paymentIntents).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.autoTopupDisabledReason).toBe(NO_PAYMENT_METHOD_REASON);
    expect(updates[0]?.autoTopupConsecutiveFailures).toBe(1);
    expect(updates[0]?.autoTopupLastCharged).toBeString();
  });

  test('repeated skips eventually disable auto-topup rather than retrying forever', async () => {
    account = creditAccount({ autoTopupConsecutiveFailures: 2 });
    stripeCustomer = {
      invoice_settings: { default_payment_method: null },
      subscriptions: { data: [] },
    };

    await checkAndTriggerAutoTopup('acct-1');

    expect(updates[0]?.autoTopupEnabled).toBe(false);
    expect(updates[0]?.autoTopupDisabledReason).toBe(NO_PAYMENT_METHOD_REASON);
  });
});

describe('auto-topup on an asynchronous payment method', () => {
  beforeEach(() => {
    stripeCustomer = {
      invoice_settings: { default_payment_method: 'pm_bank' },
      subscriptions: { data: [] },
    };
    listedPaymentMethods = [{ id: 'pm_bank', type: 'us_bank_account' }];
  });

  test('a succeeded charge grants the amount keyed on the PaymentIntent id', async () => {
    await checkAndTriggerAutoTopup('acct-1');

    expect(grants).toHaveLength(1);
    expect(grants[0]?.[1]).toBe(20);
    expect(grants[0]?.[5]).toBe('pi_test');
  });

  test('a processing charge is pending, not a failure: no grant, no failure count, auto-topup stays on', async () => {
    nextIntentStatus = 'processing';

    await checkAndTriggerAutoTopup('acct-1');

    expect(paymentIntents).toHaveLength(1);
    expect(grants).toHaveLength(0);
    expect(updates).toHaveLength(1);
    expect(updates[0]?.autoTopupLastCharged).toBeString();
    expect(updates[0]).not.toHaveProperty('autoTopupConsecutiveFailures');
    expect(updates[0]).not.toHaveProperty('autoTopupEnabled');
    expect(updates[0]).not.toHaveProperty('autoTopupDisabledReason');
    // Tagged so a later payment_intent.payment_failed counts as this attempt's failure.
    expect(intentUpdates).toEqual([{ id: 'pi_test', params: { metadata: { async_settlement: 'true' } } }]);
  });

  test('an auto-topup that is still processing blocks a second charge', async () => {
    existingIntents = [
      { id: 'pi_earlier', status: 'processing', metadata: { type: 'auto_topup', account_id: 'acct-1' } },
    ];

    await checkAndTriggerAutoTopup('acct-1');

    expect(paymentIntents).toHaveLength(0);
    expect(grants).toHaveLength(0);
  });

  test('a processing payment of another kind does not block the auto-topup', async () => {
    existingIntents = [{ id: 'pi_invoice', status: 'processing', metadata: {} }];

    await checkAndTriggerAutoTopup('acct-1');

    expect(paymentIntents).toHaveLength(1);
  });

  test('when pending payments cannot be listed, the trigger charges nothing', async () => {
    listIntentsFails = true;

    await checkAndTriggerAutoTopup('acct-1');

    expect(paymentIntents).toHaveLength(0);
  });
});
