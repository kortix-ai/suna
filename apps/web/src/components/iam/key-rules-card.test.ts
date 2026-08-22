import { describe, expect, test } from 'bun:test';

import { parseDaysField, policyIdentity } from './key-rules-card';
import type { PatPolicy } from '@/lib/iam-client';

/**
 * The rules form's only real logic: turning what someone typed into a value
 * the endpoint accepts, or into a sentence explaining why it can't.
 *
 * The messages are asserted verbatim because they are the whole point of this
 * rewrite — the previous copy read "Max lifetime must be a positive integer or
 * blank", which tells a person who does not write code nothing they can act
 * on.
 */
describe('parseDaysField', () => {
  test('blank means no rule, not an error', () => {
    expect(parseDaysField('Longest', '', 730)).toEqual({ ok: true, value: null });
    expect(parseDaysField('Longest', '   ', 730)).toEqual({ ok: true, value: null });
  });

  test('a whole number of days comes through as a number', () => {
    expect(parseDaysField('Longest', '90', 730)).toEqual({ ok: true, value: 90 });
    expect(parseDaysField('Longest', ' 30 ', 730)).toEqual({ ok: true, value: 30 });
  });

  test('rejects anything that is not a whole positive number', () => {
    for (const raw of ['0', '-5', '1.5', 'ninety', '9e2x']) {
      const result = parseDaysField('Longest a key can last', raw, 730);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe(
          'Longest a key can last: use a whole number of days, or leave it empty.',
        );
      }
    }
  });

  test('rejects a value past the backend cap, and names the cap', () => {
    const result = parseDaysField('Longest a key can last', '900', 730);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('Longest a key can last: 730 days is the most Kortix allows.');
    }
  });

  test('the cap itself is allowed', () => {
    expect(parseDaysField('Longest', '730', 730)).toEqual({ ok: true, value: 730 });
  });
});

/**
 * The form is seeded from props and remounted by this key, so a stale key
 * means a save that appears not to stick: the fields would keep showing what
 * was typed before the server answered. Every field must move it.
 */
describe('policyIdentity', () => {
  const base: PatPolicy = {
    require_expiry: false,
    max_lifetime_days: null,
    idle_revoke_days: null,
  };

  test('is stable for the same saved policy', () => {
    expect(policyIdentity(base)).toBe(policyIdentity({ ...base }));
  });

  test('changes when any one field changes', () => {
    const identity = policyIdentity(base);
    expect(policyIdentity({ ...base, require_expiry: true })).not.toBe(identity);
    expect(policyIdentity({ ...base, max_lifetime_days: 90 })).not.toBe(identity);
    expect(policyIdentity({ ...base, idle_revoke_days: 30 })).not.toBe(identity);
  });

  test('distinguishes the two day fields — 90/null is not null/90', () => {
    expect(policyIdentity({ ...base, max_lifetime_days: 90 })).not.toBe(
      policyIdentity({ ...base, idle_revoke_days: 90 }),
    );
  });
});
