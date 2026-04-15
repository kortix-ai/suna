import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const sandboxRow = {
  sandboxId: '21fe49f9-e1fa-48dc-9cba-0cb1cafbdaf0',
  accountId: 'acct_test',
  provider: 'justavps',
  metadata: {
    updateStatus: {
      phase: 'verifying',
      progress: 80,
      message: 'Verifying new container...',
      targetVersion: '0.8.41',
      previousVersion: '0.8.40',
      currentVersion: '0.8.40',
      error: null,
      startedAt: '2026-04-15T01:20:00.000Z',
      updatedAt: '2026-04-15T01:28:21.502Z',
      backupId: null,
      diagnostics: {},
    },
  },
};

function mergeMetadataPatch(target: Record<string, unknown>, value: unknown) {
  if (typeof value !== 'string') return target;
  const patch = JSON.parse(value) as Record<string, unknown>;
  return { ...target, ...patch };
}

mock.module('../middleware/auth', () => ({
  combinedAuth: async (c: any, next: any) => {
    c.set('userId', 'user_test');
    c.set('userEmail', 'test@kortix.dev');
    await next();
  },
}));

mock.module('../shared/resolve-account', () => ({
  resolveAccountId: async () => 'acct_test',
}));

mock.module('../config', () => ({
  config: {
    SANDBOX_IMAGE: 'kortix/computer:0.8.41',
  },
}));

mock.module('../shared/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [sandboxRow],
        }),
      }),
    }),
    update: () => ({
      set: (payload: Record<string, unknown>) => {
        if ('metadata' in payload && payload.metadata && typeof payload.metadata === 'object' && 'values' in (payload.metadata as any)) {
          const sqlPayload = payload.metadata as { values: unknown[] };
          sandboxRow.metadata = mergeMetadataPatch(sandboxRow.metadata, sqlPayload.values[0]);
        }
        return {
          where: async () => undefined,
        };
      },
    }),
  },
}));

mock.module('@kortix/db', () => ({
  sandboxes: {
    sandboxId: 'sandboxId',
    accountId: 'accountId',
    metadata: 'metadata',
  },
}));

mock.module('drizzle-orm', () => ({
  eq: (...args: unknown[]) => ({ type: 'eq', args }),
  and: (...args: unknown[]) => ({ type: 'and', args }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

mock.module('../platform/providers/local-docker', () => ({
  LocalDockerProvider: class LocalDockerProvider {},
  getSandboxUpdateStatus: () => ({ phase: 'idle', progress: 0, message: '' }),
  resetSandboxUpdateStatus: () => undefined,
}));

mock.module('../platform/providers', () => ({
  getProvider: () => { throw new Error('not used in GET /status test'); },
}));

mock.module('../update/executor', () => ({
  executeUpdate: async () => undefined,
}));

process.env.SANDBOX_VERSION = '0.8.41';

const { sandboxIdUpdateRouter } = await import('../platform/routes/sandbox-update');

function createApp() {
  const app = new Hono();
  app.route('/v1/platform/sandbox/:id/update', sandboxIdUpdateRouter);
  return app;
}

describe('sandbox update status route', () => {
  test('recovers self-update from verifying to complete', async () => {
    const app = createApp();

    const res = await app.request(`/v1/platform/sandbox/${sandboxRow.sandboxId}/update/status`);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.phase).toBe('complete');
    expect(body.progress).toBe(100);
    expect(body.currentVersion).toBe('0.8.41');
    expect(body.message).toBe('Updated to v0.8.41');
  });

  test('allows cancelling while backup is still running', async () => {
    sandboxRow.metadata.updateStatus = {
      phase: 'backing_up',
      progress: 8,
      message: 'Creating backup…',
      targetVersion: '0.8.41',
      previousVersion: '0.8.40',
      currentVersion: '0.8.40',
      error: null,
      startedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      backupId: '376617057',
      cancelRequested: false,
      diagnostics: { stage: 'waiting_for_backup', providerStatus: 'creating' },
    };

    const app = createApp();
    const res = await app.request(`/v1/platform/sandbox/${sandboxRow.sandboxId}/update/cancel`, { method: 'POST' });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.status.cancelRequested).toBe(true);
    expect(body.status.phase).toBe('failed');
    expect(body.status.message).toBe('Update cancelled before destructive changes started');
    expect(body.status.error).toBe('Update cancelled before destructive changes started');
  });
});
