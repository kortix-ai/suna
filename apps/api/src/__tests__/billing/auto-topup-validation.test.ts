import { beforeEach, describe, expect, test } from 'bun:test';
import {
  createMockCreditAccount,
  createMockStripeClient,
  mockRegistry,
  registerGlobalMocks,
  resetMockRegistry,
} from './mocks';

registerGlobalMocks();

const { configureAutoTopup } = await import('../../billing/services/auto-topup');

let updates: Array<{ accountId: string; data: Record<string, unknown> }> = [];

beforeEach(() => {
  updates = [];
  resetMockRegistry();
  mockRegistry.getCreditAccount = async () =>
    createMockCreditAccount({ tier: 'tier_6_50', billingModel: 'per_seat' });
  mockRegistry.updateCreditAccount = async (accountId, data) => {
    updates.push({ accountId, data });
  };
  mockRegistry.stripeClient = createMockStripeClient({
    customersRetrieve: async (id: string) => ({
      id,
      invoice_settings: { default_payment_method: 'pm_default' },
      deleted: false,
    }),
    paymentMethodsList: async () => ({ data: [{ id: 'pm_default' }] }),
  });
});

describe('configureAutoTopup — guards against spam-vector configurations', () => {
  test('disabled config is always valid', async () => {
    await expect(
      configureAutoTopup('acc_test_123', { enabled: false, threshold: 0, amount: 0 }),
    ).resolves.toEqual({ success: true });
    expect(updates[0]?.data).toMatchObject({
      autoTopupEnabled: false,
      autoTopupThreshold: '0',
      autoTopupAmount: '0',
    });
  });

  test('threshold below minimum is rejected', async () => {
    await expect(
      configureAutoTopup('acc_test_123', { enabled: true, threshold: 0.5, amount: 20 }),
    ).rejects.toThrow('Threshold must be at least');
    expect(updates).toHaveLength(0);
  });

  test('amount below minimum is rejected', async () => {
    await expect(
      configureAutoTopup('acc_test_123', { enabled: true, threshold: 5, amount: 0.5 }),
    ).rejects.toThrow('Reload amount must be at least $1');
    expect(updates).toHaveLength(0);
  });

  test('amount equal to threshold is REJECTED (would loop forever)', async () => {
    // Without the buffer, $5 topup at $5 threshold means every subsequent
    // debit triggers another charge — the email-spam scenario the user
    // wanted to prevent.
    await expect(
      configureAutoTopup('acc_test_123', { enabled: true, threshold: 5, amount: 5 }),
    ).rejects.toThrow('above the threshold');
    expect(updates).toHaveLength(0);
  });

  test('amount slightly below threshold is REJECTED', async () => {
    await expect(
      configureAutoTopup('acc_test_123', { enabled: true, threshold: 10, amount: 9 }),
    ).rejects.toThrow('above the threshold');
    expect(updates).toHaveLength(0);
  });

  test('amount = threshold + buffer is accepted', async () => {
    await expect(
      configureAutoTopup('acc_test_123', { enabled: true, threshold: 5, amount: 6 }),
    ).resolves.toEqual({ success: true });
    expect(updates[0]?.data).toMatchObject({
      autoTopupEnabled: true,
      autoTopupThreshold: '5',
      autoTopupAmount: '6',
    });
  });

  test('amount well above threshold is accepted', async () => {
    await expect(
      configureAutoTopup('acc_test_123', { enabled: true, threshold: 5, amount: 20 }),
    ).resolves.toEqual({ success: true });
    await expect(
      configureAutoTopup('acc_test_123', { enabled: true, threshold: 1, amount: 5 }),
    ).resolves.toEqual({ success: true });
  });
});
