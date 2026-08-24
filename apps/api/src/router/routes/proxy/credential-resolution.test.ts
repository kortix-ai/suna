import { describe, expect, mock, test } from 'bun:test';

// The two token tables the platform mints into. `resolveKortixAccount` must ask
// the right one per prefix — asking only `kortix_api_keys` is what 401'd every
// built-in tool, because the in-sandbox KORTIX_TOKEN is a `kortix_pat_` row in
// `account_tokens`.
let patCalls: string[] = [];
let keyCalls: string[] = [];

mock.module('../../../repositories/account-tokens', () => ({
  validateAccountToken: async (token: string) => {
    patCalls.push(token);
    return token === 'kortix_pat_good'
      ? { isValid: true, accountId: 'acct-pat' }
      : { isValid: false, error: 'API key not found or invalid' };
  },
}));

mock.module('../../../repositories/api-keys', () => ({
  validateSecretKey: async (token: string) => {
    keyCalls.push(token);
    return token === 'kortix_goodkey'
      ? { isValid: true, accountId: 'acct-key' }
      : { isValid: false, error: 'API key not found or invalid' };
  },
}));

const { resolveKortixAccount } = await import('./helpers');

describe('resolveKortixAccount', () => {
  test('a session PAT resolves through account_tokens (the in-sandbox KORTIX_TOKEN)', async () => {
    patCalls = [];
    keyCalls = [];
    expect(await resolveKortixAccount('kortix_pat_good')).toBe('acct-pat');
    expect(patCalls).toEqual(['kortix_pat_good']);
    // Never wasted on the wrong table.
    expect(keyCalls).toEqual([]);
  });

  test('an API key / sandbox key resolves through kortix_api_keys', async () => {
    patCalls = [];
    keyCalls = [];
    expect(await resolveKortixAccount('kortix_goodkey')).toBe('acct-key');
    expect(keyCalls).toEqual(['kortix_goodkey']);
    expect(patCalls).toEqual([]);
  });

  test('an invalid credential of either shape resolves to null, never to an account', async () => {
    expect(await resolveKortixAccount('kortix_pat_revoked')).toBeNull();
    expect(await resolveKortixAccount('kortix_deadkey')).toBeNull();
  });
});
