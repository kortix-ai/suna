import { describe, expect, test } from 'bun:test';

import { isReservedSandboxEnvName, sanitizeSandboxEnv } from '../projects/lib/sandbox-env-names';

describe('isReservedSandboxEnvName', () => {
  test.each([
    ['PORT', true],
    ['PATH', true],
    ['LD_PRELOAD', true],
    ['KORTIX_TOKEN', true],
    ['OPENCODE_CONFIG_DIR', true],
    ['OPENAI_API_KEY', false],
    ['STRIPE_SECRET', false],
  ])('%s → %p', (name, reserved) => {
    expect(isReservedSandboxEnvName(name)).toBe(reserved);
  });
});

describe('sanitizeSandboxEnv', () => {
  // A hot re-sync applies the same guardrails as boot. SLACK_BOT_TOKEN is the
  // reason the never-in-sandbox list exists: boot withholds it, so a re-sync
  // must not inject it either.
  test('mirrors boot guardrails: drops reserved, prefixed, and never-in-sandbox keys', () => {
    const { env, names } = sanitizeSandboxEnv({
      OPENAI_API_KEY: 'sk-123',
      DATABASE_URL: 'postgres://x',
      PORT: '9999',
      PATH: '/evil',
      KORTIX_TOKEN: 'leak',
      OPENCODE_CONFIG_DIR: '/x',
      SLACK_SIGNING_SECRET: 'sign',
      SLACK_BOT_TOKEN: 'xoxb-test',
    });
    expect(env).toEqual({ OPENAI_API_KEY: 'sk-123', DATABASE_URL: 'postgres://x' });
    expect(names).toEqual(['DATABASE_URL', 'OPENAI_API_KEY']);
    expect(Object.keys(env).sort()).toEqual(names);
  });
});
