import { describe, expect, test } from 'bun:test';

import { parseRuntimeEnv } from './env-schema';

const REQUIRED = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'anon-key',
  BACKEND_URL: 'http://localhost:8008/v1',
};

// Self-host configuration flags: KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE and
// KORTIX_PUBLIC_DISABLE_LANDING_PAGE. Both default to false (a fresh
// self-host or cloud deployment is multi-account with the landing page on)
// and are booleans by the time they reach this schema — env-config.ts /
// public-env-server.ts already did the `=== 'true'` coercion.
describe('RuntimeEnvSchema — self-host configuration flags', () => {
  test('SINGLE_ACCOUNT_MODE and DISABLE_LANDING_PAGE default to false', () => {
    const env = parseRuntimeEnv(REQUIRED);
    expect(env.SINGLE_ACCOUNT_MODE).toBe(false);
    expect(env.DISABLE_LANDING_PAGE).toBe(false);
  });

  test('both flip on when explicitly true', () => {
    const env = parseRuntimeEnv({
      ...REQUIRED,
      SINGLE_ACCOUNT_MODE: true,
      DISABLE_LANDING_PAGE: true,
    });
    expect(env.SINGLE_ACCOUNT_MODE).toBe(true);
    expect(env.DISABLE_LANDING_PAGE).toBe(true);
  });

  test('BILLING_ENABLED still defaults false, unaffected by the new flags', () => {
    const env = parseRuntimeEnv(REQUIRED);
    expect(env.BILLING_ENABLED).toBe(false);
  });
});
