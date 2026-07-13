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
