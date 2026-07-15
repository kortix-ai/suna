import { describe, expect, mock, test } from 'bun:test';

let mockEnv: {
  BILLING_ENABLED: boolean;
  MANAGED_PROVIDER_ENABLED?: boolean;
};

mock.module('@/lib/env-config', () => ({
  getEnv: () => mockEnv,
}));

const { isBillingEnabled, isManagedProviderEnabled } = await import('./config');

describe('isBillingEnabled', () => {
  test('mirrors the runtime env BILLING_ENABLED flag', () => {
    mockEnv = { BILLING_ENABLED: true };
    expect(isBillingEnabled()).toBe(true);
    mockEnv = { BILLING_ENABLED: false };
    expect(isBillingEnabled()).toBe(false);
  });
});

describe('isManagedProviderEnabled', () => {
  test('CLOUD-ONLY: off by default (self-host), on only when Kortix Cloud sets it', () => {
    mockEnv = {
      BILLING_ENABLED: false,
      MANAGED_PROVIDER_ENABLED: false,
    };
    expect(isManagedProviderEnabled()).toBe(false);
    mockEnv = {
      BILLING_ENABLED: true,
      MANAGED_PROVIDER_ENABLED: true,
    };
    expect(isManagedProviderEnabled()).toBe(true);
  });
});
