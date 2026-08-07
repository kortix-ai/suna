import { afterEach, describe, expect, test } from 'bun:test';

import {
  backendApi,
  isAdminBypassEnabled,
  PROVISION_IN_FLIGHT_CODE,
  setAdminBypass,
} from './api-client';
import { ApiError } from './api/errors';
import { configureKortix } from './config';

afterEach(() => {
  setAdminBypass(false);
  configureKortix({ backendUrl: '', getToken: async () => null });
});

describe('setAdminBypass / isAdminBypassEnabled', () => {
  test('defaults to disabled', () => {
    expect(isAdminBypassEnabled()).toBe(false);
  });

  test('toggles on and off', () => {
    setAdminBypass(true);
    expect(isAdminBypassEnabled()).toBe(true);
    setAdminBypass(false);
    expect(isAdminBypassEnabled()).toBe(false);
  });
});

describe('makeRequest admin-bypass header', () => {
  function stubFetch() {
    let capturedHeaders: Record<string, string> | null = null;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) ?? {};
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return {
      getHeaders: () => capturedHeaders,
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  }

  test('attaches x-kortix-admin-bypass when enabled', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'test-token' });
    const stub = stubFetch();
    try {
      setAdminBypass(true);
      await backendApi.get('/projects/abc/detail');
      expect(stub.getHeaders()?.['x-kortix-admin-bypass']).toBe('1');
    } finally {
      stub.restore();
    }
  });

  test('omits the header when disabled', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'test-token' });
    const stub = stubFetch();
    try {
      setAdminBypass(false);
      await backendApi.get('/projects/abc/detail');
      expect(stub.getHeaders()?.['x-kortix-admin-bypass']).toBeUndefined();
    } finally {
      stub.restore();
    }
  });

  test('attaches the configured client surface to backend requests', async () => {
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'test-token',
      clientSource: 'cli',
    });
    const stub = stubFetch();
    try {
      await backendApi.get('/projects/abc/detail');
      expect(stub.getHeaders()?.['X-Kortix-Client']).toBe('cli');
    } finally {
      stub.restore();
    }
  });
});

// Regression for prod TypeError "t.message.includes is not a function": a
// backend 4xx body whose `message` (or `detail.message`) is a non-string
// value used to flow straight into `new ApiError(message, …)`, and from there
// into `error.message.includes(...)` call sites (file-list retry callbacks,
// provider disconnect, error-handler) which crashed. `errorMessage` must stay
// a string regardless of the response body shape.
describe('makeRequest keeps ApiError.message a string for non-string body fields', () => {
  function stubErrorBody(status: number, body: unknown) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  test('a non-string top-level `message` (object) does not become ApiError.message', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const restore = stubErrorBody(403, { message: { code: 'FORBIDDEN' } });
    try {
      const res = await backendApi.get('/projects/abc/files');
      expect(res.success).toBe(false);
      expect(typeof res.error?.message).toBe('string');
      // The default fallback (`HTTP 403: …`) is used instead of the object.
      expect(res.error?.message.includes('403')).toBe(true);
      expect(() => res.error?.message.includes('404')).not.toThrow();
    } finally {
      restore();
    }
  });

  test('a non-string `detail.message` (number) does not become ApiError.message', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const restore = stubErrorBody(404, { detail: { message: 404 } });
    try {
      const res = await backendApi.get('/projects/abc/files');
      expect(res.success).toBe(false);
      expect(typeof res.error?.message).toBe('string');
      expect(res.error?.message.includes('404')).toBe(true);
    } finally {
      restore();
    }
  });

  test('a real string `message` is still used verbatim', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const restore = stubErrorBody(403, { message: 'Not allowed to read project files' });
    try {
      const res = await backendApi.get('/projects/abc/files');
      expect(res.success).toBe(false);
      expect(res.error?.message).toBe('Not allowed to read project files');
    } finally {
      restore();
    }
  });
});

