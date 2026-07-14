'use client';

import { Check } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

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

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  profile: 'View your account information',
  'machines:read': 'View your project session sandboxes',
};

export default function OAuthConsentPage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <OAuthConsent />
    </Suspense>
  );
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
  } | null>(null);

  const requestId = searchParams.get('request_id') || '';
  const clientName = consentRequest?.clientName || 'Unknown App';
  const scopes = consentRequest?.scopes || [];

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

    async function loadConsentRequest() {
      setError(null);
      setConsentRequest(null);
      try {
        const supabase = createClient();
        const {
          data: { session },
        } = await supabase.auth.getSession();
        if (!session?.access_token) {
          setError('Session expired. Please sign in again.');
          return;
        }

        const backendUrl = getEnv().BACKEND_URL || '';
        const res = await fetch(
          `${backendUrl}/oauth/authorize/consent/${encodeURIComponent(requestId)}`,
          {
            headers: {
              Authorization: `Bearer ${session.access_token}`,
            },
          },
        );
        const data = await res.json().catch(() => null);
        if (!res.ok) {
          setError(data?.error_description || data?.error || 'Authorization request expired.');
          return;
        }
        if (!cancelled) {
          setConsentRequest({
            clientName: data.client_name || 'Unknown App',
            scopes: Array.isArray(data.scopes)
              ? data.scopes.filter((scope: unknown): scope is string => typeof scope === 'string')
              : String(data.scope || '')
                  .split(' ')
                  .filter(Boolean),
          });
        }
      } catch {
        if (!cancelled) setError('Network error. Please try again.');
      }
    }

    loadConsentRequest();

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
      const res = await fetch(`${backendUrl}/oauth/authorize/consent`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({
          request_id: requestId,
          approved,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        setError(err.error_description || err.error || 'Authorization failed');
        setDecision(null);
        return;
      }

      const data = await res.json();
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
