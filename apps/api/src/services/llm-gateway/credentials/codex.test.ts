import { describe, expect, test } from 'bun:test';

import {
  accountIdFromJwt,
  applyRefresh,
  isPermanentRefreshRejection,
  needsRefresh,
  parseCodexAuth,
  refreshErrorCode,
  tokenStillValid,
} from './codex-core';

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

describe('tokenStillValid', () => {
  const now = 1_000_000_000_000;
  test('true while the access token has not expired (grace fallback)', () => {
    expect(tokenStillValid({ access: 'a', expires: now + 60_000 }, now)).toBe(true);
  });
  test('false once expired', () => {
    expect(tokenStillValid({ access: 'a', expires: now - 1 }, now)).toBe(false);
  });
  test('false without an access token', () => {
    expect(tokenStillValid({ expires: now + 60_000 }, now)).toBe(false);
  });
  test('true when expiry is unknown but an access token exists', () => {
    expect(tokenStillValid({ access: 'a' }, now)).toBe(true);
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

// Measured against https://auth.openai.com/oauth/token on 2026-09-25: an
// unknown refresh token answers 401 with this body; an empty one answers 400
// `empty_string` (our request was malformed, the login is not dead).
describe('refreshErrorCode', () => {
  test('reads the OpenAI error object', () => {
    expect(refreshErrorCode({ error: {
      message: 'Could not validate your refresh token. Please try signing in again.',
      type: 'invalid_request_error', param: null, code: 'invalid_refresh_token',
    } })).toBe('invalid_refresh_token');
  });

  test('reads an RFC 6749 error string', () => {
    expect(refreshErrorCode({ error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' })).toBe('invalid_grant');
  });

  test('is undefined for any other body', () => {
    expect(refreshErrorCode(null)).toBeUndefined();
    expect(refreshErrorCode('Bad Gateway')).toBeUndefined();
    expect(refreshErrorCode({ error: { message: 'no code' } })).toBeUndefined();
  });
});

describe('isPermanentRefreshRejection', () => {
  test('a 401 means the login is not accepted any more, whatever the code', () => {
    expect(isPermanentRefreshRejection(401, 'invalid_refresh_token')).toBe(true);
    expect(isPermanentRefreshRejection(401, undefined)).toBe(true);
  });

  test('a 400 or 403 is permanent only with a dead-token code', () => {
    for (const code of ['invalid_grant', 'invalid_refresh_token', 'refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']) {
      expect(isPermanentRefreshRejection(400, code)).toBe(true);
      expect(isPermanentRefreshRejection(403, code)).toBe(true);
    }
    expect(isPermanentRefreshRejection(400, 'empty_string')).toBe(false);
    expect(isPermanentRefreshRejection(403, undefined)).toBe(false);
  });

  test('rate limits, timeouts and server errors are transient', () => {
    for (const status of [408, 425, 429, 500, 502, 503, 504]) {
      expect(isPermanentRefreshRejection(status, 'invalid_grant')).toBe(false);
    }
  });
});
