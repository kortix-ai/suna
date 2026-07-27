'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen } from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { useGitHubNangoConnect } from '@/hooks/use-github-nango-connect';
import type { GitHubInstallationStatus } from '@kortix/sdk';
import { Github } from 'lucide-react';

export default function GitHubSetupPage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <GitHubSetup />
    </Suspense>
  );
}

function GitHubSetup() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const redirectTimer = useRef<number | undefined>(undefined);
  const [connectedOwner, setConnectedOwner] = useState<string | null | undefined>(undefined);
  const [wasCancelled, setWasCancelled] = useState(false);

  const accountId = searchParams.get('account_id') || '';
  const reconnectInstallationId = searchParams.get('reconnect_installation_id') || '';

  const finishConnection = useCallback(
    (installation: GitHubInstallationStatus) => {
      setConnectedOwner(installation.owner_login);
      redirectTimer.current = window.setTimeout(
        () => router.replace(consumeGitHubSetupReturn() ?? '/projects?new=1'),
        900,
      );
    },
    [router],
  );

  const githubConnect = useGitHubNangoConnect({
    accountId: accountId || null,
    onConnected: finishConnection,
  });

  useEffect(() => {
    if (!isLoading && !user) {
      const currentUrl = new URL(window.location.href);
      router.replace(
        `/auth?returnUrl=${encodeURIComponent(currentUrl.pathname + currentUrl.search)}`,
      );
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    return () => {
      if (redirectTimer.current) window.clearTimeout(redirectTimer.current);
    };
  }, []);

  async function handleConnect() {
    setWasCancelled(false);
    const outcome = await githubConnect.start(reconnectInstallationId || undefined);
    if (outcome?.status === 'cancelled') setWasCancelled(true);
  }

  if (isLoading || !user) return <AuthPendingScreen />;

  const connected = connectedOwner !== undefined;
  const heading = connected
    ? 'GitHub connected'
    : reconnectInstallationId
      ? 'Reconnect GitHub'
      : 'Connect GitHub';
  const description = connected
    ? connectedOwner
      ? `Connected to ${connectedOwner}. Redirecting you back now.`
      : 'Your GitHub connection is ready. Redirecting you back now.'
    : reconnectInstallationId
      ? 'Authorize GitHub again to restore this connection. Existing project links stay unchanged.'
      : 'Authorize a personal GitHub account or an organization for this Kortix account.';

  return (
    <AuthFrame>
      <div role="status" aria-live="polite" aria-label={heading} className="space-y-6">
        <Rise>
          <StepHeader title={heading} description={description} />
        </Rise>

        {!accountId ? (
          <Rise delay={0.06}>
            <InfoBanner tone="warning" icon={Github} title="Kortix account is missing">
              Open GitHub setup from account settings or project creation.
            </InfoBanner>
          </Rise>
        ) : null}

        {githubConnect.error ? (
          <Rise delay={0.06}>
            <InfoBanner
              tone="warning"
              icon={Github}
              title="Could not connect GitHub"
              action={
                <Button type="button" size="sm" variant="outline" onClick={handleConnect}>
                  Try again
                </Button>
              }
            >
              {githubConnect.error.message}
            </InfoBanner>
          </Rise>
        ) : null}

        {wasCancelled && !githubConnect.error ? (
          <Rise delay={0.06}>
            <InfoBanner tone="neutral" icon={Github} title="GitHub was not connected">
              No account changes were made. Select Connect GitHub when you are ready.
            </InfoBanner>
          </Rise>
        ) : null}

        {!connected && accountId ? (
          <Rise delay={0.06}>
            <div className="space-y-3">
              <Button
                type="button"
                size="lg"
                className="w-full"
                disabled={githubConnect.isPending}
                onClick={handleConnect}
              >
                {githubConnect.isPending ? (
                  <Loading className="size-4 shrink-0" />
                ) : (
                  <Github className="size-4 shrink-0" />
                )}
                {connectButtonLabel(githubConnect.phase, Boolean(reconnectInstallationId))}
              </Button>
              <p className="text-muted-foreground text-xs leading-relaxed">
                GitHub may require a GitHub organization owner to approve access. Allow pop-ups for
                the GitHub authorization window.
              </p>
            </div>
          </Rise>
        ) : null}

        {!connected ? (
          <Rise delay={0.1}>
            <Button
              type="button"
              size="lg"
              variant="outline"
              className="w-full"
              disabled={githubConnect.isPending}
              onClick={() => router.replace(consumeGitHubSetupReturn() ?? '/projects')}
            >
              Back
            </Button>
          </Rise>
        ) : null}
      </div>
    </AuthFrame>
  );
}

function connectButtonLabel(
  phase: ReturnType<typeof useGitHubNangoConnect>['phase'],
  reconnect: boolean,
): string {
  switch (phase) {
    case 'requesting':
      return 'Starting authorization';
    case 'authorizing':
      return 'Waiting for GitHub';
    case 'reconciling':
      return 'Syncing connection';
    case 'idle':
      return reconnect ? 'Reconnect GitHub' : 'Connect GitHub';
  }
}

function consumeGitHubSetupReturn(): string | null {
  try {
    const value = window.localStorage.getItem('kortix:github_setup_return');
    window.localStorage.removeItem('kortix:github_setup_return');
    if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
    return value;
  } catch {
    return null;
  }
}
