import { describe, expect, test } from 'bun:test';

import { parseMinutes } from './session-controls-card';

/**
 * The session-policy form's only real logic: turning what someone typed into a
 * value `PATCH /accounts/{id}/iam/session-policy` accepts, or into a sentence
 * explaining why it cannot.
 *
 * This runs on every keystroke now, not on submit — it is what disables Save
 * and what a row shows in place of its own description while a value is bad.
 * The old form parsed once, in the click handler, and printed one shared line
 * under the whole grid; a wrong value was reported after the click and away
 * from the field that caused it.
 *
 * Messages are asserted verbatim: they are the only thing a person has to work
 * from, and "Max lifetime must be a positive integer or blank" (the copy this
 * replaced) names a type, not an action.
 *
 * Same shape as `key-rules-card.test.ts`, deliberately — these are the two
 * lifetime forms in the settings panel and their rules should not drift apart.
 */
describe('parseMinutes', () => {
  test('blank means no limit, not an error', () => {
    expect(parseMinutes('')).toEqual({ ok: true, value: null });
    expect(parseMinutes('   ')).toEqual({ ok: true, value: null });
  });

  test('a whole number of minutes comes through as a number', () => {
    expect(parseMinutes('60')).toEqual({ ok: true, value: 60 });
    expect(parseMinutes(' 480 ')).toEqual({ ok: true, value: 480 });
  });

  test('accepts the cap exactly — 7 days is allowed, not one minute short of it', () => {
    expect(parseMinutes('10080')).toEqual({ ok: true, value: 10080 });
  });

  test('rejects anything that is not a whole positive number', () => {
    for (const raw of ['0', '-5', '1.5', 'sixty', '9e2x', 'NaN']) {
      const result = parseMinutes(raw);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toBe('Use a whole number of minutes, or leave it empty.');
      }
    }
  });

  test('rejects a value past the server cap, and names the cap in both units', () => {
    const result = parseMinutes('10081');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toBe('10080 minutes (7 days) is the most Kortix allows.');
    }
  });
});
