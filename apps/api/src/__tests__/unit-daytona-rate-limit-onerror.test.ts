import { beforeAll, describe, expect, it } from 'bun:test';
import { DaytonaNotFoundError, DaytonaRateLimitError } from '@daytonaio/sdk';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';

// Set test env BEFORE any import that pulls in `config` (platinum.ts → config).
// Matches the pattern in unit-daytona-snapshot-context.test.ts. The classifier
// + platinum + git-mirror modules are imported DYNAMICICALLY in beforeAll so
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
// Use loose function types so we can declare them with `let` and assign from
// the dynamic import in beforeAll — `import type` of the value would erase,
// and inline `typeof import(...)` doesn't parse multi-line in bun.
let isDaytonaRateLimitError: (err: unknown) => boolean;
let primeDaytonaRateLimitClassifier: () => Promise<void>;
let isPlatinumSandboxNotRunningError: (err: unknown) => boolean;
// Keep the type-guard return type so `err.kind` narrows correctly below.
let isGitOperationError: (err: unknown) => err is { kind: string };

beforeAll(async () => {
  ({ isDaytonaRateLimitError, primeDaytonaRateLimitClassifier } = await import(
    '../shared/daytona-rate-limit'
  ));
  ({ isPlatinumSandboxNotRunningError } = await import('../shared/platinum'));
  ({ isGitOperationError } = await import('../projects/git/mirror'));
  await primeDaytonaRateLimitClassifier();
});

// Regression for Better Stack pattern `ec26b248…`
// `DaytonaRateLimitError: ThrottlerException: Too Many Requests` (Kortix API
// prod, application_id 2346961). Prior PRs (#3567, #4605) guarded specific
// Daytona call sites one-by-one, but new call sites kept reintroducing the same
// fingerprint because a 429 still propagated to `app.onError` →
// `captureException` → Sentry → Better Stack whenever a caller forgot the
// try/catch. This test proves the GLOBAL classification in `app.onError`
// downgrades an unguarded Daytona 429 to a retryable 503 + Retry-After WITHOUT
// paging Sentry — mirroring the Platinum / git-timeout / request-deadline
// patterns. See shared/daytona-rate-limit.ts + index.ts onError.

beforeAll(async () => {
  await primeDaytonaRateLimitClassifier();
});

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
    // (abort / sandbox-proxy branch omitted — not exercised here)

    if (isPlatinumSandboxNotRunningError(err)) {
      c.header('Retry-After', '10');
      return c.json({ error: true, message: 'sandbox is not running', status: 503 }, 503);
    }

    if (isDaytonaRateLimitError(err)) {
      c.header('Retry-After', '10');
      return c.json(
        { error: true, message: 'sandbox provider is temporarily rate-limited', status: 503 },
        503,
      );
    }

    if (isGitOperationError(err) && err.kind === 'timeout') {
      c.header('Retry-After', '10');
      return c.json(
        { error: true, message: 'git mirror is temporarily unavailable', status: 503 },
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

describe('app.onError Daytona 429 classification', () => {
  it('downgrades an unguarded DaytonaRateLimitError to 503 + Retry-After (no Sentry)', async () => {
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      // A call site that forgot its try/catch — the exact regression class.
      throw new DaytonaRateLimitError(
        'ThrottlerException: Too Many Requests',
        429,
        undefined,
        'ThrottlerException',
      );
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    const body = (await res.json()) as { message: string; status: number };
    expect(body.status).toBe(503);
    // Generic, non-leaky message (no Daytona SDK internals / no raw provider
    // error text exposed to the client).
    expect(body.message).toBe('sandbox provider is temporarily rate-limited');
    // The whole point: this 429 did NOT page Sentry/Better Stack.
    expect(captured()).toHaveLength(0);
  });

  it('downgrades the wrapped-message shape (re-thrown Error) the same way', async () => {
    // Some call sites re-throw a plain Error with the SDK's toString() shape
    // (e.g. `throw new Error("DaytonaRateLimitError: ThrottlerException: Too Many Requests")`).
    // The classifier must still recognize it.
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new Error('DaytonaRateLimitError: ThrottlerException: Too Many Requests');
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(captured()).toHaveLength(0);
  });

  it('does NOT swallow a DaytonaNotFoundError (a different, real Daytona failure)', async () => {
    // A 404 missing-box is an unexpected failure for a live call site — it must
    // still fall through to the generic capture so it stays loud. The
    // classifier is scoped to the org-wide 429 throttler ONLY.
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaNotFoundError('Sandbox not found', 404);
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).not.toHaveLength(0);
    expect(captured()).toHaveLength(1);
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

  it('does NOT swallow a generic 429 from a non-Daytona upstream', async () => {
    // A bare 429 from some other service must NOT be misclassified as a Daytona
    // rate limit — it would silently hide real failures in LLM gateway / GitHub /
    // Stripe / etc. callers. Only Daytona-typed 429s are downgraded.
    const { app, captured } = makeClassifyingOnError();
    app.get('/v1/probe', () => {
      const err = new Error('Rate limit exceeded') as Error & { statusCode?: number };
      err.statusCode = 429;
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
