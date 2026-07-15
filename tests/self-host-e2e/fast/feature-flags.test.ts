import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SelfHostSandbox, composeServiceBlock, composeServiceEnv } from '../support/cli';

// CASE 2 (spec §2): the feature-flag matrix. Asserts the rendered .env
// carries the right values per flag, and that the compose passes them through
// as runtime env (template variables, not baked-in literals) so a later
// `env set` takes effect without re-rendering the compose file.

describe('self-host feature-flag matrix (fast, no Docker)', () => {
  let sandbox: SelfHostSandbox;

  beforeEach(() => {
    sandbox = new SelfHostSandbox();
  });

  afterEach(() => sandbox.cleanup());

  test('default: multi-account, marketing OFF, billing off, enterprise off, managed-git required', async () => {
    const { code } = await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    expect(code).toBe(0);
    const env = sandbox.readEnv();

    // Multi-account (single-account mode off).
    expect(env.KORTIX_SINGLE_ACCOUNT_MODE).toBe('false');
    expect(env.KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE).toBe('false');
    // Marketing/landing site DEACTIVATED by default on self-host — every
    // marketing route redirects to the app (see apps/web middleware).
    expect(env.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');
    // Billing off by default.
    expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('false');
    expect(env.KORTIX_PUBLIC_BILLING_ENABLED).toBe('false');
    // Enterprise off by default.
    expect(env.ENTERPRISE_LICENSE_AVAILABLE).toBe('false');
    // Managed git is required (declared provider is github; init doesn't
    // silently disable the requirement — see required-secrets.test.ts for
    // enforcement).
    expect(env.MANAGED_GIT_PROVIDER).toBe('github');
  });

  test('--single-account sets both KORTIX_SINGLE_ACCOUNT_MODE and the _PUBLIC_ frontend flag', async () => {
    const { code } = await sandbox.run([
      'init',
      '--yes',
      '--allow-missing-secrets',
      '--single-account',
    ]);
    expect(code).toBe(0);
    const env = sandbox.readEnv();
    expect(env.KORTIX_SINGLE_ACCOUNT_MODE).toBe('true');
    expect(env.KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE).toBe('true');
  });

  test('--no-landing sets KORTIX_PUBLIC_DISABLE_LANDING_PAGE=true', async () => {
    const { code } = await sandbox.run([
      'init',
      '--yes',
      '--allow-missing-secrets',
      '--no-landing',
    ]);
    expect(code).toBe(0);
    expect(sandbox.readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');
  });

  test('--enterprise-license sets ENTERPRISE_LICENSE_AVAILABLE=true', async () => {
    const { code } = await sandbox.run([
      'init',
      '--yes',
      '--allow-missing-secrets',
      '--enterprise-license',
    ]);
    expect(code).toBe(0);
    expect(sandbox.readEnv().ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
  });

  test('billing stays off unless explicitly enabled via env set (no flag flips it on)', async () => {
    await sandbox.run([
      'init',
      '--yes',
      '--allow-missing-secrets',
      '--single-account',
      '--no-landing',
      '--enterprise-license',
    ]);
    const env = sandbox.readEnv();
    expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('false');
    expect(env.KORTIX_PUBLIC_BILLING_ENABLED).toBe('false');

    const { code } = await sandbox.run([
      'env',
      'set',
      'KORTIX_BILLING_INTERNAL_ENABLED=true',
      'KORTIX_PUBLIC_BILLING_ENABLED=true',
    ]);
    expect(code).toBe(0);
    const after = sandbox.readEnv();
    expect(after.KORTIX_BILLING_INTERNAL_ENABLED).toBe('true');
    expect(after.KORTIX_PUBLIC_BILLING_ENABLED).toBe('true');
    // Untouched by the billing env set.
    expect(after.KORTIX_SINGLE_ACCOUNT_MODE).toBe('true');
    expect(after.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');
    expect(after.ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
  });

  test('the rendered compose passes every flag through as a runtime template var, not a literal', async () => {
    await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    const compose = sandbox.readComposeText();

    const frontendEnv = composeServiceEnv(composeServiceBlock(compose, 'frontend'));
    expect(frontendEnv.KORTIX_PUBLIC_BILLING_ENABLED).toBe('${KORTIX_PUBLIC_BILLING_ENABLED}');
    expect(frontendEnv.KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE).toBe(
      '${KORTIX_PUBLIC_SINGLE_ACCOUNT_MODE}',
    );
    expect(frontendEnv.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe(
      '${KORTIX_PUBLIC_DISABLE_LANDING_PAGE}',
    );

    // kortix-api picks these up via `env_file: .env` (the whole file), not a
    // duplicated `environment:` entry — a duplicate would win over env_file
    // and re-pin the value at render time regardless of a later `env set`.
    const apiBlock = composeServiceBlock(compose, 'kortix-api');
    const apiEnv = composeServiceEnv(apiBlock);
    expect(apiEnv.KORTIX_BILLING_INTERNAL_ENABLED).toBeUndefined();
    expect(apiEnv.KORTIX_SINGLE_ACCOUNT_MODE).toBeUndefined();
    expect(apiEnv.ENTERPRISE_LICENSE_AVAILABLE).toBeUndefined();
    expect(apiBlock).toContain('.env');
  });

  test('feature flags survive a later plain re-init (no silent reset)', async () => {
    await sandbox.run([
      'init',
      '--yes',
      '--allow-missing-secrets',
      '--single-account',
      '--enterprise-license',
    ]);
    expect(sandbox.readEnv().KORTIX_SINGLE_ACCOUNT_MODE).toBe('true');
    expect(sandbox.readEnv().ENTERPRISE_LICENSE_AVAILABLE).toBe('true');

    const { code } = await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
    expect(code).toBe(0);
    const env = sandbox.readEnv();
    expect(env.KORTIX_SINGLE_ACCOUNT_MODE).toBe('true');
    expect(env.ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
  });
});
