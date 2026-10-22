import { describe, expect, test } from 'bun:test';
import { authRedirect, mfaChallengeRequired } from './mfa';

function jwt(payload: Record<string, unknown>): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'HS256', typ: 'JWT' })}.${part(payload)}.signature`;
}

type Factor = { id: string; factor_type: string; status: string };

function session(aal: string | undefined, factors?: Factor[]) {
  return {
    access_token: jwt({ sub: 'user-a', aal, user_metadata: { full_name: 'Zoë Ünïcode 名前' } }),
    user: { id: 'user-a', factors },
  } as Parameters<typeof mfaChallengeRequired>[0];
}

const totp = (status: string): Factor => ({ id: `totp-${status}`, factor_type: 'totp', status });
const phone = (status: string): Factor => ({ id: `phone-${status}`, factor_type: 'phone', status });

describe('mfaChallengeRequired', () => {
  test('an aal2 session with a verified TOTP factor is not challenged again', () => {
    expect(mfaChallengeRequired(session('aal2', [totp('verified')]))).toBe(false);
  });

  test('an aal1 session with no factor is not challenged', () => {
    expect(mfaChallengeRequired(session('aal1'))).toBe(false);
    expect(mfaChallengeRequired(session('aal1', []))).toBe(false);
  });

  test('an aal1 session with a verified TOTP factor is challenged', () => {
    expect(mfaChallengeRequired(session('aal1', [totp('verified')]))).toBe(true);
    expect(mfaChallengeRequired(session('aal1', [phone('verified'), totp('verified')]))).toBe(true);
  });

  test('an unverified TOTP factor does not challenge', () => {
    expect(mfaChallengeRequired(session('aal1', [totp('unverified')]))).toBe(false);
  });

  test('a verified phone factor alone does not challenge: this screen cannot send an SMS', () => {
    expect(mfaChallengeRequired(session('aal1', [phone('verified')]))).toBe(false);
  });

  test('no session is not challenged', () => {
    expect(mfaChallengeRequired(null)).toBe(false);
  });

  test('a token that does not decode counts as below aal2', () => {
    const s = { access_token: 'not-a-jwt', user: { id: 'user-a', factors: [totp('verified')] } };
    expect(mfaChallengeRequired(s as Parameters<typeof mfaChallengeRequired>[0])).toBe(true);
  });
});

describe('authRedirect', () => {
  const signedOut = { isAuthenticated: false, mfaRequired: false };
  const owesCode = { isAuthenticated: true, mfaRequired: true };
  const signedIn = { isAuthenticated: true, mfaRequired: false };

  test('the start screen routes itself', () => {
    for (const state of [signedOut, owesCode, signedIn]) {
      expect(authRedirect({ ...state, segments: [] })).toBeNull();
    }
  });

  test('signed out: the auth screens stay, every other route and the code screen go to /auth', () => {
    expect(authRedirect({ ...signedOut, segments: ['auth'] })).toBeNull();
    expect(authRedirect({ ...signedOut, segments: ['auth', 'email'] })).toBeNull();
    expect(authRedirect({ ...signedOut, segments: ['auth', 'mfa'] })).toBe('/auth');
    expect(authRedirect({ ...signedOut, segments: ['projects', '[id]'] })).toBe('/auth');
  });

  test('a session that owes a code reaches only the code screen', () => {
    expect(authRedirect({ ...owesCode, segments: ['auth', 'mfa'] })).toBeNull();
    expect(authRedirect({ ...owesCode, segments: ['auth'] })).toBe('/auth/mfa');
    expect(authRedirect({ ...owesCode, segments: ['auth', 'email'] })).toBe('/auth/mfa');
    expect(authRedirect({ ...owesCode, segments: ['projects', '[id]'] })).toBe('/auth/mfa');
    expect(authRedirect({ ...owesCode, segments: ['(settings)', 'sounds'] })).toBe('/auth/mfa');
  });

  test('a signed-in session leaves every auth screen, the code screen included', () => {
    expect(authRedirect({ ...signedIn, segments: ['auth'] })).toBe('/');
    expect(authRedirect({ ...signedIn, segments: ['auth', 'mfa'] })).toBe('/');
    expect(authRedirect({ ...signedIn, segments: ['projects', '[id]'] })).toBeNull();
  });
});
