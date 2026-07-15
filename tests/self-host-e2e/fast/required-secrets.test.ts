import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SelfHostSandbox } from '../support/cli';

// CASE 3 (spec §3): required-secrets warning. `init`/`start` never hard-block
// on a missing sandbox key (there is no `--allow-missing-secrets` escape
// hatch anymore — that WAS the default-block behavior; now there's simply no
// block) — they always proceed, printing a loud warning with the exact
// `env set` fix command when something required is still unset.

describe('self-host required-secrets warning (fast, no Docker)', () => {
  let sandbox: SelfHostSandbox;

  beforeEach(() => {
    sandbox = new SelfHostSandbox();
  });

  afterEach(() => sandbox.cleanup());

  // Contract as of the frontend-first CLI simplification: the CLI's
  // init-time check is narrow — ONLY the agent sandbox runtime (Daytona) is
  // called out. Managed git (GitHub) and the LLM key (OpenRouter) are BOTH
  // configured in the web dashboard after `start` (Settings → Git / the
  // model picker, BYOK) — neither is ever mentioned here. See
  // missingRequiredSecrets() in apps/cli/src/commands/self-host.ts.
  test('init --yes with the sandbox runtime missing warns, names it, and still exits 0', async () => {
    const { code, stdout } = await sandbox.run(['init', '--yes']);

    expect(code).toBe(0);
    expect(stdout.toLowerCase()).toContain('daytona');
    expect(stdout).toContain('Proceeding with required secrets missing');
    expect(stdout).toContain('kortix self-host env set DAYTONA_API_KEY');
    // Managed git / LLM are dashboard-configured now — the warning must NOT
    // claim they're required.
    expect(stdout.toLowerCase()).not.toContain('managed git');
    expect(stdout.toLowerCase()).not.toContain('openrouter');

    // The env is still written even though the secret is missing — a
    // follow-up `env set` has something to build on.
    const env = sandbox.readEnv();
    expect(env.DAYTONA_API_KEY).toBe('');
  });

  test('setting the sandbox key clears the warning on a later re-init', async () => {
    const first = await sandbox.run(['init', '--yes']);
    expect(first.code).toBe(0);
    expect(first.stdout).toContain('Proceeding with required secrets missing');

    const envSet = await sandbox.run(['env', 'set', 'DAYTONA_API_KEY=dtn-test-key']);
    expect(envSet.code).toBe(0);

    const second = await sandbox.run(['init', '--yes']);
    expect(second.code).toBe(0);
    expect(second.stdout).not.toContain('Proceeding with required secrets missing');
    const env = sandbox.readEnv();
    expect(env.DAYTONA_API_KEY).toBe('dtn-test-key');
    // Neither was set, and neither blocks success or triggers a warning.
    expect(env.OPENROUTER_API_KEY).toBe('');
    expect(env.MANAGED_GIT_GITHUB_OWNER).toBe('');
  });

  test('managed git / OpenRouter left unset never blocks init, with or without a GitHub App configured', async () => {
    await sandbox.run(['init', '--yes']);
    await sandbox.run([
      'env',
      'set',
      'DAYTONA_API_KEY=dtn-test-key',
      'MANAGED_GIT_GITHUB_OWNER=acme-corp',
      'KORTIX_GITHUB_APP_ID=12345',
      'KORTIX_GITHUB_APP_PRIVATE_KEY=-----BEGIN KEY-----test-----END KEY-----',
      'MANAGED_GIT_GITHUB_INSTALL_ID=67890',
    ]);

    const { code, stdout } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    expect(stdout).not.toContain('Proceeding with required secrets missing');
  });
});
