/**
 * A store purchase names the workspace it buys for. One person holds several
 * workspaces, so the RevenueCat webhook reads the `kortix_workspace_id`
 * subscriber attribute to credit the right one
 * (apps/api/src/billing/services/revenuecat-webhooks.ts,
 * `resolveRevenueCatAccountId`). The app sets it right before the purchase,
 * and clears it when it does not know the workspace, so a stale attribute
 * never credits the wrong one.
 */
import { beforeEach, expect, mock, test } from 'bun:test';

const calls: string[] = [];
const attributes: Record<string, string | null>[] = [];
const customerInfo = { originalAppUserId: 'synthetic-user', entitlements: { active: {} }, activeSubscriptions: [] };

mock.module('react-native-purchases', () => ({
  default: {
    getCustomerInfo: async () => customerInfo,
    logIn: async () => ({ customerInfo }),
    setEmail: async () => {
      calls.push('setEmail');
    },
    setAttributes: async (value: Record<string, string | null>) => {
      calls.push('setAttributes');
      attributes.push(value);
    },
    purchasePackage: async () => {
      calls.push('purchasePackage');
      return { customerInfo };
    },
    getOfferings: async () => ({ current: { identifier: 'default', availablePackages: [] }, all: {} }),
  },
}));
mock.module('react-native-purchases-ui', () => ({
  default: {
    presentPaywall: async () => {
      calls.push('presentPaywall');
      return 'PURCHASED';
    },
    PAYWALL_RESULT: { NOT_PRESENTED: 'NOT_PRESENTED', ERROR: 'ERROR', PURCHASED: 'PURCHASED', CANCELLED: 'CANCELLED', RESTORED: 'RESTORED' },
  },
}));
mock.module('react-native', () => ({ Platform: { OS: 'ios' } }));
mock.module('@/lib/logger', () => ({ log: { rc: () => {}, rcWarn: () => {}, rcError: () => {} } }));

const { purchasePackage, presentPaywall, REVENUECAT_WORKSPACE_ATTRIBUTE } = await import('./revenuecat');

beforeEach(() => {
  calls.length = 0;
  attributes.length = 0;
});

const pkg = { identifier: 'monthly' } as never;

test('the attribute name is the one the webhook reads', () => {
  expect(REVENUECAT_WORKSPACE_ATTRIBUTE).toBe('kortix_workspace_id');
});

test('purchasePackage sets kortix_workspace_id to the current workspace before the purchase', async () => {
  await purchasePackage(pkg, undefined, 'synthetic-user', 'synthetic-workspace-1');
  expect(attributes).toEqual([{ kortix_workspace_id: 'synthetic-workspace-1' }]);
  expect(calls.indexOf('setAttributes')).toBeLessThan(calls.indexOf('purchasePackage'));
});

test('purchasePackage with no workspace deletes the attribute (empty value), so a stale one credits nothing', async () => {
  await purchasePackage(pkg, undefined, 'synthetic-user');
  expect(attributes).toEqual([{ kortix_workspace_id: '' }]);
  expect(calls.indexOf('setAttributes')).toBeLessThan(calls.indexOf('purchasePackage'));
});

test('presentPaywall sets the attribute before the paywall can purchase', async () => {
  await presentPaywall(undefined, 'synthetic-workspace-2');
  expect(attributes).toEqual([{ kortix_workspace_id: 'synthetic-workspace-2' }]);
  expect(calls.indexOf('setAttributes')).toBeLessThan(calls.indexOf('presentPaywall'));
});
