'use client';

import { useTranslations } from '@/i18n/use-translations';

import { useEffect, useRef, useState } from 'react';

import { setupLinkApiBase } from '@/components/setup-links/util';
import { KortixLogo } from '@/components/ui/kortix-logo';
import Loading from '@/components/ui/loading';
import { ErrorStrip } from '@/features/auth/auth-primitives';

type ConnectMessage =
  | { type: 'github-connect-success'; provider_token: string }
  | { type: 'github-connect-error'; message: string };

export default function GitHubConnectPopup() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [status, setStatus] = useState<'loading' | 'processing' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');
  // What the first run of the effect decided, so a second run (React
  // StrictMode unmounts and remounts effects once in development) does not
  // decide again. The first run strips the token from the URL; a second read
  // finds no token, takes the fresh-open branch and sends the popup off to
  // GitHub instead of closing it. The cleanup also cancels the pending close,
  // so the re-run re-arms it.
  const outcomeRef = useRef<{ closeAfterMs: number } | 'redirecting' | null>(null);

  useEffect(() => {
    let disposed = false;
    let closeTimer: ReturnType<typeof setTimeout> | null = null;
    const armClose = (ms: number) => {
      outcomeRef.current = { closeAfterMs: ms };
      closeTimer = setTimeout(() => window.close(), ms);
    };
    const settled = outcomeRef.current;
    if (settled === 'redirecting') return undefined;
    if (settled) {
      armClose(settled.closeAfterMs);
      return () => {
        disposed = true;
        if (closeTimer) clearTimeout(closeTimer);
      };
    }
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
        // `github_token`, and not the fragment key the app's own auth client
        // treats as an implicit-flow login on every page load: this popup runs
        // inside the web app, so a GitHub token under THAT name is picked up
        // as a session, fails to validate, and the client clears the session
        // the opener is signed in with — the "verify with GitHub logs me out"
        // report (dev, 2026-09-17).
        const accessToken = hashParams.get('github_token');
        const error = queryParams.get('error') || hashParams.get('error');

        if (error) {
          throw new Error(error);
        }

        if (accessToken) {
          setStatus('processing');
          if (disposed) return;
          post({ type: 'github-connect-success', provider_token: accessToken });
          history.replaceState(null, '', window.location.pathname);
          armClose(200);
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
        outcomeRef.current = 'redirecting';
        window.location.replace(`${apiBase}/platform/github-app/oauth/authorize`);
      } catch (err) {
        if (disposed) return;
        const message = (err as Error).message || 'Failed to connect GitHub';
        setStatus('error');
        setErrorMessage(message);
        post({ type: 'github-connect-error', message });
        armClose(2200);
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
            <ErrorStrip
              message={errorMessage || tHardcodedUi.raw('i18nComplete.text93821eb7ce8c')}
            />
          ) : (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loading className="text-muted-foreground size-4 shrink-0" />
              <span>
                {status === 'processing'
                  ? tHardcodedUi.raw('i18nComplete.text4bc99680df20')
                  : tHardcodedUi.raw('i18nComplete.text502698660877')}
              </span>
            </div>
          )}
        </div>
      </div>
    </main>
  );
}
