'use client';

import { useTranslations } from '@/i18n/use-translations';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useRef, useState } from 'react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import { AuthPendingScreen } from '@/features/auth/auth-consent';
import { Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { newWorkspacePathForAccount } from '@/features/workspace/new/account-param';
import { PROJECT_LANDING_PATH } from '@/lib/onboarding/landing-destination';
import { useAppHome } from '@/lib/onboarding/use-app-home';
import {
  linkGitHubInstallation,
  listLinkableGitHubInstallations,
  saveGitHubInstallation,
  type LinkableGitHubInstallation,
} from '@kortix/sdk';
import { GithubLogoIcon as Github } from '@phosphor-icons/react';
import { requestGitHubUserProof } from '@/lib/github-user-proof';

type SetupState = 'verify' | 'loading' | 'select' | 'empty' | 'saving' | 'done' | 'error';

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
      return 'GitHub did not finish connecting this account. Start again from this account\'s Git settings.';
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
  const appHome = useAppHome();
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

  const heading = getHeading(state, setupAction, selectingExistingInstallation);

  // The live region wraps only the status content — not the frame — so
  // screen readers don't re-announce the mark and legal footer on updates.
  // Desktop Back returns to the page that opened this flow, like the in-page
  // Back below. The account hub opens it with router.replace, so history alone
  // would skip the hub's Git tab.
  return (
    <AuthFrame backHref={returnPath ?? undefined}>
      <div role="status" aria-live="polite" aria-label={heading}>
        <Rise>
          <StepHeader title={heading} description={message} />
        </Rise>
        {state === 'verify' ? (
          <Rise delay={0.06}>
            <Button size="lg" className="w-full" onClick={handleVerify}>
              {selectingExistingInstallation
                ? tI18nComplete.raw('text7b9db77e0178')
                : tI18nComplete.raw('text8130db25eca7')}
            </Button>
          </Rise>
        ) : state === 'loading' || state === 'saving' ? (
          <Rise delay={0.06}>
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loading className="size-4 shrink-0" />
              <span>{tI18nComplete.raw('text147251df4759')}</span>
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
                      {installation.owner_login ?? tI18nComplete.raw('textd686f873a566')}
                    </p>
                    <div className="mt-1 flex items-center gap-1.5">
                      <Badge variant="outline" size="xs">
                        {installation.owner_type === 'User' ? 'Personal' : 'Organization'}
                      </Badge>
                      {installation.repository_selection ? (
                        <span className="text-muted-foreground text-xs">
                          {installation.repository_selection === 'all'
                            ? tI18nComplete.raw('text77fe4eba38d8')
                            : tI18nComplete.raw('texte0a8d25fe959')}
                        </span>
                      ) : null}
                    </div>
                    {/* One GitHub installation can back several Kortix
                        accounts. Linking it again is legal, so this is a
                        warning on the row and not a disabled button. */}
                    {installation.linked_to_other_accounts > 0 ? (
                      <p className="text-kortix-orange mt-1 text-xs">
                        {tI18nComplete('text0b0e4c425624', {
                          value0: installation.linked_to_other_accounts,
                        })}
                      </p>
                    ) : null}
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
                  {tI18nComplete.raw('text8d3f36f31348')}
                </Button>
              ) : null}
              <Button size="lg" variant="outline" className="w-full" asChild>
                <Link href={backHref} replace prefetch onClick={clearGitHubSetupReturn}>
                  {tI18nComplete.raw('text76900f1bfd16')}
                </Link>
              </Button>
            </div>
          </Rise>
        ) : state === 'error' ? (
          // Back to the page that opened this flow when there is one — a
          // failed link should return the user to the Git tab they started
          // from, not strand them on the app's landing page.
          <Rise delay={0.06}>
            <Button size="lg" className="w-full" asChild>
              <Link href={backHref} replace prefetch onClick={clearGitHubSetupReturn}>
                {returnPath
                  ? tI18nComplete.raw('text76900f1bfd16')
                  : tI18nComplete.raw('text5fae82827f98')}
              </Link>
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
      return 'Install the Kortix App';
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
