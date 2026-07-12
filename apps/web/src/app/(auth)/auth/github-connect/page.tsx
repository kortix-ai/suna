'use client';

import { useTranslations } from 'next-intl';

import { useEffect, useState } from 'react';

import { KortixLogo } from '@/components/ui/kortix-logo';
import Loading from '@/components/ui/loading';
import { ErrorStrip } from '@/features/auth/auth-primitives';
import { createClient } from '@/lib/supabase/client';

type ConnectMessage =
  | { type: 'github-connect-success'; provider_token: string; github_login?: string }
  | { type: 'github-connect-error'; message: string };

export default function GitHubConnectPopup() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const [status, setStatus] = useState<'loading' | 'processing' | 'error'>('loading');
  const [errorMessage, setErrorMessage] = useState<string>('');

  useEffect(() => {
    const supabase = createClient();
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
        const urlParams = new URLSearchParams(window.location.search);
        const isCallback = urlParams.has('code') || urlParams.has('access_token');
        const hasError = urlParams.has('error');

        if (hasError) {
          const error = urlParams.get('error');
          const desc = urlParams.get('error_description');
          throw new Error(desc || error || 'GitHub authorization failed');
        }

        if (isCallback) {
          setStatus('processing');
          // Allow Supabase a moment to consume the redirect into a session.
          await new Promise((r) => setTimeout(r, 600));
          const {
            data: { session },
            error,
          } = await supabase.auth.getSession();
          if (error) throw error;
          if (!session?.provider_token) {
            throw new Error('GitHub did not return an access token. Try again.');
          }

          let githubLogin: string | undefined;
          try {
            const r = await fetch('https://api.github.com/user', {
              headers: {
                Authorization: `Bearer ${session.provider_token}`,
                Accept: 'application/vnd.github+json',
              },
            });
            if (r.ok) {
              const u = (await r.json()) as { login?: string };
              githubLogin = u.login;
            }
          } catch {
            // best-effort; opener fetches /user too
          }

          post({
            type: 'github-connect-success',
            provider_token: session.provider_token,
            github_login: githubLogin,
          });
          setTimeout(() => window.close(), 200);
          return;
        }

        // The @supabase/ssr browser client doesn't implement linkIdentity
        // reliably, so use signInWithOAuth — the existing /auth/github-popup
        // uses the same approach. If the user's primary identity is already
        // GitHub, the session is preserved; otherwise Supabase will match by
        // email per the project's auth configuration.
        const redirectTo = `${window.location.origin}/auth/github-connect`;
        const { error: signInError } = await supabase.auth.signInWithOAuth({
          provider: 'github',
          options: {
            scopes: 'repo read:user',
            redirectTo,
            queryParams: { prompt: 'select_account' },
          },
        });
        if (signInError) throw signInError;
      } catch (err) {
        const message = (err as Error).message || 'Failed to connect GitHub';
        setStatus('error');
        setErrorMessage(message);
        post({ type: 'github-connect-error', message });
        setTimeout(() => window.close(), 2200);
      }
    };

    handle();
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
