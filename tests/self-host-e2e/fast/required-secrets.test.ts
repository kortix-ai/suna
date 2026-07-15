import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SelfHostSandbox, selfHostCapabilities } from '../support/cli';

// CASE 3 (spec §3): required-secrets enforcement. A sibling agent is building
// this in apps/cli/src/commands/self-host.ts (ensureRequiredSecrets()) in
// parallel with this suite. This whole file is gated on
// selfHostCapabilities().allowMissingSecrets, so it runs for real the moment
// that lands (already true as of this writing — confirmed by manually
// invoking `kortix self-host -h` / `init` against this checkout) and
// degrades to a clean `describe.skip` (not a false failure) if it's ever run
// against an older CLI build that doesn't have the flag yet.
//
// TODO(self-host-required-secrets): if `bun test` reports this describe
// block as skipped, check apps/cli/src/commands/self-host.ts for
// `--allow-missing-secrets` / `ensureRequiredSecrets` / `missingRequiredSecrets`
// — that's the flag this whole file is written against.
const caps = await selfHostCapabilities();

describe.skipIf(!caps.allowMissingSecrets)(
  'self-host required-secrets enforcement (fast, no Docker)',
  () => {
    let sandbox: SelfHostSandbox;

    beforeEach(() => {
      sandbox = new SelfHostSandbox();
    });

    afterEach(() => sandbox.cleanup());

    test('init --yes with required secrets missing fails non-zero and names what is missing', async () => {
      const { code, stderr } = await sandbox.run(['init', '--yes']);

      expect(code).not.toBe(0);
      // Managed-git (GitHub), Daytona API key, and an LLM (OpenRouter) key are
      // the three required-secret groups this deployment can't function
      // without — the failure message must name all three so an operator knows
      // exactly what to fix, not just that "something" is missing.
      expect(stderr.toLowerCase()).toContain('daytona');
      expect(stderr.toLowerCase()).toContain('managed git');
      expect(stderr.toLowerCase()).toContain('openrouter');
      expect(stderr).toContain('--allow-missing-secrets');
    });

    test('--allow-missing-secrets downgrades the same failure to a warning and proceeds', async () => {
      const { code, stdout } = await sandbox.run(['init', '--yes', '--allow-missing-secrets']);

      expect(code).toBe(0);
      expect(stdout.toLowerCase()).toContain('missing');
      // The env is still written even though secrets are missing — a follow-up
      // `secrets set` / `env set` has something to build on.
      const env = sandbox.readEnv();
      expect(env.OPENROUTER_API_KEY).toBe('');
      expect(env.DAYTONA_API_KEY).toBe('');
    });

    test('a fully-configured env passes without --allow-missing-secrets', async () => {
      // Secrets can't be supplied in the same non-interactive `init` call (no
      // flags for them) — the realistic flow is: render once with the escape
      // hatch, backfill the secrets via `env set`, then a plain re-init (or
      // `start`) re-validates and should now pass.
      const first = await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
      expect(first.code).toBe(0);

      const envSet = await sandbox.run([
        'env',
        'set',
        'OPENROUTER_API_KEY=sk-or-test-key',
        'DAYTONA_API_KEY=dtn-test-key',
        'MANAGED_GIT_GITHUB_OWNER=acme-corp',
        'MANAGED_GIT_GITHUB_TOKEN=ghp-test-token',
      ]);
      expect(envSet.code).toBe(0);

      const second = await sandbox.run(['init', '--yes']);
      expect(second.code).toBe(0);
      const env = sandbox.readEnv();
      expect(env.OPENROUTER_API_KEY).toBe('sk-or-test-key');
      expect(env.DAYTONA_API_KEY).toBe('dtn-test-key');
      expect(env.MANAGED_GIT_GITHUB_OWNER).toBe('acme-corp');
    });

    test('a GitHub App (instead of a PAT) also satisfies the managed-git requirement', async () => {
      await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
      await sandbox.run([
        'env',
        'set',
        'OPENROUTER_API_KEY=sk-or-test-key',
        'DAYTONA_API_KEY=dtn-test-key',
        'MANAGED_GIT_GITHUB_OWNER=acme-corp',
        'KORTIX_GITHUB_APP_ID=12345',
        'KORTIX_GITHUB_APP_PRIVATE_KEY=-----BEGIN KEY-----test-----END KEY-----',
        'MANAGED_GIT_GITHUB_INSTALL_ID=67890',
      ]);

      const { code, stderr } = await sandbox.run(['init', '--yes']);
      expect(code).toBe(0);
      expect(stderr).not.toContain('Required secrets are missing');
    });
  },
);