// Regression for prod Better Stack frontend pattern `994987…`
// (`ApiError: HTTP 502: ` on the background `useSessionAudit` poll): a single
// transient gateway 502/503/504 from the ALB/proxy on an idempotent read used
// to fire `onError` → Sentry on the first response, even though the very next
// attempt succeeds. `makeRequest` now bounded-retries transient gateway
// statuses on GET/HEAD; persistent failures still surface.
describe('makeRequest retries transient gateway (502/503/504) on idempotent reads', () => {
  function stubFetchSequence(responses: Array<{ status: number; body?: unknown }>) {
    const originalFetch = globalThis.fetch;
    let call = 0;
    const calls: string[] = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push(`${(init?.method ?? 'GET').toUpperCase()} ${url}`);
      const r = responses[Math.min(call, responses.length - 1)];
      call++;
      const body = r.body === undefined ? '' : JSON.stringify(r.body);
      return new Response(body, {
        status: r.status,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;
    return {
      calls: () => calls,
      attemptCount: () => call,
      restore: () => {
        globalThis.fetch = originalFetch;
      },
    };
  }

  test('a single transient 502 on GET is retried and succeeds (no error surfaced)', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const stub = stubFetchSequence([
      { status: 502 }, // transient blip
      { status: 200, body: { ok: true } }, // retry succeeds
    ]);
    try {
      const res = await backendApi.get('/projects/abc/sessions/s1/audit');
      expect(res.success).toBe(true);
      expect(res.data).toEqual({ ok: true });
      expect(stub.attemptCount()).toBe(2);
    } finally {
      stub.restore();
    }
  });

  test('503 and 504 are also retried on GET', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    for (const status of [503, 504]) {
      const stub = stubFetchSequence([{ status }, { status: 200, body: { ok: true } }]);
      try {
        const res = await backendApi.get('/projects/abc/sessions/s1/audit');
        expect(res.success).toBe(true);
        expect(stub.attemptCount()).toBe(2);
      } finally {
        stub.restore();
      }
    }
  });

  test('a persistent 502 on GET exhausts retries and surfaces the error', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const stub = stubFetchSequence([{ status: 502 }]); // always 502
    try {
      const res = await backendApi.get('/projects/abc/sessions/s1/audit');
      expect(res.success).toBe(false);
      expect(res.error?.status).toBe(502);
      // 1 initial + 2 retries = 3 attempts
      expect(stub.attemptCount()).toBe(3);
    } finally {
      stub.restore();
    }
  });

  test('a 502 on a POST is NOT retried (non-idempotent)', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const stub = stubFetchSequence([{ status: 502 }, { status: 200, body: { ok: true } }]);
    try {
      const res = await backendApi.post('/projects/abc/sessions', { foo: 1 });
      expect(res.success).toBe(false);
      expect(res.error?.status).toBe(502);
      expect(stub.attemptCount()).toBe(1);
    } finally {
      stub.restore();
    }
  });

  test('a 500 on GET is NOT retried (deterministic server error)', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const stub = stubFetchSequence([{ status: 500 }, { status: 200, body: { ok: true } }]);
    try {
      const res = await backendApi.get('/projects/abc/sessions/s1/audit');
      expect(res.success).toBe(false);
      expect(res.error?.status).toBe(500);
      expect(stub.attemptCount()).toBe(1);
    } finally {
      stub.restore();
    }
  });

  test('a 4xx on GET is NOT retried', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const stub = stubFetchSequence([{ status: 404 }, { status: 200, body: { ok: true } }]);
    try {
      const res = await backendApi.get('/projects/abc/sessions/s1/audit');
      expect(res.success).toBe(false);
      expect(res.error?.status).toBe(404);
      expect(stub.attemptCount()).toBe(1);
    } finally {
      stub.restore();
    }
  });
});

