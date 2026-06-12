import { describe, expect, test } from 'bun:test';

import { isReservedSandboxEnvName, sanitizeSandboxEnv } from '../projects/lib/sandbox-env-names';

describe('isReservedSandboxEnvName', () => {
  test('flags platform-reserved + KORTIX_/OPENCODE_ prefixes', () => {
    expect(isReservedSandboxEnvName('PORT')).toBe(true);
    expect(isReservedSandboxEnvName('PATH')).toBe(true);
    expect(isReservedSandboxEnvName('LD_PRELOAD')).toBe(true);
    expect(isReservedSandboxEnvName('KORTIX_TOKEN')).toBe(true);
    expect(isReservedSandboxEnvName('OPENCODE_CONFIG_DIR')).toBe(true);
  });

  test('allows ordinary user secret names', () => {
    expect(isReservedSandboxEnvName('OPENAI_API_KEY')).toBe(false);
    expect(isReservedSandboxEnvName('STRIPE_SECRET')).toBe(false);
  });
});

describe('sanitizeSandboxEnv', () => {
  test('mirrors boot guardrails: drops reserved, prefixed, and never-in-sandbox keys', () => {
    const { env, names } = sanitizeSandboxEnv({
      OPENAI_API_KEY: 'sk-123',
      DATABASE_URL: 'postgres://x',
      PORT: '9999',
      PATH: '/evil',
      KORTIX_TOKEN: 'leak',
      OPENCODE_CONFIG_DIR: '/x',
      SLACK_SIGNING_SECRET: 'sign',
    });
    expect(env).toEqual({ OPENAI_API_KEY: 'sk-123', DATABASE_URL: 'postgres://x' });
    expect(names).toEqual(['DATABASE_URL', 'OPENAI_API_KEY']);
  });

  test('names are sorted and aligned with the kept env keys', () => {
    const { env, names } = sanitizeSandboxEnv({ ZED: '1', ALPHA: '2', MID: '3' });
    expect(names).toEqual(['ALPHA', 'MID', 'ZED']);
    expect(Object.keys(env).sort()).toEqual(names);
  });

  test('empty input yields empty output', () => {
    const { env, names } = sanitizeSandboxEnv({});
    expect(env).toEqual({});
    expect(names).toEqual([]);
  });
});
