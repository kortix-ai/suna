import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { pickVerifiedTotpFactor } from '@/lib/auth/mfa-challenge';

/**
 * The challenge page the sign-in completions and the middleware land on.
 *
 * Static render covers the first paint: the pending, loading state — header,
 * sign-out exit, and no code input yet (the factor list arrives after mount,
 * so an input here would be a lie). The factor-selection predicate is pure
 * and asserted directly; the sign-in redirects and the middleware hold are
 * behavior-tested at their own surfaces.
 */

mock.module('@/i18n/use-translations', () => ({
  useTranslations: (namespace: string) => {
    const t = (key: string) => `${namespace}.${key}`;
    return Object.assign(t, { raw: t });
  },
}));
mock.module('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams('returnUrl=%2Fprojects'),
  useRouter: () => ({ push: () => {}, replace: () => {}, prefetch: () => {} }),
}));
mock.module('@/lib/onboarding/use-app-home', () => ({ useAppHome: () => '/projects' }));
mock.module('@/lib/auth/perform-sign-out', () => ({ performSignOut: async () => {} }));

const { default: MfaChallengePage } = await import('./page');

describe('mfa challenge page', () => {
  test('first paint is the loading state with a sign-out exit', () => {
    const markup = renderToStaticMarkup(<MfaChallengePage />);

    expect(markup).toContain('auth.mfaChallenge.title');
    expect(markup).toContain('auth.mfaChallenge.loading');
    expect(markup).toContain('auth.mfaChallenge.signOut');
    // No code input before the factor list has arrived.
    expect(markup).not.toContain('one-time-code');
  });

  test('picks the verified TOTP factor to challenge', () => {
    expect(
      pickVerifiedTotpFactor([
        { id: 'p', factor_type: 'phone', status: 'verified' },
        { id: 't', factor_type: 'totp', status: 'verified' },
      ]),
    ).toEqual({ id: 't', factor_type: 'totp', status: 'verified' });
  });

  test('an unverified enrollment is not challengeable', () => {
    expect(pickVerifiedTotpFactor([{ id: 't', factor_type: 'totp', status: 'unverified' }])).toBe(
      null,
    );
  });

  test('an empty factor list is not challengeable', () => {
    expect(pickVerifiedTotpFactor([])).toBe(null);
  });
});
