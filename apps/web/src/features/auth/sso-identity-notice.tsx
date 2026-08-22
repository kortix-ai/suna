'use client';

import { usePathname, useSearchParams } from 'next/navigation';
import { useEffect, useRef } from 'react';

import { warningToast } from '@/components/ui/toast';
import { useAuth } from '@/features/providers/auth-provider';
import { SSO_IDENTITY_MISMATCH, SSO_IDENTITY_PARAM } from '@/lib/auth/sso-identity';

/**
 * Says who the user actually signed in as, when that is not who they asked for.
 *
 * `/auth/callback` sets `?sso_identity=mismatch` when the address returned by
 * the IdP is not the one typed before the hop. It deliberately does not put the
 * address in the URL, so the address is read here from the session — which is
 * also the authoritative answer to "who am I", rather than a value that
 * travelled through a redirect.
 *
 * The toast does not expire. Everything else on this surface is transient
 * feedback the user can afford to miss; being signed in as somebody else is
 * not, and a notice that scrolls away after three seconds is the same as no
 * notice for a user who looked away during the IdP hop.
 */
export function SsoIdentityNotice() {
  const searchParams = useSearchParams();
  const pathname = usePathname();
  const { user, isLoading } = useAuth();
  // React may run this effect twice for one arrival (StrictMode, a re-render
  // while the session loads). The toast id dedupes sonner-side; this stops the
  // URL cleanup from racing with a second pass.
  const shown = useRef(false);

  useEffect(() => {
    if (shown.current) return;
    if (searchParams?.get(SSO_IDENTITY_PARAM) !== SSO_IDENTITY_MISMATCH) return;
    // The session arrives a beat after the redirect. Waiting for it is what
    // lets the notice name the account instead of saying "someone else".
    if (isLoading) return;

    const actual = user?.email;
    shown.current = true;

    warningToast(
      actual ? `You are signed in as ${actual}` : 'You are signed in as a different account',
      {
        description:
          'Your identity provider returned a different account than the address you entered — ' +
          'usually because a session for that account was already open in this browser. ' +
          'Sign out and try again if this is not you.',
        duration: Number.POSITIVE_INFINITY,
        id: 'sso-identity-mismatch',
      },
    );

    const params = new URLSearchParams(searchParams?.toString() || '');
    params.delete(SSO_IDENTITY_PARAM);
    const query = params.toString();
    window.history.replaceState({}, '', query ? `${pathname}?${query}` : pathname);
  }, [searchParams, pathname, user, isLoading]);

  return null;
}
