// A restart claim must never take the archived row of a deleted session. The
// claim's CAS is the only gate between a Restart request and a provider
// stop/start, so the status predicate lives in its WHERE clause.
import { expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

let captured: unknown = null;

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    update: () => ({
      set: () => ({
        where: (where: unknown) => {
          captured = where;
          return { returning: async () => [] };
        },
      }),
    }),
  },
}));

const { claimInPlaceRestart } = await import('../runtime-restart-claim');

test('the restart claim refuses an archived (deleted-session) row', async () => {
  const startedAt = new Date('2026-09-24T12:00:00.000Z');
  const claimed = await claimInPlaceRestart({
    sandboxId: '00000000-0000-4000-a000-0000000000c1',
    externalId: 'sbx_ext_1',
    claim: { id: 'restart-1', startedAt, leaseExpiresAt: new Date(startedAt.getTime() + 240_000) },
  });
  expect(claimed).toBe(false);
  // The claim moves only a live row: `archived` is outside its from-set.
  const query = new PgDialect().sqlToQuery(captured as Parameters<PgDialect['sqlToQuery']>[0]);
  expect(query.sql).toContain('"status" in (');
  expect(query.params).toEqual(expect.arrayContaining(['provisioning', 'active', 'stopped']));
  expect(query.params).not.toContain('archived');
});
