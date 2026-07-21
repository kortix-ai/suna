import { beforeAll, describe, expect, it } from 'bun:test';
import { DaytonaError, DaytonaNotFoundError, DaytonaRateLimitError } from '@daytonaio/sdk';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Set test env BEFORE any import that pulls in `config` (platinum.ts → config).
// Matches the pattern in unit-daytona-snapshot-context.test.ts. The classifier
// + platinum + git-mirror modules are imported DYNAMICALLY in beforeAll so
// this runs first.
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
setTestEnv('RECALL_BASE_URL', 'https://us-west-2.recall.ai/api/v1');

// Dynamic imports — resolved after setTestEnv has primed process.env, so the
// `config` module (transitively pulled in by platinum.ts) sees the test values.
let isDaytonaTransientProviderError: (err: unknown) => boolean;
let primeDaytonaTransientClassifier: () => Promise<void>;
let isPlatinumSandboxNotRunningError: (err: unknown) => boolean;
// Keep the type-guard return type so `err.kind` narrows correctly below.
let isGitOperationError: (err: unknown) => err is { kind: string };

beforeAll(async () => {
  ({ isDaytonaTransientProviderError, primeDaytonaTransientClassifier } = await import(
    '../shared/daytona-transient'
  ));
  ({ isPlatinumSandboxNotRunningError } = await import('../shared/platinum'));
  ({ isGitOperationError } = await import('../projects/git/mirror'));
  await primeDaytonaTransientClassifier();
});

// Regression for Better Stack pattern `e98d61f1…`
// `DaytonaError` with message `<html>…<h1>502 Bad Gateway</h1>…</html>`
// (Kortix API prod, application_id 2346961). The Daytona API gateway 502-ed
// with an HTML error page on an unguarded provider call inside
// `POST /v1/projects/:projectId/turn-stream` (kind: execution_lease_discover
// → discoverExecutionKeepAliveEndpoint → provider.resolveEndpoint → Daytona
// getPreviewLink). The SDK's axios response interceptor threw a generic
// `DaytonaError` (statusCode 502, message = HTML body) that propagated to
// `app.onError` → `captureException` → Sentry → Better Stack. This test
// proves the GLOBAL classification in `app.onError` downgrades an unguarded
// transient Daytona gateway failure to a retryable 503 + Retry-After WITHOUT
// paging Sentry — mirroring the Platinum / git-timeout / request-deadline
// patterns. See shared/daytona-transient.ts + index.ts onError.

/**
 * A faithful reproduction of the production `app.onError` classification chain
 * (the relevant branches only — see apps/api/src/index.ts). Captures whether
 * `captureException` (the Sentry/Better Stack paging call) would have fired,
 * and what status + headers the client gets.
 */
function makeClassifyingOnError() {
  const captured: unknown[] = [];
  const captureException = (err: unknown) => {
    captured.push(err);
  };
  const app = new Hono();
  app.onError((err, c) => {
    // (abort / sandbox-proxy branch omitted — not exercised here. The
    // production `app.onError` also derives `method`/`path`/`errName` for
    // structured logging, but this reproduction only exercises the
    // classification branches, so they're intentionally not declared here.)

    if (isPlatinumSandboxNotRunningError(err)) {
      c.header('Retry-After', '10');
      return c.json({ error: true, message: 'sandbox is not running', status: 503 }, 503);
    }

    if (isGitOperationError(err) && err.kind === 'timeout') {
      c.header('Retry-After', '10');
      return c.json(
        { error: true, message: 'git mirror is temporarily unavailable', status: 503 },
        503,
      );
    }

    if (isDaytonaTransientProviderError(err)) {
      c.header('Retry-After', '10');
      return c.json(
        { error: true, message: 'sandbox provider is temporarily unavailable', status: 503 },
        503,
      );
    }

    if (err instanceof HTTPException) {
      if (err.status >= 500) captureException(err);
      if (err.status === 503) c.header('Retry-After', '10');
      return c.json({ error: true, message: err.message, status: err.status }, err.status);
    }

    // Generic unhandled error — capture to Sentry (this is what pages Better Stack).
    captureException(err);
    return c.json({ error: true, message: 'Internal server error', status: 500 }, 500);
  });
  return { app, captured: () => captured };
}

