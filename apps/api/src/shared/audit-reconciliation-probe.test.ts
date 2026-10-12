/**
 * The reconciliation dedupe probe must be an index condition.
 *
 * `audit_events` dedupes on the unique partial index whose key ends in the
 * expression `coalesce(source_revision, '')`
 * (20260807221203000_audit_source_phase_index.concurrent.ts, carried through
 * the partition cutover as idx_audit_events_next_source_phase). A probe that
 * compares the raw column — `source_revision IS NOT DISTINCT FROM $1` — cannot
 * be an index condition against an expression index: the planner keeps the
 * first three columns as index conds and turns the revision comparison into a
 * Filter, so every probe reads EVERY entry of its
 * (source_ledger, source_record_id, phase) key and heap-fetches it. Relay
 * record ids are content hashes and each emission carries a fresh random
 * revision, so heavy keys accumulate hundreds of rows per key and a 1,000-row
 * page outran the audit pool's 10 s statement_timeout on prod (KRTX-618:
 * 326/326 slow `GET /v1/billing/account-state` requests in a 100 h window fell
 * inside one of these scan windows; ~30 expected by chance). Comparing the
 * same expression the index carries makes the probe a point lookup.
 */
import { afterAll, describe, expect, mock, test } from 'bun:test';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';

// Import the real pool client first: this file re-registers it after capturing
// its SQL, so every later test file in the shared bun process sees the real
// audit-db (its auditDb() resolves per call, so the restore lands).
const realAuditDb = await import('./audit-db');

const executed: unknown[] = [];
const results: unknown[][] = [];

mock.module('./audit-db', () => ({
  auditDb: () => ({
    execute: async (query: SQL) => {
      executed.push(query);
      return results[Math.min(executed.length - 1, results.length - 1)] ?? [];
    },
  }),
}));

const { reconcileAuditEvents } = await import('./audit-reconciliation');

// Call 1 (mark read): no mark → a full pass is due.
// Call 2 (window read): the pass runs to now.
// Call 3 (the page statement): the completion marker only.
results.push([], [{ from: '2026-10-01 00:00:00+00', until: null }], [
  { sourceLedger: null, marker: true, hasMore: false },
]);

describe('reconcileAuditEvents dedupe probe', () => {
  afterAll(() => {
    mock.module('./audit-db', () => ({ auditDb: realAuditDb.auditDb }));
  });

  test('compares source_revision through the index expression, not the raw column', async () => {
    await reconcileAuditEvents('00000000-0000-4000-a000-000000000001');
    expect(executed.length).toBe(3);
    const pageSql = new PgDialect().sqlToQuery(executed[2] as SQL).sql;
    // The probe condition must name the expression the unique index carries.
    expect(pageSql).toMatch(
      /coalesce\(\s*a\.source_revision\s*,\s*''\s*\)\s*=\s*coalesce\(\s*c\.source_revision\s*,\s*''\s*\)/,
    );
    // A raw-column IS NOT DISTINCT FROM cannot be an index condition on the
    // expression index; regression-pin its absence.
    expect(pageSql).not.toMatch(/IS NOT DISTINCT FROM/);
  });
});
