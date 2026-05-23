'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { CheckCircle2, KeyRound, Loader2, TerminalSquare, XCircle } from 'lucide-react';

import { useAuth } from '@/components/AuthProvider';
import { accountTokensApi } from '@/lib/api/account-tokens';
import { Button } from '@/components/ui/button';

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
    <Suspense fallback={<Centered><Loader2 className="size-6 animate-spin text-muted-foreground" /></Centered>}>
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
    return (
      <Centered>
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </Centered>
    );
  }

  if (!callback || !state) {
    return (
      <Centered>
        <ErrorCard
          title="Missing callback"
          message="This page is opened by the kortix CLI. Run `kortix login` in your terminal to start."
        />
      </Centered>
    );
  }

  if (!validation.ok) {
    return (
      <Centered>
        <ErrorCard title="Invalid callback" message={validation.reason} />
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
    <div className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
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
  const busy = phase === 'authorizing';
  return (
    <div className="rounded-2xl border bg-background shadow-sm">
      <div className="p-7">
        <div className="mb-6 flex items-center gap-3">
          <div className="grid size-11 place-items-center rounded-2xl border bg-muted/40">
            <TerminalSquare className="size-5" />
          </div>
          <div>
            <div className="text-base font-semibold">Authorize Kortix CLI</div>
            <div className="text-xs text-muted-foreground">
              kortix.com → your terminal
            </div>
          </div>
        </div>

        <p className="text-sm text-muted-foreground">
          Approving will create a new Personal Access Token in your account
          and hand it to the CLI running on this machine.
        </p>

        <dl className="mt-5 space-y-2 rounded-2xl border bg-muted/30 p-4 text-sm">
          <Row label="Account" value={userEmail || 'You'} />
          <Row label="Callback" value={callbackHost} />
          {deviceLabel && <Row label="Device" value={deviceLabel} />}
        </dl>

        {phase === 'error' && error && (
          <div className="mt-5 flex items-start gap-2 rounded-2xl border border-destructive bg-destructive/5 p-3 text-sm text-destructive">
            <XCircle className="mt-0.5 size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <div className="mt-6 flex items-center justify-between gap-3">
          <a
            href="/"
            className="text-sm text-muted-foreground underline-offset-4 hover:underline"
          >
            Cancel
          </a>
          <Button onClick={onAuthorize} disabled={busy} size="lg">
            {busy ? (
              <>
                <Loader2 className="size-4 animate-spin" /> Authorizing…
              </>
            ) : (
              <>
                <KeyRound className="size-4" /> Authorize
              </>
            )}
          </Button>
        </div>
      </div>

      <div className="border-t bg-muted/30 px-7 py-3 text-xs text-muted-foreground">
        You can revoke this token anytime under{' '}
        <strong className="text-foreground">Settings → CLI tokens</strong>.
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
  return (
    <div className="rounded-2xl border bg-background p-7 shadow-sm text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
        <CheckCircle2 className="size-6" />
      </div>
      <div className="mt-4 text-base font-semibold">CLI authorized</div>
      <p className="mt-1 text-sm text-muted-foreground">
        Return to your terminal — you&apos;re signed in.
      </p>
      <p className="mt-4 text-xs text-muted-foreground">
        You can close this tab.
      </p>
    </div>
  );
}

function ErrorCard({ title, message }: { title: string; message: string }) {
  return (
    <div className="rounded-2xl border bg-background p-7 shadow-sm text-center">
      <div className="mx-auto grid size-12 place-items-center rounded-full bg-destructive/10 text-destructive">
        <XCircle className="size-6" />
      </div>
      <div className="mt-4 text-base font-semibold">{title}</div>
      <p className="mt-1 text-sm text-muted-foreground">{message}</p>
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
