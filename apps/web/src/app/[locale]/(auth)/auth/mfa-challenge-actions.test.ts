import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createTranslator } from 'next-intl';
import messages from '../../../../../translations/de.json';

/**
 * A password sign-in with an enrolled, verified TOTP factor owes the
 * challenge before the app — the same rule the auth callback route enforces
 * for magic links. The password proves the first factor, not the second, so
 * the action's `redirectTo` must be the challenge (with the resolved
 * destination riding along) and the middleware's pending cookie must arm.
 * Drives the REAL server actions.
 */

type CookieJar = Map<string, string>;

const cookieJar: CookieJar = new Map();

mock.module('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (cookieJar.has(name) ? { value: cookieJar.get(name) } : undefined),
    set: (name: string, value: string) => cookieJar.set(name, value),
    delete: (name: string) => cookieJar.delete(name),
  }),
  headers: async () => new Headers(),
}));

let userFactors: Array<Record<string, string>> = [];

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      signInWithOtp: async () => ({ error: null }),
      signInWithPassword: async () => ({
        data: {
          user: {
            id: '33333333-3333-3333-3333-333333333333',
            created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            user_metadata: {},
            factors: userFactors,
          },
          session: { access_token: 'tok', refresh_token: 'rtok' },
        },
        error: null,
      }),
      signUp: async () => ({ error: null }),
    },
  }),
}));

mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({
    APP_URL: 'http://localhost:13000',
    BACKEND_URL: 'http://127.0.0.1:1/v1',
  }),
}));

mock.module('@/i18n/get-translations', () => ({
  getTranslations: async () =>
    createTranslator({ locale: 'de', messages, namespace: 'hardcodedUi.i18nComplete' }),
}));

const { signInWithPassword, signUpWithPassword } = await import('./actions');

/** The success shape of both actions. The union return type makes TS see
 *  `redirectTo` as possibly absent; a success result always carries it. */
function redirectToOf(result: unknown): string {
  if (
    result &&
    typeof result === 'object' &&
    'redirectTo' in result &&
    typeof result.redirectTo === 'string'
  ) {
    return result.redirectTo;
  }
  throw new Error('the action returned no redirectTo');
}

const MFA_PENDING_COOKIE = 'kortix-mfa-pending';
const RETURN_URL = '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c';

function form() {
  const data = new FormData();
  data.set('email', 'synthetic@example.test');
  data.set('password', 'synthetic-password');
  data.set('confirmPassword', 'synthetic-password');
  data.set('returnUrl', RETURN_URL);
  data.set('origin', 'http://localhost:13000');
  return data;
}

beforeEach(() => {
  cookieJar.clear();
  userFactors = [];
});

describe('password sign-in enforces the TOTP challenge', () => {
  test('a verified TOTP factor redirects to the challenge and arms the middleware', async () => {
    userFactors = [{ factor_type: 'totp', status: 'verified' }];

    const result = await signInWithPassword(null, form());
    const redirectTo = redirectToOf(result);

    expect(result.success).toBe(true);
    expect(redirectTo.startsWith('/auth/mfa?returnUrl=')).toBe(true);
    expect(decodeURIComponent(redirectTo)).toContain(RETURN_URL);
    expect(cookieJar.get(MFA_PENDING_COOKIE)).toBe('1');
  });

  test('a session without factors redirects to the destination, no cookie', async () => {
    const result = await signInWithPassword(null, form());
    const redirectTo = redirectToOf(result);

    expect(redirectTo.startsWith(RETURN_URL)).toBe(true);
    expect(cookieJar.has(MFA_PENDING_COOKIE)).toBe(false);
  });

  test('a phone factor does not gate the sign-in (TOTP scope)', async () => {
    userFactors = [{ factor_type: 'phone', status: 'verified' }];

    const result = await signInWithPassword(null, form());
    const redirectTo = redirectToOf(result);

    expect(redirectTo.startsWith(RETURN_URL)).toBe(true);
    expect(cookieJar.has(MFA_PENDING_COOKIE)).toBe(false);
  });

  test('signup that resolves to an existing account with a verified factor is challenged too', async () => {
    userFactors = [{ factor_type: 'totp', status: 'verified' }];

    const result = await signUpWithPassword(null, form());
    const redirectTo = redirectToOf(result);

    expect(result.success).toBe(true);
    expect(redirectTo.startsWith('/auth/mfa?returnUrl=')).toBe(true);
    expect(cookieJar.get(MFA_PENDING_COOKIE)).toBe('1');
  });
});
