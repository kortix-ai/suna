import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createFakeWallet } from '../../__tests__/helpers/fake-wallet';

const fake = createFakeWallet();
mock.module('../wallet', () => ({ wallet: fake.wallet }));

let paymentIntent: { metadata: Record<string, string> } = { metadata: {} };
let sessions: unknown[] = [];
mock.module('../../shared/stripe', () => ({
  getStripe: () => ({
    paymentIntents: { retrieve: async () => paymentIntent },
    checkout: { sessions: { list: async () => ({ data: sessions }) } },
  }),
}));

const { handleChargeRefunded, handleDisputeClosed, handleDisputeCreated } = await import('./refund-clawback');

const creditPackSession = {
  mode: 'payment',
  metadata: { type: 'credit_purchase', account_id: 'acct-synthetic' },
};

beforeEach(() => {
  fake.restore();
  paymentIntent = { metadata: {} };
  sessions = [];
});

describe('Stripe refund and dispute clawback', () => {
  test('a $500 credit pack refunded in full takes -$500 from the wallet, keyed on the cumulative refund', async () => {
    sessions = [creditPackSession];
    await handleChargeRefunded({ id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 50_000 } as never);
    expect(fake.calls.grant).toHaveLength(1);
    expect(fake.calls.grant[0]).toMatchObject({
      accountId: 'acct-synthetic',
      amount: -500,
      kind: 'admin_debit',
      expiring: false,
      key: { event: 'refund:ch_1:50000' },
    });
  });

  test('a second partial refund takes only the increment (previous_attributes), under its own key', async () => {
    sessions = [creditPackSession];
    await handleChargeRefunded(
      { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 30_000 } as never,
      { amount_refunded: 12_500 },
    );
    expect(fake.calls.grant[0]).toMatchObject({ amount: -175, key: { event: 'refund:ch_1:30000' } });
  });

  test('an auto-topup charge resolves through the PaymentIntent metadata', async () => {
    paymentIntent = { metadata: { type: 'auto_topup', account_id: 'acct-topup' } };
    await handleChargeRefunded({ id: 'ch_2', payment_intent: 'pi_2', amount_refunded: 2_500 } as never);
    expect(fake.calls.grant[0]).toMatchObject({ accountId: 'acct-topup', amount: -25 });
  });

  test('a subscription invoice charge is not clawed back', async () => {
    sessions = [{ mode: 'subscription', metadata: { account_id: 'acct-synthetic' } }];
    await handleChargeRefunded({ id: 'ch_3', payment_intent: 'pi_3', amount_refunded: 5_000 } as never);
    expect(fake.calls.grant).toHaveLength(0);
  });

  test('a charge with no payment_intent or no refund moves no money', async () => {
    await handleChargeRefunded({ id: 'ch_4', payment_intent: null, amount_refunded: 100 } as never);
    await handleChargeRefunded({ id: 'ch_5', payment_intent: 'pi_5', amount_refunded: 0 } as never);
    expect(fake.calls.grant).toHaveLength(0);
  });

  test('a dispute takes the disputed amount; a won dispute gives it back', async () => {
    sessions = [creditPackSession];
    await handleDisputeCreated({ id: 'dp_1', payment_intent: 'pi_1', amount: 10_000 } as never);
    expect(fake.calls.grant[0]).toMatchObject({ amount: -100, key: { event: 'dispute:dp_1' } });

    await handleDisputeClosed({ id: 'dp_1', payment_intent: 'pi_1', amount: 10_000, status: 'won' } as never);
    expect(fake.calls.grant[1]).toMatchObject({ amount: 100, key: { event: 'dispute-won:dp_1' } });

    await handleDisputeClosed({ id: 'dp_2', payment_intent: 'pi_1', amount: 10_000, status: 'lost' } as never);
    expect(fake.calls.grant).toHaveLength(2);
  });
});
