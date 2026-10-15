import { describe, expect, test } from 'bun:test';
import { planTier } from './plan-tier';

describe('planTier', () => {
  test('the three family labels the API sends', () => {
    expect(planTier('Free')).toBe('free');
    expect(planTier('Credits')).toBe('credits');
    expect(planTier('Enterprise')).toBe('enterprise');
    expect(planTier(' credits ')).toBe('credits');
  });

  test('legacy tier names are not plans', () => {
    for (const name of ['Basic', 'Plus', 'Pro', 'Ultra', 'Starter', 'Scale', 'Max', 'Team', 'Pro (Legacy)', 'Enterprise (Legacy)']) {
      expect(planTier(name)).toBeNull();
    }
  });

  test('a missing label has no tier', () => {
    expect(planTier('')).toBeNull();
    expect(planTier(null)).toBeNull();
    expect(planTier(undefined)).toBeNull();
  });
});
