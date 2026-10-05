import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type Stripe from 'stripe';
import { AUTO_TOPUP_DEFAULT_AMOUNT, AUTO_TOPUP_DEFAULT_THRESHOLD } from '@kortix/shared';
import type { GrantInput } from '../wallet';

let account: Record<string, unknown> | null = null;
let customer: { id: string } | null = { id: 'cus_test' };
let stripeCustomer: Record<string, unknown> = {};
let listedPaymentMethods: Array<{ id: string; type: string }> = [];
const updates: Array<Record<string, unknown>> = [];
const paymentIntents: Array<Record<string, unknown>> = [];
const grants: GrantInput[] = [];
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

mock.module('../wallet', () => ({
  wallet: {
    grant: async (input: GrantInput) => {
      grants.push(input);
      return { replayed: false, ledgerId: null };
    },
  },
}));

mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    customers: { retrieve: async () => stripeCustomer },
    paymentMethods: {
      list: async (params: Record<string, unknown>) => {
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

const {
  checkAndTriggerAutoTopup,
  getAutoTopupSetupStatus,
  NO_PAYMENT_METHOD_REASON,
  settleAutoTopupPaymentIntent,
  validateAutoTopupConfig,
} = await import('./auto-topup');

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

  test('an attached non-card method is charged when no default exists anywhere', async () => {
    listedPaymentMethods = [{ id: 'pm_link', type: 'link' }];

    await checkAndTriggerAutoTopup('acct-1');

    expect(paymentIntents).toHaveLength(1);
    expect(paymentIntents[0]?.payment_method).toBe('pm_link');
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
    expect(grants[0]?.amount).toBe(20);
    expect(grants[0]?.key).toEqual({ event: 'pi_test' });
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

describe('validateAutoTopupConfig — guards against spam-vector configurations', () => {
  test.each([
    ['a disabled config is always valid', { enabled: false, threshold: 0, amount: 0 }, null],
    ['a threshold below the minimum', { enabled: true, threshold: 0.5, amount: 20 }, 'Threshold must be at least'],
    ['an amount below the minimum', { enabled: true, threshold: 5, amount: 0.5 }, 'Reload amount must be at least $1'],
    // Without the buffer, a $5 topup at a $5 threshold means every subsequent
    // debit triggers another charge — the email-spam scenario.
    ['an amount equal to the threshold', { enabled: true, threshold: 5, amount: 5 }, 'above the threshold'],
    ['an amount below the threshold', { enabled: true, threshold: 10, amount: 9 }, 'above the threshold'],
    ['an amount one buffer above the threshold', { enabled: true, threshold: 5, amount: 6 }, null],
    [
      'the product defaults the webhooks write',
      { enabled: true, threshold: AUTO_TOPUP_DEFAULT_THRESHOLD, amount: AUTO_TOPUP_DEFAULT_AMOUNT },
      null,
    ],
  ])('%s', (_name, config, error) => {
    const result = validateAutoTopupConfig(config);
    if (error === null) expect(result).toBeNull();
    else expect(result).toContain(error);
  });
});

describe('settleAutoTopupPaymentIntent — the payment_intent webhook outcome', () => {
  function intent(overrides: Record<string, unknown> = {}) {
    return {
      id: 'pi_topup_1',
      object: 'payment_intent',
      status: 'succeeded',
      amount: 2000,
      amount_received: 2000,
      metadata: { account_id: 'acct-1', type: 'auto_topup', amount: '20' },
      last_payment_error: null,
      ...overrides,
    } as unknown as Stripe.PaymentIntent;
  }

  test('a PaymentIntent that is not an auto-topup is ignored', async () => {
    await settleAutoTopupPaymentIntent(intent({ metadata: { account_id: 'acct-1' } }));
    expect(grants).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });

  test('a failure after processing counts one failure and grants nothing', async () => {
    await settleAutoTopupPaymentIntent(
      intent({
        status: 'requires_payment_method',
        metadata: { account_id: 'acct-1', type: 'auto_topup', amount: '20', async_settlement: 'true' },
        last_payment_error: { code: 'payment_intent_payment_attempt_failed' },
      }),
    );
    expect(grants).toHaveLength(0);
    expect(updates.map((update) => update.autoTopupConsecutiveFailures)).toEqual([1]);
  });

  test('a synchronous decline is not counted a second time by its payment_failed webhook', async () => {
    await settleAutoTopupPaymentIntent(
      intent({ status: 'requires_payment_method', last_payment_error: { code: 'processing_error' } }),
    );
    expect(grants).toHaveLength(0);
    expect(updates).toHaveLength(0);
  });
});
