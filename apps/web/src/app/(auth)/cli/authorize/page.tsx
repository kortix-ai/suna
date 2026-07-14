'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { AuthFrame } from '@/features/auth/auth-card-shell';
import {
  AuthPendingScreen,
  AuthStatusScreen,
  CopyCommand,
  DetailPanel,
  DetailRow,
} from '@/features/auth/auth-consent';
import { ErrorStrip, Rise, StepHeader } from '@/features/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { accountTokensApi } from '@/lib/api/account-tokens';
import { validateCallback } from './validate-callback';

/**
 * Browser-callback authorization page. The CLI runs `kortix login`,
 * spawns a one-shot HTTP server on `http://127.0.0.1:<port>/callback`,
 * and opens this page with `?callback=<encoded URL>&state=<nonce>`.
 *
 * The user clicks **Authorize**. We mint a fresh PAT via the existing
 * `/v1/accounts/tokens` endpoint and POST `{state, token}` to the
 * local callback. The CLI captures it and tears its server down.
 *
 * Security:
 *  - `callback` must be `http://127.0.0.1` or `http://localhost`.
 *  - The `state` nonce is round-tripped to prevent cross-tab CSRF.
 *  - We never expose the token in the URL (no `#fragment`, no query) —
 *    it's only sent via POST body to localhost.
 */
export default function CliAuthorizePage() {
  return (
    <Suspense fallback={<AuthPendingScreen />}>
      <CliAuthorizeInner />
    </Suspense>
  );
}

type Phase = 'idle' | 'authorizing' | 'success' | 'error';

function CliAuthorizeInner() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const params = useSearchParams();

  const callback = params.get('callback');
  const state = params.get('state');
  const label = params.get('label') ?? '';

  const validation = useMemo(() => validateCallback(callback), [callback]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      const target = `/cli/authorize?${params.toString()}`;
      router.replace(`/auth?redirect=${encodeURIComponent(target)}`);
    }
  }, [isLoading, user, params, router]);

  if (isLoading || !user) {
    return <AuthPendingScreen />;
  }

  if (!callback || !state) {
    return (
      <AuthStatusScreen
        title="Open this page from the CLI"
        description="Run this command in your terminal to get a fresh sign-in link."
        action={<CopyCommand command="kortix login" />}
      />
    );
  }

  if (!validation.ok) {
    return <AuthStatusScreen title="Invalid callback" description={validation.reason} />;
  }

  async function authorize() {
    if (!callback || !state) return;
    setPhase('authorizing');
    setError(null);

    // Two timeouts to avoid the page hanging forever if anything along
    // the way silently stalls (e.g. the API takes too long to mint, or
    // the CLI callback socket accepts the connection but never replies).
    const MINT_TIMEOUT_MS = 15_000;
    const CALLBACK_TIMEOUT_MS = 10_000;

    try {
      const name = label ? `CLI · ${label}` : `CLI · ${new Date().toLocaleString()}`;
      const minted = await withTimeout(
        accountTokensApi.create({ name }),
        MINT_TIMEOUT_MS,
        'Timed out asking the Kortix API to mint an API key. Is the API reachable?',
      );

      const controller = new AbortController();
      const callbackTimer = setTimeout(() => controller.abort(), CALLBACK_TIMEOUT_MS);
      let resp: Response;
      try {
        resp = await fetch(callback, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ state, token: minted.secret_key }),
          signal: controller.signal,
        });
      } catch (err) {
        // Best-effort cleanup: revoke the just-minted PAT so we don't
        // leave a dead token in the DB after a failed delivery.
        accountTokensApi.revoke(minted.token_id).catch(() => {});
        if ((err as Error).name === 'AbortError') {
          throw new Error(
            `Timed out delivering the API key to ${new URL(callback).host}. Is the \`kortix login\` process still running in your terminal?`,
          );
        }
        throw new Error(
          `Could not reach ${new URL(callback).host}: ${(err as Error).message}. Make sure \`kortix login\` is running in your terminal and try again.`,
        );
      } finally {
        clearTimeout(callbackTimer);
      }

      if (!resp.ok) {
        let detail = `HTTP ${resp.status}`;
        try {
          const body = await resp.json();
          if (body?.error) detail = `${detail} — ${body.error}`;
        } catch {
          /* ignore */
        }
        // Same cleanup if the CLI rejected the token (state mismatch, etc.)
        accountTokensApi.revoke(minted.token_id).catch(() => {});
        throw new Error(`CLI callback rejected the token: ${detail}`);
      }

      setPhase('success');
    } catch (err) {
      setError((err as Error).message);
      setPhase('error');
    }
  }

  if (phase === 'success') {
    return (
      <AuthStatusScreen
        title="CLI connected"
        description="You're signed in. Return to your terminal — you can close this tab."
      />
    );
  }

  const busy = phase === 'authorizing';

  return (
    <AuthFrame>
      <Rise>
        <StepHeader
          title="Sign in to the Kortix CLI"
          description={
            <>
              <span className="text-foreground font-mono">kortix login</span> in your terminal is
              waiting for you to approve this sign-in.
            </>
          }
        />
      </Rise>

      <Rise delay={0.06}>
        {phase === 'error' && error ? <ErrorStrip message={error} /> : null}

        <DetailPanel>
          <DetailRow label="Account" value={user.email ?? 'You'} />
          <DetailRow label="Sends to" value={validation.display} mono />
          {label ? <DetailRow label="Device" value={label} /> : null}
        </DetailPanel>

        <Button size="lg" className="mt-5 w-full" onClick={authorize} disabled={busy}>
          {busy ? <Loading className="size-4 shrink-0" /> : null}
          Authorize
        </Button>

        <div className="text-muted-foreground mt-8 space-y-2 text-sm">
          <p>
            This creates a personal access token. Revoke it anytime in{' '}
            <span className="text-foreground">Settings → CLI tokens</span>.
          </p>
          <p>
            <Link
              href="/"
              className="hover:text-foreground -my-2 inline-block py-2 underline-offset-4 transition-colors hover:underline"
            >
              Cancel
            </Link>
          </p>
        </div>
      </Rise>
    </AuthFrame>
  );
}

/** Race a promise against a timeout. Rejects with `message` if the
 *  promise doesn't settle in time — keeps the UI from sitting on a
 *  silent "Authorizing…" spinner if the network stalls. */
function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}
