import { describe, expect, test } from 'bun:test';

import { ONBOARDING_PARAM, onboardingPath, readOnboardingParam } from './onboarding-param';

describe('readOnboardingParam', () => {
  test('returns the project id', () => {
    expect(readOnboardingParam(new URLSearchParams('onboarding=proj_1'))).toBe('proj_1');
  });

  test('returns null when absent', () => {
    expect(readOnboardingParam(new URLSearchParams(''))).toBeNull();
  });

  test('returns null for an empty or whitespace value', () => {
    expect(readOnboardingParam(new URLSearchParams('onboarding='))).toBeNull();
    expect(readOnboardingParam(new URLSearchParams('onboarding=%20%20'))).toBeNull();
  });

  test('trims surrounding whitespace', () => {
    expect(readOnboardingParam(new URLSearchParams('onboarding=%20proj_1%20'))).toBe('proj_1');
  });

  test('ignores an unrelated param', () => {
    expect(readOnboardingParam(new URLSearchParams('source=github'))).toBeNull();
  });
});

describe('onboardingPath', () => {
  test('builds the /new path carrying the project id', () => {
    expect(onboardingPath('proj_1')).toBe('/new?onboarding=proj_1');
  });

  test('percent-encodes a value that would otherwise break the query string', () => {
    expect(onboardingPath('a b&c=d')).toBe('/new?onboarding=a%20b%26c%3Dd');
  });

  // The two halves are one contract: whatever `onboardingPath` writes,
  // `readOnboardingParam` must read back unchanged. Asserting them
  // independently would let an encoding change pass while breaking the round
  // trip that is the module's whole job.
  test('round-trips through a real URL', () => {
    const url = new URL(onboardingPath('a b&c=d'), 'https://example.test');
    expect(readOnboardingParam(url.searchParams)).toBe('a b&c=d');
  });

  test('the param name is exported and used by the builder', () => {
    expect(ONBOARDING_PARAM).toBe('onboarding');
    expect(onboardingPath('x')).toContain(`${ONBOARDING_PARAM}=`);
  });
});
