// deleteSession must remove the provider box DURABLY and must not leave a
// lifecycle fence behind that a concurrent restart could still finalize on.
//
//   - Both tombstone writes merge in SQL. A whole-object write built from an
//     earlier read erases keys a concurrent writer added.
//   - The archive write strips the restart / wake / recovery fences, so a
//     detached restart loses its `runtimeRestartId` CAS instead of flipping the
//     archived row back to `active`.
//   - The archive write records `providerRemovalPendingAt`; only a confirmed
//     removal clears it, and a failed remove records the next retry.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { projectSessions, sessionSandboxes } from '@kortix/db';
import * as realProviders from '../../../platform/providers';
import * as realComputeMetering from '../../../billing/services/compute-metering';
import * as realAccountTokens from '../../../repositories/account-tokens';
import * as realSessionAttachments from '../../lib/session-attachments';
import * as realPromptAttachments from '../../prompt-attachments';

const SESSION_ID = '00000000-0000-4000-a000-0000000000d1';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000000a1';
const PROJECT_ID = '00000000-0000-4000-a000-0000000000b1';

type Update = { table: unknown; set: Record<string, unknown> };
let updates: Update[] = [];
let removeError: Error | null = null;
let providerStatus = 'running';
let removeCalls = 0;

const SANDBOX_ROW = {
  sandboxId: SESSION_ID,
  sessionId: SESSION_ID,
  accountId: ACCOUNT_ID,
  projectId: PROJECT_ID,
  externalId: 'sbx_ext_1',
  provider: 'daytona',
  status: 'active',
  metadata: {
    runtimeRestartId: 'restart-1',
    runtimeRestartLeaseExpiresAt: '2099-01-01T00:00:00.000Z',
    egress_ip: '203.0.113.9',
  },
};

function chain<T>(result: T) {
  const promise = Promise.resolve(result);
  return Object.assign(promise, { returning: () => Promise.resolve(result) });
}

mock.module('../../../shared/db', () => ({
  hasDatabase: () => true,
  db: {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [SANDBOX_ROW] }) }),
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table, set });
          return chain(
            table === projectSessions ? [{ sessionId: SESSION_ID }] : [{ sandboxId: SESSION_ID }],
          );
        },
      }),
    }),
  },
}));

mock.module('../../prompt-attachments', () => ({
  ...realPromptAttachments,
  releasePromptAttachmentsForSession: async () => undefined,
}));

mock.module('../../lib/session-attachments', () => ({
  ...realSessionAttachments,
  sessionAttachmentStore: () => ({ removeSession: async () => undefined }),
}));

mock.module('../../../billing/services/compute-metering', () => ({
  ...realComputeMetering,
  pauseComputeSession: async () => undefined,
}));

mock.module('../../../repositories/account-tokens', () => ({
  ...realAccountTokens,
  revokeSessionConnectorTokens: async () => undefined,
}));

mock.module('../../../platform/providers', () => ({
  ...realProviders,
  getProvider: () => ({
    remove: async () => {
      removeCalls += 1;
      if (removeError) throw removeError;
    },
    getStatus: async () => providerStatus,
  }),
}));

const { deleteSession } = await import('../actions');
const dialect = new PgDialect();

function compiled(value: unknown): { sql: string; params: unknown[] } {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  // A drizzle SQL fragment, never a plain metadata object.
  expect(typeof (value as { getSQL?: unknown }).getSQL).toBe('function');
  const query = dialect.sqlToQuery(value as Parameters<PgDialect['sqlToQuery']>[0]);
  return { sql: query.sql.replace(/\s+/g, ' '), params: query.params };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  updates = [];
  removeError = null;
  providerStatus = 'running';
  removeCalls = 0;
});

function runDelete() {
  return deleteSession({
    projectId: PROJECT_ID,
    sessionId: SESSION_ID,
    accountId: ACCOUNT_ID,
    userId: 'user-1',
    // A snapshot read by the route before the delete. Its keys must not be
    // written back over the live row.
    metadata: { staleSnapshotKey: 'from-an-earlier-read' },
  });
}

describe('deleteSession — durable provider removal', () => {
  test('the session tombstone is merged in SQL, not written back from a snapshot', async () => {
    expect(await runDelete()).toEqual({ ok: true });
    const tombstone = updates.find((u) => u.table === projectSessions)!;
    const { sql, params } = compiled(tombstone.set.metadata);
    expect(sql).toContain('||');
    expect(JSON.stringify(params)).toContain('deletedAt');
    expect(JSON.stringify(params)).not.toContain('staleSnapshotKey');
  });

  test('the archive strips the restart fence and records the removal intent', async () => {
    await runDelete();
    const archive = updates.find(
      (u) => u.table === sessionSandboxes && u.set.status === 'archived',
    )!;
    expect(archive).toBeDefined();
    const { sql, params } = compiled(archive.set.metadata);
    for (const key of ['runtimeRestartId', 'runtimeRestartLeaseExpiresAt', 'runtimeWakeId', 'runtimeRecoveryLeaseId']) {
      expect(sql).toContain(`- '${key}'`);
    }
    expect(JSON.stringify(params)).toContain('providerRemovalPendingAt');
    // The egress pin and every other concurrent key survive: no whole-object write.
    expect(JSON.stringify(params)).not.toContain('egress_ip');
  });

  test('a confirmed removal clears the intent', async () => {
    await runDelete();
    await settle();
    expect(removeCalls).toBe(1);
    const cleared = updates.filter(
      (u) => u.table === sessionSandboxes && u.set.status === undefined,
    );
    expect(cleared).toHaveLength(1);
    const { sql, params } = compiled(cleared[0]!.set.metadata);
    expect(sql).toContain("- 'providerRemovalPendingAt'");
    expect(JSON.stringify(params)).toContain('providerRemovedAt');
  });

  test('a refused removal keeps the intent and schedules a retry', async () => {
    removeError = new Error('sandbox is in a lifecycle transition');
    providerStatus = 'running';
    await runDelete();
    await settle();
    const followUps = updates.filter(
      (u) => u.table === sessionSandboxes && u.set.status === undefined,
    );
    expect(followUps).toHaveLength(1);
    const { sql, params } = compiled(followUps[0]!.set.metadata);
    expect(sql).not.toContain("- 'providerRemovalPendingAt'");
    const patch = JSON.parse(String(params.find((p) => String(p).includes('providerRemovalAttempts'))));
    expect(patch.providerRemovalAttempts).toBe(1);
    expect(Date.parse(patch.providerRemovalRetryAfterAt)).toBeGreaterThan(Date.now());
  });

  test('a remove that fails because the box is already gone counts as removed', async () => {
    removeError = new Error('not found');
    providerStatus = 'removed';
    await runDelete();
    await settle();
    const followUps = updates.filter(
      (u) => u.table === sessionSandboxes && u.set.status === undefined,
    );
    expect(followUps).toHaveLength(1);
    expect(compiled(followUps[0]!.set.metadata).sql).toContain("- 'providerRemovalPendingAt'");
  });
});
