// Contract of POST /v1/feedback with an in-memory store, a stub auth
// middleware and a pass-through rate limiter (DI, no mock.module). The real
// rate limiter is proven in rate-limit.test.ts and the SQL insert in
// store.integration.test.ts.
import { describe, expect, test } from 'bun:test';
import type { MiddlewareHandler } from 'hono';
import type { FeedbackRow, FeedbackStore, InsertFeedbackInput } from './index';
import { createFeedbackApp, FEEDBACK_KINDS, FEEDBACK_SOURCES } from './index';

const USER_A = '00000000-0000-4000-8000-00000000000a';
const USER_B = '00000000-0000-4000-8000-00000000000b';
const ACCOUNT = '00000000-0000-4000-8000-0000000000aa';

function memoryStore() {
  const rows: FeedbackRow[] = [];
  const store: FeedbackStore = {
    async insert(input) {
      const row: FeedbackRow = {
        id: crypto.randomUUID(),
        userId: input.userId,
        accountId: input.accountId,
        source: input.source,
        kind: input.kind,
        message: input.message,
        context: input.context,
        createdAt: new Date(),
      };
      rows.push(row);
      return row;
    },
  };
  return { store, rows };
}

type Identity = { userId?: string; accountId?: string } | null;

function appFor(memory: ReturnType<typeof memoryStore>) {
  const authMiddleware: MiddlewareHandler = async (c, next) => {
    const raw = c.req.header('x-test-identity');
    const identity = raw ? (JSON.parse(raw) as Identity) : null;
    if (!identity) return c.json({ error: true, message: 'Unauthorized', status: 401 }, 401);
    if (identity.userId) c.set('userId', identity.userId);
    if (identity.accountId) c.set('accountId', identity.accountId);
    await next();
  };
  const rateLimitMiddleware: MiddlewareHandler = async (_c, next) => next();
  const app = createFeedbackApp({ store: memory.store, authMiddleware, rateLimitMiddleware });
  return { app, memory };
}

function post(app: ReturnType<typeof createFeedbackApp>, body: unknown, identity?: Identity) {
  return app.request('/', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(identity ? { 'x-test-identity': JSON.stringify(identity) } : {}),
    },
    body: JSON.stringify(body),
  });
}

const VALID = { kind: 'idea', message: 'The CLI should remember my last project.' };

describe('POST /v1/feedback contract', () => {
  test('an unauthenticated call is rejected and nothing is stored', async () => {
    const { app, memory } = appFor(memoryStore());
    const r = await post(app, VALID);
    expect(r.status).toBe(401);
    expect(memory.rows).toHaveLength(0);
  });

  test('a valid payload is persisted and returns the receipt', async () => {
    const memory = memoryStore();
    const { app } = appFor(memory);
    const r = await post(
      app,
      { ...VALID, source: 'agent', context: { session_id: 'sess-1' } },
      { userId: USER_A, accountId: ACCOUNT },
    );
    expect(r.status).toBe(201);
    const receipt = await r.json();
    expect(receipt).toMatchObject({
      source: 'agent',
      kind: 'idea',
    });
    expect(receipt.id).toBeString();
    expect(receipt.created_at).toBeString();
    expect(memory.rows).toHaveLength(1);
    expect(memory.rows[0]).toMatchObject({
      userId: USER_A,
      accountId: ACCOUNT,
      source: 'agent',
      kind: 'idea',
      message: VALID.message,
      context: { session_id: 'sess-1' },
    });
    expect(receipt.id).toBe(memory.rows[0]!.id);
  });

  test('source defaults to cli; every allowed kind and source is accepted', async () => {
    const memory = memoryStore();
    const { app } = appFor(memory);
    for (const kind of FEEDBACK_KINDS) {
      const r = await post(app, { kind, message: 'm' }, { userId: USER_A });
      expect(r.status).toBe(201);
      expect((await r.json()).source).toBe('cli');
    }
    for (const source of FEEDBACK_SOURCES) {
      const r = await post(app, { kind: 'bug', message: 'm', source }, { userId: USER_B });
      expect(r.status).toBe(201);
    }
    expect(memory.rows).toHaveLength(FEEDBACK_KINDS.length + FEEDBACK_SOURCES.length);
  });

  test('invalid payloads are rejected with 400 and nothing is stored', async () => {
    const memory = memoryStore();
    const { app } = appFor(memory);
    const bad = [
      { message: 'missing kind' },
      { kind: 'idea' }, // missing message
      { kind: 'complaint', message: 'unknown kind' },
      { kind: 'idea', message: '', source: 'cli' },
      { kind: 'idea', message: 'x'.repeat(4001) },
      { kind: 'idea', message: 'm', source: 'sms' },
      { kind: 'idea', message: 'm', context: { session_id: 'x'.repeat(257) } },
      { kind: 'idea', message: 'm', context: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`k${i}`, 'v'])) },
    ];
    for (const body of bad) {
      const r = await post(app, body, { userId: USER_A });
      expect(r.status).toBe(400);
    }
    expect(memory.rows).toHaveLength(0);
  });

  test('the receipt shape omits the caller identity but the row keeps it', async () => {
    const memory = memoryStore();
    const { app } = appFor(memory);
    const r = await post(app, VALID, { userId: USER_A, accountId: ACCOUNT });
    const receipt = await r.json();
    expect(JSON.stringify(receipt)).not.toContain(USER_A);
    expect(memory.rows[0]!.userId).toBe(USER_A);
  });
});

describe('InsertFeedbackInput round-trip', () => {
  test('a null context and null account store as SQL NULLs (typed through the store)', async () => {
    const { store, rows } = memoryStore();
    const input: InsertFeedbackInput = {
      userId: USER_A,
      accountId: null,
      source: 'web',
      kind: 'friction',
      message: 'no context',
      context: null,
    };
    await store.insert(input);
    expect(rows[0]).toMatchObject({ accountId: null, context: null, source: 'web', kind: 'friction' });
  });
});
