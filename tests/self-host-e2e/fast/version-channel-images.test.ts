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

    // Auto-update defaults ON everywhere, including a pinned --version/--tag:
    // the nightly updater re-pulling the SAME immutable pinned tag is a
    // harmless no-op (nothing to roll), not silent drift — so pinning alone
    // is no longer a reason to default it off. --local-images is the one real
    // exception (a locally-built image was never pushed to any registry —
    // see the --local-images tests below).
    test('--version 0.9.107 pins every *_IMAGE tag to :0.9.107, auto-update still defaults ON', async () => {
      const { code } = await sandbox.run([
        'init',
        '--yes',
        '--version',
        '0.9.107',
      ]);
      expect(code).toBe(0);
      const env = sandbox.readEnv();

      expect(env.KORTIX_VERSION).toBe('0.9.107');
      expect(env.FRONTEND_IMAGE).toBe('kortix/kortix-frontend:0.9.107');
      expect(env.API_IMAGE).toBe('kortix/kortix-api:0.9.107');
      expect(env.GATEWAY_IMAGE).toBe('kortix/kortix-gateway:0.9.107');
      // Pinning an explicit version doesn't invent/overwrite the channel name.
      expect(env.KORTIX_CHANNEL).toBe('stable');
      expect(env.KORTIX_AUTO_UPDATE).toBe('true');
    });

    test('--tag and --release are accepted aliases for --version', async () => {
      const viaTag = await sandbox.run([
        'init',
        '--yes',
        '--tag',
        '0.9.55',
      ]);
      expect(viaTag.code).toBe(0);
      expect(sandbox.readEnv().API_IMAGE).toBe('kortix/kortix-api:0.9.55');
      expect(sandbox.readEnv().KORTIX_AUTO_UPDATE).toBe('true');

      const other = new SelfHostSandbox();
      try {
        const viaRelease = await other.run([
          'init',
          '--yes',
          '--release',
          '0.9.60',
        ]);
        expect(viaRelease.code).toBe(0);
        expect(other.readEnv().API_IMAGE).toBe('kortix/kortix-api:0.9.60');
        expect(other.readEnv().KORTIX_AUTO_UPDATE).toBe('true');
      } finally {
        other.cleanup();
      }
    });

    test('--channel latest tracks :latest and keeps auto-update ON (a moving channel)', async () => {
      const { code } = await sandbox.run([
        'init',
        '--yes',
        '--channel',
        'latest',
      ]);
      expect(code).toBe(0);
      const env = sandbox.readEnv();
      expect(env.KORTIX_CHANNEL).toBe('latest');
      expect(env.API_IMAGE).toBe('kortix/kortix-api:latest');
      expect(env.KORTIX_AUTO_UPDATE).toBe('true');
    });

    test('an explicit --auto-update off always wins over the (now-ON-by-default) pin/channel default', async () => {
      const pinnedOn = await sandbox.run([
        'init',
        '--yes',
        '--version',
        '0.9.107',
      ]);
      expect(pinnedOn.code).toBe(0);
      expect(sandbox.readEnv().KORTIX_AUTO_UPDATE).toBe('true');

      const channelOff = new SelfHostSandbox();
      try {
        const result = await channelOff.run([
          'init',
          '--yes',
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

    // Moving-tag tracking (CI now publishes kortix/kortix-{api,gateway,
    // frontend}:dev / :staging / :prod by re-tagging the deployed build — see
    // .github/workflows/deploy-dev.yml, deploy-staging.yml, deploy-prod.yml).
    // `--channel` itself stays stable|latest only (see isChannel/CHANNELS
    // above) — `--tag`/`--version` is the existing, already-generic way an
    // operator points at ANY published tag, moving or pinned. This just
    // proves the tag→image resolution and the auto-update override work
    // end-to-end for the new moving tags, exactly as they already do for a
    // pinned semver above.
    test('--tag dev renders every *_IMAGE at :dev, auto-update defaults ON (a moving tag)', async () => {
      const { code } = await sandbox.run(['init', '--yes', '--tag', 'dev']);
      expect(code).toBe(0);
      const env = sandbox.readEnv();

      expect(env.KORTIX_VERSION).toBe('dev');
      expect(env.FRONTEND_IMAGE).toBe('kortix/kortix-frontend:dev');
      expect(env.API_IMAGE).toBe('kortix/kortix-api:dev');
      expect(env.GATEWAY_IMAGE).toBe('kortix/kortix-gateway:dev');
      expect(env.SANDBOX_IMAGE).toBe('kortix/kortix-sandbox:dev');
      // "dev" isn't one of CHANNELS (stable|latest), so it doesn't invent a
      // channel name — same rule already covered for a semver pin above.
      expect(env.KORTIX_CHANNEL).toBe('stable');
      expect(env.KORTIX_AUTO_UPDATE).toBe('true');
    });

    test('--tag dev --auto-update on: the explicit flag wins (still ON), so the box actually tracks the moving tag nightly', async () => {
      const { code } = await sandbox.run([
        'init',
        '--yes',
        '--tag',
        'dev',
        '--auto-update',
        'on',
      ]);
      expect(code).toBe(0);
      const env = sandbox.readEnv();
      expect(env.API_IMAGE).toBe('kortix/kortix-api:dev');
      expect(env.KORTIX_AUTO_UPDATE).toBe('true');
    });

    test('--tag staging / --tag prod render the matching moving-tag images too', async () => {
      const staging = await sandbox.run(['init', '--yes', '--tag', 'staging']);
      expect(staging.code).toBe(0);
      expect(sandbox.readEnv().API_IMAGE).toBe('kortix/kortix-api:staging');
      expect(sandbox.readEnv().GATEWAY_IMAGE).toBe('kortix/kortix-gateway:staging');
      expect(sandbox.readEnv().FRONTEND_IMAGE).toBe('kortix/kortix-frontend:staging');
      expect(sandbox.readEnv().KORTIX_AUTO_UPDATE).toBe('true');

      const prodSandbox = new SelfHostSandbox();
      try {
        const prod = await prodSandbox.run(['init', '--yes', '--tag', 'prod']);
        expect(prod.code).toBe(0);
        expect(prodSandbox.readEnv().API_IMAGE).toBe('kortix/kortix-api:prod');
        expect(prodSandbox.readEnv().KORTIX_AUTO_UPDATE).toBe('true');
      } finally {
        prodSandbox.cleanup();
      }
    });

    // `update` shares the exact same resolveTag()/applyImagesForTag() path as
    // `init` (see self-host.ts selfHostUpdate) — re-running init on an
    // already-initialized instance with a different --tag exercises that
    // same "move the channel forward" code path without needing a live Docker
    // daemon (which the real `update` subcommand additionally requires, to
    // actually shell out to `docker compose` — out of scope for this fast,
    // no-Docker suite).
    test('re-running init with --tag dev after a prior pin moves every *_IMAGE to :dev (the update path)', async () => {
      const first = await sandbox.run(['init', '--yes', '--tag', '0.9.107']);
      expect(first.code).toBe(0);
      expect(sandbox.readEnv().API_IMAGE).toBe('kortix/kortix-api:0.9.107');

      const second = await sandbox.run(['init', '--yes', '--tag', 'dev']);
      expect(second.code).toBe(0);
      const env = sandbox.readEnv();
      expect(env.KORTIX_VERSION).toBe('dev');
      expect(env.API_IMAGE).toBe('kortix/kortix-api:dev');
      expect(env.GATEWAY_IMAGE).toBe('kortix/kortix-gateway:dev');
      expect(env.FRONTEND_IMAGE).toBe('kortix/kortix-frontend:dev');
      expect(env.SANDBOX_IMAGE).toBe('kortix/kortix-sandbox:dev');
      expect(env.KORTIX_AUTO_UPDATE).toBe('true');
    });

    test('--local-images forces auto-update off even on the default stable channel', async () => {
      const { code } = await sandbox.run([
        'init',
        '--yes',
        '--local-images',
      ]);
      expect(code).toBe(0);
      const env = sandbox.readEnv();
      expect(env.KORTIX_IMAGE_PULL).toBe('never');
      expect(env.KORTIX_AUTO_UPDATE).toBe('false');
    });

    test('--no-pull is an accepted alias for --local-images', async () => {
      const { code } = await sandbox.run(['init', '--yes', '--no-pull']);
      expect(code).toBe(0);
      expect(sandbox.readEnv().KORTIX_IMAGE_PULL).toBe('never');
    });

    test('without --local-images, KORTIX_IMAGE_PULL is left unset (default Docker pull policy)', async () => {
      const { code } = await sandbox.run(['init', '--yes']);
      expect(code).toBe(0);
      expect(sandbox.readEnv().KORTIX_IMAGE_PULL ?? '').toBe('');
    });
  },
);
