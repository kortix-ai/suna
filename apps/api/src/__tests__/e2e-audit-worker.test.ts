/**
 * Rows written inside a worker tick name the worker.
 *
 * Before: `buildAuditRow` saw no request context and wrote
 * `actor_type: system, authoritative_source: api` for every background job,
 * indistinguishable from API traffic and never naming the job.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

let auditRows: Array<Record<string, unknown>> = [];

mock.module('../shared/db', () => ({
  db: {
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        auditRows.push(values);
        return { returning: async () => [{ eventId: 'audit_test', ...values }] };
      },
    }),
    select: () => {
      const chain = {
        from: () => chain,
        where: () => chain,
        limit: async () => [],
        then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(resolve([])),
      };
      return chain;
    },
  },
}));

const { recordAuditEvent } = await import('../shared/audit');
const { runWorkerTick } = await import('../shared/audit-scope');

const ACCOUNT = '00000000-0000-4000-a000-000000000101';

beforeEach(() => {
  auditRows = [];
});

describe('audit rows written by a background job', () => {
  test('an event a tick writes names the worker, with source worker', async () => {
    await runWorkerTick('iam-grant-expiry', () =>
      recordAuditEvent({ accountId: ACCOUNT, action: 'iam.assignment.expired', resourceType: 'role_assignment' }),
    );
    expect(auditRows).toHaveLength(1);
    expect(auditRows[0]).toMatchObject({
      accountId: ACCOUNT,
      actorType: 'system',
      actorUserId: null,
      source: 'worker',
      action: 'iam.assignment.expired',
    });
    expect((auditRows[0]!.metadata as Record<string, unknown>).auth).toEqual({
      kind: 'worker',
      worker: 'iam-grant-expiry',
    });
  });

  test('an event that names its own actor keeps it', async () => {
    await runWorkerTick('audit-reconciliation', () =>
      recordAuditEvent({
        accountId: ACCOUNT,
        actorType: 'system',
        authoritativeSource: 'system',
        action: 'audit.reconciliation.completed',
        resourceType: 'audit',
      }),
    );
    expect(auditRows[0]).toMatchObject({ actorType: 'system', source: 'system' });
  });

  test('a worker tick writes no request row of its own', async () => {
    await runWorkerTick('trigger-scheduler', async () => undefined);
    expect(auditRows).toHaveLength(0);
  });

  test('outside a worker tick nothing changes: no context still means system/api', async () => {
    await recordAuditEvent({ accountId: ACCOUNT, action: 'x.y', resourceType: 'x' });
    expect(auditRows[0]).toMatchObject({ actorType: 'system', source: 'api' });
  });
});
