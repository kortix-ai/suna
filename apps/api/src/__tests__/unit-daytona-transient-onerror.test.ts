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
let isDaytonaRateLimitError: (err: unknown) => boolean;
let primeDaytonaRateLimitClassifier: () => Promise<void>;
let isPlatinumSandboxNotRunningError: (err: unknown) => boolean;
// Keep the type-guard return type so `err.kind` narrows correctly below.
let isGitOperationError: (err: unknown) => err is { kind: string };

beforeAll(async () => {
  ({ isDaytonaTransientProviderError, primeDaytonaTransientClassifier } = await import(
    '../shared/daytona-transient'
  ));
  ({ isDaytonaRateLimitError, primeDaytonaRateLimitClassifier } = await import(
    '../shared/daytona-rate-limit'
  ));
  ({ isPlatinumSandboxNotRunningError } = await import('../shared/platinum'));
  ({ isGitOperationError } = await import('../projects/git/mirror'));
  await primeDaytonaTransientClassifier();
  await primeDaytonaRateLimitClassifier();
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

// Combined-order regression: proves the two Daytona classifiers
// (`isDaytonaRateLimitError` from PR #5167 + `isDaytonaTransientProviderError`
// from PR #5175) coexist in the production `app.onError` ordering WITHOUT
// shadowing each other. Added during the rebase of #5175 onto the merged
// #5167 (`1379e49`) — the two PRs landed as siblings and this guards the
// ordering against any future re-ordering regression. The production order is:
//   Platinum → DaytonaRateLimit(429) → GitTimeout → DaytonaTransient(502/503/504/conn/timeout)
// A 429 must be caught by `isDaytonaRateLimitError` (rate-limited message),
// a 502 must be caught by `isDaytonaTransientProviderError` (temporarily
// unavailable message) — neither may swallow the other's class.
describe('app.onError combined Daytona rate-limit + transient ordering', () => {
  /**
   * Reproduces the production `app.onError` chain with BOTH Daytona
   * classifiers in their shipped order (rate-limit BEFORE transient), so the
   * two classifiers are exercised against each other exactly as they run in
   * prod. Captures whether `captureException` (Sentry/Better Stack paging)
   * would have fired and what status/headers/message the client gets.
   */
  function makeCombinedClassifyingOnError() {
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

      // #5167's branch — fires BEFORE the transient classifier in prod.
      if (isDaytonaRateLimitError(err)) {
        c.header('Retry-After', '10');
        return c.json(
          {
            error: true,
            message: 'sandbox provider is temporarily rate-limited',
            status: 503,
          },
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

      // #5175's branch — fires AFTER the rate-limit classifier in prod.
      if (isDaytonaTransientProviderError(err)) {
        c.header('Retry-After', '10');
        return c.json(
          {
            error: true,
            message: 'sandbox provider is temporarily unavailable',
            status: 503,
          },
          503,
        );
      }

      if (err instanceof HTTPException) {
        if (err.status >= 500) captureException(err);
        if (err.status === 503) c.header('Retry-After', '10');
        return c.json({ error: true, message: err.message, status: err.status }, err.status);
      }

      captureException(err);
      return c.json({ error: true, message: 'Internal server error', status: 500 }, 500);
    });
    return { app, captured: () => captured };
  }

  it('a DaytonaRateLimitError (429) gets the RATE-LIMIT message, NOT the transient message', async () => {
    // A 429 ThrottlerException must be caught by `isDaytonaRateLimitError`
    // (which fires first in prod) and surface the rate-limited message — it
    // must NOT be swallowed by `isDaytonaTransientProviderError` (which would
    // surface "temporarily unavailable" and lose the throttler semantics).
    const { app, captured } = makeCombinedClassifyingOnError();
    app.get('/v1/probe', () => {
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
    expect(body.message).toBe('sandbox provider is temporarily rate-limited');
    // Not paged to Sentry.
    expect(captured()).toHaveLength(0);
  });

  it('a generic DaytonaError with the prod 502-HTML-body fingerprint gets the TRANSIENT message, NOT the rate-limit message', async () => {
    // The exact shape Better Stack records for `e98d61f1…`. A 502 HTML body
    // must be caught by `isDaytonaTransientProviderError` (the transient
    // gateway classifier) and surface the temporarily-unavailable message —
    // it must NOT be swallowed by `isDaytonaRateLimitError` (which only
    // matches the 429 ThrottlerException shape, asserted in #5167's own
    // `unit-daytona-rate-limit.test.ts`).
    const { app, captured } = makeCombinedClassifyingOnError();
    app.get('/v1/probe', () => {
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
    expect(body.message).toBe('sandbox provider is temporarily unavailable');
    expect(captured()).toHaveLength(0);
  });

  it('a DaytonaError with statusCode 503 gets the TRANSIENT message (not rate-limit)', async () => {
    const { app, captured } = makeCombinedClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaError('Service Unavailable', 503);
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(503);
    const body = (await res.json()) as { message: string };
    expect(body.message).toBe('sandbox provider is temporarily unavailable');
    expect(captured()).toHaveLength(0);
  });

  it('a DaytonaNotFoundError (404) still falls through BOTH classifiers to Sentry (neither swallows it)', async () => {
    // A 404 missing-box is an unexpected failure for a live call site and must
    // NOT be classified by either Daytona classifier — it must fall through to
    // the generic capture so it stays loud. Guards against either classifier
    // accidentally widening to "any DaytonaError".
    const { app, captured } = makeCombinedClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaNotFoundError('Sandbox not found', 404);
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).toHaveLength(1);
  });

  it('a DaytonaError with statusCode 500 (unexpected 5xx) falls through BOTH classifiers to Sentry', async () => {
    // 500 is NOT a transient gateway status (only 502/503/504 are) and NOT a
    // 429 — so it must fall through both Daytona classifiers and page Sentry.
    const { app, captured } = makeCombinedClassifyingOnError();
    app.get('/v1/probe', () => {
      throw new DaytonaError('internal server error', 500);
    });
    const res = await app.request('/v1/probe');
    expect(res.status).toBe(500);
    expect(captured()).toHaveLength(1);
  });

  it('a DaytonaRateLimitError is NOT matched by isDaytonaTransientProviderError (classifier isolation)', () => {
    // Direct classifier-level assertion (no app.onError involved): the 429
    // throttler class is NOT matched by the transient classifier, so even if
    // the branches were ever re-ordered, the 429 wouldn't be silently
    // swallowed with the wrong message by the transient branch.
    const err = new DaytonaRateLimitError(
      'ThrottlerException: Too Many Requests',
      429,
      undefined,
      'ThrottlerException',
    );
    expect(isDaytonaRateLimitError(err)).toBe(true);
    expect(isDaytonaTransientProviderError(err)).toBe(false);
  });

  it('a generic DaytonaError with 502 is NOT matched by isDaytonaRateLimitError (classifier isolation)', () => {
    // Symmetric isolation assertion: a transient 502 is NOT matched by the
    // rate-limit classifier, so it can't be swallowed with the wrong message
    // by the rate-limit branch.
    const err = new DaytonaError(
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body>\r\n<center><h1>502 Bad Gateway</h1></center>\r\n</body>\r\n</html>\r\n',
      502,
    );
    expect(isDaytonaTransientProviderError(err)).toBe(true);
    expect(isDaytonaRateLimitError(err)).toBe(false);
  });
});
