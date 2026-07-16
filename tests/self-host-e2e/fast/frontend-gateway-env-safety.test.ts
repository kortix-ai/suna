import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SelfHostSandbox, composeServiceBlock, composeServiceEnv } from '../support/cli';

// CI guarantee: secrets never reach the frontend or the LLM gateway. Both
// services are network-facing in a way `kortix-api` isn't (frontend ships to
// the browser; llm-gateway proxies third-party model calls) — an explicit
// `environment:` entry there would land in a process an operator might
// reasonably expect to be lower-trust than the API. Rather than re-deriving
// "which keys are secrets" from secrets-registry.ts (a second, driftable
// source of truth), this pins the exact allowlist against the rendered
// Compose file directly: every key the `frontend`/`llm-gateway` `environment:`
// block declares must be one of these, full stop. Any new key added to
// kortix-compose.yml for either service has to be added here deliberately —
// this test forces that to be a conscious decision, not a silent leak.

describe('self-host compose: secrets never reach frontend/llm-gateway (fast, no Docker)', () => {
  let sandbox: SelfHostSandbox;

  beforeEach(() => {
    sandbox = new SelfHostSandbox();
  });

  afterEach(() => sandbox.cleanup());

  test('frontend environment is limited to public config — no DAYTONA/GITHUB/POSTGRES/gateway-token keys', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const compose = sandbox.readComposeText();

    const frontendEnv = composeServiceEnv(composeServiceBlock(compose, 'frontend'));
    const keys = Object.keys(frontendEnv);
    expect(keys.length).toBeGreaterThan(0);

    const ALLOWED_FRONTEND_KEYS = new Set([
      'KORTIX_API_PROXY_TARGET',
      'KORTIX_PUBLIC_SUPABASE_URL',
      'KORTIX_PUBLIC_SUPABASE_ANON_KEY',
      'KORTIX_PUBLIC_BACKEND_URL',
      'KORTIX_PUBLIC_BILLING_ENABLED',
      'KORTIX_PUBLIC_CONNECTORS_ENABLED',
      'KORTIX_PUBLIC_APP_URL',
      'KORTIX_PUBLIC_AUTH_METHODS',
      'KORTIX_PUBLIC_DISABLE_LANDING_PAGE',
      'SUPABASE_URL',
      'SUPABASE_SERVER_URL',
      'SUPABASE_ANON_KEY',
      'BACKEND_URL',
      'NODE_OPTIONS',
    ]);

    for (const key of keys) {
      // Every KORTIX_PUBLIC_* key is fine by construction (that prefix IS the
      // "safe to expose to the browser" contract) — anything else must be on
      // the explicit allowlist above.
      const allowed = key.startsWith('KORTIX_PUBLIC_') || ALLOWED_FRONTEND_KEYS.has(key);
      expect(allowed, `unexpected frontend env key: ${key}`).toBe(true);
    }

    // Belt-and-suspenders: name the specific secrets that must never appear,
    // so a failure here reads as "a secret leaked" rather than "an allowlist
    // needs updating" if a future refactor renames the allowlist away.
    for (const forbidden of [
      'DAYTONA_API_KEY',
      'PLATINUM_API_KEY',
      'E2B_API_KEY',
      'MANAGED_GIT_GITHUB_TOKEN',
      'KORTIX_GITHUB_APP_PRIVATE_KEY',
      'POSTGRES_PASSWORD',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_JWT_SECRET',
      'GATEWAY_INTERNAL_TOKEN',
      'INTERNAL_SERVICE_KEY',
      'API_KEY_SECRET',
      'OPENROUTER_API_KEY',
      'PIPEDREAM_CLIENT_SECRET',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  test('llm-gateway environment is limited to its own config + GATEWAY_INTERNAL_TOKEN — never DAYTONA/GITHUB/POSTGRES keys', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const compose = sandbox.readComposeText();

    const gatewayEnv = composeServiceEnv(composeServiceBlock(compose, 'llm-gateway'));
    const keys = Object.keys(gatewayEnv);
    expect(keys.length).toBeGreaterThan(0);

    const ALLOWED_GATEWAY_KEYS = new Set(['PORT', 'KORTIX_API_URL', 'GATEWAY_INTERNAL_TOKEN']);
    for (const key of keys) {
      expect(ALLOWED_GATEWAY_KEYS.has(key), `unexpected llm-gateway env key: ${key}`).toBe(true);
    }

    for (const forbidden of [
      'DAYTONA_API_KEY',
      'PLATINUM_API_KEY',
      'E2B_API_KEY',
      'MANAGED_GIT_GITHUB_TOKEN',
      'KORTIX_GITHUB_APP_PRIVATE_KEY',
      'POSTGRES_PASSWORD',
      'SUPABASE_SERVICE_ROLE_KEY',
      'SUPABASE_JWT_SECRET',
      'OPENROUTER_API_KEY',
      'PIPEDREAM_CLIENT_SECRET',
    ]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // kortix-api is the one service allowed full secret access — it gets
  // everything via `env_file: .env` (see kortix-compose.yml), never a
  // duplicated `environment:` entry for the sensitive keys (a duplicate would
  // win over env_file and re-pin the value at render time). Asserting THAT
  // shape (env_file present, no secret duplicated into `environment:`) is
  // already covered by feature-flags.test.ts; this file only pins the
  // frontend/llm-gateway allowlists.
});
