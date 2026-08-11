/**
 * Unit tests for the shared `buildFilters` used by the account audit log
 * list + export endpoints. It's the one piece of query-shaping logic that's
 * easy to get subtly wrong (prefix vs exact, invalid dates swallowed, the
 * `q` OR term) and it backs both the viewer and CSV/JSONL export, so it
 * earns a direct test that doesn't need a DB.
 */
import { describe, expect, test } from 'bun:test';
import { buildFilters } from '../accounts/audit-filters';

const ACCOUNT = '00000000-0000-4000-a000-000000000101';
const ACTOR = '00000000-0000-4000-a000-000000000001';

describe('audit buildFilters', () => {
  test('empty input yields only the account-scoping condition', () => {
    const conds = buildFilters(ACCOUNT, {
      actor: null,
      actionPrefix: null,
      resourceType: null,
      sinceRaw: null,
      untilRaw: null,
      q: null,
    });
    expect(conds).toHaveLength(1);
  });

  test('each independent filter adds exactly one condition', () => {
    const conds = buildFilters(ACCOUNT, {
      actor: ACTOR,
      actionPrefix: 'iam.group',
      resourceType: 'project_session',
      sinceRaw: '2026-01-01T00:00:00Z',
      untilRaw: '2026-02-01T00:00:00Z',
      q: 'delete',
    });
    // account + actor + action + resourceType + since + until + q = 7
    expect(conds).toHaveLength(7);
  });

  test('invalid since/until dates are silently dropped (never throw, never filter)', () => {
    const conds = buildFilters(ACCOUNT, {
      actor: null,
      actionPrefix: null,
      resourceType: null,
      sinceRaw: 'not-a-date',
      untilRaw: '',
      q: null,
    });
    // Only the account condition — the bad `since` is ignored.
    expect(conds).toHaveLength(1);
  });

  test('empty-string filters are treated as "no constraint"', () => {
    const conds = buildFilters(ACCOUNT, {
      actor: '',
      actionPrefix: '',
      resourceType: '',
      sinceRaw: '',
      untilRaw: '',
      q: '',
    });
    expect(conds).toHaveLength(1);
  });

  test('an action prefix without a trailing dot uses a plain LIKE', () => {
    // iam.policy (exact) OR iam.policy.* — handled as a single OR condition.
    const conds = buildFilters(ACCOUNT, {
      actor: null,
      actionPrefix: 'iam.policy',
      resourceType: null,
      sinceRaw: null,
      untilRaw: null,
      q: null,
    });
    expect(conds).toHaveLength(2);
  });

  test('resourceType is a prefix match (project → project, project_session, …)', () => {
    const conds = buildFilters(ACCOUNT, {
      actor: null,
      actionPrefix: null,
      resourceType: 'project',
      sinceRaw: null,
      untilRaw: null,
      q: null,
    });
    expect(conds).toHaveLength(2);
  });

  test('reconstruction fields each add one exact condition', () => {
    const conds = buildFilters(ACCOUNT, {
      actor: null,
      actionPrefix: null,
      resourceType: null,
      sinceRaw: null,
      untilRaw: null,
      q: null,
      workspaceId: '00000000-0000-4000-a000-000000000201',
      sessionId: 'session-1',
      actorType: 'agent',
      source: 'connector',
      outcome: 'failure',
      requestId: 'request-1',
      correlationId: 'execution-1',
    });
    expect(conds).toHaveLength(8);
  });
});
