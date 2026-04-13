'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams, useRouter } from 'next/navigation';
import { useAuth } from '@/components/AuthProvider';
import { createClient } from '@/lib/supabase/client';
import { getEnv } from '@/lib/env-config';
import { Button } from '@/components/ui/button';
import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Shield, X } from 'lucide-react';

const SCOPE_DESCRIPTIONS: Record<string, string> = {
  profile: 'View your account information',
  'machines:read': 'View your machines provisioned via JustAVPS',
};

export default function OAuthConsentPage() {
  return (
    <Suspense
      fallback={<ConnectingScreen forceConnecting minimal title="Authorizing" />}
    >
      <OAuthConsent />
    </Suspense>
  );
}

function OAuthConsent() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { user, isLoading } = useAuth();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clientName = searchParams.get('client_name') || 'Unknown App';
  const clientId = searchParams.get('client_id') || '';
  const scope = searchParams.get('scope') || '';
  const state = searchParams.get('state') || '';
  const redirectUri = searchParams.get('redirect_uri') || '';
  const codeChallenge = searchParams.get('code_challenge') || '';
  const codeChallengeMethod = searchParams.get('code_challenge_method') || 'S256';

  const scopes = scope.split(' ').filter(Boolean);

  useEffect(() => {
    if (!isLoading && !user) {
      const currentUrl = new URL(window.location.href);
      router.replace(`/auth?returnUrl=${encodeURIComponent(currentUrl.pathname + currentUrl.search)}`);
    }
  }, [user, isLoading, router]);

  const handleConsent = async (approved: boolean) => {
    setSubmitting(true);
    setError(null);

    try {
      const supabase = createClient();
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        setError('Session expired. Please sign in again.');
        setSubmitting(false);
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
          client_id: clientId,
          redirect_uri: redirectUri,
          scope,
          state,
          code_challenge: codeChallenge,
          code_challenge_method: codeChallengeMethod,
          approved,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        setError(err.error_description || err.error || 'Authorization failed');
        setSubmitting(false);
        return;
      }

      const data = await res.json();
      if (data.redirect_uri) {
        window.location.href = data.redirect_uri;
      }
    } catch (err) {
      setError('Network error. Please try again.');
      setSubmitting(false);
    }
  };

  if (isLoading || !user) {
    return <ConnectingScreen forceConnecting minimal title="Authorizing" />;
  }

  if (!clientId || !redirectUri || !codeChallenge) {
    return (
      <div className="fixed inset-0 bg-background flex items-center justify-center">
        <div className="max-w-sm text-center space-y-4">
          <p className="text-destructive font-medium">Invalid authorization request</p>
          <p className="text-sm text-muted-foreground">Missing required parameters.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="text-center space-y-2">
          <div className="flex items-center justify-center mb-4">
            <div className="flex h-14 w-14 items-center justify-center rounded-full bg-foreground/[0.06] border border-foreground/[0.08]">
              <Shield className="h-6 w-6 text-foreground/50" />
            </div>
          </div>
          <h1 className="text-xl font-semibold tracking-tight">
            Authorize {clientName}
          </h1>
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{clientName}</span> wants to access your Kortix account
          </p>
        </div>

        <div className="rounded-xl border border-border bg-muted/30 p-4 space-y-3">
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            This will allow {clientName} to:
          </p>
          <ul className="space-y-2">
            {scopes.map((s) => (
              <li key={s} className="flex items-start gap-2 text-sm">
                <div className="size-1.5 rounded-full bg-foreground/40 mt-1.5 shrink-0" />
                <span>{SCOPE_DESCRIPTIONS[s] || s}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="rounded-xl border border-border bg-muted/20 px-4 py-3">
          <p className="text-xs text-muted-foreground">Signed in as</p>
          <p className="text-sm font-medium truncate">{user.email}</p>
        </div>

        {error && (
          <div className="rounded-xl border border-destructive/20 bg-destructive/5 p-3 text-sm text-destructive">
            {error}
          </div>
        )}

        <div className="flex gap-3">
          <Button
            variant="outline"
            className="flex-1"
            onClick={() => handleConsent(false)}
            disabled={submitting}
          >
            <X className="size-4" />
            Deny
          </Button>
          <Button
            className="flex-1"
            onClick={() => handleConsent(true)}
            disabled={submitting}
          >
            {submitting ? 'Authorizing...' : 'Allow'}
          </Button>
        </div>

        <p className="text-xs text-center text-muted-foreground">
          You can revoke access at any time from your account settings.
        </p>
      </div>
    </div>
  );
}
