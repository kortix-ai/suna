import { describe, expect, mock, test } from 'bun:test';

let mockEnv: { BILLING_ENABLED: boolean; SINGLE_ACCOUNT_MODE: boolean };

mock.module('@/lib/env-config', () => ({
  getEnv: () => mockEnv,
}));

const { isBillingEnabled, isSingleAccountMode } = await import('./config');

describe('isBillingEnabled', () => {
  test('mirrors the runtime env BILLING_ENABLED flag', () => {
    mockEnv = { BILLING_ENABLED: true, SINGLE_ACCOUNT_MODE: false };
    expect(isBillingEnabled()).toBe(true);
    mockEnv = { BILLING_ENABLED: false, SINGLE_ACCOUNT_MODE: false };
    expect(isBillingEnabled()).toBe(false);
  });
});

describe('isSingleAccountMode', () => {
  test('mirrors the runtime env SINGLE_ACCOUNT_MODE flag', () => {
    mockEnv = { BILLING_ENABLED: false, SINGLE_ACCOUNT_MODE: true };
    expect(isSingleAccountMode()).toBe(true);
    mockEnv = { BILLING_ENABLED: false, SINGLE_ACCOUNT_MODE: false };
    expect(isSingleAccountMode()).toBe(false);
  });
});
