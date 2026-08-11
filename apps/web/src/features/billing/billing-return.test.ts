import { describe, expect, test } from 'bun:test';

import { BILLING_RETURNS, BILLING_RETURN_PARAMS } from './billing-return';

/**
 * The contract these tests protect: a Stripe return is handled wherever the
 * user lands, so no `success_url` has to point at the workspaces list.
 */
describe('billing returns', () => {
  test('every return declares a distinct param', () => {
    const params = BILLING_RETURNS.map((r) => r.param);
    expect(new Set(params).size).toBe(params.length);
  });

  test('BILLING_RETURN_PARAMS matches the table', () => {
    // The door preserves these across its redirect; a drift here silently
    // swallows a post-checkout refresh.
    expect([...BILLING_RETURN_PARAMS].sort()).toEqual(BILLING_RETURNS.map((r) => r.param).sort());
  });

  test('covers the live Stripe flows', () => {
    expect(BILLING_RETURNS.map((r) => r.param).sort()).toEqual([
      'credit_purchase',
      'team_signup',
    ]);
  });

  test('every return has user-facing copy and a settle step', () => {
    for (const entry of BILLING_RETURNS) {
      expect({ param: entry.param, ok: entry.title.length > 0 }).toEqual({
        param: entry.param,
        ok: true,
      });
      expect({ param: entry.param, ok: entry.description.length > 0 }).toEqual({
        param: entry.param,
        ok: true,
      });
      expect({ param: entry.param, ok: typeof entry.settle === 'function' }).toEqual({
        param: entry.param,
        ok: true,
      });
      expect(entry.value).toBe('success');
    }
  });
});
