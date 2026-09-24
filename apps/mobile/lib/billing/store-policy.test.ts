import { describe, expect, test } from 'bun:test';
import { canShowExternalPurchase } from './store-policy';

describe('canShowExternalPurchase', () => {
  test('iOS never shows an external purchase action (App Store guideline 3.1.1)', () => {
    expect(canShowExternalPurchase('ios')).toBe(false);
  });

  test('Android and web keep the web checkout handoff', () => {
    expect(canShowExternalPurchase('android')).toBe(true);
    expect(canShowExternalPurchase('web')).toBe(true);
  });

  test('an unknown platform string defaults to allowed (only ios is blocked)', () => {
    expect(canShowExternalPurchase('windows')).toBe(true);
    expect(canShowExternalPurchase('')).toBe(true);
  });
});
