'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { KortixLoader } from '@/components/ui/kortix-loader';

type ConnectMessage =
  | { type: 'github-connect-success'; provider_token: string; github_login?: string }
  | { type: 'github-connect-error'; message: string };

export default function GitHubConnectPopup() {
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

  const statusMessage =
    status === 'error'
      ? errorMessage || 'Authentication failed'
      : status === 'processing'
        ? 'Finishing up…'
        : 'Redirecting to GitHub…';

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background p-8">
      <div className="flex max-w-sm flex-col items-center gap-4 text-center">
        {status !== 'error' && <KortixLoader size="large" />}
        <div className="space-y-1">
          <h1 className="text-base font-medium">Connect GitHub</h1>
          <p className={status === 'error' ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
            {statusMessage}
          </p>
        </div>
      </div>
    </main>
  );
}
