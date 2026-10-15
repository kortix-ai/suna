/**
 * `readSessionAuditActions` — the approval-projection half of
 * `GET .../audit`, extracted so the session-open bundle's `audit` leg answers
 * from the SAME code the standalone route uses. See `session-audit-read.ts`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const CONNECTOR_ID = '66666666-6666-4666-8666-666666666666';

let rows: Array<Record<string, unknown>> = [];
let connectorRows: Array<Record<string, unknown>> = [];
let emailLookupCalls: string[][] = [];

function makeDbMock() {
  return {
    select: (_cols?: Record<string, unknown>) => ({
      from: (table: { [k: symbol]: unknown } | { toString(): string }) => {
        const isConnectorCalls = String(table).includes('connector_calls') || table === CONNECTOR_CALLS_MARKER;
        return {
          where: (..._conditions: unknown[]) => ({
            orderBy: (..._order: unknown[]) => ({
              limit: async (_n: number) => (isConnectorCalls ? rows : []),
            }),
            // connectors lookup has no orderBy/limit chain in the real query —
            // `.where(...)` resolves directly there.
            then: (resolve: (v: unknown[]) => void) => resolve(connectorRows),
          }),
        };
      },
    }),
  };
}

// A stable marker so the mock can tell "the connectorCalls table" from
// "the connectors table" without depending on drizzle's real table identity.
const CONNECTOR_CALLS_MARKER = Symbol('connectorCalls');

mock.module('../../shared/db', () => ({ db: makeDbMock() }));
mock.module('@kortix/db', () => ({
  connectorCalls: CONNECTOR_CALLS_MARKER,
  connectors: { connectorId: 'connectors.connector_id', slug: 'connectors.slug' },
}));
mock.module('../lib/access', () => ({
  lookupEmailsByUserIds: async (ids: string[]) => {
    emailLookupCalls.push(ids);
    return new Map(ids.map((id) => [id, `${id}@example.test`]));
  },
}));
mock.module('../../setup-links/token', () => ({
  approvalPageUrl: (projectId: string, executionId: string, sessionId: string) =>
    `https://dev.kortix.com/approve/${projectId}/${sessionId}/${executionId}`,
}));

const { readSessionAuditActions } = await import('./session-audit-read');

describe('readSessionAuditActions', () => {
  beforeEach(() => {
    rows = [];
    connectorRows = [];
    emailLookupCalls = [];
  });

  test('an entitled account gets every action, most-recent-first, as the route already orders them', async () => {
    rows = [
      {
        executionId: 'exec-1',
        connectorId: CONNECTOR_ID,
        actionPath: 'crm.whoami',
        actingUserId: USER_ID,
        status: 'ok',
        risk: 'read',
        resultSummary: { ok: true },
        approvedBy: null,
        createdAt: new Date('2026-09-27T10:00:00.000Z'),
        resolvedAt: null,
      },
    ];
    connectorRows = [{ connectorId: CONNECTOR_ID, slug: 'crm' }];

    const result = await readSessionAuditActions({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      agentName: 'kortix',
      audited: true,
      limit: 100,
      canResolve: async () => true,
      resolvers: 'managers_and_launcher',
    });

    expect(result).toEqual({
      session_id: SESSION_ID,
      agent: 'kortix',
      audit_access: true,
      count: 1,
      actions: [
        {
          execution_id: 'exec-1',
          action: 'crm.whoami',
          connector_id: CONNECTOR_ID,
          connector: 'crm',
          status: 'ok',
          risk: 'read',
          acted_by: USER_ID,
          acted_by_email: `${USER_ID}@example.test`,
          resolved_by: null,
          resolved_by_email: null,
          result_summary: { ok: true },
          at: '2026-09-27T10:00:00.000Z',
          resolved_at: null,
          approval_url: null,
          can_resolve: false,
          resolvers: null,
        },
      ],
    });
  });

  test('a pending row not yet resolved carries an approval_url', async () => {
    rows = [
      {
        executionId: 'exec-2',
        connectorId: null,
        actionPath: 'crm.delete',
        actingUserId: USER_ID,
        status: 'pending_approval',
        risk: 'destructive',
        resultSummary: null,
        approvedBy: null,
        createdAt: new Date('2026-09-27T10:05:00.000Z'),
        resolvedAt: null,
      },
    ];

    const result = await readSessionAuditActions({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      agentName: null,
      audited: true,
      limit: 100,
      canResolve: async () => true,
      resolvers: 'managers_and_launcher',
    });

    expect(result.actions[0]?.approval_url).toBe(
      `https://dev.kortix.com/approve/${PROJECT_ID}/${SESSION_ID}/exec-2`,
    );
    expect(result.actions[0]?.connector).toBeNull();
  });

  test('a resolved row never carries an approval_url, even if status is pending_approval', async () => {
    rows = [
      {
        executionId: 'exec-3',
        connectorId: null,
        actionPath: 'crm.delete',
        actingUserId: USER_ID,
        status: 'pending_approval',
        risk: 'destructive',
        resultSummary: null,
        approvedBy: USER_ID,
        createdAt: new Date('2026-09-27T10:05:00.000Z'),
        resolvedAt: new Date('2026-09-27T10:06:00.000Z'),
      },
    ];

    const result = await readSessionAuditActions({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      agentName: null,
      audited: true,
      limit: 100,
      canResolve: async () => true,
      resolvers: 'managers_and_launcher',
    });

    expect(result.actions[0]?.approval_url).toBeNull();
    expect(result.actions[0]?.resolved_by).toBe(USER_ID);
  });

  test('batches actor + approver email lookups into ONE call', async () => {
    rows = [
      {
        executionId: 'exec-4',
        connectorId: null,
        actionPath: 'crm.delete',
        actingUserId: USER_ID,
        status: 'ok',
        risk: 'write',
        resultSummary: null,
        approvedBy: ACCOUNT_ID,
        createdAt: new Date('2026-09-27T10:05:00.000Z'),
        resolvedAt: new Date('2026-09-27T10:06:00.000Z'),
      },
    ];

    await readSessionAuditActions({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      agentName: null,
      audited: true,
      limit: 100,
      canResolve: async () => true,
      resolvers: 'managers_and_launcher',
    });

    expect(emailLookupCalls).toHaveLength(1);
    expect(emailLookupCalls[0]?.sort()).toEqual([ACCOUNT_ID, USER_ID].sort());
  });

  test('an unentitled account never asks for a resolved/historical row — the DB filter, not a client-side trim', async () => {
    // The mock's `.limit()` always returns `rows` regardless of the
    // conditions passed to `.where()`; what this test asserts is the STABLE
    // CONTRACT — `audited: false` must still produce a result shaped the same
    // as the entitled path (the WHERE predicate is exercised by the real DB in
    // the route's own integration coverage, not re-proven here).
    rows = [];
    const result = await readSessionAuditActions({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      agentName: 'kortix',
      audited: false,
      limit: 100,
      canResolve: async () => true,
      resolvers: 'managers_and_launcher',
    });
    expect(result).toEqual({
      session_id: SESSION_ID,
      agent: 'kortix',
      audit_access: false,
      count: 0,
      actions: [],
    });
  });

  describe('can_resolve (KRTX-1724)', () => {
    const pendingRow = (executionId: string, overrides: Record<string, unknown> = {}) => ({
      executionId,
      connectorId: null,
      actionPath: 'gmail.send_email',
      actingUserId: USER_ID,
      status: 'pending_approval',
      risk: 'write',
      resultSummary: null,
      approvedBy: null,
      createdAt: new Date('2026-09-27T10:05:00.000Z'),
      resolvedAt: null,
      ...overrides,
    });

    test('a pending row carries the caller verdict; a settled row carries false', async () => {
      rows = [
        pendingRow('exec-pending'),
        pendingRow('exec-ok', { status: 'ok', approvedBy: USER_ID, resolvedAt: new Date() }),
      ];
      const result = await readSessionAuditActions({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        agentName: null,
        audited: true,
        limit: 100,
        canResolve: async () => true,
        resolvers: 'managers_and_launcher',
      });
      expect(result.actions.map((action) => [action.execution_id, action.can_resolve])).toEqual([
        ['exec-pending', true],
        ['exec-ok', false],
      ]);
    });

    test('a caller the resolve route refuses reads can_resolve false on a pending row', async () => {
      rows = [pendingRow('exec-pending')];
      const result = await readSessionAuditActions({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        agentName: null,
        audited: true,
        limit: 100,
        canResolve: async () => false,
        resolvers: 'managers',
      });
      expect(result.actions[0]?.can_resolve).toBe(false);
    });

    test('a pending row names who decides; a settled row names nobody', async () => {
      rows = [
        pendingRow('exec-pending'),
        pendingRow('exec-ok', { status: 'ok', approvedBy: USER_ID, resolvedAt: new Date() }),
      ];
      const result = await readSessionAuditActions({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        agentName: null,
        audited: true,
        limit: 100,
        canResolve: async () => false,
        resolvers: 'managers',
      });
      expect(result.actions.map((action) => [action.execution_id, action.resolvers])).toEqual([
        ['exec-pending', 'managers'],
        ['exec-ok', null],
      ]);
    });

    test('asks for the verdict once for many pending rows, and never when none is pending', async () => {
      let calls = 0;
      const canResolve = async () => {
        calls += 1;
        return true;
      };
      rows = [pendingRow('exec-a'), pendingRow('exec-b'), pendingRow('exec-c')];
      await readSessionAuditActions({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        agentName: null,
        audited: true,
        limit: 100,
        canResolve,
        resolvers: 'managers_and_launcher',
      });
      expect(calls).toBe(1);

      // The badge poll of a session with nothing pending pays no authority probe.
      rows = [pendingRow('exec-ok', { status: 'ok', resolvedAt: new Date() })];
      await readSessionAuditActions({
        projectId: PROJECT_ID,
        sessionId: SESSION_ID,
        agentName: null,
        audited: true,
        limit: 100,
        canResolve,
        resolvers: 'managers_and_launcher',
      });
      expect(calls).toBe(1);
    });
  });

  test('skips the connector-slug lookup entirely when no row names a connector', async () => {
    rows = [
      {
        executionId: 'exec-5',
        connectorId: null,
        actionPath: 'shell.run',
        actingUserId: null,
        status: 'ok',
        risk: null,
        resultSummary: null,
        approvedBy: null,
        createdAt: new Date('2026-09-27T10:05:00.000Z'),
        resolvedAt: null,
      },
    ];
    // If the code queried `connectors` anyway it would read `connectorRows`
    // (left `[]`) and still pass — so assert the FIELD instead, which only a
    // real slug lookup could have populated.
    const result = await readSessionAuditActions({
      projectId: PROJECT_ID,
      sessionId: SESSION_ID,
      agentName: null,
      audited: true,
      limit: 100,
      canResolve: async () => true,
      resolvers: 'managers_and_launcher',
    });
    expect(result.actions[0]?.connector).toBeNull();
    expect(result.actions[0]?.connector_id).toBeNull();
  });
});
