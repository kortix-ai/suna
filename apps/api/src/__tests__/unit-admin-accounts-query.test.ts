import { describe, expect, test } from 'bun:test';
import { parseAdminAccountsListQuery, UNPAID_TIERS } from '../admin/accounts-query';

/** Build a query accessor from a plain record, mirroring c.req.query(k). */
function get(params: Record<string, string>) {
  return (key: string): string | undefined => params[key];
}

describe('parseAdminAccountsListQuery', () => {
  test('defaults when nothing is provided', () => {
    const q = parseAdminAccountsListQuery(get({}));
    expect(q).toMatchObject({
      search: '',
      tierValues: [],
      paymentStatusValues: [],
      paidOnly: false,
      hasSubscription: null,
      minBalance: null,
      maxBalance: null,
      sortBy: 'created',
      sortDir: 'desc',
      page: 1,
      limit: 50,
      offset: 0,
    });
  });

  test('parses the paid-only flag only when exactly "true"', () => {
    expect(parseAdminAccountsListQuery(get({ paid: 'true' })).paidOnly).toBe(true);
    expect(parseAdminAccountsListQuery(get({ paid: 'false' })).paidOnly).toBe(false);
    expect(parseAdminAccountsListQuery(get({ paid: '1' })).paidOnly).toBe(false);
  });

  test('parses hasSubscription as tri-state', () => {
    expect(parseAdminAccountsListQuery(get({ hasSubscription: 'true' })).hasSubscription).toBe(true);
    expect(parseAdminAccountsListQuery(get({ hasSubscription: 'false' })).hasSubscription).toBe(false);
    expect(parseAdminAccountsListQuery(get({ hasSubscription: 'maybe' })).hasSubscription).toBeNull();
    expect(parseAdminAccountsListQuery(get({})).hasSubscription).toBeNull();
  });

  test('splits CSV tier and paymentStatus lists, trimming blanks', () => {
    const q = parseAdminAccountsListQuery(
      get({ tier: 'pro, per_seat , ,enterprise', paymentStatus: 'active,past_due' }),
    );
    expect(q.tierValues).toEqual(['pro', 'per_seat', 'enterprise']);
    expect(q.paymentStatusValues).toEqual(['active', 'past_due']);
  });

  test('normalizes sort + clamps pagination and computes offset', () => {
    expect(parseAdminAccountsListQuery(get({ sortBy: 'balance', sortDir: 'asc' }))).toMatchObject({
      sortBy: 'balance',
      sortDir: 'asc',
    });
    // Unknown sortBy falls back to 'created'; limit is capped at 100, min page 1.
    expect(parseAdminAccountsListQuery(get({ sortBy: 'nonsense' })).sortBy).toBe('created');
    const clamped = parseAdminAccountsListQuery(get({ page: '0', limit: '999' }));
    expect(clamped).toMatchObject({ page: 1, limit: 100, offset: 0 });
    const paged = parseAdminAccountsListQuery(get({ page: '3', limit: '20' }));
    expect(paged.offset).toBe(40);
  });

  test('treats empty balance strings as no filter', () => {
    expect(parseAdminAccountsListQuery(get({ minBalance: '', maxBalance: '' }))).toMatchObject({
      minBalance: null,
      maxBalance: null,
    });
    expect(parseAdminAccountsListQuery(get({ minBalance: '-5', maxBalance: '10' }))).toMatchObject({
      minBalance: '-5',
      maxBalance: '10',
    });
  });

  test('UNPAID_TIERS matches isPaidTier semantics (free + none excluded)', () => {
    expect([...UNPAID_TIERS]).toEqual(['free', 'none']);
  });
});
