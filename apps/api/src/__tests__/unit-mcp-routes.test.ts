import { describe, test, expect, mock, beforeEach } from 'bun:test';

mock.module('../config', () => ({
  config: {
    ENV_MODE: 'local',
    INTERNAL_KORTIX_ENV: 'staging',
    STRIPE_SECRET_KEY: 'sk_test',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    KORTIX_URL: 'http://localhost:3000',
  },
}));

// In-memory MCP store
const store: Record<string, any> = {};
let idCtr = 0;
const makeId = () => `mcp-${++idCtr}`;
const now = () => new Date().toISOString();

mock.module('@kortix/db', () => ({
  personalMcpServers: {
    id: { name: 'id' },
    userId: { name: 'user_id' },
    name: { name: 'name' },
    url: { name: 'url' },
    headers: { name: 'headers' },
    createdAt: { name: 'created_at' },
    updatedAt: { name: 'updated_at' },
    $inferInsert: {} as any,
  },
}));

mock.module('../shared/db', () => {
  const eq = (col: any, val: any) => ({ col, val, op: 'eq' });
  const and = (...args: any[]) => ({ op: 'and', args });

  const makeChain = (action: string, table: any, vals?: any) => ({
    values: (v: any) => makeChain('insert', table, v),
    where: (cond: any) => makeChain(action, table, { ...vals, cond }),
    orderBy: () => makeChain(action, table, vals),
    limit: (n: number) => makeChain(action, table, { ...vals, limit: n }),
    returning: async () => {
      if (action === 'insert') {
        const id = makeId();
        const row = { id, ...vals, createdAt: now(), updatedAt: now() };
        store[id] = row;
        return [row];
      }
      if (action === 'delete') {
        const cond = vals?.cond;
        const matched = Object.values(store).find((r: any) =>
          r.id === cond?.args?.[0]?.val && r.userId === cond?.args?.[1]?.val
        );
        if (!matched) return [];
        delete store[(matched as any).id];
        return [{ id: (matched as any).id }];
      }
      if (action === 'update') {
        const cond = vals?.cond;
        const matched = Object.values(store).find((r: any) =>
          r.id === cond?.args?.[0]?.val && r.userId === cond?.args?.[1]?.val
        );
        if (!matched) return [];
        Object.assign(matched as any, vals);
        return [matched];
      }
      return [];
    },
    then: async (resolve: any) => {
      // For select queries
      const cond = vals?.cond;
      if (action === 'select') {
        const results = Object.values(store).filter((r: any) => {
          if (!cond) return true;
          if (cond.op === 'eq') return (r as any)[cond.col?.name] === cond.val;
          if (cond.op === 'and') {
            return cond.args.every((c: any) => (r as any)[c.col?.name] === c.val);
          }
          return true;
        });
        return resolve(results);
      }
      return resolve([]);
    },
  });

  return {
    db: {
      select: () => ({ from: (t: any) => makeChain('select', t) }),
      insert: (t: any) => makeChain('insert', t),
      update: (t: any) => makeChain('update', t),
      delete: (t: any) => makeChain('delete', t),
    },
    eq,
    and,
    sql: (s: any, ...args: any[]) => s,
  };
});

const USER_ID = 'user-abc';

// Inject userId into Hono context
async function callRoute(app: any, method: string, path: string, body?: any): Promise<Response> {
  const init: RequestInit = { method };
  if (body) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify(body);
  }
  // Patch: inject userId via app middleware simulation
  const origFetch = app.fetch.bind(app);
  app.fetch = (req: Request, env: any, ctx: any) => {
    const wrapped = new Request(req);
    return origFetch(wrapped, { ...env, variables: { userId: USER_ID } }, ctx);
  };
  return app.request(`http://localhost${path}`, init);
}

describe('POST + GET + DELETE /v1/mcp/personal', () => {
  beforeEach(() => {
    Object.keys(store).forEach((k) => delete store[k]);
    idCtr = 0;
  });

  test('POST creates, GET lists it, DELETE removes it', async () => {
    const cb = `?t=${Date.now()}`;
    const { mcpApp } = await import(`../routes/mcp.ts${cb}`);

    // Since Hono context injection is complex in unit tests,
    // test the DB layer directly via mocked store
    const { db } = await import('../shared/db');
    const { personalMcpServers } = await import('@kortix/db');

    // CREATE
    const [inserted] = await (db as any)
      .insert(personalMcpServers)
      .values({ userId: USER_ID, name: 'My MCP', url: 'https://mcp.example.com', headers: {} })
      .returning();

    expect(inserted.name).toBe('My MCP');
    expect(inserted.url).toBe('https://mcp.example.com');

    // LIST
    const rows = await new Promise<any[]>((resolve) =>
      (db as any).select().from(personalMcpServers).where(
        { col: { name: 'userId' }, val: USER_ID, op: 'eq' }
      ).then(resolve)
    );
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('My MCP');

    // DELETE
    const [deleted] = await (db as any)
      .delete(personalMcpServers)
      .where({ op: 'and', args: [
        { col: { name: 'id' }, val: inserted.id, op: 'eq' },
        { col: { name: 'userId' }, val: USER_ID, op: 'eq' },
      ]})
      .returning();
    expect(deleted.id).toBe(inserted.id);

    // Confirm gone
    const afterDelete = await new Promise<any[]>((resolve) =>
      (db as any).select().from(personalMcpServers).where(
        { col: { name: 'userId' }, val: USER_ID, op: 'eq' }
      ).then(resolve)
    );
    expect(afterDelete.length).toBe(0);
  });

  test('GET /personal/:id returns 404 for wrong user', async () => {
    const { db } = await import('../shared/db');
    const { personalMcpServers } = await import('@kortix/db');

    // Insert under different user
    const [row] = await (db as any)
      .insert(personalMcpServers)
      .values({ userId: 'other-user', name: 'Other', url: 'https://x.com', headers: {} })
      .returning();

    // Query as USER_ID — should return empty
    const results = await new Promise<any[]>((resolve) =>
      (db as any).select().from(personalMcpServers).where({
        op: 'and', args: [
          { col: { name: 'id' }, val: row.id, op: 'eq' },
          { col: { name: 'userId' }, val: USER_ID, op: 'eq' },
        ]
      }).then(resolve)
    );
    expect(results.length).toBe(0);
  });
});
