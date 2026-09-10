import { describe, expect, test } from 'bun:test';
import { isForbiddenSandboxEnv } from './sandbox-env';

describe('sandbox credential allowlist', () => {
  test('permits only the runtime PAT and purpose-bound RPC secret', () => {
    expect(isForbiddenSandboxEnv('KORTIX_TOKEN')).toBe(false);
    expect(isForbiddenSandboxEnv('KORTIX_ENV_RPC_SECRET')).toBe(false);
    expect(isForbiddenSandboxEnv('UNRELATED_API_SECRET')).toBe(true);
  });
});
