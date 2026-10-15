/**
 * Regression for Better Stack pattern `6bc03d7d…` (frontend app 2346967,
 * `ApiError: Internal server error`) driven by the Kortix API pattern
 * `POST /v1/projects/:id/apps/:appId/stop -> 500 [Error] Sandbox state change
 * in progress (provider status: running)`.
 *
 * Daytona answers HTTP 409 `DaytonaConflictError` when a sandbox state
 * transition is already in flight — the user double-clicks the app
 * hibernate button and the second `POST .../stop` arrives while the first is
 * still settling. `apps/api/src/apps/hosting.ts`'s `stop()` waits through its
 * settle window, then re-throws a plain `Error` whose `cause` is the original
 * `DaytonaConflictError`. The stop route has no try/catch, so the error
 * reached `app.onError` → generic `500 Internal server error` → Sentry →
 * Better Stack — twice per user click, for a state that was already doing
 * exactly what the user asked.
 *
 * This is an EXPECTED, self-resolving state, so the global ladder must answer
 * a typed 409 `sandbox_state_change_in_progress` WITHOUT paging Sentry — the
 * same machine as `provision_in_flight` / `model_not_servable` /
 * `PlatinumSandboxNotRunningError`. The typed code lets the SDK classify the
 * response silent to `onError` and the web toast shows the retryable message.
 *
 * Mirrors `unit-http-secret-undecryptable.test.ts`: the REAL
 * `installHttpErrors` ladder is mounted, with Sentry mocked, so the assertion
 * covers the real dispatch order.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { DaytonaConflictError } from '@daytonaio/sdk';
import { OpenAPIHono } from '@hono/zod-openapi';

// Set test env BEFORE any import that pulls in `config` (the http-errors
// import graph reaches it). Matches unit-daytona-rate-limit-onerror.test.ts.
// The worktree's committed .env carries dotenvx-ciphertext values that fail
// validation, so encrypted values are overwritten too.
function setTestEnv(name: string, value: string): void {
  if (!process.env[name] || process.env[name]?.startsWith('encrypted:')) {
    process.env[name] = value;
  }
}
setTestEnv('DATABASE_URL', 'postgres://postgres:postgres@127.0.0.1:54322/postgres');
setTestEnv('SUPABASE_URL', 'http://127.0.0.1:54321');
setTestEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-service-role');
setTestEnv('API_KEY_SECRET', 'test-api-key-secret');
setTestEnv('TUNNEL_SIGNING_SECRET', 'test-tunnel-signing-secret');
setTestEnv('ALLOWED_SANDBOX_PROVIDERS', 'daytona');
setTestEnv('DAYTONA_API_KEY', 'test-daytona-key');
setTestEnv('DAYTONA_SERVER_URL', 'https://daytona.example.test');
setTestEnv('DAYTONA_TARGET', 'test-target');
setTestEnv('FRONTEND_URL', 'http://localhost:3000');
setTestEnv('INTERNAL_KORTIX_ENV', 'dev');

const captured: unknown[] = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown) => captured.push(error),
  isSentryIgnoredError: () => false,
}));

// Dynamic imports — resolved after setTestEnv has primed process.env.
let installHttpErrors: (app: OpenAPIHono) => void;
let SANDBOX_STATE_CHANGE_IN_PROGRESS_CODE: string;
let isDaytonaStateTransitionConflict: (err: unknown) => boolean;

beforeAll(async () => {
  ({ installHttpErrors } = await import('../http-errors'));
  ({ SANDBOX_STATE_CHANGE_IN_PROGRESS_CODE, isDaytonaStateTransitionConflict } = await import(
    '../shared/daytona-state-transition'
  ));
});

/** The exact shape `hosting.stop()` re-throws after its settle window expires. */
function wrappedStateChangeError(): Error {
  const cause = new DaytonaConflictError('Sandbox state change in progress', 409);
  return new Error('Sandbox state change in progress (provider status: running)', {
    cause,
  });
}