describe('makeRequest retries transient transport failures on idempotent reads', () => {
  test('a failed preflight on GET is retried before the host error handler runs', async () => {
    const errors: Error[] = [];
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'tok',
      onError: (error) => {
        errors.push(error as Error);
      },
    });
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      if (attempts === 1) throw new TypeError('Failed to fetch');
      return Response.json({ ok: true });
    }) as unknown as typeof fetch;
    try {
      const response = await backendApi.get('/projects/p1/sessions/s1/audit');
      expect(response).toEqual({ success: true, data: { ok: true } });
      expect(attempts).toBe(2);
      expect(errors).toEqual([]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('persistent GET transport failures report once after three attempts', async () => {
    const errors: Error[] = [];
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'tok',
      onError: (error) => {
        errors.push(error as Error);
      },
    });
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    try {
      const response = await backendApi.get('/projects/p1/sessions/s1/audit');
      expect(response.success).toBe(false);
      expect(response.error?.message).toBe('Failed to fetch');
      expect(attempts).toBe(3);
      expect(errors).toHaveLength(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('a POST transport failure is not retried', async () => {
    configureKortix({ backendUrl: 'http://api.test/v1', getToken: async () => 'tok' });
    const originalFetch = globalThis.fetch;
    let attempts = 0;
    globalThis.fetch = (async () => {
      attempts++;
      throw new TypeError('Failed to fetch');
    }) as unknown as typeof fetch;
    try {
      const response = await backendApi.post('/projects/p1/sessions', {});
      expect(response.success).toBe(false);
      expect(attempts).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('account_mfa_required 403 → kortix:mfa-required browser event', () => {
  function stubFetch403(body: Record<string, unknown>) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

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

  test('the coded MFA denial dispatches the step-up event', async () => {
    configureKortix({ backendUrl: 'http://test', getToken: async () => 'tok' });
    const restoreFetch = stubFetch403({ error: 'mfa needed', code: 'account_mfa_required' });
    const win = stubWindow();
    try {
      const res = await backendApi.get('/accounts/abc/iam/groups');
      expect(res.success).toBe(false);
      expect(win.dispatched).toContain('kortix:mfa-required');
    } finally {
      win.restore();
      restoreFetch();
    }
  });

  test('an ordinary 403 dispatches nothing', async () => {
    configureKortix({ backendUrl: 'http://test', getToken: async () => 'tok' });
    const restoreFetch = stubFetch403({ error: "You don't have permission to create projects." });
    const win = stubWindow();
    try {
      const res = await backendApi.get('/accounts/abc/iam/groups');
      expect(res.success).toBe(false);
      expect(win.dispatched.length).toBe(0);
    } finally {
      win.restore();
      restoreFetch();
    }
  });
});

// Regression for Better Stack frontend pattern `1f3c4d96…`
// (`ApiError: not supported`, HTTP 501) on the co-worker session "add
// connector" path: `POST /v1/connectors/projects/:id/connectors/auth-discovery`
// returned a bare `{ error: 'not supported' }` 501 when an optional connector
// capability wasn't wired on the deployment, and `makeRequest` forwarded it
// to `onError` → Sentry as an opaque, unhandled-looking `ApiError`. The API
// now returns a TYPED 501 envelope with `code: 'feature_not_supported'`
// (connector router `featureNotSupportedResponse`); `makeRequest` classifies
// that as an EXPECTED "feature unavailable" state — silent to `onError`
// (Sentry) but still returned as an `ApiError` so callers/UI can branch on
// `.code`. Mirrors the billing-gate 402 / no-compaction-model classification.
// See `apps/api/src/__tests__/unit-connector-feature-not-supported.test.ts`
// for the API-side half of this contract.
describe('makeRequest classifies a typed feature_not_supported 501 as silent to Sentry', () => {
  function stubFetchOnce(status: number, body: unknown) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  test('a 501 with code=feature_not_supported does NOT fire onError (Sentry) but returns an ApiError', async () => {
    let onErrorCalls = 0;
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'tok',
      onError: () => {
        onErrorCalls++;
      },
    });
    const restore = stubFetchOnce(501, {
      error: 'feature_not_supported',
      code: 'feature_not_supported',
      message: 'This capability is not enabled on this deployment.',
      feature: 'connector_auth_discovery',
    });
    try {
      const res = await backendApi.post('/connectors/projects/p1/connectors/auth-discovery', {
        provider: 'openapi',
        spec: 'https://example.com/openapi.json',
      });
      expect(res.success).toBe(false);
      // The ApiError is still returned so the UI (e.g. the connector
      // discovery InfoBanner) can branch on the typed code.
      expect(res.error).toBeInstanceOf(ApiError);
      expect(res.error?.status).toBe(501);
      expect(res.error?.code).toBe('feature_not_supported');
      // The human message (not the bare 'not supported' string) is on it.
      expect(res.error?.message).toBe('This capability is not enabled on this deployment.');
      // The expected state must NEVER page Sentry.
      expect(onErrorCalls).toBe(0);
    } finally {
      restore();
    }
  });

  test('a genuine 501 (no feature_not_supported code) STILL fires onError (Sentry)', async () => {
    let onErrorCalls = 0;
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'tok',
      onError: () => {
        onErrorCalls++;
      },
    });
    const restore = stubFetchOnce(501, { error: 'something broke', message: 'something broke' });
    try {
      const res = await backendApi.post('/connectors/projects/p1/connectors/auth-discovery', {});
      expect(res.success).toBe(false);
      expect(res.error).toBeInstanceOf(ApiError);
      expect(res.error?.status).toBe(501);
      // A real server bug (no typed code) still reports — the classification
      // gate must never swallow a genuine defect.
      expect(onErrorCalls).toBe(1);
    } finally {
      restore();
    }
  });
});

// Regression for Better Stack frontend pattern `ed07f6c5…`
// (`ApiError: Model "nvidia/minimaxai/minimax-m3" is not available for this
// account`, HTTP 409, `onunhandledrejection` `handled:false`) on the
// co-worker session page: `PUT /v1/projects/:projectId/model-defaults`
// returns a TYPED 409 with `code: 'model_not_servable'` (from
// `isModelServableForAccount` in `apps/api/src/projects/routes/r4.ts` and
// `channel-bindings.ts`) when a user picks a model their account can't use
// (free-tier managed model, disconnected BYOK provider). The
// `useModelDefaults` `setMutation` had no `onError`, and every call site
// fire-and-forgets the promise (`void setXxxDefault(...)`), so the rejected
// `mutateAsync` became an unhandled rejection → Sentry. `makeRequest` now
// classifies that typed 409 as an EXPECTED "model not available" state —
// silent to `onError` (Sentry) but still returned as an `ApiError` so the
// mutation's `onError` can branch on `.code` and show a user-facing toast.
// A genuine 409 (no typed code) still reports. Mirrors the
// `feature_not_supported` 501 classification (PR #5240). See
// `apps/api/src/__tests__/` for the API-side half of this contract.
describe('makeRequest classifies a typed model_not_servable 409 as silent to Sentry', () => {
  function stubFetchOnce(status: number, body: unknown) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  test('a 409 with code=model_not_servable does NOT fire onError (Sentry) but returns an ApiError', async () => {
    let onErrorCalls = 0;
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'tok',
      onError: () => {
        onErrorCalls++;
      },
    });
    const restore = stubFetchOnce(409, {
      error: 'Model "nvidia/minimaxai/minimax-m3" is not available for this account',
      code: 'model_not_servable',
    });
    try {
      const res = await backendApi.put('/projects/p1/model-defaults', {
        scope: 'project',
        model: 'nvidia/minimaxai/minimax-m3',
      });
      expect(res.success).toBe(false);
      // The ApiError is still returned so the UI (useModelDefaults setMutation
      // onError) can branch on the typed code and show a user-facing toast.
      expect(res.error).toBeInstanceOf(ApiError);
      expect(res.error?.status).toBe(409);
      expect(res.error?.code).toBe('model_not_servable');
      expect(res.error?.message).toBe(
        'Model "nvidia/minimaxai/minimax-m3" is not available for this account',
      );
      // The expected state must NEVER page Sentry.
      expect(onErrorCalls).toBe(0);
    } finally {
      restore();
    }
  });

  test('a genuine 409 (no model_not_servable code) STILL fires onError (Sentry)', async () => {
    let onErrorCalls = 0;
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'tok',
      onError: () => {
        onErrorCalls++;
      },
    });
    const restore = stubFetchOnce(409, { error: 'Conflict', message: 'Conflict' });
    try {
      const res = await backendApi.put('/projects/p1/model-defaults', {
        scope: 'project',
        model: 'x/y',
      });
      expect(res.success).toBe(false);
      expect(res.error).toBeInstanceOf(ApiError);
      expect(res.error?.status).toBe(409);
      // A real conflict (no typed code) still reports — the classification
      // gate must never swallow a genuine defect.
      expect(onErrorCalls).toBe(1);
    } finally {
      restore();
    }
  });
});

