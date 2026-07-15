import { afterEach, describe, expect, test } from 'bun:test';

import { backendApi, isAdminBypassEnabled, setAdminBypass } from './api-client';
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
      })) as typeof fetch;
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
      const stub = stubFetchSequence([
        { status },
        { status: 200, body: { ok: true } },
      ]);
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
