import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { SelfHostSandbox } from '../support/cli';

// Coverage for the stateless LiteLLM translation sidecar's `.env` surface
// (see packages/llm-gateway's GatewayConfig.translationSidecar). The
// compose-RENDERING assertions for this feature (litellm service
// present/absent, memory ceiling, no published ports, kortix-api wiring) live
// in apps/cli/src/self-host/__tests__/compose-assets.test.ts instead of here,
// deliberately: that suite calls renderFullDockerCompose() as a pure function
// with an explicit `translationSidecarConfigured` option, so both the
// enabled and disabled shapes are exercised deterministically. Doing that here
// via `env set` would need to actually flip the flag on a real instance named
// "default", and `env set` restarts real running services by Compose PROJECT
// NAME (kortix-<instance>) — which on a shared/dev machine can collide with
// and mutate an unrelated ALREADY-RUNNING "default" self-host instance one
// level up (`~/.config/kortix/self-host/default`), not just this sandboxed
// one. This file only exercises what `init` alone writes to `.env` — `init`
// never restarts anything, so it carries none of that risk.

describe('self-host LiteLLM translation sidecar — .env surface (fast, no Docker)', () => {
  let sandbox: SelfHostSandbox;

  beforeEach(() => {
    sandbox = new SelfHostSandbox();
  });

  afterEach(() => sandbox.cleanup());

  test('LITELLM_MASTER_KEY is always generated at init, regardless of the toggle', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const env = sandbox.readEnv();
    expect(env.LITELLM_MASTER_KEY).toBeTruthy();
    expect(env.LITELLM_MASTER_KEY.length).toBeGreaterThanOrEqual(32);
  });

  test('LLM_TRANSLATION_SIDECAR_ENABLED defaults to a well-formed true/false (RAM-gated), never unset', async () => {
    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    const env = sandbox.readEnv();
    expect(['true', 'false']).toContain(env.LLM_TRANSLATION_SIDECAR_ENABLED);
  });

  test('LLM_TRANSLATION_SIDECAR_URL always mirrors the enabled flag: http://litellm:4000 or empty, never anything else', async () => {
    await sandbox.run(['init', '--yes']);
    const env = sandbox.readEnv();
    if (env.LLM_TRANSLATION_SIDECAR_ENABLED === 'true') {
      expect(env.LLM_TRANSLATION_SIDECAR_URL).toBe('http://litellm:4000');
    } else {
      expect(env.LLM_TRANSLATION_SIDECAR_URL).toBe('');
    }
  });

  test('LITELLM_IMAGE is pinned by tag@digest at init, not a floating tag', async () => {
    await sandbox.run(['init', '--yes']);
    const env = sandbox.readEnv();
    expect(env.LITELLM_IMAGE).toMatch(/^ghcr\.io\/berriai\/litellm:.+@sha256:[a-f0-9]{64}$/);
  });

  test('a plain re-init does not silently reset an operator override of the toggle', async () => {
    await sandbox.run(['init', '--yes']);
    const initial = sandbox.readEnv().LLM_TRANSLATION_SIDECAR_ENABLED;
    const flipped = initial === 'true' ? 'false' : 'true';

    // Hand-edit `.env` directly (no docker compose restart involved at all —
    // unlike `env set`, this can never touch a real running instance).
    const path = `${sandbox.configRoot}/default/.env`;
    const content = await Bun.file(path).text();
    await Bun.write(
      path,
      content.replace(/^LLM_TRANSLATION_SIDECAR_ENABLED=.*$/m, `LLM_TRANSLATION_SIDECAR_ENABLED=${flipped}`),
    );

    const { code } = await sandbox.run(['init', '--yes']);
    expect(code).toBe(0);
    expect(sandbox.readEnv().LLM_TRANSLATION_SIDECAR_ENABLED).toBe(flipped);
  });
});
