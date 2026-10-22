/**
 * Composio (hosted connectors provider) transient-failure classification at
 * the GLOBAL HTTP error handler.
 *
 * Regression for Better Stack pattern `0386d70c…` (Kortix API prod,
 * application 2346961, 2026-10-15): `InternalServerError: 500 {"error":
 * {"message":"Failed to fetch API key information from DB","code":809,…}}`
 * thrown by `@composio/client`'s `makeRequest` on
 * `GET /v1/connectors/projects/:projectId/connect/toolkits?limit=12` — a
 * 102 s request that the SDK's own three attempts (maxRetries 2) could not
 * save. The toolkits route has no try/catch, so the SDK error propagated to
 * `app.onError` → `captureException` → Sentry → Better Stack.
 *
 * A transient Composio API failure (their own 5xx, or a dropped connection /
 * client timeout) is EXPECTED and retryable — the provider is momentarily
 * unavailable, not a Kortix code bug. This test proves the global
 * classification downgrades it to a retryable 503 + Retry-After WITHOUT
 * paging Sentry, mirroring the Platinum / git-mirror / Daytona / request-
 * deadline patterns. See shared/composio-transient.ts + http-errors.ts.
 *
 * Deliberately NOT classified (must stay loud):
 *   - Composio 4xx (400 / 401 / 403 / 404 / 409 / 422) — a real request fault
 *     or a credential problem, not a transient provider state;
 *   - Composio 429 — `executeComposio` already answers it at its call site as
 *     a real HTTP 429 + Retry-After (apps/api/src/connectors/composio.ts);
 *     an unguarded 429 that bubbles here should page until it gets the same
 *     call-site treatment (mirrors the Daytona 429-is-owned-elsewhere rule);
 *   - a bare Error that merely carries a 5xx-ish field — only the SDK's own
 *     error classes may be classified.
 *
 * Uses the REAL `installHttpErrors` dispatcher (mocking only the Sentry
 * lib to observe captureException), following
 * `unit-http-secret-undecryptable.test.ts`.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const captured: unknown[] = [];
mock.module('../lib/sentry', () => ({
  captureException: (error: unknown) => {
    captured.push(error);
  },
  isSentryIgnoredError: () => false,
}));

const { installHttpErrors } = await import('../http-errors');
const {
  CONNECTORS_PROVIDER_UNAVAILABLE_CODE,
  isComposioTransientProviderError,
  primeComposioTransientClassifier,
} = await import('../shared/composio-transient');
const {
  APIConnectionError,
  APIConnectionTimeoutError,
  BadRequestError,
  InternalServerError,
  NotFoundError,
  RateLimitError,
} = await import('@composio/client');

await primeComposioTransientClassifier();

/**
 * The exact prod fingerprint of pattern `0386d70c…`, reconstructed through the
 * SDK's real `InternalServerError` so the message is byte-identical to prod
 * (`APIError.makeMessage` JSON-stringifies the parsed body when it has no
 * direct `message` string). Composio's own request id is replaced with a
 * placeholder; nothing here is customer data — it is Composio's platform
 * error envelope.
 */
function prodInternalServerError(): Error {
  return new InternalServerError(
    500,
    {
      error: {
        message: 'Failed to fetch API key information from DB',
        code: 809,
        slug: 'APIKey_InternalServerError',
        status: 500,
        request_id: '00000000-0000-0000-0000-000000000000',
        suggested_fix: 'Please retry the request',
      },
    },
    undefined,
    new Headers(),
  );
}

function app(thrower: () => never): OpenAPIHono {
  const server = new OpenAPIHono();
  installHttpErrors(server);
  server.get('/v1/probe', thrower);
  return server;
}

async function classify(err: unknown) {
  captured.length = 0;
  const res = await app(() => {
    throw err as never;
  }).request('/v1/probe');
  const body = (await res.json()) as Record<string, unknown>;
  return { res, body, capturedCount: captured.length };
}

