'use client';

import { CheckIcon as Check } from '@phosphor-icons/react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import {
  AuthPendingScreen,
  AuthStatusScreen,
  DetailPanel,
  DetailRow,
} from '@/features/auth/auth-consent';
import { ErrorStrip, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { getEnv } from '@/lib/env-config';
import { createClient } from '@/lib/supabase/client';
import {
  getOAuthConsentRequest,
  submitOAuthConsent,
} from '@kortix/sdk';

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  profile: 'View your account information',
  email: 'View your email address',
  kortix: 'Act on your behalf in Kortix — projects, sessions, files and everything your role allows',
  'machines:read': 'View your project session sandboxes',
};

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <OAuthConsent />
    </Suspense>
  );
}

type ConsentRequestView = { clientName: string; scopes: string[]; remembered: boolean };
type ConsentLoadResult =
  | { kind: 'consent'; request: ConsentRequestView }
  | { kind: 'redirecting' }
  | { kind: 'error'; message: string; request?: ConsentRequestView };

/** Read the pending request; when the consent is remembered, approve it and redirect. */
async function loadAndMaybeApprove(requestId: string): Promise<ConsentLoadResult> {
  const supabase = createClient();
  const {
    data: { session },
  } = await supabase.auth.getSession();
  if (!session?.access_token) return { kind: 'error', message: 'Session expired. Please sign in again.' };
  const backendUrl = getEnv().BACKEND_URL || '';
  let data;
  try {
    data = await getOAuthConsentRequest(requestId, { backendUrl, accessToken: session.access_token });
  } catch {
    return { kind: 'error', message: 'Network error. Please try again.' };
  }
  const request: ConsentRequestView = {
    clientName: data.client_name || 'Unknown App',
    scopes: Array.isArray(data.scopes)
      ? data.scopes.filter((scope: unknown): scope is string => typeof scope === 'string')
      : String(data.scope || '')
          .split(' ')
          .filter(Boolean),
    remembered: data.remembered === true,
  };
  if (!request.remembered) return { kind: 'consent', request };

  // Remembered consent: approve straight away and send the user back. A
  // failure falls through to the normal Allow/Deny screen with the error strip.
  try {
    const approved = await submitOAuthConsent(
      { requestId, approved: true },
      { backendUrl, accessToken: session.access_token },
    );
    if (approved.redirect_uri) {
      window.location.href = approved.redirect_uri;
      return { kind: 'redirecting' };
    }
    return { kind: 'error', message: 'The authorization did not return a redirect.', request: { ...request, remembered: false } };
  } catch (err) {
    return {
      kind: 'error',
      message: err instanceof Error && err.message ? err.message : 'Network error. Please try again.',
      request: { ...request, remembered: false },
    };
  }
}

