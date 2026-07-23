'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen } from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { saveGitHubInstallation } from '@kortix/sdk/projects-client';

type SetupState = 'verify' | 'saving' | 'done' | 'error';

type GitHubProofMessage =
  | { type: 'github-connect-success'; provider_token: string }
  | { type: 'github-connect-error'; message: string };

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
  const [state, setState] = useState<SetupState>('verify');
  const [message, setMessage] = useState(
    'Confirm that your GitHub user owns this account or administers this organization.',
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

    if (setupAction === 'uninstall') {
      setState('done');
      setMessage('GitHub App removed from your account.');
      redirectTimer.current = window.setTimeout(() => router.replace('/projects'), 900);
      return;
    }

    if (!installState || !installationId) {
      setState('error');
      setMessage(
        'GitHub did not return the installation details. Try connecting again from your project or account settings.',
      );
      return;
    }

    setState('verify');
    setMessage(
      'Confirm that your GitHub user owns this account or administers this organization.',
    );
  }, [installState, installationId, isLoading, router, setupAction, user]);

  useEffect(() => {
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, []);

  async function handleVerify() {
    setState('saving');
    setMessage('Verifying your GitHub access and saving the account connection.');
    try {
      const githubUserToken = await requestGitHubUserProof();
      const status = await saveGitHubInstallation({
        state: installState,
        installation_id: installationId,
        github_user_token: githubUserToken,
      });
      setState('done');
      setMessage(
        status.owner_login
          ? `Connected to ${status.owner_login}. Redirecting you back now.`
          : 'GitHub connected. Redirecting you back now.',
      );
      redirectTimer.current = window.setTimeout(
        () => router.replace(consumeGitHubSetupReturn() ?? '/projects?new=1'),
        900,
      );
    } catch (error) {
      setState('verify');
      setMessage((error as Error).message || 'GitHub verification failed. Try again.');
    }
  }

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
        {state === 'verify' ? (
          <Rise delay={0.06}>
            <Button size="lg" className="w-full" onClick={handleVerify}>
              Verify with GitHub
            </Button>
          </Rise>
        ) : state === 'saving' ? (
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
    case 'verify':
      return 'Verify GitHub access';
    case 'saving':
      return 'Linking GitHub';
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

function requestGitHubUserProof(): Promise<string> {
  const popup = window.open(
    '/auth/github-connect',
    'kortix-github-proof',
    'popup,width=520,height=720',
  );
  if (!popup) return Promise.reject(new Error('Allow pop-ups to verify your GitHub access.'));

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (result: { token: string } | { error: Error }) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      window.clearInterval(closePoll);
      window.clearTimeout(timeout);
      if ('error' in result) reject(result.error);
      else resolve(result.token);
    };
    const onMessage = (event: MessageEvent<GitHubProofMessage>) => {
      if (event.origin !== window.location.origin) return;
      if (event.data?.type === 'github-connect-success' && event.data.provider_token) {
        finish({ token: event.data.provider_token });
      } else if (event.data?.type === 'github-connect-error') {
        finish({ error: new Error(event.data.message || 'GitHub verification failed.') });
      }
    };
    window.addEventListener('message', onMessage);
    const closePoll = window.setInterval(() => {
      if (popup.closed) finish({ error: new Error('GitHub verification was cancelled.') });
    }, 500);
    const timeout = window.setTimeout(
      () => finish({ error: new Error('GitHub verification timed out. Try again.') }),
      120_000,
    );
    popup.focus();
  });
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
