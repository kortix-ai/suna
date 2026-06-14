'use client';

import { useTranslations } from 'next-intl';

import { CheckCircle2, KeyRound, Loader2, TerminalSquare, XCircle } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { useAuth } from '@/features/providers/auth-provider';
import { accountTokensApi } from '@/lib/api/account-tokens';

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
    <Suspense
      fallback={
        <Centered>
          <Loader2 className="text-muted-foreground size-6 animate-spin" />
        </Centered>
      }
    >
      <CliAuthorizeInner />
    </Suspense>
  );
}

type Phase = 'idle' | 'authorizing' | 'success' | 'error';

function CliAuthorizeInner() {
  const tHardcodedUi = useTranslations('hardcodedUi');
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
    return (
      <Centered>
        <Loader2 className="text-muted-foreground size-6 animate-spin" />
      </Centered>
    );
  }

  if (!callback || !state) {
    return (
      <Centered>
        <ErrorCard
          title={tHardcodedUi.raw('appCliAuthorizePage.line70JsxAttrTitleMissingCallback')}
          message={tHardcodedUi.raw(
            'appCliAuthorizePage.line71JsxAttrMessageThisPageIsOpenedByTheKortixCli',
          )}
        />
      </Centered>
    );
  }

  if (!validation.ok) {
    return (
      <Centered>
        <ErrorCard
          title={tHardcodedUi.raw('appCliAuthorizePage.line80JsxAttrTitleInvalidCallback')}
          message={validation.reason}
        />
      </Centered>
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
        accountTokensApi.create({ name }),
        MINT_TIMEOUT_MS,
        'Timed out asking the Kortix API to mint a token. Is the API reachable?',
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
            `Timed out delivering the token to ${new URL(callback).host}. Is the \`kortix login\` process still running in your terminal?`,
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
      <Centered>
        <SuccessCard />
      </Centered>
    );
  }

  return (
    <Centered>
      <ConsentCard
        userEmail={user.email ?? ''}
        callbackHost={validation.display}
        deviceLabel={label}
        phase={phase}
        error={error}
        onAuthorize={authorize}
      />
    </Centered>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Layout
// ──────────────────────────────────────────────────────────────────────────

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-muted/30 flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-md">{children}</div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Consent card
// ──────────────────────────────────────────────────────────────────────────

interface ConsentProps {
  userEmail: string;
  callbackHost: string;
  deviceLabel: string;
  phase: Phase;
  error: string | null;
  onAuthorize: () => void;
}

function ConsentCard({
  userEmail,
  callbackHost,
  deviceLabel,
  phase,
  error,
  onAuthorize,
}: ConsentProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const busy = phase === 'authorizing';
  return (
    <div className="bg-background rounded-2xl border shadow-sm">
      <div className="p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="bg-muted/40 grid size-11 place-items-center rounded-2xl border">
            <TerminalSquare className="size-5" />
          </div>
          <div>
            <div className="text-base font-semibold">
              {tHardcodedUi.raw('appCliAuthorizePage.line214JsxTextAuthorizeKortixCli')}
            </div>
            <div className="text-muted-foreground text-xs">
              {tHardcodedUi.raw('appCliAuthorizePage.line216JsxTextKortixComYourTerminal')}
            </div>
          </div>
        </div>

        <p className="text-muted-foreground text-sm">
          {tHardcodedUi.raw(
            'appCliAuthorizePage.line222JsxTextApprovingWillCreateANewPersonalAccessToken',
          )}
        </p>

        <dl className="bg-muted/30 mt-5 space-y-2 rounded-2xl border p-4 text-sm">
          <Row label="Account" value={userEmail || 'You'} />
          <Row label="Callback" value={callbackHost} />
          {deviceLabel && <Row label="Device" value={deviceLabel} />}
        </dl>

        {phase === 'error' && error && (
          <div className="border-destructive bg-destructive/5 text-destructive mt-5 flex items-start gap-2 rounded-2xl border p-3 text-sm">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <Link
            href="/"
            className="text-muted-foreground text-sm underline-offset-4 hover:underline"
          >
            Cancel
          </Link>
          <Button onClick={onAuthorize} disabled={busy} size="lg">
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                {tHardcodedUi.raw('appCliAuthorizePage.line249JsxTextAuthorizing')}
              </>
            ) : (
              <>
                <KeyRound className="size-4" /> Authorize
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="bg-muted/30 text-muted-foreground border-t px-7 py-3 text-xs">
        {tHardcodedUi.raw('appCliAuthorizePage.line261JsxTextYouCanRevokeThisTokenAnytimeUnder')}{' '}
        <strong className="text-foreground">
          {tHardcodedUi.raw('appCliAuthorizePage.line262JsxTextSettingsCliTokens')}
        </strong>
        .
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="truncate font-mono text-xs">{value}</dd>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Success / error states
// ──────────────────────────────────────────────────────────────────────────

function SuccessCard() {
  const tHardcodedUi = useTranslations('hardcodedUi');
  return (
    <div className="bg-background rounded-2xl border p-7 text-center shadow-sm">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-6" />
      </div>
      <div className="mt-4 text-base font-semibold">
        {tHardcodedUi.raw('appCliAuthorizePage.line287JsxTextCliAuthorized')}
      </div>
      <p className="text-muted-foreground mt-1 text-sm">
        {tHardcodedUi.raw('appCliAuthorizePage.line289JsxTextReturnToYourTerminalYouAposReSigned')}
      </p>
      <p className="text-muted-foreground mt-4 text-xs">
        {tHardcodedUi.raw('appCliAuthorizePage.line292JsxTextYouCanCloseThisTab')}
      </p>
    </div>
  );
}

function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="bg-background rounded-2xl border p-7 text-center shadow-sm">
      <div className="bg-destructive/10 text-destructive mx-auto grid size-12 place-items-center rounded-full">
        <XCircle className="size-6" />
      </div>
      <div className="mt-4 text-base font-semibold">{title}</div>
      <p className="text-muted-foreground mt-1 text-sm">{message}</p>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

interface Validation {
  ok: boolean;
  reason: string;
  display: string;
}

function validateCallback(raw: string | null): Validation {
  if (!raw) return { ok: false, reason: 'No callback URL provided.', display: '' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: 'Callback is not a valid URL.', display: '' };
  }
  if (url.protocol !== 'http:') {
    return {
      ok: false,
      reason: 'Callback must use http:// — refusing other protocols.',
      display: url.origin,
    };
  }
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    return {
      ok: false,
      reason: 'Callback must be a localhost address.',
      display: url.origin,
    };
  }
  return { ok: true, reason: '', display: `${url.hostname}:${url.port}` };
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
