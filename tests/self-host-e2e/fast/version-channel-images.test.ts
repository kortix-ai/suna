import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SelfHostSandbox, selfHostCapabilities } from '../support/cli';

// CASE 4 (spec §4): run-any-version / local-images mode.
//
// As of this writing, `--version`/`--tag`/`--release` (pinning), `--channel`,
// and `--local-images` are all live in this CLI build — confirmed empirically
// against this checkout on 2026-07-15 (this was in flight from a sibling
// agent when this suite was first written; it landed mid-session, so every
// test below is a real assertion, none skip-pending).
//
// Every test in the main describe block is still gated on
// selfHostCapabilities() so this file degrades to a clean `describe.skip`
// (never a false failure) if it ever runs against an older CLI build that
// predates this feature.

const caps = await selfHostCapabilities();

describe.skipIf(!caps.localImages)(
  'self-host run-any-version / local-images (fast, no Docker)',
  () => {
    let sandbox: SelfHostSandbox;

    beforeEach(() => {
      sandbox = new SelfHostSandbox();
    });

    afterEach(() => sandbox.cleanup());

    test('--version 0.9.107 pins every *_IMAGE tag to :0.9.107 and defaults auto-update OFF', async () => {
      const { code } = await sandbox.run([
        'init',
        '--yes',
        '--allow-missing-secrets',
        '--version',
        '0.9.107',
      ]);
      expect(code).toBe(0);
      const env = sandbox.readEnv();

      expect(env.KORTIX_VERSION).toBe('0.9.107');
      expect(env.FRONTEND_IMAGE).toBe('kortix/kortix-frontend:0.9.107');
      expect(env.API_IMAGE).toBe('kortix/kortix-api:0.9.107');
      expect(env.GATEWAY_IMAGE).toBe('kortix/kortix-gateway:0.9.107');
      expect(env.SANDBOX_IMAGE).toBe('kortix/kortix-sandbox:0.9.107');
      // Pinning an explicit version doesn't invent/overwrite the channel name.
      expect(env.KORTIX_CHANNEL).toBe('stable');
      // A pinned ref means "stay here" — the nightly updater must not silently
      // move a pinned box off it.
      expect(env.KORTIX_AUTO_UPDATE).toBe('false');
    });

    test('--tag and --release are accepted aliases for --version', async () => {
      const viaTag = await sandbox.run([
        'init',
        '--yes',
        '--allow-missing-secrets',
        '--tag',
        '0.9.55',
      ]);
      expect(viaTag.code).toBe(0);
      expect(sandbox.readEnv().API_IMAGE).toBe('kortix/kortix-api:0.9.55');
      expect(sandbox.readEnv().KORTIX_AUTO_UPDATE).toBe('false');

      const other = new SelfHostSandbox();
      try {
        const viaRelease = await other.run([
          'init',
          '--yes',
          '--allow-missing-secrets',
          '--release',
          '0.9.60',
        ]);
        expect(viaRelease.code).toBe(0);
        expect(other.readEnv().API_IMAGE).toBe('kortix/kortix-api:0.9.60');
        expect(other.readEnv().KORTIX_AUTO_UPDATE).toBe('false');
      } finally {
        other.cleanup();
      }
    });

    test('--channel latest tracks :latest and keeps auto-update ON (a moving channel, not a pin)', async () => {
      const { code } = await sandbox.run([
        'init',
        '--yes',
        '--allow-missing-secrets',
        '--channel',
        'latest',
      ]);
      expect(code).toBe(0);
      const env = sandbox.readEnv();
      expect(env.KORTIX_CHANNEL).toBe('latest');
      expect(env.API_IMAGE).toBe('kortix/kortix-api:latest');
      expect(env.KORTIX_AUTO_UPDATE).toBe('true');
    });

    test('an explicit --auto-update always wins over the pin/channel default', async () => {
      const pinnedOn = await sandbox.run([
        'init',
        '--yes',
        '--allow-missing-secrets',
        '--version',
        '0.9.107',
        '--auto-update',
        'on',
      ]);
      expect(pinnedOn.code).toBe(0);
      expect(sandbox.readEnv().KORTIX_AUTO_UPDATE).toBe('true');

      const channelOff = new SelfHostSandbox();
      try {
        const result = await channelOff.run([
          'init',
          '--yes',
          '--allow-missing-secrets',
          '--channel',
          'latest',
          '--auto-update',
          'off',
        ]);
        expect(result.code).toBe(0);
        expect(channelOff.readEnv().KORTIX_AUTO_UPDATE).toBe('false');
      } finally {
        channelOff.cleanup();
      }
    });

    test('--local-images sets KORTIX_IMAGE_PULL=never and forces auto-update off', async () => {
      const { code } = await sandbox.run([
        'init',
        '--yes',
        '--allow-missing-secrets',
        '--version',
        'dev-abc123',
        '--local-images',
      ]);
      expect(code).toBe(0);
      const env = sandbox.readEnv();
      expect(env.KORTIX_VERSION).toBe('dev-abc123');
      expect(env.API_IMAGE).toBe('kortix/kortix-api:dev-abc123');
      expect(env.KORTIX_IMAGE_PULL).toBe('never');
      expect(env.KORTIX_AUTO_UPDATE).toBe('false');
    });

    test('--local-images forces auto-update off even on the default stable channel', async () => {
      const { code } = await sandbox.run([
        'init',
        '--yes',
        '--allow-missing-secrets',
        '--local-images',
      ]);
      expect(code).toBe(0);
      const env = sandbox.readEnv();
      expect(env.KORTIX_IMAGE_PULL).toBe('never');
      expect(env.KORTIX_AUTO_UPDATE).toBe('false');
    });

    test('--no-pull is an accepted alias for --local-images', async () => {
      const { code } = await sandbox.run(['init', '--yes', '--allow-missing-secrets', '--no-pull']);
      expect(code).toBe(0);
      expect(sandbox.readEnv().KORTIX_IMAGE_PULL).toBe('never');
    });

    test('without --local-images, KORTIX_IMAGE_PULL is left unset (default Docker pull policy)', async () => {
      const { code } = await sandbox.run(['init', '--yes', '--allow-missing-secrets']);
      expect(code).toBe(0);
      expect(sandbox.readEnv().KORTIX_IMAGE_PULL ?? '').toBe('');
    });
  },
);
