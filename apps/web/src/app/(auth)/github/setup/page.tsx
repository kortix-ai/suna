'use client';

import { useTranslations } from 'next-intl';

import { ConnectingScreen } from '@/components/dashboard/connecting-screen';
import { Button } from '@/components/ui/button';
import { InfoBanner } from '@/components/ui/info-banner';
import Loading from '@/components/ui/loading';
import { useAuth } from '@/features/providers/auth-provider';
import { saveGitHubInstallation } from '@/lib/projects-client';
import { CheckCircleSolid, InfoCircleSolid } from '@mynaui/icons-react';
import { AlertCircle } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

type SetupState = 'saving' | 'done' | 'error';

export default function GitHubSetupPage() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <Suspense
      fallback={
        <ConnectingScreen
          forceConnecting
          minimal
          title={tHardcodedUi.raw('appGithubSetupPage.line15JsxAttrTitleConnectingGithub')}
        />
      }
    >
      <GitHubSetup />
    </Suspense>
  );
}

function GitHubSetup() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    return (
      <ConnectingScreen
        forceConnecting
        minimal
        title={tHardcodedUi.raw('appGithubSetupPage.line90JsxAttrTitleConnectingGithub')}
      />
    );
  }

  const heading = getHeading(state, setupAction);

  return (
    <main
      className="bg-background fixed inset-0 flex items-center justify-center px-4"
      role="status"
      aria-live="polite"
      aria-label={heading}
    >
      <div className="w-full max-w-sm space-y-6 py-6">
        {state === 'saving' ? (
          <>
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="text-muted-foreground flex items-center gap-2 text-sm">
                <Loading />
                <span>Connecting</span>
              </div>
              <div className="space-y-1.5">
                <h1 className="text-base font-semibold tracking-tight">
                  {getHeading(state, setupAction)}
                </h1>
                <p className="text-muted-foreground text-sm leading-relaxed">{message}</p>
              </div>
            </div>
            <p className="text-muted-foreground text-center text-xs">
              This usually takes a few seconds.
            </p>
          </>
        ) : state === 'error' ? (
          <>
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="border-destructive/25 bg-destructive/5 flex h-10 w-10 items-center justify-center rounded-lg border">
                <AlertCircle className="text-destructive h-5 w-5" aria-hidden />
              </div>
              <div className="space-y-1.5">
                <h1 className="text-base font-semibold tracking-tight">
                  {getHeading(state, setupAction)}
                </h1>
              </div>
            </div>
            <InfoBanner tone="destructive" icon={InfoCircleSolid}>
              {message}
            </InfoBanner>
            <Button
              variant="outline"
              className="w-full"
              onClick={() => router.replace('/projects')}
            >
              {tHardcodedUi.raw('appGithubSetupPage.line123JsxTextBackToProjects')}
            </Button>
          </>
        ) : (
          <>
            <div className="flex flex-col items-center gap-4 text-center">
              <div className="border-border bg-primary/6 flex h-10 w-10 items-center justify-center rounded-lg border">
                <CheckCircleSolid className="text-foreground size-5" aria-hidden />
              </div>
              <div className="space-y-1.5">
                <h1 className="text-base font-semibold tracking-tight">
                  {getHeading(state, setupAction)}
                </h1>
                <p className="text-muted-foreground text-sm leading-relaxed">{message}</p>
              </div>
            </div>
            <p className="text-muted-foreground text-center text-xs">Redirecting…</p>
          </>
        )}
      </div>
    </main>
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
