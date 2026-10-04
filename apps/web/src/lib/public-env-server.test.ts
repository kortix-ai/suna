import { beforeEach, afterEach, describe, expect, mock, test } from 'bun:test';

// The module guards itself with `server-only`; under bun test that guard fires,
// so stand in an empty module.
mock.module('server-only', () => ({}));

const { serverBackendUrl } = await import('./public-env-server');

/**
 * Pins the server-side precedence rule of env-schema.ts: a server caller that
 * builds a URL must resolve the absolute `process.env.BACKEND_URL` first — the
 * public value may be a root-relative same-origin preview shape ("/v1") that
 * only the browser can fetch. The auth callback's billing lookup and the auth
 * actions' existence check both go through this one accessor.
 */
describe('serverBackendUrl', () => {
  const saved: Record<string, string | undefined> = {};
  const KEYS = ['BACKEND_URL', 'KORTIX_PUBLIC_BACKEND_URL', 'NEXT_PUBLIC_BACKEND_URL'];

  beforeEach(() => {
    for (const key of KEYS) saved[key] = process.env[key];
    for (const key of KEYS) delete process.env[key];
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('the absolute runtime var wins over a root-relative public value', () => {
    process.env.BACKEND_URL = 'http://localhost:8008/v1';
    process.env.NEXT_PUBLIC_BACKEND_URL = '/v1';
    expect(serverBackendUrl()).toBe('http://localhost:8008/v1');
  });

  test('without the runtime var, the public chain value is used', () => {
    process.env.KORTIX_PUBLIC_BACKEND_URL = 'https://api.example.test/v1';
    expect(serverBackendUrl()).toBe('https://api.example.test/v1');
  });

  test('the caller fallback shapes the mocked-module contract (an invalid public value cannot reach it)', () => {
    // The schema refuses an empty/invalid BACKEND_URL, so through the real
    // module the fallback is belt-and-braces; the auth tests mock this module
    // and exercise the fallback contract directly.
    process.env.BACKEND_URL = 'http://localhost:8008/v1';
    expect(serverBackendUrl('http://elsewhere.test/v1')).toBe('http://localhost:8008/v1');
  });
});
