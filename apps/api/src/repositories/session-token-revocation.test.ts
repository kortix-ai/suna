/**
 * `revokeSessionConnectorTokens` is one UPDATE, so the whole of its correctness
 * is in the SET and the WHERE. This renders both and asserts on them, which is
 * what the real-DB integration test in `__tests__/integration-token-revocation`
 * cannot do in CI (integration tests need a live Postgres and are excluded from
 * `scripts/test.sh`).
 *
 * The scoping is not incidental: dropping the account predicate would let one
 * tenant's session id revoke another's tokens, and dropping `status='active'`
 * would rewrite already-revoked rows' `revoked_at`, destroying the audit trail
 * of when a credential actually died.
 */
import { describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

let lastSet: Record<string, unknown> | null = null;
let lastWhere: unknown = null;

mock.module('../shared/db', () => ({
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        lastSet = values;
        return {
          where: (predicate: unknown) => {
            lastWhere = predicate;
            return { returning: async () => [{ tokenId: 't1' }, { tokenId: 't2' }] };
          },
        };
      },
    }),
  },
}));

const { revokeSessionConnectorTokens } = await import('./account-tokens');

describe('revokeSessionConnectorTokens', () => {
  test('revokes by session AND account AND active-only, and reports the count', async () => {
    const revoked = await revokeSessionConnectorTokens('sess-1', 'acct-1');
    expect(revoked).toBe(2);

    const { sql, params } = new PgDialect().sqlToQuery(lastWhere as SQL);
    expect(sql).toContain('session_id');
    expect(sql).toContain('account_id');
    expect(sql).toContain('status');
    // A session id alone must never be enough — it would reach across tenants.
    expect(params).toContain('sess-1');
    expect(params).toContain('acct-1');
    expect(params).toContain('active');
  });

  test('marks the row revoked AND stamps when — status alone loses the audit trail', async () => {
    await revokeSessionConnectorTokens('sess-1', 'acct-1');
    expect(lastSet?.status).toBe('revoked');
    expect(lastSet?.revokedAt).toBeInstanceOf(Date);
  });
});
