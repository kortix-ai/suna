import { describe, expect, test } from 'bun:test';
import { MAX_TRIAL_DURATION_DAYS, validateGrantTrialInput } from './trial-admin';

const valid = { tierKey: 'credits', durationDays: 60, creditGrant: 25 };

describe('validateGrantTrialInput', () => {
  test('accepts a well-formed grant', () => {
    expect(validateGrantTrialInput(valid)).toBeNull();
  });

  test('accepts omitted credit grant', () => {
    expect(validateGrantTrialInput({ ...valid, creditGrant: undefined })).toBeNull();
  });

  test('accepts the enterprise plan', () => {
    expect(validateGrantTrialInput({ ...valid, tierKey: 'enterprise' })).toBeNull();
  });

  // Legacy plan keys (per_seat, team, tier_*) are no longer valid trial plans:
  // a trial emulates `credits` or `enterprise`.
  test.each(['free', 'none', 'not_a_tier', '', 'per_seat', 'team', 'tier_2_20'])(
    'rejects tier_key %p',
    (tierKey) => {
      expect(validateGrantTrialInput({ ...valid, tierKey })).toContain('tier_key');
    },
  );

  test.each([0, -7, 2.5, MAX_TRIAL_DURATION_DAYS + 1])(
    'rejects duration_days %p',
    (durationDays) => {
      expect(validateGrantTrialInput({ ...valid, durationDays })).toContain('duration_days');
    },
  );

  test.each([-1, 10_001, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects credit_grant %p',
    (creditGrant) => {
      expect(validateGrantTrialInput({ ...valid, creditGrant })).toContain('credit_grant');
    },
  );

  test('accepts zero credit grant (pure BYOK trial)', () => {
    expect(validateGrantTrialInput({ ...valid, creditGrant: 0 })).toBeNull();
  });
});
