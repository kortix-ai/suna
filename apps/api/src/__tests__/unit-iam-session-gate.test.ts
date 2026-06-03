import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Hono } from 'hono';

const nowMs = 1_700_000_000_000;
const realDateNow = Date.now;

const state = {
  policyRows: [] as Array<{
    maxLifetimeMinutes: number | null;
    idleTimeoutMinutes: number | null;
    lastSeenAt: Date | null;
    revokedAt: Date | null;
  }>,
  revocations: [] as Array<Record<string, unknown>>,
  touches: 0,
};

const fakeDb = {
  select: () => ({
    from: () => ({
      leftJoin: () => ({
        where: () => ({
          limit: async (count: number) => state.policyRows.slice(0, count),
        }),
      }),
    }),
  }),
  insert: () => ({
    values: (values: Record<string, unknown>) => ({
      onConflictDoUpdate: async () => {
        state.revocations.push(values);
      },
    }),
  }),
  execute: async () => {
    state.touches += 1;
    return { rows: [{ first_sight: false }] };
  },
};

mock.module('../shared/db', () => ({ db: fakeDb }));
mock.module('../shared/auth-audit', () => ({
  auditSessionFirstSight: () => undefined,
}));

const { accountSessionGate } = await import('../iam/session-gate');

beforeEach(() => {
  Date.now = () => nowMs;
  state.policyRows = [];
  state.revocations = [];
  state.touches = 0;
});

afterEach(() => {
  Date.now = realDateNow;
});

describe('accountSessionGate', () => {
  test('no policy -> allow without touching activity', async () => {
    state.policyRows = [policy()];

    const res = await request();

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(state.touches).toBe(0);
    expect(state.revocations).toEqual([]);
  });

  test('revoked_at denies without overwriting the existing revocation', async () => {
    state.policyRows = [policy({
      maxLifetimeMinutes: 60,
      idleTimeoutMinutes: 60,
      lastSeenAt: new Date(nowMs - 1_000),
      revokedAt: new Date(nowMs - 10_000),
    })];

    const res = await request();

    expect(res.status).toBe(401);
    expect(await res.text()).toContain('session revoked');
    expect(state.revocations).toEqual([]);
  });

  test('max lifetime exceeded denies and records lifetime revocation', async () => {
    state.policyRows = [policy({
      maxLifetimeMinutes: 60,
      lastSeenAt: new Date(nowMs - 1_000),
    })];

    const res = await request({ sessionIat: nowMs / 1000 - 2 * 60 * 60 });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain('session lifetime exceeded');
    expect(state.revocations[0]).toMatchObject({ revokedReason: 'lifetime' });
  });

  test('max lifetime within bounds allows and refreshes activity', async () => {
    state.policyRows = [policy({
      maxLifetimeMinutes: 60,
      lastSeenAt: new Date(nowMs - 2 * 60_000),
    })];

    const res = await request({ sessionIat: nowMs / 1000 - 30 * 60 });

    expect(res.status).toBe(200);
    expect(state.touches).toBe(1);
    expect(state.revocations).toEqual([]);
  });

  test('max lifetime is skipped when iat is missing', async () => {
    state.policyRows = [policy({
      maxLifetimeMinutes: 60,
      lastSeenAt: new Date(nowMs - 2 * 60_000),
    })];

    const res = await request({ sessionIat: undefined });

    expect(res.status).toBe(200);
    expect(state.revocations).toEqual([]);
  });

  test('idle timeout exceeded denies and records idle revocation', async () => {
    state.policyRows = [policy({
      idleTimeoutMinutes: 15,
      lastSeenAt: new Date(nowMs - 30 * 60 * 1000),
    })];

    const res = await request();

    expect(res.status).toBe(401);
    expect(await res.text()).toContain('session idle timeout');
    expect(state.revocations[0]).toMatchObject({ revokedReason: 'idle' });
  });

  test('idle timeout is skipped on first sight', async () => {
    state.policyRows = [policy({
      idleTimeoutMinutes: 5,
      lastSeenAt: null,
    })];

    const res = await request();

    expect(res.status).toBe(200);
    expect(state.revocations).toEqual([]);
  });

  test('lifetime is checked before idle', async () => {
    state.policyRows = [policy({
      maxLifetimeMinutes: 60,
      idleTimeoutMinutes: 5,
      lastSeenAt: new Date(nowMs - 24 * 60 * 60 * 1000),
    })];

    const res = await request({ sessionIat: nowMs / 1000 - 24 * 60 * 60 });

    expect(res.status).toBe(401);
    expect(await res.text()).toContain('session lifetime exceeded');
    expect(state.revocations[0]).toMatchObject({ revokedReason: 'lifetime' });
  });

  test('non-Supabase auth skips the gate', async () => {
    state.policyRows = [policy({ revokedAt: new Date(nowMs - 1_000) })];

    const res = await request({ authType: 'api_key' });

    expect(res.status).toBe(200);
    expect(state.revocations).toEqual([]);
  });
});

function policy(overrides: Partial<(typeof state.policyRows)[number]> = {}) {
  return {
    maxLifetimeMinutes: null,
    idleTimeoutMinutes: null,
    lastSeenAt: null,
    revokedAt: null,
    ...overrides,
  };
}

async function request(opts: {
  authType?: string;
  sessionIat?: number;
} = {}) {
  const app = new Hono<{
    Variables: {
      authType: string;
      userId: string;
      sessionId: string;
      sessionIat: number;
    };
  }>();
  app.use('/accounts/:accountId/*', async (c, next) => {
    c.set('authType', opts.authType ?? 'supabase');
    c.set('userId', 'user-1');
    c.set('sessionId', 'session-1');
    if (opts.sessionIat !== undefined) c.set('sessionIat', opts.sessionIat);
    await next();
  });
  app.use('/accounts/:accountId/*', accountSessionGate());
  app.get('/accounts/:accountId/probe', (c) => c.text('ok'));

  return app.request('/accounts/acct-1/probe', {
    headers: {
      'x-forwarded-for': '203.0.113.5',
      'user-agent': 'unit-test',
    },
  });
}