describe('app.onError Composio transient classification', () => {
  test('downgrades the exact prod 500 "Failed to fetch API key information from DB" to 503 + Retry-After (no Sentry)', async () => {
    const { res, body, capturedCount } = await classify(prodInternalServerError());
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('10');
    expect(body).toEqual({
      error: true,
      code: CONNECTORS_PROVIDER_UNAVAILABLE_CODE,
      message: 'connectors provider is temporarily unavailable',
      status: 503,
    });
    expect(capturedCount).toBe(0);
  });

  test('downgrades any Composio 5xx (InternalServerError covers every 5xx status) to 503 (no Sentry)', async () => {
    const { res, capturedCount } = await classify(
      new InternalServerError(503, { error: 'upstream unavailable' }, undefined, new Headers()),
    );
    expect(res.status).toBe(503);
    expect(capturedCount).toBe(0);
  });

  test('downgrades an APIConnectionError (network failure) to 503 (no Sentry)', async () => {
    const { res, capturedCount } = await classify(new APIConnectionError({}));
    expect(res.status).toBe(503);
    expect(capturedCount).toBe(0);
  });

  test('downgrades an APIConnectionTimeoutError (the SDK client timeout) to 503 (no Sentry)', async () => {
    const { res, capturedCount } = await classify(new APIConnectionTimeoutError({}));
    expect(res.status).toBe(503);
    expect(capturedCount).toBe(0);
  });

  test('does NOT swallow a BadRequestError (400 — a real request fault stays loud)', async () => {
    const { res, capturedCount } = await classify(
      new BadRequestError(400, { error: 'invalid toolkit slug' }, undefined, new Headers()),
    );
    expect(res.status).toBe(500);
    expect(capturedCount).toBe(1);
  });

  test('does NOT swallow a NotFoundError (404 stays loud)', async () => {
    const { res, capturedCount } = await classify(
      new NotFoundError(404, { error: 'no such project' }, undefined, new Headers()),
    );
    expect(res.status).toBe(500);
    expect(capturedCount).toBe(1);
  });

  test('does NOT swallow a RateLimitError (429 — owned by the executeComposio call-site answer)', async () => {
    const { res, capturedCount } = await classify(
      new RateLimitError(429, { error: 'too many requests' }, undefined, new Headers()),
    );
    expect(res.status).toBe(500);
    expect(capturedCount).toBe(1);
  });

  test('does NOT swallow a generic Error (a real bug stays 500 + captured)', async () => {
    const { res, capturedCount } = await classify(new Error('boom — a real bug'));
    expect(res.status).toBe(500);
    expect(capturedCount).toBe(1);
  });

  test('does NOT classify a bare Error that merely carries a 5xx-shaped status field', async () => {
    // Isolation: only the SDK's own error classes match. A 500-shaped error
    // from an unrelated upstream must keep paging.
    const err = Object.assign(new Error('some other upstream failed'), { status: 500 });
    const { res, capturedCount } = await classify(err);
    expect(res.status).toBe(500);
    expect(capturedCount).toBe(1);
  });
});

describe('isComposioTransientProviderError (classifier, direct)', () => {
  test('the prod fingerprint matches', () => {
    expect(isComposioTransientProviderError(prodInternalServerError())).toBe(true);
  });

  test('connection failures match', () => {
    expect(isComposioTransientProviderError(new APIConnectionError({}))).toBe(true);
    expect(isComposioTransientProviderError(new APIConnectionTimeoutError({}))).toBe(true);
  });

  test('4xx and 429 do not match', () => {
    expect(isComposioTransientProviderError(new RateLimitError(429, {}, undefined, new Headers()))).toBe(
      false,
    );
    expect(
      isComposioTransientProviderError(new BadRequestError(400, {}, undefined, new Headers())),
    ).toBe(false);
    expect(
      isComposioTransientProviderError(new NotFoundError(404, {}, undefined, new Headers())),
    ).toBe(false);
  });

  test('plain errors and non-errors do not match', () => {
    expect(isComposioTransientProviderError(new Error('boom'))).toBe(false);
    expect(isComposioTransientProviderError('InternalServerError: 500')).toBe(false);
    expect(isComposioTransientProviderError(null)).toBe(false);
    expect(
      isComposioTransientProviderError(Object.assign(new Error('x'), { status: 500 })),
    ).toBe(false);
  });
});
