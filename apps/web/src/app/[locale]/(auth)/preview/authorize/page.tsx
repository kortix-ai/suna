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
  PreviewAuthorizeView,
  type PreviewAuthorizeState,
} from '@/features/auth/preview-authorize-view';
import { useAuth } from '@/features/providers/auth-provider';
import { getEnv } from '@/lib/env-config';
import { createClient } from '@/lib/supabase/client';

/** The preview hostname shape, as `GET /v1/p/config` describes it. */
async function fetchPreviewTemplate(backendUrl: string): Promise<string | null> {
  try {
    const res = await fetch(`${backendUrl.replace(/\/+$/, '')}/p/config`, {
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { preview_url_template?: string | null };
    return typeof body?.preview_url_template === 'string' ? body.preview_url_template : null;
  } catch {
    return null;
  }
}

/**
 * True only for a URL on a hostname this deployment serves previews on.
 *
 * The template gives the exact origin shape; we compare the host SUFFIX and the
 * label form rather than string-matching the whole URL, because the port and
 * sandbox vary. Anything else — another domain, a lookalike, a path on our own
 * app — is refused.
 */
export function isServablePreviewUrl(candidate: string, template: string | null): boolean {
  if (!template) return false;
  let url: URL;
  let shape: URL;
  try {
    url = new URL(candidate);
    shape = new URL(template.replace('{port}', '1').replace('{sandbox}', 'x'));
  } catch {
    return false;
  }
  if (url.protocol !== shape.protocol) return false;

  // `dev-p{port}-{sandbox}.p.kortix.com` -> suffix `.p.kortix.com`, prefix `dev-`
  const shapeHost = shape.hostname;
  const firstDot = shapeHost.indexOf('.');
  if (firstDot === -1) return false;
  const domain = shapeHost.slice(firstDot); // ".p.kortix.com"
  const envPrefix = shapeHost.slice(0, shapeHost.indexOf('-p1-') + 1); // "dev-"
  if (!envPrefix || !domain) return false;
  if (!url.hostname.endsWith(domain)) return false;

  const label = url.hostname.slice(0, -domain.length);
  if (label.includes('.')) return false;
  return new RegExp(`^${envPrefix}p\\d{1,5}-[a-z0-9-]+$`).test(label);
}

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
      const template = await fetchPreviewTemplate(backendUrl);
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
