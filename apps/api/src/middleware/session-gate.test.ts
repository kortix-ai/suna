/**
 * Regression coverage for the session-gate refusal shape (KRTX-2369).
 *
 * PROD, 2026-10-14 20:55–21:00 UTC: one browser kept polling eight account
 * routes with a session the per-account gate had just revoked — 113 warn
 * lines (`GET /v1/accounts/<id>/iam/members/<id>/effective -> 401
 * [HTTPException] session revoked — please sign in again`, ~30/h on the
 * effective route alone) where the gate was working exactly as designed.
 *
 * The gate's refusal is a dead credential in the KRTX-446/1039 sense: the
 * session can never come back, only a fresh sign-in restores access. It must
 * therefore (a) carry the typed body a reading client can stop on (`code:
 * 'session_token_revoked'`) and (b) be marked so the global error handler's
 * dead-credential log throttle bounds the warn lines a NON-reading client
 * produces — the same treatment `deadCredential401` gives PAT and secret-key
 * refusals. The response itself is untouched: still 401, still the same
 * message.
 *
 * Unit boundary: the middleware, given a verdict. The verdict matrix itself
 * is covered in `__tests__/unit-iam-session-gate.test.ts`; the log throttle's
 * window semantics in `shared/dead-credential-log.test.ts`.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';

// The context fields the session gate reads off the request, seeded through a
// small seam: the app itself is untyped (the gate middleware accepts any env)
// and `c.set` needs the key/value pair loosened to match.
type WritableContext = { set: (key: string, value: unknown) => void };

function seedGateContext(c: Context, sessionIat: number): void {
  const writable = c as unknown as WritableContext;
  writable.set('authType', 'supabase');
  writable.set('userId', 'user-1');
  writable.set('sessionId', 'session-1');
  writable.set('sessionIat', sessionIat);
}

interface Logged {
  level: string;
  message: string;
  context?: Record<string, unknown>;
}
const logged: Logged[] = [];
const record =
  (level: string) =>
  (message: string, context?: Record<string, unknown>): void => {
    logged.push({ level, message, context });
  };

mock.module('../lib/logger', () => ({
  logger: {
    debug: record('debug'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    localError: record('localError'),
    localWarn: record('localWarn'),
    flush: async (): Promise<void> => {},
  },
  isLoggingTransportError: () => false,
}));

const markRevokedCalls: string[] = [];

// The verdict `evaluateSessionGate` returns for the next request. `allow`
// (the default) passes through; every dead verdict is refused.
let verdict: 'allow' | 'revoked' | 'idle_timeout' | 'lifetime_exceeded' = 'allow';

mock.module('../iam/session-gate', () => ({
  evaluateSessionGate: () => verdict,
  loadPolicyAndActivity: async () => ({
    // An opted-in account, so the gate never short-circuits before the
    // verdict under test.
    maxLifetimeMinutes: 60,
    idleTimeoutMinutes: 15,
    lastSeenAt: new Date(Date.now() - 60_000),
    revokedAt: null,
  }),
  markRevoked: async (_accountId: string, _userId: string, _sessionId: string, reason: string) => {
    markRevokedCalls.push(reason);
    return { revoked: true };
  },
  touchActivity: async () => ({ firstSight: false }),
}));

mock.module('./auth-audit', () => ({
  auditSessionFirstSight: async () => undefined,
}));

const { accountSessionGate } = await import('./session-gate');
const { installHttpErrors } = await import('../http-errors');
const { resetDeadCredentialLogForTests, isDeadCredential } = await import('../shared/dead-credential-log');

const ACCOUNT = 'a5ddd8d5-c8f2-4c54-9b64-842b2ad31ceb';
const EFFECTIVE_PATH = `/v1/accounts/${ACCOUNT}/iam/members/22222222-2222-4222-8222-222222222222/effective`;

interface Captured {
  err: unknown;
}

function gateApp(): { app: OpenAPIHono; captured: Captured } {
  const captured: Captured = { err: null };
  const app = new OpenAPIHono();
  app.use('*', async (c, next) => {
    seedGateContext(c, 1_700_000_000);
    await next();
  });
  app.use('/v1/accounts/:accountId/*', accountSessionGate());
  app.get('/v1/accounts/:accountId/iam/members/:memberId/effective', (c) => c.json({ ran: true }));
  app.onError((err, c) => {
    captured.err = err;
    // Mirror the global handler's first move: an exception built with an
    // explicit `res` (the typed dead-credential body) is returned verbatim.
    const res = (err as { res?: Response }).res;
    if (res) return res;
    return c.json({ error: true, message: (err as Error).message, status: 401 }, 401);
  });
  return { app, captured };
}

function bareGateApp(): OpenAPIHono {
  // No custom onError: the global handler (`installHttpErrors`) is what prod
  // serves through, so the log throttle and the typed body show up here.
  const app = new OpenAPIHono();
  app.use('*', async (c, next) => {
    seedGateContext(c, 1_700_000_000);
    await next();
  });
  app.use('/v1/accounts/:accountId/*', accountSessionGate());
  app.get('/v1/accounts/:accountId/iam/members/:memberId/effective', (c) => c.json({ ran: true }));
  installHttpErrors(app);
  return app;
}

beforeEach(() => {
  logged.length = 0;
  markRevokedCalls.length = 0;
  verdict = 'allow';
  resetDeadCredentialLogForTests();
});

describe('session-gate refusal shape (KRTX-2369)', () => {
  test('a revoked session is refused with the typed dead-credential body and the handler never runs', async () => {
    verdict = 'revoked';
    const res = await gateApp().app.request(EFFECTIVE_PATH);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('session_token_revoked');
    expect(body.message).toBe('session revoked — please sign in again');
    expect(body.error).toBe(true);
    expect(body.status).toBe(401);
    expect((body as { ran?: string }).ran).toBeUndefined();
  });

  test('the refusal carries the dead-credential mark the global handler throttles on', async () => {
    verdict = 'revoked';
    const { app, captured } = gateApp();
    await app.request(EFFECTIVE_PATH);
    expect(captured.err).toBeInstanceOf(Error);
    expect(isDeadCredential(captured.err as never)).toBe(true);
  });

  test('a client that keeps polling a revoked session produces ONE warn line, not one per refusal', async () => {
    verdict = 'revoked';
    const app = bareGateApp();
    const before = logged.length;
    for (let i = 0; i < 6; i += 1) {
      const res = await app.request(EFFECTIVE_PATH);
      expect(res.status).toBe(401);
      expect((await res.json()).code).toBe('session_token_revoked');
    }
    expect(logged.slice(before).filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });

  test('idle-timeout and lifetime refusals carry the typed body too, and still mark the session revoked', async () => {
    verdict = 'idle_timeout';
    const res = await gateApp().app.request(EFFECTIVE_PATH);
    expect(res.status).toBe(401);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('session_token_revoked');
    expect(body.message).toBe('session idle timeout — please sign in again');
    expect(markRevokedCalls).toContain('idle');

    verdict = 'lifetime_exceeded';
    const res2 = await bareGateApp().request(EFFECTIVE_PATH);
    expect(res2.status).toBe(401);
    const body2 = (await res2.json()) as Record<string, unknown>;
    expect(body2.code).toBe('session_token_revoked');
    expect(body2.message).toBe('session lifetime exceeded — please sign in again');
    expect(markRevokedCalls).toContain('lifetime');
  });

  test('a live session still passes through the gate untouched', async () => {
    verdict = 'allow';
    const res = await gateApp().app.request(EFFECTIVE_PATH);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ran: true });
    expect(logged.filter((entry) => entry.level === 'warn')).toHaveLength(0);
  });
});
