import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Sign-out clears the pending TOTP-challenge flag.
 *
 * The flag is browser-scoped, not session-scoped: an account that signed in,
 * was held at the challenge, and signed out must not leave the flag armed for
 * the NEXT account on this browser. (The challenge page also self-heals a
 * stale flag, but only after one wasted bounce — the sign-out is the clean
 * place to clear it.)
 */

const jar = new Map<string, string>();

mock.module('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
    set: (name: string, value: string) => jar.set(name, value),
    delete: (name: string) => jar.delete(name),
  }),
  headers: async () => new Headers(),
}));

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));

const realSdk = await import('@kortix/sdk');
mock.module('@kortix/sdk', () => ({ ...realSdk, recordPlatformLogout: async () => {} }));

const { finalizeServerSignOut } = await import('./sign-out-actions');
const { MFA_PENDING_COOKIE } = await import('./mfa-challenge');

beforeEach(() => jar.clear());

describe('sign-out and the pending TOTP flag', () => {
  test('a pending flag does not survive the sign-out that ended its session', async () => {
    jar.set(MFA_PENDING_COOKIE, '1');

    await finalizeServerSignOut();

    expect(jar.has(MFA_PENDING_COOKIE)).toBe(false);
  });

  test('clearing is a no-op when no flag is set', async () => {
    await expect(finalizeServerSignOut()).resolves.toBeUndefined();
    expect(jar.has(MFA_PENDING_COOKIE)).toBe(false);
  });
});