function OAuthConsent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const [decision, setDecision] = useState<'allow' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [consentRequest, setConsentRequest] = useState<{
    clientName: string;
    scopes: string[];
    /**
     * The user already granted this client these scopes (`oauth_consents`).
     * The Allow screen is skipped: the load effect approves and redirects on
     * its own, and this page shows the pending screen meanwhile.
     */
    remembered: boolean;
  } | null>(null);

  const requestId = searchParams.get('request_id') || '';
  const clientName = consentRequest?.clientName || 'Unknown App';
  const scopes = consentRequest?.scopes || [];

  /**
   * ONE load (and, when remembered, one approval) per request id, shared by
   * every run of the effect below. The effect re-runs whenever the auth
   * provider hands out a fresh `user` object (it does, right after its own
   * /user refresh). Two earlier shapes both failed live on 2026-08-26:
   *
   *  - no guard: run #2 re-read a request run #1 had already consumed (400),
   *    and run #1's cleanup had told it to drop the redirect;
   *  - a bail-out guard: run #1 was cancelled by the re-run and dropped its
   *    result, run #2 bailed on the guard — the page spun forever.
   *
   * So the WORK is cached per request id, and whichever run is still current
   * when it settles applies the result. A remembered consent redirects from
   * inside the shared work, unconditionally — the request is consumed by then.
   */
  const loadRef = useRef<{ requestId: string; promise: Promise<ConsentLoadResult> } | null>(null);

  useEffect(() => {
    if (!isLoading && !user) {
      const currentUrl = new URL(window.location.href);
      router.replace(
        `/auth?returnUrl=${encodeURIComponent(currentUrl.pathname + currentUrl.search)}`,
      );
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (isLoading || !user || !requestId) return;
    let cancelled = false;
    if (loadRef.current?.requestId !== requestId) {
      loadRef.current = { requestId, promise: loadAndMaybeApprove(requestId) };
    }
    loadRef.current.promise.then((result) => {
      if (cancelled) return;
      if (result.kind === 'redirecting') return; // the browser is leaving
      if (result.kind === 'error') {
        setError(result.message);
        setConsentRequest(result.request ?? null);
        return;
      }
      setError(null);
      setConsentRequest(result.request);
    });
    return () => {
      cancelled = true;
    };
  }, [isLoading, requestId, user]);

  const handleConsent = async (approved: boolean) => {
    setDecision(approved ? 'allow' : 'deny');
    setError(null);

    try {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Session expired. Please sign in again.');
        setDecision(null);
        return;
      }

      const backendUrl = getEnv().BACKEND_URL || '';
      const data = await submitOAuthConsent({
        requestId,
        approved,
      }, {
        backendUrl,
        accessToken: session.access_token,
      });

      if (data.redirect_uri) {
        window.location.href = data.redirect_uri;
      }
    } catch (err) {
      setError('Network error. Please try again.');
      setDecision(null);
    }
  };

  if (isLoading || !user) {
    return <AuthPendingScreen />;
  }

  if (!requestId) {
    return (
      <AuthStatusScreen
        title="Invalid authorization request"
        description="This link is missing required parameters. Start the authorization again from the app that sent you here."
      />
    );
  }

  if (!consentRequest) {
    if (error) {
      return <AuthStatusScreen title="Authorization request unavailable" description={error} />;
    }
    return <AuthPendingScreen />;
  }

  // Remembered consent is being submitted — nothing to decide, so no Allow
  // screen. `remembered` flips back to false if that submit fails.
  if (consentRequest.remembered) {
    return <AuthPendingScreen />;
  }

  const submitting = decision !== null;

  return (
    <AuthFrame>
      <Rise>
        <StepHeader
          title={`Authorize ${clientName}`}
          description={
            <>
              <span className="text-foreground font-medium">{clientName}</span> wants to access your
              Kortix account.
            </>
          }
        />
      </Rise>

      <Rise delay={0.06}>
        {error ? <ErrorStrip message={error} /> : null}

        <div className="space-y-5">
          {scopes.length > 0 ? (
            <div className="space-y-3">
              <p className="text-muted-foreground text-sm font-medium">It will be able to</p>
              <ul className="border-border divide-border/60 divide-y rounded-md border">
                {scopes.map((s) => (
                  <li key={s} className="flex items-center gap-2.5 px-3.5 py-2.5 text-sm">
                    <Check className="text-muted-foreground size-4 shrink-0" />
                    <span className="min-w-0 truncate">{SCOPE_DESCRIPTIONS[s] || s}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <DetailPanel>
            <DetailRow label="Signed in as" value={user.email ?? 'You'} />
          </DetailPanel>

          <div className="space-y-3">
            <Button
              size="lg"
              className="w-full"
              onClick={() => handleConsent(true)}
              disabled={submitting}
            >
              {decision === 'allow' ? <Loading className="size-4 shrink-0" /> : null}
              Allow
            </Button>
            <Button
              variant="secondary"
              size="lg"
              className="w-full"
              onClick={() => handleConsent(false)}
              disabled={submitting}
            >
              {decision === 'deny' ? (
                <Loading className="text-foreground! size-4 shrink-0" />
              ) : null}
              Deny
            </Button>
          </div>
        </div>

        <p className="text-muted-foreground mt-8 text-sm">
          You can revoke access at any time in your account settings.
        </p>
      </Rise>
    </AuthFrame>
  );
}
