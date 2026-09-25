/**
 * The GitHub App USER access token store.
 *
 * GitHub refuses `POST /user/repos` from an App installation token, so a
 * personal account can only receive a new repository through a user access
 * token. That token is a credential: it is encrypted at rest with the
 * account-salted envelope, it is never returned to a caller, and a token whose
 * expiry has passed is treated as absent.
 *
 * Pure over its dependencies — the database and GitHub are injected, so this
 * suite needs neither.
 */
import { describe, expect, mock, test } from 'bun:test';

import {
  githubUserTokenIsUsable,
  resolveGitHubUserToken,
  type StoredGitHubUserToken,
} from './github-user-token';

const NOW = Date.parse('2026-09-25T12:00:00.000Z');

function stored(over: Partial<StoredGitHubUserToken> = {}): StoredGitHubUserToken {
  return {
    token: 'ghu_live',
    githubLogin: 'octo-person',
    expiresAt: null,
    ...over,
  };
}

describe('githubUserTokenIsUsable', () => {
  test('a token with no expiry is usable', () => {
    expect(githubUserTokenIsUsable(stored(), NOW)).toBe(true);
  });

  test('a token that expires later is usable', () => {
    expect(githubUserTokenIsUsable(stored({ expiresAt: NOW + 10 * 60_000 }), NOW)).toBe(true);
  });

  // A token that expires inside the next minute is treated as expired: the
  // create it would authorize takes longer than that.
  test('a token expiring within the skew is not usable', () => {
    expect(githubUserTokenIsUsable(stored({ expiresAt: NOW + 30_000 }), NOW)).toBe(false);
    expect(githubUserTokenIsUsable(stored({ expiresAt: NOW - 1 }), NOW)).toBe(false);
  });
});

describe('resolveGitHubUserToken', () => {
  test('returns the stored token for this account and user', async () => {
    const load = mock(async (_accountId: string, _userId: string) => stored());

    const resolved = await resolveGitHubUserToken(
      { accountId: 'acc-1', userId: 'user-1', ownerLogin: 'octo-person' },
      { load, now: () => NOW },
    );

    expect(resolved?.token).toBe('ghu_live');
    expect(load.mock.calls[0]).toEqual(['acc-1', 'user-1']);
  });

  test('null when nothing is stored', async () => {
    const resolved = await resolveGitHubUserToken(
      { accountId: 'acc-1', userId: 'user-1', ownerLogin: 'octo-person' },
      { load: async () => null, now: () => NOW },
    );

    expect(resolved).toBeNull();
  });

  test('null when the stored token has expired', async () => {
    const resolved = await resolveGitHubUserToken(
      { accountId: 'acc-1', userId: 'user-1', ownerLogin: 'octo-person' },
      { load: async () => stored({ expiresAt: NOW - 1 }), now: () => NOW },
    );

    expect(resolved).toBeNull();
  });

  // The token authorizes the LOGIN it was minted for. Creating under a
  // different owner with it would either fail upstream or create the repo in
  // the wrong account, so a mismatch is treated as no token at all.
  test('null when the token belongs to another GitHub login', async () => {
    const resolved = await resolveGitHubUserToken(
      { accountId: 'acc-1', userId: 'user-1', ownerLogin: 'acme-org' },
      { load: async () => stored({ githubLogin: 'octo-person' }), now: () => NOW },
    );

    expect(resolved).toBeNull();
  });

  test('the login comparison ignores case, as GitHub does', async () => {
    const resolved = await resolveGitHubUserToken(
      { accountId: 'acc-1', userId: 'user-1', ownerLogin: 'Octo-Person' },
      { load: async () => stored({ githubLogin: 'octo-person' }), now: () => NOW },
    );

    expect(resolved?.token).toBe('ghu_live');
  });

  test('an unreadable row is no token, never a thrown request', async () => {
    const resolved = await resolveGitHubUserToken(
      { accountId: 'acc-1', userId: 'user-1', ownerLogin: 'octo-person' },
      {
        load: async () => {
          throw new Error('decrypt failed');
        },
        now: () => NOW,
      },
    );

    expect(resolved).toBeNull();
  });
});
