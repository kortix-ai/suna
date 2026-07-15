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

  test('default: marketing OFF, billing off, enterprise off, git provider declared github', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const env = sandbox.readEnv();

    // Marketing/landing site DEACTIVATED by default on self-host — every
    // marketing route redirects to the app (see apps/web middleware).
    expect(env.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');
    // Billing off by default.
    expect(env.KORTIX_BILLING_INTERNAL_ENABLED).toBe('false');
    expect(env.KORTIX_PUBLIC_BILLING_ENABLED).toBe('false');
    // Enterprise off by default.
    expect(env.ENTERPRISE_LICENSE_AVAILABLE).toBe('false');
    // Managed git's declared provider is always github, but it's NOT
    // init-required anymore — it's configured in-app (Settings → Git) after
    // start, not gated by this CLI. See required-secrets.test.ts.
    expect(env.MANAGED_GIT_PROVIDER).toBe('github');
  });

  // There is deliberately no `--landing`/`--no-landing` flag: the landing page
  // isn't a guided-flow decision (self-host is an app deployment, not a
  // marketing site), it's just an ordinary env var an operator flips directly
  // if they genuinely want it back — see the default-off assertion above.
  test('re-enabling the landing page is a plain `env set`, no dedicated flag', async () => {
    await sandbox.run(['init', '--yes']);
    expect(sandbox.readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');

    const { code } = await sandbox.run(['env', 'set', 'KORTIX_PUBLIC_DISABLE_LANDING_PAGE=false']);
    expect(code).toBe(0);
    expect(sandbox.readEnv().KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('false');
  });

  test('--enterprise-license sets ENTERPRISE_LICENSE_AVAILABLE=true', async () => {
    const { code } = await sandbox.run([
      'init',
      '--yes',
      '--enterprise-license',
    ]);
    expect(code).toBe(0);
    expect(sandbox.readEnv().ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
  });

  test('billing stays off unless explicitly enabled via env set (no flag flips it on)', async () => {
    await sandbox.run([
      'init',
      '--yes',
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
    expect(after.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe('true');
    expect(after.ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
  });

  test('the rendered compose passes every flag through as a runtime template var, not a literal', async () => {
    await sandbox.run(['init', '--yes']);
    const compose = sandbox.readComposeText();

    const frontendEnv = composeServiceEnv(composeServiceBlock(compose, 'frontend'));
    expect(frontendEnv.KORTIX_PUBLIC_BILLING_ENABLED).toBe('${KORTIX_PUBLIC_BILLING_ENABLED}');
    expect(frontendEnv.KORTIX_PUBLIC_DISABLE_LANDING_PAGE).toBe(
      '${KORTIX_PUBLIC_DISABLE_LANDING_PAGE}',
    );

    // kortix-api picks these up via `env_file: .env` (the whole file), not a
    // duplicated `environment:` entry — a duplicate would win over env_file
    // and re-pin the value at render time regardless of a later `env set`.
    const apiBlock = composeServiceBlock(compose, 'kortix-api');
    const apiEnv = composeServiceEnv(apiBlock);
    expect(apiEnv.KORTIX_BILLING_INTERNAL_ENABLED).toBeUndefined();
    expect(apiEnv.ENTERPRISE_LICENSE_AVAILABLE).toBeUndefined();
    expect(apiBlock).toContain('.env');
  });

  test('feature flags survive a later plain re-init (no silent reset)', async () => {
    await sandbox.run([
      'init',
      '--yes',
      '--enterprise-license',
    ]);
    expect(sandbox.readEnv().ENTERPRISE_LICENSE_AVAILABLE).toBe('true');

    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const env = sandbox.readEnv();
    expect(env.ENTERPRISE_LICENSE_AVAILABLE).toBe('true');
  });
});
