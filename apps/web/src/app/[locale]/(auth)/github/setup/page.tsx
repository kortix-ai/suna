'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { AuthPendingScreen } from '@/features/auth/auth-consent';
import { GitHubSetupView, type GitHubSetupState } from '@/features/auth/github-setup-view';
import { useAuth } from '@/features/providers/auth-provider';
import { newWorkspacePathForAccount } from '@/features/workspace/new/account-param';
import { requestGitHubUserProof } from '@/lib/github-user-proof';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { useAppHome } from '@/lib/onboarding/use-app-home';
import {
  linkGitHubInstallation,
  listLinkableGitHubInstallations,
  saveGitHubInstallation,
  type LinkableGitHubInstallation,
} from '@kortix/sdk';

/**
 * `?github=error&reason=<slug>` — what the backend says when an account link
 * fails, turned into a sentence.
 *
 * The slugs are the ones `apps/api/src/platform/routes/github-app.ts` emits on
 * the install callback, plus whatever GitHub itself returns as `error` (e.g.
 * `access_denied`). Anything unrecognized falls through to the generic line:
 * a raw slug on screen is not a message, it is a leak.
 */
function setupErrorMessage(reason: string | null): string {
  switch (reason) {
    case 'access_denied':
      return 'GitHub authorization was declined. Nothing was connected.';
    case 'app_not_configured':
    case 'install_url_unavailable':
      return 'This instance has no GitHub App to install. A platform admin sets this up in the admin console.';
    case 'missing_installation_id':
    case 'owner_unresolved':
      return 'GitHub did not return a usable installation. Install the Kortix App again and pick an account.';
    default:
      return "GitHub did not finish connecting this account. Start again from this account's Git settings.";
  }
}

export default function GitHubSetupPage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <GitHubSetup />
    </Suspense>
  );
}

function GitHubSetup() {
  const appHome = useAppHome();
  const router = useRouter();
  const searchParams = useSearchParams();
  const { user, isLoading } = useAuth();
  const redirectTimer = useRef<number | undefined>(undefined);
  const [state, setState] = useState<GitHubSetupState>('verify');
  const [message, setMessage] = useState(
    'Confirm that your GitHub user owns this account or administers this organization.',
  );
  const [githubUserToken, setGitHubUserToken] = useState('');
  const [installations, setInstallations] = useState<LinkableGitHubInstallation[]>([]);
  const [installUrl, setInstallUrl] = useState<string | null>(null);

  // `useAppHome` reads document.cookie, which the server pass cannot see. Seed
  // the state with the door and adopt the real answer after mount, so an href
  // built from it is identical on both passes.
  const [homeHref, setHomeHref] = useState(PROJECT_LANDING_PATH);
  useEffect(() => setHomeHref(appHome), [appHome]);

  // Where "Back" goes. Read (not consumed) at mount so the control can be an
  // anchor and Next can prefetch it; the click still clears the one-shot entry.
  const [returnPath, setReturnPath] = useState<string | null>(null);
  useEffect(() => setReturnPath(peekGitHubSetupReturn()), []);
  const backHref = returnPath ?? homeHref;

  const installState = searchParams.get('state') || '';
  const installationId = searchParams.get('installation_id') || '';
  const setupAction = searchParams.get('setup_action') || '';
  const accountId = searchParams.get('account_id') || '';
  // The backend redirects a FAILED account link back here now, not to
  // `/accounts/<id>?tab=git` — there is no `/accounts` route, so that URL was a
  // 404 carrying the only explanation of what went wrong.
  const failureFlag = searchParams.get('github') === 'error';
  const failureReason = searchParams.get('reason');
  const selectingExistingInstallation = Boolean(
    accountId && !installState && !installationId && !failureFlag,
  );

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

    if (failureFlag) {
      setState('error');
      setMessage(setupErrorMessage(failureReason));
      return;
    }

    if (setupAction === 'uninstall') {
      setState('done');
      setMessage('GitHub App removed from your account.');
      redirectTimer.current = window.setTimeout(() => router.replace(appHome), 900);
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
    failureFlag,
    failureReason,
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
          // The dead end this state used to be: it said everything was already
          // linked and offered no way forward. Installing the App on ANOTHER
          // organization is the way forward, and it is only honest to offer it
          // when the instance actually has an App to install.
          const already =
            result.installations.length > 0
              ? `Every installation available to ${result.github_login} is already linked to this Kortix account.`
              : `No existing Kortix App installation is available to ${result.github_login}.`;
          setMessage(
            result.install_url
              ? `${already} To connect another organization, install the Kortix App on it.`
              : `${already} This instance has no GitHub App to install. A platform admin sets this up in the admin console.`,
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
      finishConnection(status.owner_login, status.account_id ?? null);
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
      finishConnection(status.owner_login, status.account_id ?? null);
    } catch (error) {
      setState('select');
      setMessage((error as Error).message || 'GitHub verification failed. Try again.');
    }
  }

  function finishConnection(ownerLogin: string | null, linkedAccountId: string | null) {
    setState('done');
    setMessage(
      ownerLogin
        ? `Connected to ${ownerLogin}. Redirecting you back now.`
        : 'GitHub connected. Redirecting you back now.',
    );
    // The remembered return path first (the hub or /new, as the user left
    // it). Without one, `/new` — but SCOPED to the account that was just
    // linked: a bare `/new` resolves to the personal account and shows the
    // connection as missing (dev, 2026-09-17).
    const fallback = linkedAccountId ? newWorkspacePathForAccount(linkedAccountId) : '/new';
    redirectTimer.current = window.setTimeout(
      () => router.replace(consumeGitHubSetupReturn() ?? fallback),
      900,
    );
  }

  if (isLoading || !user) {
    return <AuthPendingScreen />;
  }

  return (
    <GitHubSetupView
      state={state}
      message={message}
      setupAction={setupAction}
      selectingExistingInstallation={selectingExistingInstallation}
      email={user.email ?? null}
      installations={installations}
      installUrl={installUrl}
      backHref={backHref}
      returnPath={returnPath}
      onVerify={handleVerify}
      onLink={(installation) => void handleLink(installation)}
      onBack={clearGitHubSetupReturn}
    />
  );
}

/** The stored return path, validated, WITHOUT clearing it. */
function peekGitHubSetupReturn(): string | null {
  try {
    const value = window.localStorage.getItem('kortix:github_setup_return');
    if (!value || !value.startsWith('/') || value.startsWith('//')) return null;
    return value;
  } catch {
    return null;
  }
}

function clearGitHubSetupReturn(): void {
  try {
    window.localStorage.removeItem('kortix:github_setup_return');
  } catch {
    // A blocked storage read is not a reason to fail the navigation.
  }
}

function consumeGitHubSetupReturn(): string | null {
  const value = peekGitHubSetupReturn();
  clearGitHubSetupReturn();
  return value;
}
