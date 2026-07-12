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
