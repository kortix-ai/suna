import { describe, expect, test } from 'bun:test';
import { oauthScopeAllowsPath } from './access-token';

const KORTIX = ['profile', 'email', 'kortix'];

// Pentest M-2: an App's code holds its viewer's `kortix` token, and any DCR
// client can get one. Neither may change sign-in state, delete the account or
// mint a credential that outlives the grant.
describe('oauthScopeAllowsPath', () => {
  test.each([
    ['POST', '/v1/projects/p1/apps/a1/token'],
    ['PATCH', '/v1/accounts/acc/iam/pat-policy'],
    ['PATCH', '/v1/auth/user'],
    ['POST', '/v1/auth/password/update'],
    ['POST', '/v1/account/request-deletion'],
    ['POST', '/v1/billing/account/request-deletion'],
    ['POST', '/v1/tunnel/connections/t1/rotate-token'],
    ['POST', '/v1/platform/github-app/pat'],
    ['POST', '/v1/auth/mfa/factors'],
    ['PATCH', '/v1/auth/user/'],
  ])('a kortix token may not %s %s', (method, path) => {
    expect(oauthScopeAllowsPath(KORTIX, path, method)).toBe(false);
  });

  test('a kortix token still reads those routes and writes everything else', () => {
    expect(oauthScopeAllowsPath(KORTIX, '/v1/accounts/tokens', 'GET')).toBe(true);
    expect(oauthScopeAllowsPath(KORTIX, '/v1/projects/p1/sessions', 'POST')).toBe(true);
    expect(oauthScopeAllowsPath(KORTIX, '/v1/projects/p1/git-token', 'POST')).toBe(true);
  });

  test('an identity-only token reaches only the identity probes', () => {
    expect(oauthScopeAllowsPath(['profile'], '/v1/accounts/me')).toBe(true);
    expect(oauthScopeAllowsPath(['profile'], '/v1/projects')).toBe(false);
  });
});