function app(): OpenAPIHono {
  const server = new OpenAPIHono();
  installHttpErrors(server);
  server.post('/v1/projects/:projectId/apps/:appId/stop', () => {
    throw wrappedStateChangeError();
  });
  server.post('/v1/raw-conflict', () => {
    throw new DaytonaConflictError('Sandbox state change in progress', 409);
  });
  server.post('/v1/other-conflict', () => {
    // A DaytonaConflictError for a DIFFERENT reason (a genuine concurrent
    // mutation conflict) — not the state-transition message.
    throw new DaytonaConflictError('Sandbox is being deleted', 409);
  });
  server.post('/v1/unrelated-409', () => {
    const err = new Error('Conflict') as Error & { statusCode?: number };
    err.statusCode = 409;
    throw err;
  });
  server.post('/v1/plain', () => {
    throw new Error('boom');
  });
  return server;
}

describe('Daytona sandbox state-transition conflict at the HTTP error handler', () => {
  test('the wrapped hosting.stop() shape answers the typed 409, no Sentry event', async () => {
    captured.length = 0;
    const res = await app().request('/v1/projects/p-1/apps/app-1/stop', { method: 'POST' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: true,
      message: 'sandbox state change in progress; try again shortly',
      code: SANDBOX_STATE_CHANGE_IN_PROGRESS_CODE,
      status: 409,
    });
    expect(captured).toHaveLength(0);
  });

  test('a raw DaytonaConflictError answers the same typed 409, no Sentry event', async () => {
    captured.length = 0;
    const res = await app().request('/v1/raw-conflict', { method: 'POST' });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { code: string };
    expect(body.code).toBe(SANDBOX_STATE_CHANGE_IN_PROGRESS_CODE);
    expect(captured).toHaveLength(0);
  });

  test('a DaytonaConflictError for a different reason still answers 500 and is captured', async () => {
    captured.length = 0;
    const res = await app().request('/v1/other-conflict', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(captured).toHaveLength(1);
  });

  test('an unrelated 409 without the Daytona shape still answers 500 and is captured', async () => {
    captured.length = 0;
    const res = await app().request('/v1/unrelated-409', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(captured).toHaveLength(1);
  });

  test('a generic Error still answers the generic 500 and is captured', async () => {
    captured.length = 0;
    const res = await app().request('/v1/plain', { method: 'POST' });
    expect(res.status).toBe(500);
    expect(captured).toHaveLength(1);
  });
});

describe('isDaytonaStateTransitionConflict', () => {
  test('matches the wrapped hosting.stop() shape', () => {
    expect(isDaytonaStateTransitionConflict(wrappedStateChangeError())).toBe(true);
  });

  test('matches a raw DaytonaConflictError with the state-change message', () => {
    expect(
      isDaytonaStateTransitionConflict(
        new DaytonaConflictError('Sandbox state change in progress', 409),
      ),
    ).toBe(true);
  });

  test('rejects a DaytonaConflictError with a different message', () => {
    expect(
      isDaytonaStateTransitionConflict(new DaytonaConflictError('Sandbox is being deleted', 409)),
    ).toBe(false);
  });

  test('classifies a plain 409 carrying the Daytona message, even without the DaytonaConflictError name', () => {
    const err = new Error('Sandbox state change in progress') as Error & { statusCode?: number };
    err.statusCode = 409;
    // The contract this pins: the conflict SHAPE (a 409 status) plus the exact
    // Daytona message suffice — the error does not also need the
    // `DaytonaConflictError` name to be classified as the expected conflict.
    expect(isDaytonaStateTransitionConflict(err)).toBe(true);
  });

  test('rejects the message on a bare Error with no conflict shape anywhere', () => {
    expect(isDaytonaStateTransitionConflict(new Error('Sandbox state change in progress'))).toBe(
      false,
    );
  });

  test('rejects non-Error values and errors without the message', () => {
    expect(isDaytonaStateTransitionConflict(null)).toBe(false);
    expect(isDaytonaStateTransitionConflict('Sandbox state change in progress')).toBe(false);
    expect(isDaytonaStateTransitionConflict(new Error('boom'))).toBe(false);
  });
});
