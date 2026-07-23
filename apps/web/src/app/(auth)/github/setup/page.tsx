'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen } from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import {
  linkGitHubInstallation,
  listLinkableGitHubInstallations,
  saveGitHubInstallation,
  type LinkableGitHubInstallation,
} from '@kortix/sdk/projects-client';
import { Github } from 'lucide-react';

type SetupState = 'verify' | 'loading' | 'select' | 'empty' | 'saving' | 'done' | 'error';

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
  const [githubUserToken, setGitHubUserToken] = useState('');
  const [installations, setInstallations] = useState<LinkableGitHubInstallation[]>([]);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  const installState = searchParams.get('state') || '';
  const installationId = searchParams.get('installation_id') || '';
  const setupAction = searchParams.get('setup_action') || '';
  const accountId = searchParams.get('account_id') || '';
  const selectingExistingInstallation = Boolean(accountId && !installState && !installationId);

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

    if (selectingExistingInstallation) {
      setState('verify');
      setMessage(
        'Continue with GitHub to select an existing personal or organization App installation.',
      );
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
    setMessage('Confirm that your GitHub user owns this account or administers this organization.');
  }, [
    installState,
    installationId,
    isLoading,
    router,
    selectingExistingInstallation,
    setupAction,
    user,
  ]);

  useEffect(() => {
    return () => {
      if (redirectTimer.current) clearTimeout(redirectTimer.current);
    };
  }, []);

  async function handleVerify() {
    setState(selectingExistingInstallation ? 'loading' : 'saving');
    setMessage(
      selectingExistingInstallation
        ? 'Loading GitHub App installations that you can administer.'
        : 'Verifying your GitHub access and saving the account connection.',
    );
    try {
      const userToken = await requestGitHubUserProof();
      if (selectingExistingInstallation) {
        const result = await listLinkableGitHubInstallations({
          account_id: accountId,
          github_user_token: userToken,
        });
        setGitHubUserToken(userToken);
        setInstallations(result.installations);
        setInstallUrl(result.install_url);
        const available = result.installations.filter((installation) => !installation.linked);
        if (available.length === 0) {
          setState('empty');
          setMessage(
            result.installations.length > 0
              ? `Every installation available to ${result.github_login} is already linked to this Kortix account.`
              : `No existing Kortix App installation is available to ${result.github_login}.`,
          );
        } else {
          setState('select');
          setMessage(`Select a GitHub account available to ${result.github_login}.`);
        }
        return;
      }

      const status = await saveGitHubInstallation({
        state: installState,
        installation_id: installationId,
        github_user_token: userToken,
      });
      finishConnection(status.owner_login);
    } catch (error) {
      setState('verify');
      setMessage((error as Error).message || 'GitHub verification failed. Try again.');
    }
  }

  async function handleLink(installation: LinkableGitHubInstallation) {
    if (!githubUserToken || !accountId) {
      setState('verify');
      setMessage('Continue with GitHub again before you link this installation.');
      return;
    }
    setState('saving');
    setMessage(`Verifying and linking ${installation.owner_login ?? 'this GitHub account'}.`);
    try {
      const status = await linkGitHubInstallation({
        account_id: accountId,
        installation_id: installation.installation_id,
        github_user_token: githubUserToken,
      });
      finishConnection(status.owner_login);
    } catch (error) {
      setState('select');
      setMessage((error as Error).message || 'GitHub verification failed. Try again.');
    }
  }

  function finishConnection(ownerLogin: string | null) {
    setState('done');
    setMessage(
      ownerLogin
        ? `Connected to ${ownerLogin}. Redirecting you back now.`
        : 'GitHub connected. Redirecting you back now.',
    );
    redirectTimer.current = window.setTimeout(
      () => router.replace(consumeGitHubSetupReturn() ?? '/projects?new=1'),
      900,
    );
  }

  if (isLoading || !user) {
    return <AuthPendingScreen />;
  }

  const heading = getHeading(state, setupAction, selectingExistingInstallation);

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
              {selectingExistingInstallation ? 'Continue with GitHub' : 'Verify with GitHub'}
            </Button>
          </Rise>
        ) : state === 'loading' || state === 'saving' ? (
          <Rise delay={0.06}>
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loading className="size-4 shrink-0" />
              <span>This usually takes a few seconds</span>
            </div>
          </Rise>
        ) : state === 'select' ? (
          <Rise delay={0.06}>
            <ul className="space-y-2">
              {installations.map((installation) => (
                <li
                  key={installation.installation_id}
                  className="bg-popover flex items-center gap-3 rounded-md border px-3 py-2.5"
                >
                  <span className="bg-primary/[0.06] flex size-9 shrink-0 items-center justify-center rounded-sm">
                    <Github className="size-5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-foreground truncate text-sm font-medium">
                      {installation.owner_login ?? 'GitHub account'}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge variant="outline" size="xs">
                        {installation.owner_type === 'User' ? 'Personal' : 'Organization'}
                      </Badge>
                      {installation.repository_selection ? (
                        <span className="text-muted-foreground text-xs">
                          {installation.repository_selection === 'all'
                            ? 'All repositories'
                            : 'Selected repositories'}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant={installation.linked ? 'outline' : 'secondary'}
                    disabled={installation.linked}
                    onClick={() => void handleLink(installation)}
                  >
                    {installation.linked ? 'Linked' : 'Link'}
                  </Button>
                </li>
              ))}
            </ul>
          </Rise>
        ) : state === 'empty' ? (
          <Rise delay={0.06}>
            <div className="space-y-3">
              {installUrl ? (
                <Button
                  size="lg"
                  className="w-full"
                  onClick={() => window.location.assign(installUrl)}
                >
                  <Github className="size-4 shrink-0" />
                  Install GitHub App
                </Button>
              ) : null}
              <Button
                size="lg"
                variant="outline"
                className="w-full"
                onClick={() => router.replace(consumeGitHubSetupReturn() ?? '/projects')}
              >
                Back
              </Button>
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

function getHeading(
  state: SetupState,
  setupAction: string,
  selectingExistingInstallation: boolean,
): string {
  switch (state) {
    case 'verify':
      return selectingExistingInstallation ? 'Link a GitHub account' : 'Verify GitHub access';
    case 'loading':
      return 'Loading GitHub accounts';
    case 'select':
      return 'Select a GitHub account';
    case 'empty':
      return 'Install the GitHub App';
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
