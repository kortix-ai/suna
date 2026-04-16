import { describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const sandboxRows = [
  {
    sandboxId: '04cf77fc-f258-46d1-8cf2-5ebe47464636',
    accountId: 'owner-account',
    externalId: 'external-04cf77fc',
    provider: 'justavps',
    status: 'active',
    name: 'Owner sandbox',
    baseUrl: 'https://sandbox.example.com',
    metadata: {},
    stripeSubscriptionItemId: null,
    createdAt: new Date('2026-04-15T10:00:00.000Z'),
    updatedAt: new Date('2026-04-15T10:00:00.000Z'),
  },
];

function matchesClause(row: Record<string, any>, clause: any): boolean {
  if (!clause) return true;

  switch (clause.type) {
    case 'eq':
      return row[clause.column] === clause.value;
    case 'ne':
      return row[clause.column] !== clause.value;
    case 'inArray':
      return clause.values.includes(row[clause.column]);
    case 'and':
      return clause.clauses.every((child: any) => matchesClause(row, child));
    default:
      return true;
  }
}

function orderedRows(clause: any) {
  return [...sandboxRows]
    .filter((row) => matchesClause(row, clause))
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function createOrderResult(rows: typeof sandboxRows) {
  return {
    limit: async (count: number) => rows.slice(0, count),
    then: (resolve: (value: typeof sandboxRows) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(rows).then(resolve, reject),
  };
}

const fakeDb = {
  select: () => ({
    from: () => ({
      where: (clause: any) => ({
        orderBy: () => createOrderResult(orderedRows(clause)),
        limit: async (count: number) => orderedRows(clause).slice(0, count),
      }),
    }),
  }),
};

function resolveAccountId(userId: string) {
  if (userId === 'admin-user') return Promise.resolve('admin-account');
  if (userId === 'owner-user') return Promise.resolve('owner-account');
  return Promise.resolve('viewer-account');
}

mock.module('@kortix/db', () => ({
  sandboxes: {
    sandboxId: 'sandboxId',
    accountId: 'accountId',
    status: 'status',
    createdAt: 'createdAt',
  },
}));

mock.module('drizzle-orm', () => ({
  and: (...clauses: any[]) => ({ type: 'and', clauses }),
  desc: (column: string) => ({ type: 'desc', column }),
  eq: (column: string, value: unknown) => ({ type: 'eq', column, value }),
  inArray: (column: string, values: unknown[]) => ({ type: 'inArray', column, values }),
  ne: (column: string, value: unknown) => ({ type: 'ne', column, value }),
  sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
}));

mock.module('../shared/db', () => ({ db: fakeDb }));
mock.module('../middleware/auth', () => ({
  supabaseAuth: async (_c: any, next: any) => next(),
}));
mock.module('../shared/resolve-account', () => ({
  resolveAccountId,
}));
mock.module('../shared/platform-roles', () => ({
  isPlatformAdmin: async (accountId: string) => accountId === 'admin-account',
}));
mock.module('../config', () => ({
  config: {
    JUSTAVPS_DEFAULT_LOCATION: 'ash',
    JUSTAVPS_DEFAULT_SERVER_TYPE: 'starter',
    KORTIX_BILLING_INTERNAL_ENABLED: false,
    isJustAVPSEnabled: () => true,
  },
}));
mock.module('../repositories/api-keys', () => ({
  createApiKey: async () => ({ secretKey: 'kortix_sb_test' }),
}));
mock.module('../pool', () => ({}));
mock.module('../platform/providers/justavps', () => ({
  JustAVPSProvider: class JustAVPSProvider {},
  justavpsFetch: async () => ({}),
  listServerTypes: async () => [],
}));
mock.module('../platform/providers', () => ({
  getProvider: () => ({
    stop: async () => undefined,
    start: async () => undefined,
    remove: async () => undefined,
  }),
  getDefaultProviderName: () => 'justavps',
}));
mock.module('../platform/services/ensure-sandbox', () => ({
  generateSandboxName: async () => 'sandbox-name',
}));

const { createBackupRouter } = await import('../platform/routes/sandbox-backups');
const { createCloudSandboxRouter } = await import('../platform/routes/sandbox-cloud');

function createApp(userId: string) {
  const backupProvider = {
    listBackups: async (externalId: string) => ({
      backups: [{ id: `backup-for-${externalId}`, description: 'Nightly', created: '2026-04-15T10:00:00.000Z', size: 1024, status: 'ready' }],
      backups_enabled: true,
    }),
    createBackup: async () => ({ backup_id: 'new-backup', status: 'creating' }),
    restoreBackup: async () => undefined,
    deleteBackup: async () => undefined,
  };

  const app = new Hono<{ Variables: { userId: string; userEmail: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', userId);
    c.set('userEmail', `${userId}@kortix.dev`);
    await next();
  });
  app.route('/v1/platform/sandbox', createBackupRouter({
    db: fakeDb as any,
    getProvider: () => backupProvider as any,
    resolveAccountId,
    useAuth: false,
  }));
  app.route('/v1/platform/sandbox', createCloudSandboxRouter({
    db: fakeDb as any,
    getProvider: () => ({}) as any,
    getDefaultProviderName: () => 'justavps' as any,
    resolveAccountId,
    useAuth: false,
  }));
  return app;
}

describe('sandbox access helper wiring', () => {
  test('allows admins to list another account\'s backups', async () => {
    const app = createApp('admin-user');
    const res = await app.request('/v1/platform/sandbox/04cf77fc-f258-46d1-8cf2-5ebe47464636/backups');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.backups[0].id).toBe('backup-for-external-04cf77fc');
  });

  test('keeps cross-account backups blocked for non-admin users', async () => {
    const app = createApp('viewer-user');
    const res = await app.request('/v1/platform/sandbox/04cf77fc-f258-46d1-8cf2-5ebe47464636/backups');

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error).toBe('Sandbox not found');
  });

  test('allows admins to read another account\'s sandbox status', async () => {
    const app = createApp('admin-user');
    const res = await app.request('/v1/platform/sandbox/04cf77fc-f258-46d1-8cf2-5ebe47464636/status');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('active');
    expect(body.startedAt).toBe('2026-04-15T10:00:00.000Z');
  });
});
