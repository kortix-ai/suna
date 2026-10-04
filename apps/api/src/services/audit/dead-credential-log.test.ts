/** Regression coverage for best-effort dead-credential warning suppression.
 * Pending counts are emitted only when another refusal opens the next window;
 * quiet bursts, eviction and restart can lose counts. Auth audits and
 * request-completion logs remain the exact accounting surfaces.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';
import { HTTPException } from 'hono/http-exception';

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

mock.module('../../lib/logger', () => ({
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

const { deadCredentialLogDecision, isDeadCredential, markDeadCredential, resetDeadCredentialLogForTests } =
  await import('./dead-credential-log');
const { installHttpErrors } = await import('../../http/middleware/http-errors');

// What resolvePat throws for a dead credential: the typed deadCredential401
// body, marked. http/middleware/auth.test.ts pins that deadCredential401 itself
// marks; this file pins what the mark does at the error handler.
function deadCredential401Like(): HTTPException {
  const err = new HTTPException(401, {
    message: 'PAT not found or revoked',
    res: new Response(
      JSON.stringify({ error: true, message: 'PAT not found or revoked', status: 401, code: 'session_token_revoked' }),
      { status: 401, headers: { 'content-type': 'application/json' } },
    ),
  });
  markDeadCredential(err);
  return err;
}

describe('dead-credential log decision', () => {
  test('the first refusal of a message logs, repeats inside the window are suppressed with the count kept', () => {
    resetDeadCredentialLogForTests();
    let now = 1_000_000;
    expect(deadCredentialLogDecision('POST /p -> 401 [HTTPException] PAT not found or revoked', now)).toEqual({
      log: true,
      suppressed: 0,
    });
    for (let i = 1; i <= 4; i += 1) {
      now += 5_000;
      expect(deadCredentialLogDecision('POST /p -> 401 [HTTPException] PAT not found or revoked', now)).toEqual({
        log: false,
        suppressed: 0,
      });
    }
  });

  test('the next logged line after the window carries the volume suppressed since the previous one', () => {
    resetDeadCredentialLogForTests();
    let now = 2_000_000;
    const key = 'POST /p -> 401 [HTTPException] PAT not found or revoked';
    expect(deadCredentialLogDecision(key, now).log).toBe(true);
    for (let i = 0; i < 3; i += 1) {
      now += 1_000;
      deadCredentialLogDecision(key, now);
    }
    now += 601_000;
    const next = deadCredentialLogDecision(key, now);
    expect(next.log).toBe(true);
    expect(next.suppressed).toBe(3);
    // The count resets with the window: a refusal long after the burst does
    // not inherit the stale volume.
    now += 601_000;
    const later = deadCredentialLogDecision(key, now);
    expect(later.log).toBe(true);
    expect(later.suppressed).toBe(0);
  });

  test('a different message logs independently of another one inside its window', () => {
    resetDeadCredentialLogForTests();
    const now = 3_000_000;
    expect(deadCredentialLogDecision('POST /p/turn-stream -> 401 [HTTPException] PAT not found or revoked', now).log).toBe(true);
    expect(deadCredentialLogDecision('POST /p/audit/events -> 401 [HTTPException] PAT not found or revoked', now).log).toBe(true);
    expect(deadCredentialLogDecision('POST /p/turn-stream -> 401 [HTTPException] PAT not found or revoked', now + 1_000).log).toBe(false);
  });

  test('the tracked-window map is bounded: the oldest key is evicted past the cap', () => {
    resetDeadCredentialLogForTests();
    const now = 4_000_000;
    // Past the cap, the first key must have been evicted, so it logs again
    // immediately instead of being suppressed forever.
    expect(deadCredentialLogDecision('key-a', now).log).toBe(true);
    for (let i = 0; i < 20_000; i += 1) deadCredentialLogDecision(`key-${i}`, now);
    expect(deadCredentialLogDecision('key-a', now + 1_000).log).toBe(true);
  });
});

describe('dead-credential exceptions are marked and throttled at the error handler', () => {
  // The route throws what resolvePat throws for a dead credential. Five
  // identical refusals must produce ONE warn line (suppressed 0 on the first
  // window) — five lines is the spike this throttles.
  function appWithDeadCredentialThrow(): OpenAPIHono {
    const app = new OpenAPIHono();
    installHttpErrors(app);
    app.post('/v1/projects/:projectId/turn-stream', () => {
      throw deadCredential401Like();
    });
    app.post('/v1/plain', () => {
      throw new HTTPException(401, { message: 'Invalid PAT' });
    });
    return app;
  }

  test('an unmarked 401 still logs one warn line per refusal', () => {
    const app = appWithDeadCredentialThrow();
    const before = logged.length;
    for (let i = 0; i < 3; i += 1) app.request('/v1/plain', { method: 'POST' });
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(3);
    for (const warn of warns) {
      expect(warn.message).toContain('-> 401 [HTTPException] Invalid PAT');
      expect(warn.context?.suppressed).toBeUndefined();
    }
  });

  test('five identical dead-credential refusals log one warn line, carrying the response body verbatim', async () => {
    const app = appWithDeadCredentialThrow();
    const before = logged.length;
    let lastBody = '';
    for (let i = 0; i < 5; i += 1) {
      const res = await app.request('/v1/projects/p/turn-stream', { method: 'POST' });
      expect(res.status).toBe(401);
      lastBody = await res.text();
    }
    expect(JSON.parse(lastBody)).toEqual({
      error: true,
      message: 'PAT not found or revoked',
      status: 401,
      code: 'session_token_revoked',
    });
    const warns = logged.slice(before).filter((l) => l.level === 'warn');
    expect(warns).toHaveLength(1);
    const first = warns[0];
    if (!first) throw new Error('expected the first refusal warning');
    expect(first.message).toContain('-> 401 [HTTPException] PAT not found or revoked');
    expect(first.context?.suppressed).toBe(0);
    expect(first.context?.reason).toBe('PAT not found or revoked');
  });

  test('fifteen project paths share one refusal window', async () => {
    resetDeadCredentialLogForTests();
    const app = appWithDeadCredentialThrow();
    const before = logged.length;
    for (let i = 0; i < 15; i += 1) {
      const projectId = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      const response = await app.request(`/v1/projects/${projectId}/turn-stream`, { method: 'POST' });
      expect(response.status).toBe(401);
      expect((await response.json()).code).toBe('session_token_revoked');
    }
    expect(logged.slice(before).filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });

  test('marking is what routes the line through the throttle', () => {
    const plain = new HTTPException(401, { message: 'Invalid PAT' });
    const marked = new HTTPException(401, { message: 'PAT not found or revoked' });
    markDeadCredential(marked);
    expect(isDeadCredential(marked)).toBe(true);
    expect(isDeadCredential(plain)).toBe(false);
  });
});
