import { describe, expect, mock, test } from 'bun:test';
import * as realRequestContext from '../lib/request-context';

const calls: string[] = [];
let auditFails = false;

const auditRow = {
  eventId: '11111111-1111-4111-8111-111111111111',
  occurredAt: new Date('2026-08-03T10:00:00.000Z'),
  accountId: '22222222-2222-4222-8222-222222222222',
  workspaceId: null,
  sessionId: null,
  actorUserId: null,
  actorType: 'system',
  source: 'api',
  outcome: 'success',
  action: 'secret.strategy.changed',
  resourceType: 'project_secret',
  resourceId: null,
  httpStatus: null,
  durationMs: null,
  requestId: null,
  traceId: null,
  correlationId: null,
  before: null,
  after: null,
  ip: null,
  userAgent: null,
  metadata: {},
};

const transactionClient = {
  insert: () => ({
    values: () => ({
      returning: async () => {
        calls.push('audit');
        if (auditFails) throw new Error('audit unavailable');
        return [auditRow];
      },
    }),
  }),
};

mock.module('../shared/db', () => ({
  db: {
    transaction: async (operation: (tx: typeof transactionClient) => Promise<unknown>) => {
      calls.push('begin');
      try {
        const result = await operation(transactionClient);
        calls.push('commit');
        return result;
      } catch (error) {
        calls.push('rollback');
        throw error;
      }
    },
  },
}));

// Spread the real module: `mock.module` replaces it WHOLESALE, so a stub that
// lists exports by hand deletes every export it omits — the failure surfaces in
// whatever unrelated file imports the missing name next, attributed to no test.
mock.module('../lib/request-context', () => ({
  ...realRequestContext,
  getRequestContext: () => null,
}));

const { runAuditedTransaction } = await import('../shared/audit');

describe('runAuditedTransaction', () => {
  test('stores the mutation and canonical audit event in one transaction', async () => {
    calls.length = 0;
    auditFails = false;

    const result = await runAuditedTransaction(
      async () => {
        calls.push('mutation');
        return 'updated';
      },
      () => ({
        accountId: auditRow.accountId,
        action: auditRow.action,
        resourceType: auditRow.resourceType,
      }),
    );

    expect(result).toBe('updated');
    expect(calls).toEqual(['begin', 'mutation', 'audit', 'commit']);
  });

  test('rolls back the mutation when the audit event cannot be stored', async () => {
    calls.length = 0;
    auditFails = true;

    await expect(
      runAuditedTransaction(
        async () => {
          calls.push('mutation');
        },
        () => ({
          accountId: auditRow.accountId,
          action: auditRow.action,
          resourceType: auditRow.resourceType,
        }),
      ),
    ).rejects.toThrow('audit unavailable');

    expect(calls).toEqual(['begin', 'mutation', 'audit', 'rollback']);
  });
});
