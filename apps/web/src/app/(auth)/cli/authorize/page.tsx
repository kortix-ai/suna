'use client';

import { useTranslations } from '@/i18n/use-translations';
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
import { createAccountToken, revokeAccountToken } from '@kortix/sdk';
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
  const tI18nComplete = useTranslations('hardcodedUi.i18nComplete');
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
        title={tI18nComplete.raw('text78ba0d8d5880')}
        description={tI18nComplete.raw('text5c705d15f3ef')}
        action={<CopyCommand command={tI18nComplete.raw('text69fcb4fde341')} />}
      />
    );
  }

  if (!validation.ok) {
    return (
      <AuthStatusScreen
        title={tI18nComplete.raw('text7544354edd29')}
        description={validation.reason}
      />
    );
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
        createAccountToken({ name }),
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
        revokeAccountToken(minted.token_id).catch(() => {});
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
        revokeAccountToken(minted.token_id).catch(() => {});
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
        title={tI18nComplete.raw('text33a41fd14a13')}
        description={tI18nComplete.raw('texte6284f383569')}
      />
    );
  }

  const busy = phase === 'authorizing';

  return (
    <AuthFrame>
      <Rise>
        <StepHeader
          title={tI18nComplete.raw('textdc76dd6b1aff')}
          description={
            <>
              <span className="text-foreground font-mono">
                {tI18nComplete.raw('text69fcb4fde341')}
              </span>{' '}
              {tI18nComplete.raw('textc19c3fc65916')}
            </>
          }
        />
      </Rise>

      <Rise delay={0.06}>
        {phase === 'error' && error ? <ErrorStrip message={error} /> : null}

        <DetailPanel>
          <DetailRow label={tI18nComplete.raw('text7e1b0d5641f2')} value={user.email ?? 'You'} />
          <DetailRow
            label={tI18nComplete.raw('text03fe47e17852')}
            value={validation.display}
            mono
          />
          {label ? <DetailRow label={tI18nComplete.raw('text6ba0bdeccb42')} value={label} /> : null}
        </DetailPanel>

        <Button size="lg" className="mt-5 w-full" onClick={authorize} disabled={busy}>
          {busy ? <Loading className="size-4 shrink-0" /> : null}
          {tI18nComplete.raw('textb6741b4ccf6d')}
        </Button>

        <div className="text-muted-foreground mt-8 space-y-2 text-sm">
          <p>
            {tI18nComplete.raw('text702391f5d071')}{' '}
            <span className="text-foreground">{tI18nComplete.raw('text7955091baf3b')}</span>.
          </p>
          <p>
            <Link
              href="/"
              className="hover:text-foreground -my-2 inline-block py-2 underline-offset-4 transition-colors hover:underline"
            >
              {tI18nComplete.raw('text19766ed6ccb2')}
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
