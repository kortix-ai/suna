/**
 * The typed-503 frontend-Sentry suppression for the transient connectors
 * provider failure (`CONNECTORS_PROVIDER_UNAVAILABLE_CODE`, the mirror of
 * `apps/api/src/shared/composio-transient.ts`'s
 * `CONNECTORS_PROVIDER_UNAVAILABLE_CODE`). The API classifies a transient
 * Composio failure (its own 5xx, a dropped connection) out of ITS Sentry and
 * answers a clean 503 + Retry-After; without the `isExpectedResponse` entry
 * here the 503 crossed into the FRONTEND Sentry (app 2346967) through
 * `handleApiError` and paged a second time — the same double-paging the
 * git-mirror code fixed for its 503.
 */
import { describe, expect, test } from 'bun:test';
import { ApiError } from './api/errors';
import { configureKortix } from './config';
import { handleErrorResponse } from './response-error';

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const errors: unknown[] = [];
const remedies: string[] = [];

configureKortix({
  backendUrl: 'http://127.0.0.1:1',
  getToken: async () => null,
  onError: (error) => {
    errors.push(error);
  },
  onAccessRemedy: (code) => {
    remedies.push(code);
  },
});

const signal = new AbortController().signal;

describe('handleErrorResponse · connectors_provider_unavailable 503', () => {
  test('the typed 503 is SILENT to onError (no frontend Sentry capture), but still returns the ApiError with its code', async () => {
    errors.length = 0;
    const result = await handleErrorResponse(
      response(503, {
        error: true,
        code: 'connectors_provider_unavailable',
        message: 'connectors provider is temporarily unavailable',
        status: 503,
      }),
      signal,
      true,
    );
    expect(result.success).toBe(false);
    expect(result.error).toBeInstanceOf(ApiError);
    expect((result.error as ApiError).message).toBe(
      'connectors provider is temporarily unavailable',
    );
    expect((result.error as ApiError).code).toBe('connectors_provider_unavailable');
    // The whole point: the expected, retryable provider blip is NOT reported.
    expect(errors).toHaveLength(0);
  });

  test('a genuine 503 with another code still reports (the suppression is code-scoped)', async () => {
    errors.length = 0;
    await handleErrorResponse(
      response(503, { error: true, message: 'something else is down', status: 503 }),
      signal,
      true,
    );
    expect(errors).toHaveLength(1);
  });

  test('the git-mirror 503 stays silent (sibling behavior unchanged)', async () => {
    errors.length = 0;
    await handleErrorResponse(
      response(503, { error: true, message: 'git mirror is temporarily unavailable', status: 503 }),
      signal,
      true,
    );
    expect(errors).toHaveLength(0);
  });
});

describe('handleErrorResponse · the coded 403 remedies', () => {
  // The core emits the semantic event to the host sink only (KRTX-2729
  // move-response-error-remedy-dispatch): the DOM dispatch is the host's.
  function stubWindow() {
    const dispatched: string[] = [];
    const g = globalThis as { window?: unknown };
    const original = g.window;
    g.window = {
      dispatchEvent: (e: { type: string }) => {
        dispatched.push(e.type);
        return true;
      },
    };
    return {
      dispatched,
      restore: () => {
        if (original === undefined) delete g.window;
        else g.window = original;
      },
    };
  }

  for (const showErrors of [true, false]) {
    test(`an account_mfa_required 403 reports the remedy to the host sink, never the DOM (showErrors: ${showErrors})`, async () => {
      errors.length = 0;
      remedies.length = 0;
      const win = stubWindow();
      try {
        const result = await handleErrorResponse(
          response(403, { error: true, message: 'MFA required', code: 'account_mfa_required' }),
          signal,
          showErrors,
        );
        expect(result.success).toBe(false);
        expect((result.error as ApiError).code).toBe('account_mfa_required');
        expect(remedies).toEqual(['account_mfa_required']);
        expect(win.dispatched).toEqual([]);
        // The remedy codes are NOT in isExpectedResponse: a shown error still reports.
        expect(errors).toHaveLength(showErrors ? 1 : 0);
      } finally {
        win.restore();
      }
    });

    test(`an sso_required 403 reports the remedy to the host sink, never the DOM (showErrors: ${showErrors})`, async () => {
      errors.length = 0;
      remedies.length = 0;
      const win = stubWindow();
      try {
        const result = await handleErrorResponse(
          response(403, { error: true, message: 'SSO required', code: 'sso_required' }),
          signal,
          showErrors,
        );
        expect(result.success).toBe(false);
        expect((result.error as ApiError).code).toBe('sso_required');
        expect(remedies).toEqual(['sso_required']);
        expect(win.dispatched).toEqual([]);
        expect(errors).toHaveLength(showErrors ? 1 : 0);
      } finally {
        win.restore();
      }
    });
  }

  test('an ordinary 403 reports no remedy at all', async () => {
    errors.length = 0;
    remedies.length = 0;
    const win = stubWindow();
    try {
      await handleErrorResponse(
        response(403, { error: true, message: 'forbidden', code: 'insufficient_permissions' }),
        signal,
        true,
      );
      expect(remedies).toEqual([]);
      expect(win.dispatched).toEqual([]);
    } finally {
      win.restore();
    }
  });
});