describe('app.onError Daytona transient-gateway classification', () => {
  it('downgrades the exact prod 502-HTML-body fingerprint to 503 + Retry-After (no Sentry)', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      // The exact shape Better Stack records for `e98d61f1…`.
      throw new DaytonaError(
        '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n',
        502,
      );
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    const body = (await res.json()) as { message: string; status: number };
    expect(body.status).toBe(503);
    // Generic, non-leaky message — the raw HTML 502 body is NOT exposed to the
    // client (no SDK internals, no upstream gateway HTML leak).
    expect(body.message).toBe('sandbox provider is temporarily unavailable');
    // The whole point: this transient 502 did NOT page Sentry/Better Stack.
    expect(captured()).toHaveLength(0);
  });

  it('downgrades a generic DaytonaError with statusCode 503 (no Sentry)', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaError('Service Unavailable', 503);
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(captured()).toHaveLength(0);
  });

  it('downgrades a generic DaytonaError with statusCode 504 (no Sentry)', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaError('Gateway Timeout', 504);
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(captured()).toHaveLength(0);
  });

  it('downgrades a DaytonaError with a connection-failure message (no Sentry)', async () => {
    // The SDK wraps axios network errors into a generic DaytonaError when it
    // can't classify them — `socket hang up`, `ECONNRESET`, `ETIMEDOUT`, …
    // are all transient and must NOT page Sentry.
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaError('socket hang up');
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(captured()).toHaveLength(0);
  });

  it('does NOT swallow a DaytonaNotFoundError (a different, real Daytona failure)', async () => {
    // A 404 missing-box is an unexpected failure for a live call site — it must
    // still fall through to the generic capture so it stays loud. The
    // classifier is scoped to transient gateway / connection / timeout
    // failures ONLY.
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaNotFoundError('Sandbox not found', 404);
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).not.toHaveLength(0);
    expect(captured()).toHaveLength(1);
  });

  it('does NOT swallow a DaytonaRateLimitError (429 — owned by isDaytonaRateLimitError)', async () => {
    // The 429 throttler is owned by the sibling classifier
    // `isDaytonaRateLimitError` (shared/daytona-rate-limit.ts, PR #5167). It
    // is NOT matched by `isDaytonaTransientProviderError` — when #5167 lands,
    // its branch fires first and downgrades the 429 to 503 with its own
    // message. Without #5167, the 429 must fall through to the generic
    // capture (NOT be silently swallowed by this classifier).
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaRateLimitError(
        'ThrottlerException: Too Many Requests',
        429,
        undefined,
        'ThrottlerException',
      );
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).not.toHaveLength(0);
  });

  it('does NOT swallow a generic Error (still 500 + captureException)', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new Error('boom — a real bug');
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).not.toHaveLength(0);
  });

  it('does NOT swallow a generic 502 from a non-Daytona upstream', async () => {
    // A bare 502 from some other service (LLM gateway, GitHub, Stripe, …)
    // must NOT be misclassified as a Daytona transient failure — it would
    // silently hide real failures in unrelated callers. Only Daytona-typed
    // 502/503/504s are downgraded.
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      const err = new Error('upstream returned 502') as Error & { statusCode?: number };
      err.statusCode = 502;
      throw err;
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).not.toHaveLength(0);
  });

  it('keeps the Platinum not-running branch intact (precedence is unchanged)', async () => {
    // The Daytona branch was inserted AFTER Platinum; Platinum's own typed
    // expected-state must still classify first. (Sanity guard against the new
    // branch accidentally swallowing a Platinum not-running error.)
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', async () => {
      const { PlatinumSandboxNotRunningError } = await import('../shared/platinum');
      throw new PlatinumSandboxNotRunningError();
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('sandbox is not running');
    expect(captured()).toHaveLength(0);
  });
});
