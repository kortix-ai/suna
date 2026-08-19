'use client';

import { useTranslations } from 'next-intl';

import { useEffect, useState } from 'react';

import { KortixLogo } from '@/components/ui/kortix-logo';
import Loading from '@/components/ui/loading';
import { ErrorStrip } from '@/features/auth/auth-primitives';
import { setupLinkApiBase } from '@/components/setup-links/util';

type ConnectMessage =
  | { type: 'github-connect-success'; provider_token: string }
  | { type: 'github-connect-error'; message: string };

export default function GitHubConnectPopup() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [status, setStatus] = useState<'loading' | 'processing' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    let disposed = false;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const post = (message: ConnectMessage) => {
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(message, window.location.origin);
        }
      } catch (err) {
        console.error('Failed to post message to opener:', err);
      }
    };

    const handle = async () => {
      try {
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
        const queryParams = new URLSearchParams(window.location.search);
        const accessToken = hashParams.get('access_token');
        const error = queryParams.get('error') || hashParams.get('error');

        if (error) {
          throw new Error(error);
        }

        if (accessToken) {
          setStatus('processing');
          if (disposed) return;
          post({ type: 'github-connect-success', provider_token: accessToken });
          history.replaceState(null, '', window.location.pathname);
          closeTimer = setTimeout(() => window.close(), 200);
          return;
        }

        // Fresh open — hand off to the GitHub App's own OAuth identity-proof
        // flow. This IS a full navigation (not a fetch): GitHub's redirect
        // chain has to land back on this same popup window.
        //
        // No origin is sent. The API always returns the token to its own
        // configured FRONTEND_URL — passing a caller-chosen origin let any
        // attacker HTTPS origin receive the exchanged GitHub token (CWE-601).
        const apiBase = setupLinkApiBase();
        window.location.replace(`${apiBase}/platform/github-app/oauth/authorize`);
      } catch (err) {
        if (disposed) return;
        const message = (err as Error).message || 'Failed to connect GitHub';
        setStatus('error');
        setErrorMessage(message);
        post({ type: 'github-connect-error', message });
        closeTimer = setTimeout(() => window.close(), 2200);
      }
    };

    handle();

    return () => {
      disposed = true;
      if (closeTimer) clearTimeout(closeTimer);
    };
  }, []);

  return (
    <main className="bg-background flex min-h-svh flex-col items-center justify-center px-6">
      <div className="w-full max-w-[320px]">
        <KortixLogo variant="icon" size={22} className="text-foreground" />
        <h1 className="text-foreground mt-6 text-2xl font-medium tracking-tight">
          {tHardcodedUi.raw('appAuthGithubConnectPage.line116JsxTextConnectGithub')}
        </h1>

        <div className="mt-6">
          {status === 'error' ? (
            <ErrorStrip message={errorMessage || 'Authentication failed'} />
          ) : (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loading className="text-muted-foreground size-4 shrink-0" />
              <span>{status === 'processing' ? 'Finishing up…' : 'Redirecting to GitHub…'}</span>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
