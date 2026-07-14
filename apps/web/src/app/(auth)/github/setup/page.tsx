'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen } from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { saveGitHubInstallation } from '@kortix/sdk/projects-client';

type SetupState = 'saving' | 'done' | 'error';

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
  const [state, setState] = useState<SetupState>('saving');
  const [message, setMessage] = useState(
    'Finishing your account connection and saving the installation.',
  );

  const installState = searchParams.get('state') || '';
  const installationId = searchParams.get('installation_id') || '';
  const setupAction = searchParams.get('setup_action') || '';

  useEffect(() => {
    if (!isLoading && !user) {
      const currentUrl = new URL(window.location.href);
      router.replace(
        `/auth?returnUrl=${encodeURIComponent(currentUrl.pathname + currentUrl.search)}`,
      );
    }
  }, [user, isLoading, router]);

  useEffect(() => {
    if (isLoading || !user) return;

    let redirectTimer: number | undefined;

    if (setupAction === 'uninstall') {
      setState('done');
      setMessage('GitHub App removed from your account.');
      redirectTimer = window.setTimeout(() => router.replace('/projects'), 900);
      return () => {
        if (redirectTimer) clearTimeout(redirectTimer);
      };
    }

    if (!installState || !installationId) {
      setState('error');
      setMessage(
        'GitHub did not return the installation details. Try connecting again from your project or account settings.',
      );
      return;
    }

    let cancelled = false;
    saveGitHubInstallation({
      state: installState,
      installation_id: installationId,
    })
      .then((status) => {
        if (cancelled) return;
        setState('done');
        setMessage(
          status.owner_login
            ? `Connected to ${status.owner_login}. Redirecting you back now.`
            : 'GitHub connected. Redirecting you back now.',
        );
        redirectTimer = window.setTimeout(
          () => router.replace(consumeGitHubSetupReturn() ?? '/projects?new=1'),
          900,
        );
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setState('error');
        setMessage(error.message || 'Failed to save the GitHub installation.');
      });

    return () => {
      cancelled = true;
      if (redirectTimer) clearTimeout(redirectTimer);
    };
  }, [installState, installationId, isLoading, router, setupAction, user]);

  if (isLoading || !user) {
    return <AuthPendingScreen />;
  }

  const heading = getHeading(state, setupAction);

  // The live region wraps only the status content — not the frame — so
  // screen readers don't re-announce the mark and legal footer on updates.
  return (
    <AuthFrame>
      <div role="status" aria-live="polite" aria-label={heading}>
        <Rise>
          <StepHeader title={heading} description={message} />
        </Rise>
        {state === 'saving' ? (
          <Rise delay={0.06}>
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loading className="size-4 shrink-0" />
              <span>This usually takes a few seconds</span>
            </div>
          </Rise>
        ) : state === 'error' ? (
          <Rise delay={0.06}>
            <Button size="lg" className="w-full" onClick={() => router.replace('/projects')}>
              Back to projects
            </Button>
          </Rise>
        ) : null}
      </div>
    </AuthFrame>
  );
}

function getHeading(state: SetupState, setupAction: string): string {
  switch (state) {
    case 'saving':
      return 'Connecting to GitHub';
    case 'done':
      return setupAction === 'uninstall' ? 'GitHub disconnected' : 'GitHub connected';
    case 'error':
      return 'Could not connect GitHub';
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
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
