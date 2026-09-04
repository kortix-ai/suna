import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
const ACCOUNT_ID = '44444444-4444-4444-8444-444444444444';
const USER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION_ID = '55555555-5555-4555-8555-555555555555';
const APPEND_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

interface StoredLogItem {
  id: number;
  sessionId: string;
  appendId: string | null;
  item: Record<string, unknown>;
}

let logRows: StoredLogItem[] = [];
let pendingAppendId: string | null = null;

mock.module('../../shared/db', () => ({
  hasDatabase: true,
  db: {
    select: (selection: Record<string, unknown>) => ({
      from: () => ({
        where: () => ({
          limit: async () => {
            if ('metadata' in selection) return [{ metadata: {} }];
            const row = logRows.find((candidate) => candidate.appendId === pendingAppendId);
            return row ? [{ item: row.item }] : [];
          },
          orderBy: async () => logRows.map((row) => ({ item: row.item })),
        }),
      }),
    }),
    insert: () => ({
      values: (value: Omit<StoredLogItem, 'id'> & { appendId?: string | null }) => {
        pendingAppendId = value.appendId ?? null;
        const insert = () => {
          const duplicate =
            typeof value.appendId !== 'string'
              ? undefined
              : logRows.find(
                  (row) => row.sessionId === value.sessionId && row.appendId === value.appendId,
                );
          if (duplicate) return [];
          logRows.push({ ...value, appendId: value.appendId ?? null, id: logRows.length + 1 });
          return [{ item: value.item }];
        };
        return {
          onConflictDoNothing: () => ({ returning: async () => insert() }),
          then: (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
            Promise.resolve(insert()).then(resolve, reject),
        };
      },
    }),
  },
}));

mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: { accountId: ACCOUNT_ID, projectId: PROJECT_ID },
  }),
  assertProjectCapability: async () => {},
}));

mock.module('../lib/caller-session', () => ({ callerKortixSessionId: () => null }));

const { projectsApp } = await import('../lib/app');
await import('./session-log');

function buildApp() {
  const app = new Hono<{ Variables: { userId: string; authType: string } }>();
  app.use('*', async (c, next) => {
    c.set('userId', USER_ID);
    c.set('authType', 'pat');
    await next();
  });
  app.route('/v1/projects', projectsApp);
  return app;
}

function append(item: Record<string, unknown>, appendId: string | null = APPEND_ID) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (appendId !== null) headers['idempotency-key'] = appendId;
  return buildApp().request(
    `/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/log`,
    { method: 'POST', headers, body: JSON.stringify(item) },
  );
}

function read() {
  return buildApp().request(`/v1/projects/${PROJECT_ID}/sessions/${SESSION_ID}/log`);
}

beforeEach(() => {
  logRows = [];
  pendingAppendId = null;
});

describe('session worker log HTTP contract', () => {
  test('a byte-identical retry under one idempotency key stores one item', async () => {
    const item = { kind: 'entry', lane: 'main', entry: { id: 'message-1' } };

    expect((await append(item)).status).toBe(204);
    expect((await append(item)).status).toBe(204);

    const response = await read();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([item]);
  });

  test('reusing an idempotency key for different content returns 409 and preserves the first item', async () => {
    const first = { kind: 'name', name: 'first' };
    expect((await append(first)).status).toBe(204);

    const conflict = await append({ kind: 'name', name: 'different' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: 'idempotency key reused with different item' });

    expect(await (await read()).json()).toEqual([first]);
  });

  test('accepts a missing key during the mixed-version rollout and rejects a malformed key', async () => {
    expect((await append({ kind: 'name', name: 'legacy' }, null)).status).toBe(204);
    expect((await append({ kind: 'name', name: 'invalid' }, 'not-a-uuid')).status).toBe(400);
    expect(await (await read()).json()).toEqual([{ kind: 'name', name: 'legacy' }]);
  });
});
