import { describe, expect, mock, test } from 'bun:test';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

const client = postgres('postgres://user:pass@127.0.0.1:5432/never-connected', {
  max: 1,
  connect_timeout: 1,
});

// This suite only renders SQL, so every config export the import graph pulls in
// can be a stub — but they must exist statically for ESM named-export resolution.
mock.module('../../config', () => ({
  config: { KORTIX_BILLING_INTERNAL_ENABLED: true },
  SANDBOX_VERSION: '0.0.0-test',
  KNOWN_PROVIDERS: [],
  KORTIX_MARKUP: 1,
  PLATFORM_FEE_MARKUP: 1,
  getToolCost: () => 0,
  parseAllowedProviders: () => [],
}));

mock.module('../../shared/db', () => ({ db: drizzle(client) }));

const { selectMissingAppComputeCandidates, selectMissingComputeCandidates } = await import('./compute-metering');
const { selectOpenComputeInvariantCandidates } = await import('./compute-invariant-sweep');
const { buildClaimComputeWindowQuery, buildReleaseComputeWindowQuery } = await import(
  '../repositories/compute-sessions'
);

const T0 = '2026-08-07T18:52:18.948Z';
const T1 = '2026-08-07T18:52:41.710Z';

describe('compute window compare-and-set SQL', () => {
  test('terminal claim moves the cursor and closes the row in one update', () => {
    const { sql, params } = buildClaimComputeWindowQuery({
      id: 'meter-1',
      expectedLastBilledAt: T0,
      nextLastBilledAt: T1,
      addCostUsd: 0.001,
      terminalState: 'stopped',
    }).toSQL();

    expect(sql).toMatch(/set .*state.*ended_at.*last_billed_at.*cost_usd/);
    expect(sql).toMatch(/ended_at.*is null/);
    expect(sql).toMatch(/last_billed_at.*=/);
    expect(params).toContain('stopped');
    expect(params.filter((value) => value === T1)).toHaveLength(2);
  });

  test('terminal release only reopens the exact failed terminal claim', () => {
    const { sql, params } = buildReleaseComputeWindowQuery({
      id: 'meter-1',
      claimedLastBilledAt: T1,
      revertToLastBilledAt: T0,
      subCostUsd: 0.001,
      terminalState: 'stopped',
    }).toSQL();

    expect(sql).toMatch(/set .*last_billed_at.*cost_usd.*state.*ended_at/);
    expect(sql).toMatch(/state.*=.*ended_at.*=/);
    expect(params).toContain('active');
    expect(params).toContain('stopped');
    expect(params.filter((value) => value === T1)).toHaveLength(2);
  });

  test('partial release cannot move the cursor after a terminal close', () => {
    const { sql } = buildReleaseComputeWindowQuery({
      id: 'meter-1',
      claimedLastBilledAt: T1,
      revertToLastBilledAt: T0,
      subCostUsd: 0.001,
    }).toSQL();

    expect(sql).toMatch(/ended_at.*is null/);
  });
});

describe('reconcile candidate predicate', () => {
  const rendered = () => selectMissingComputeCandidates(100).toSQL();

  test('restricts candidates to per_seat accounts via an inner join', () => {
    const { sql, params } = rendered();
    expect(sql).toContain('inner join');
    expect(sql).toContain('credit_accounts');
    expect(sql).toMatch(/credit_accounts"?\."?billing_model/);
    expect(params).toContain('per_seat');
  });

  test('only considers active sandboxes with no open compute window', () => {
    const { sql, params } = rendered();
    expect(sql).toMatch(/session_sandboxes"?\."?status"? = /);
    expect(params).toContain('active');
    expect(sql).toMatch(/sandbox_compute_sessions"?\."?ended_at"? is null/);
    expect(sql).toMatch(/sandbox_compute_sessions"?\."?id"? is null/);
  });

  test('selects external_id so liveness can be probed before billing', () => {
    expect(rendered().sql).toMatch(/session_sandboxes"?\."?external_id/);
  });

  test('is bounded', () => {
    const { sql, params } = rendered();
    expect(sql).toContain('limit');
    expect(params).toContain(100);
  });
});

describe('App reconcile candidate predicate', () => {
  const rendered = () => selectMissingAppComputeCandidates(100).toSQL();

  test('selects only the active deployment runtime for a running App', () => {
    const { sql, params } = rendered();
    expect(sql).toContain('app_runtimes');
    expect(sql).toContain('app_deployments');
    expect(sql).toContain('apps');
    expect(sql).toMatch(/active_deployment_id/);
    expect(sql).toMatch(/app_runtimes"?\."?status"? = /);
    expect(sql).toMatch(/desired_state"? = /);
    expect(params).toContain('running');
  });

  test('requires a metered account and no open compute window', () => {
    const { sql, params } = rendered();
    expect(sql).toContain('credit_accounts');
    expect(params).toContain('per_seat');
    expect(params).toContain('credit');
    expect(sql).toMatch(/sandbox_compute_sessions"?\."?ended_at"? is null/);
    expect(sql).toMatch(/sandbox_compute_sessions"?\."?id"? is null/);
  });
});

describe('compute invariant candidate predicate', () => {
  const rendered = () => selectOpenComputeInvariantCandidates(100).toSQL();

  test('joins both session sandboxes and App runtimes', () => {
    const { sql } = rendered();
    expect(sql).toContain('session_sandboxes');
    expect(sql).toContain('app_runtimes');
    expect(sql).toMatch(/app_runtime_id/);
  });

  test('selects workload_type so the sweep uses the matching runtime state', () => {
    const { sql } = rendered();
    expect(sql).toMatch(/workload_type/);
    expect(sql).toMatch(/app_runtimes"?\."?status/);
    expect(sql).toMatch(/app_runtimes"?\."?external_id/);
  });
});
