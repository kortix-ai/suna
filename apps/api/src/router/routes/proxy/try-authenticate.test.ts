import { describe, expect, mock, test } from 'bun:test';
import type { AuthResult } from './app';

// Characterization test for `tryAuthenticate`: the ordered set of client shapes
// the proxy accepts a Kortix credential in. It pins the 401 each shape returns for
// an invalid Kortix-shaped token, and that a valid one resolves to its account.
//
// The two token tables the platform mints into — the same mocks as
// credential-resolution.test.ts: a session PAT lives in `account_tokens`, an API
// or sandbox key in `kortix_api_keys`.
mock.module('../../../repositories/account-tokens', () => ({
  validateAccountToken: async (token: string) =>
    token === 'kortix_pat_valid'
      ? { isValid: true, accountId: 'acct-pat' }
      : { isValid: false, error: 'API key not found or invalid' },
}));

mock.module('../../../repositories/api-keys', () => ({
  validateSecretKey: async (token: string) =>
    token === 'kortix_validkey' || token === 'kortix_sb_valid'
      ? { isValid: true, accountId: 'acct-key' }
      : { isValid: false, error: 'API key not found or invalid' },
}));

const { tryAuthenticate } = await import('./helpers');

type CtxInit = {
  authorization?: string;
  xApiKey?: string;
  xKortixToken?: string;
  method?: string;
  body?: string;
};

function makeContext(init: CtxInit) {
  const headers: Record<string, string> = {};
  if (init.authorization) headers.authorization = init.authorization;
  if (init.xApiKey) headers['x-api-key'] = init.xApiKey;
  if (init.xKortixToken) headers['x-kortix-token'] = init.xKortixToken;
  return {
    req: {
      method: init.method ?? 'POST',
      header: (name: string) => headers[name.toLowerCase()],
      raw: { clone: () => ({ text: async () => init.body ?? '' }) },
    },
  };
}

async function authError(init: CtxInit): Promise<{ status: number; message: string }> {
  try {
    await tryAuthenticate(makeContext(init));
  } catch (error) {
    const thrown = error as { status?: number; message?: string };
    return { status: thrown.status ?? 0, message: thrown.message ?? '' };
  }
  throw new Error('expected tryAuthenticate to throw');
}

describe('tryAuthenticate accepts a valid Kortix token in every client shape', () => {
  const valid: Array<[string, CtxInit, AuthResult]> = [
    [
      'Authorization: Bearer <session PAT>',
      { authorization: 'Bearer kortix_pat_valid' },
      { isKortixUser: true, accountId: 'acct-pat' },
    ],
    [
      'Authorization: Bearer <sandbox key>',
      { authorization: 'Bearer kortix_sb_valid' },
      { isKortixUser: true, accountId: 'acct-key' },
    ],
    [
      'Authorization: Token <PAT> (Replicate SDK)',
      { authorization: 'Token kortix_pat_valid' },
      { isKortixUser: true, accountId: 'acct-pat' },
    ],
    [
      'x-api-key <PAT> (Anthropic SDK)',
      { xApiKey: 'kortix_pat_valid' },
      { isKortixUser: true, accountId: 'acct-pat' },
    ],
    [
      'JSON body api_key <PAT> (Tavily SDK)',
      { body: '{"api_key":"kortix_pat_valid"}' },
      { isKortixUser: true, accountId: 'acct-pat' },
    ],
    [
      'X-Kortix-Token <PAT> beside a provider key',
      { authorization: 'Bearer provider-key', xKortixToken: 'kortix_pat_valid' },
      { isKortixUser: true, accountId: 'acct-pat', isPassthrough: true },
    ],
  ];

  for (const [name, init, expected] of valid) {
    test(`accepts ${name}`, async () => {
      expect(await tryAuthenticate(makeContext(init))).toEqual(expected);
    });
  }
});

describe('tryAuthenticate rejects an invalid Kortix-shaped token per shape', () => {
  const invalid: Array<[string, CtxInit, string]> = [
    [
      'Authorization: Bearer',
      { authorization: 'Bearer kortix_pat_revoked' },
      'Invalid Kortix token',
    ],
    ['Authorization: Token', { authorization: 'Token kortix_pat_revoked' }, 'Invalid Kortix token'],
    ['x-api-key', { xApiKey: 'kortix_pat_revoked' }, 'Invalid Kortix token in x-api-key'],
    [
      'JSON body api_key',
      { body: '{"api_key":"kortix_pat_revoked"}' },
      'Invalid Kortix token in request body',
    ],
    [
      'X-Kortix-Token',
      { authorization: 'Bearer provider-key', xKortixToken: 'kortix_pat_revoked' },
      'Invalid X-Kortix-Token',
    ],
  ];

  for (const [name, init, message] of invalid) {
    test(`rejects ${name} with 401 and its own message`, async () => {
      expect(await authError(init)).toEqual({ status: 401, message });
    });
  }
});

describe('tryAuthenticate mode precedence', () => {
  test('a Kortix token in Authorization wins over X-Kortix-Token', async () => {
    expect(
      await tryAuthenticate(
        makeContext({
          authorization: 'Bearer kortix_pat_valid',
          xKortixToken: 'kortix_pat_valid',
        }),
      ),
    ).toEqual({ isKortixUser: true, accountId: 'acct-pat' });
  });

  test('an invalid Kortix token in Authorization hard-rejects before X-Kortix-Token', async () => {
    expect(
      await authError({
        authorization: 'Bearer kortix_pat_revoked',
        xKortixToken: 'kortix_pat_valid',
      }),
    ).toEqual({ status: 401, message: 'Invalid Kortix token' });
  });

  test('a provider key in Authorization with a valid X-Kortix-Token is passthrough', async () => {
    expect(
      await tryAuthenticate(
        makeContext({
          authorization: 'Bearer provider-key',
          xKortixToken: 'kortix_pat_valid',
        }),
      ),
    ).toEqual({ isKortixUser: true, accountId: 'acct-pat', isPassthrough: true });
  });

  test('no Kortix token anywhere is pure passthrough', async () => {
    expect(await tryAuthenticate(makeContext({ authorization: 'Bearer provider-key' }))).toEqual({
      isKortixUser: false,
    });
  });

  test('a non-Kortix body api_key is not a token and falls through', async () => {
    expect(await tryAuthenticate(makeContext({ body: '{"api_key":"provider-key"}' }))).toEqual({
      isKortixUser: false,
    });
  });

  test('a body with no api_key falls through', async () => {
    expect(await tryAuthenticate(makeContext({ body: '{"model":"gpt"}' }))).toEqual({
      isKortixUser: false,
    });
  });

  test('a non-JSON body falls through instead of throwing', async () => {
    expect(await tryAuthenticate(makeContext({ body: 'kortix_ not json' }))).toEqual({
      isKortixUser: false,
    });
  });
});
