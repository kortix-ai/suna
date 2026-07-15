import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SelfHostSandbox, composeServiceNames } from '../support/cli';

// CASE 1 (spec §1): a fresh `init` renders a valid .env + compose — every
// required service present, ports set, and SHARED_SELF_HOST_DEFAULTS applied
// (password-first auth, autoconfirm on, daytona sandbox). Pure render check:
// no Docker daemon involved, so this runs in default CI with zero setup.
//
// `--allow-missing-secrets` is required on every init below because none of
// these renders configure DAYTONA_API_KEY/managed-git/OPENROUTER_API_KEY —
// see required-secrets.test.ts for the enforcement this is deliberately
// opting out of.

describe('self-host init: fresh render (fast, no Docker)', () => {
  let sandbox: SelfHostSandbox;

  beforeEach(() => {
    sandbox = new SelfHostSandbox();
  });

  afterEach(() => sandbox.cleanup());

  test('exits 0 and writes .env + docker-compose.yml', async () => {
    const { code } = await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    expect(code).toBe(0);

    const env = sandbox.readEnv();
    expect(Object.keys(env).length).toBeGreaterThan(20);
    const compose = sandbox.readComposeText();
    expect(compose.length).toBeGreaterThan(0);
  });

  test('every required service is present in the rendered compose', async () => {
    await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    const services = composeServiceNames(sandbox.readComposeText());

    for (const required of [
      'supabase-db',
      'supabase-auth',
      'supabase-rest',
      'supabase-kong',
      'kortix-migrate',
      'kortix-api',
      'llm-gateway',
      'frontend',
      'kortix-updater',
    ]) {
      expect(services).toContain(required);
    }
    // No Caddy / no 2nd replica without a domain configured — laptop mode.
    expect(services).not.toContain('caddy');
  });

  test('ports are set (laptop-mode loopback host ports)', async () => {
    await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    const env = sandbox.readEnv();

    expect(env.FRONTEND_PORT).toBeTruthy();
    expect(env.API_PORT).toBeTruthy();
    expect(env.SUPABASE_PORT).toBeTruthy();
    expect(env.POSTGRES_PORT).toBeTruthy();
    // Every port is a distinct integer.
    const ports = [env.FRONTEND_PORT, env.API_PORT, env.SUPABASE_PORT, env.POSTGRES_PORT];
    expect(new Set(ports).size).toBe(ports.length);
    for (const p of ports) expect(Number.isInteger(Number(p))).toBe(true);

    const compose = sandbox.readComposeText();
    expect(compose).toContain('127.0.0.1:${FRONTEND_PORT}:3000');
    expect(compose).toContain('127.0.0.1:${API_PORT}:8008');
  });

  test('SHARED_SELF_HOST_DEFAULTS: password-first auth + autoconfirm + daytona sandbox', async () => {
    await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    const env = sandbox.readEnv();

    // Auth: password-first, signup on, email autoconfirm on (no SMTP needed
    // to try the product locally).
    expect(env.DISABLE_SIGNUP).toBe('false');
    expect(env.ENABLE_EMAIL_SIGNUP).toBe('true');
    expect(env.ENABLE_EMAIL_AUTOCONFIRM).toBe('true');
    expect(env.KORTIX_PUBLIC_AUTH_METHODS).toBe('password');

    // Sandbox: daytona is the only allowed provider by default.
    expect(env.ALLOWED_SANDBOX_PROVIDERS).toBe('daytona');
    expect(env.DAYTONA_SERVER_URL).toBeTruthy();
  });

  test('a re-run of init on the same instance is idempotent (no port/secret churn)', async () => {
    await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    const first = sandbox.readEnv();

    const { code } = await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    expect(code).toBe(0);
    const second = sandbox.readEnv();

    expect(second.FRONTEND_PORT).toBe(first.FRONTEND_PORT);
    expect(second.SUPABASE_JWT_SECRET).toBe(first.SUPABASE_JWT_SECRET);
    expect(second.POSTGRES_PASSWORD).toBe(first.POSTGRES_PASSWORD);
  });
});