// `POST /projects/provision` answers 409 `provision_in_flight` when another
// call carrying the same `idempotency_key` is still creating (see
// `apps/api/src/projects/lib/provision-idempotency.ts`). `provisionProject`
// passes no `showErrors`, so it defaults to `true` — without a carve-out the
// web host's global `onError` shows a 5s red toast reading "Another provision
// with this idempotency_key is in flight" during FIRST-RUN onboarding, for a
// race the onboarding retry loop resolves on its own. Silence it here, and
// keep the `ApiError` so `isProvisionInFlightError` can still branch.
describe('makeRequest classifies a typed provision_in_flight 409 as silent to Sentry', () => {
  function stubFetchOnce(status: number, body: unknown) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (_url: string, _init?: RequestInit) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    return () => {
      globalThis.fetch = originalFetch;
    };
  }

  test('a 409 with code=provision_in_flight does NOT fire onError but returns an ApiError', async () => {
    let onErrorCalls = 0;
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'tok',
      onError: () => {
        onErrorCalls++;
      },
    });
    const restore = stubFetchOnce(409, {
      error: 'Another provision with this idempotency_key is in flight',
      code: PROVISION_IN_FLIGHT_CODE,
    });
    try {
      const res = await backendApi.post('/projects/provision', {
        account_id: 'a1',
        idempotency_key: 'onboarding-first-project:abc',
      });
      expect(res.success).toBe(false);
      expect(res.error).toBeInstanceOf(ApiError);
      expect(res.error?.status).toBe(409);
      expect(res.error?.code).toBe('provision_in_flight');
      // The user must never be shown this message — it names an internal field
      // and describes a state that resolves without their involvement.
      expect(onErrorCalls).toBe(0);
    } finally {
      restore();
    }
  });

  test('a genuine 409 on /provision (no typed code) STILL fires onError', async () => {
    let onErrorCalls = 0;
    configureKortix({
      backendUrl: 'http://api.test/v1',
      getToken: async () => 'tok',
      onError: () => {
        onErrorCalls++;
      },
    });
    const restore = stubFetchOnce(409, { error: 'Conflict', message: 'Conflict' });
    try {
      const res = await backendApi.post('/projects/provision', { account_id: 'a1' });
      expect(res.success).toBe(false);
      expect(res.error?.status).toBe(409);
      expect(onErrorCalls).toBe(1);
    } finally {
      restore();
    }
  });
});
