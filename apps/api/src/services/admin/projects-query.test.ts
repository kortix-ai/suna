import { describe, expect, test } from 'bun:test';

import { PROJECT_STATUS_VALUES, parseAdminProjectsListQuery } from './projects-query';

/** Build a `get` accessor over a plain object, matching `c.req.query`. */
function q(params: Record<string, string>) {
  return (key: string) => params[key];
}

const UUID = '11111111-2222-4333-8444-555555555555';

describe('parseAdminProjectsListQuery', () => {
  test('defaults: activity sort, desc, page 1, limit 50, no filters', () => {
    expect(parseAdminProjectsListQuery(q({}))).toEqual({
      search: '',
      accountId: null,
      invalidAccountId: false,
      statusValues: [],
      sortBy: 'activity',
      sortDir: 'desc',
      page: 1,
      limit: 50,
      offset: 0,
    });
  });

  test('accepts the three sort columns and rejects anything else', () => {
    expect(parseAdminProjectsListQuery(q({ sortBy: 'activity' })).sortBy).toBe('activity');
    expect(parseAdminProjectsListQuery(q({ sortBy: 'created' })).sortBy).toBe('created');
    expect(parseAdminProjectsListQuery(q({ sortBy: 'sessions' })).sortBy).toBe('sessions');
    expect(parseAdminProjectsListQuery(q({ sortBy: 'name' })).sortBy).toBe('activity');
    expect(parseAdminProjectsListQuery(q({ sortBy: '' })).sortBy).toBe('activity');
  });

  test('sortDir is asc only on the literal "asc"', () => {
    expect(parseAdminProjectsListQuery(q({ sortDir: 'asc' })).sortDir).toBe('asc');
    expect(parseAdminProjectsListQuery(q({ sortDir: 'ASC' })).sortDir).toBe('desc');
    expect(parseAdminProjectsListQuery(q({ sortDir: 'descending' })).sortDir).toBe('desc');
  });

  test('limit is clamped to [1,100] and page to >= 1', () => {
    expect(parseAdminProjectsListQuery(q({ limit: '1000' })).limit).toBe(100);
    expect(parseAdminProjectsListQuery(q({ limit: '0' })).limit).toBe(1);
    expect(parseAdminProjectsListQuery(q({ limit: 'abc' })).limit).toBe(50);
    expect(parseAdminProjectsListQuery(q({ page: '0' })).page).toBe(1);
    expect(parseAdminProjectsListQuery(q({ page: '-3' })).page).toBe(1);
  });

  test('offset is (page - 1) * limit', () => {
    expect(parseAdminProjectsListQuery(q({ page: '3', limit: '25' })).offset).toBe(50);
    expect(parseAdminProjectsListQuery(q({ page: '1', limit: '25' })).offset).toBe(0);
  });

  test('search is trimmed', () => {
    expect(parseAdminProjectsListQuery(q({ search: '  acme  ' })).search).toBe('acme');
  });

  // An unknown status would reach Postgres as a project_status enum literal and
  // raise 22P02 ("invalid input value for enum"), turning a typo into a 500. The
  // parser drops unknown values so the filter degrades to "no status filter".
  test('status keeps only real project_status values, deduped', () => {
    expect(parseAdminProjectsListQuery(q({ status: 'active,archived' })).statusValues).toEqual([
      'active',
      'archived',
    ]);
    expect(parseAdminProjectsListQuery(q({ status: 'active, ACTIVE ,bogus' })).statusValues).toEqual([
      'active',
    ]);
    expect(parseAdminProjectsListQuery(q({ status: 'deleted' })).statusValues).toEqual([]);
    expect(PROJECT_STATUS_VALUES).toEqual(['active', 'archived']);
  });

  // A non-uuid accountId is also a 22P02 in Postgres. It is flagged rather than
  // dropped: dropping it would silently widen "one account" to "every account".
  test('accountId passes through only when it is a uuid, and flags a bad one', () => {
    const good = parseAdminProjectsListQuery(q({ accountId: UUID }));
    expect(good.accountId).toBe(UUID);
    expect(good.invalidAccountId).toBe(false);

    const bad = parseAdminProjectsListQuery(q({ accountId: 'not-a-uuid' }));
    expect(bad.accountId).toBeNull();
    expect(bad.invalidAccountId).toBe(true);

    const absent = parseAdminProjectsListQuery(q({ accountId: '   ' }));
    expect(absent.accountId).toBeNull();
    expect(absent.invalidAccountId).toBe(false);
  });

  test('uuid match is case-insensitive', () => {
    expect(parseAdminProjectsListQuery(q({ accountId: UUID.toUpperCase() })).accountId).toBe(
      UUID.toUpperCase(),
    );
  });
});
