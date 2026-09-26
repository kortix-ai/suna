import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createMockCreditAccount,
  createMockRevenueCatEvent,
  mockRegistry,
  registerWalletMock,
  fakeWallet,
  registerGlobalMocks,
  resetMockRegistry,
} from './billing/mocks';

registerGlobalMocks();
registerWalletMock();

const walletGrants = fakeWallet.calls.grant;
let upsertCreditAccountCalls: any[] = [];

beforeEach(() => {
  walletGrants.length = 0;
  upsertCreditAccountCalls = [];
  resetMockRegistry();

  mockRegistry.getCreditAccount = async () => createMockCreditAccount({ stripeSubscriptionId: null });
  mockRegistry.upsertCreditAccount = async (id: string, data: any) => {
    upsertCreditAccountCalls.push({ accountId: id, data });
  };
  mockRegistry.resolveAccountId = async (userId: string) => `${userId}_account`;
  mockRegistry.stripeClient = {
    subscriptions: {
      cancel: async () => ({}),
    },
  };
});

const { processRevenueCatWebhook } = await import('../billing/services/webhooks');

describe('processRevenueCatWebhook canonical account writes', () => {
  test('writes initial purchase into canonical kortix account', async () => {
    const result = await processRevenueCatWebhook(createMockRevenueCatEvent('INITIAL_PURCHASE', {
      app_user_id: 'legacy_user_123',
      product_id: 'kortix_plus_monthly',
      subscriber_id: 'rc_customer_123',
      original_transaction_id: 'rc_txn_123',
    }));

    expect(upsertCreditAccountCalls.length).toBe(1);
    expect(upsertCreditAccountCalls[0].accountId).toBe('legacy_user_123_account');
    expect(upsertCreditAccountCalls[0].data.provider).toBe('revenuecat');
    expect(upsertCreditAccountCalls[0].data.paymentStatus).toBe('active');
    expect(upsertCreditAccountCalls[0].data.revenuecatCustomerId).toBe('rc_customer_123');
    expect(upsertCreditAccountCalls[0].data.revenuecatSubscriptionId).toBe('rc_txn_123');
    expect(walletGrants[0].accountId).toBe('legacy_user_123_account');
    expect((result as any).account_id).toBe('legacy_user_123_account');
  });
});
