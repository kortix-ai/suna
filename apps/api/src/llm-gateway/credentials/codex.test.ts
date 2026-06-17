import { describe, expect, test } from 'bun:test';

import { accountIdFromJwt, applyRefresh, needsRefresh, parseCodexAuth } from './codex-core';

function jwt(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${header}.${body}.`;
}

describe('parseCodexAuth', () => {
  test('extracts the openai oauth block', () => {
    const stored = parseCodexAuth(JSON.stringify({ openai: { type: 'oauth', access: 'a', refresh: 'r', expires: 123 } }));
    expect(stored).toEqual({ type: 'oauth', access: 'a', refresh: 'r', expires: 123 });
  });

  test('returns null for malformed json or missing block', () => {
    expect(parseCodexAuth('not json')).toBeNull();
    expect(parseCodexAuth(JSON.stringify({ anthropic: {} }))).toBeNull();
  });
});

describe('needsRefresh', () => {
  const now = 1_000_000_000_000;
  test('true within five minutes of expiry', () => {
    expect(needsRefresh({ expires: now + 60_000 }, now)).toBe(true);
  });
  test('false when comfortably valid', () => {
    expect(needsRefresh({ expires: now + 60 * 60_000 }, now)).toBe(false);
  });
  test('false when expiry is unknown', () => {
    expect(needsRefresh({ access: 'a' }, now)).toBe(false);
  });
});

describe('applyRefresh', () => {
  const now = 1_000_000_000_000;
  test('rotates tokens and computes expiry', () => {
    const next = applyRefresh(
      { access_token: 'a2', refresh_token: 'r2', expires_in: 3600, id_token: jwt({ chatgpt_account_id: 'acct_9' }) },
      { access: 'a1', refresh: 'r1', accountId: undefined },
      now,
    );
    expect(next).toEqual({ type: 'oauth', access: 'a2', refresh: 'r2', expires: now + 3_600_000, accountId: 'acct_9' });
  });

  test('keeps the prior refresh token + accountId when the response omits them', () => {
    const next = applyRefresh({ access_token: 'a2' }, { access: 'a1', refresh: 'r1', accountId: 'acct_1' }, now);
    expect(next?.refresh).toBe('r1');
    expect(next?.accountId).toBe('acct_1');
  });

  test('returns null without an access token', () => {
    expect(applyRefresh({ refresh_token: 'r2' }, { refresh: 'r1' }, now)).toBeNull();
  });
});

describe('accountIdFromJwt', () => {
  test('reads chatgpt_account_id from the nested auth claim', () => {
    expect(accountIdFromJwt(jwt({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct_nested' } }))).toBe('acct_nested');
  });
  test('returns undefined for a non-jwt', () => {
    expect(accountIdFromJwt('garbage')).toBeUndefined();
  });
});
