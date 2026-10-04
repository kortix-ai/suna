'use client';

/**
 * The hand-off that turns "you are signed in to Kortix" into "this preview
 * origin will serve you".
 *
 * A preview lives on its own hostname (`{env}-p{port}-{sandbox}.p.kortix.com`),
 * which is exactly what makes an arbitrary app work there — and also means none
 * of the web app's credentials reach it. Opening such a URL cold gets a page
 * asking to sign in; that page sends the person here with `?to=<preview url>`.
 *
 * Here we are on the Kortix origin, so we have the session. We take the access
 * token and bounce back with a ONE-SHOT `?token=`, which the proxy exchanges
 * for a host-scoped cookie and strips from the address bar.
 *
 * `to` is attacker-controllable, so it is validated against the preview
 * hostname shape this deployment actually serves before we ever redirect to it.
 * Without that check this page would be an open redirect that also hands over a
 * bearer token.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { AuthPendingScreen } from '@/features/auth/auth-consent';
import {
  type PreviewAuthorizeState,
  PreviewAuthorizeView,
} from '@/features/auth/preview-authorize-view';
import { useAuth } from '@/features/providers/auth-provider';
import { getEnv } from '@/lib/env-config';
import { createClient } from '@/lib/supabase/client';
import { isServablePreviewUrl, loadPreviewUrlTemplate } from '@kortix/sdk';

export default function PreviewAuthorizePage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <PreviewAuthorize />
    </Suspense>
  );
}

function PreviewAuthorize() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const [failure, setFailure] = useState<Exclude<PreviewAuthorizeState, 'opening'> | null>(null);
  const to = searchParams.get('to') || '';
  // Come back here once signed in, carrying `to` untouched.
  const signInUrl = `/auth?returnUrl=${encodeURIComponent(
    `/preview/authorize?to=${encodeURIComponent(to)}`,
  )}`;

  useEffect(() => {
    if (isLoading) return;

    if (!user) {
      // `replace`, not `push`: this page is a hand-off, and leaving it in
      // history means Back lands on a page that immediately redirects again.
      router.replace(signInUrl);
      return;
    }

    let cancelled = false;
    (async () => {
      const backendUrl = getEnv().BACKEND_URL || '';
      const template = await loadPreviewUrlTemplate(backendUrl);
      if (cancelled) return;

      if (!isServablePreviewUrl(to, template)) {
        setFailure('not-served');
        return;
      }

      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (cancelled) return;
      if (!session?.access_token) {
        setFailure('expired');
        return;
      }

      const target = new URL(to);
      target.searchParams.set('token', session.access_token);
      window.location.replace(target.toString());
    })();

    return () => {
      cancelled = true;
    };
  }, [user, isLoading, to, router, signInUrl]);

  // Until the session is known there is nothing true to say about the preview.
  if (isLoading || !user) return <AuthPendingScreen />;

  return (
    <PreviewAuthorizeView
      state={failure ?? 'opening'}
      to={to}
      email={user.email ?? null}
      onSignInAgain={() => router.replace(signInUrl)}
    />
  );
}
