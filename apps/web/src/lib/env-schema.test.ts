import { describe, expect, test } from 'bun:test';

import { parseRuntimeEnv } from './env-schema';

const REQUIRED = {
  SUPABASE_URL: 'http://localhost:54321',
  SUPABASE_ANON_KEY: 'anon-key',
  BACKEND_URL: 'http://localhost:8008/v1',
};

// Self-host configuration flag: KORTIX_PUBLIC_DISABLE_LANDING_PAGE. Defaults
// to false (a fresh self-host or cloud deployment has the landing page on)
// and is a boolean by the time it reaches this schema — env-config.ts /
// public-env-server.ts already did the `=== 'true'` coercion.
describe('RuntimeEnvSchema — self-host configuration flags', () => {
  test('DISABLE_LANDING_PAGE defaults to false', () => {
    const env = parseRuntimeEnv(REQUIRED);
    expect(env.DISABLE_LANDING_PAGE).toBe(false);
  });

  test('flips on when explicitly true', () => {
    const env = parseRuntimeEnv({
      ...REQUIRED,
      DISABLE_LANDING_PAGE: true,
    });
    expect(env.DISABLE_LANDING_PAGE).toBe(true);
  });

  test('BILLING_ENABLED still defaults false, unaffected by the new flag', () => {
    const env = parseRuntimeEnv(REQUIRED);
    expect(env.BILLING_ENABLED).toBe(false);
  });
});

// CLOUD-ONLY: Kortix's own managed model lineup ("Managed · Included with
// your plan") must never appear on a self-host by default. Mirrors the
// backend's KORTIX_MANAGED_PROVIDER_ENABLED.
describe('RuntimeEnvSchema — MANAGED_PROVIDER_ENABLED', () => {
  test('defaults false (self-host)', () => {
    const env = parseRuntimeEnv(REQUIRED);
    expect(env.MANAGED_PROVIDER_ENABLED).toBe(false);
  });

  test('flips on when Kortix Cloud sets it true', () => {
    const env = parseRuntimeEnv({ ...REQUIRED, MANAGED_PROVIDER_ENABLED: true });
    expect(env.MANAGED_PROVIDER_ENABLED).toBe(true);
  });
});

// Self-host account-creation restriction: KORTIX_PUBLIC_RESTRICT_ACCOUNT_CREATION.
// Defaults false (cloud is unaffected); the self-host CLI sets it explicitly
// via SHARED_FEATURE_FLAG_DEFAULTS.
describe('RuntimeEnvSchema — RESTRICT_ACCOUNT_CREATION', () => {
  test('defaults to false', () => {
    const env = parseRuntimeEnv(REQUIRED);
    expect(env.RESTRICT_ACCOUNT_CREATION).toBe(false);
  });

  test('flips on when explicitly true', () => {
    const env = parseRuntimeEnv({ ...REQUIRED, RESTRICT_ACCOUNT_CREATION: true });
    expect(env.RESTRICT_ACCOUNT_CREATION).toBe(true);
  });
});
