import { describe, expect, test } from 'bun:test';

import { computeFreeTier } from './use-runtime-local';

// The pure agent/model-selection algorithm (formatModelString, resolveHiddenAutoModel,
// resolveCurrentAgentName, scopedModelSelectionKey, ...) moved to the SDK —
// see packages/sdk/src/react/use-runtime-local.test.ts. This file only owns
// the web-specific glue: deriving `freeTier` from billing account state.
describe('computeFreeTier', () => {
  test('is free tier with no account state', () => {
    expect(computeFreeTier(undefined)).toBe(true);
  });

  test('is free tier for an explicit "free" or "none" tier with no active subscription', () => {
    expect(computeFreeTier({ subscription: { tier_key: 'free' } } as any)).toBe(true);
    expect(computeFreeTier({ subscription: { tier_key: 'none' } } as any)).toBe(true);
  });

  test('is not free tier once there is an active subscription, even on the free tier key', () => {
    expect(
      computeFreeTier({ subscription: { tier_key: 'free', subscription_id: 'sub_123' } } as any),
    ).toBe(false);
  });

  test('is not free tier for a paid tier key', () => {
    expect(computeFreeTier({ subscription: { tier_key: 'pro' } } as any)).toBe(false);
  });
});
