'use client';

import { useTranslations } from '@/i18n/use-translations';

import { callbackTimeoutMessage, callbackUnreachableMessage } from './callback-errors';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@kortix/ui/button';
import { EntityAvatar } from '@kortix/ui/entity-avatar';
import { Input } from '@kortix/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@kortix/ui/select';
import Loading from '@kortix/ui/loading';
import { AuthFrame } from '@kortix/ui/internal/auth/auth-card-shell';
import {
  AuthPendingScreen,
  AuthStatusScreen,
  CopyCommand,
  DetailPanel,
  DetailRow,
} from '@kortix/ui/internal/auth/auth-consent';
import { ErrorStrip, FieldLabel, Rise, StepHeader } from '@kortix/ui/internal/auth/auth-primitives';
import { useAuth } from '@/features/providers/auth-provider';
import { approveCliDevice, createAccountToken, isNoWorkspaceError, revokeAccountToken } from '@kortix/sdk';
import { PlusIcon } from '@phosphor-icons/react';
import { useWorkspaceDirectory } from '@kortix/ui/workspace/sidebar/use-workspace-directory';
import { validateCallback } from './validate-callback';

const normalizeCliCode = (code: string) => code.trim().toUpperCase().replace(/-/g, '');

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

  const userCode = params.get('user_code');
  const callback = params.get('callback');
  const state = params.get('state');
  const label = params.get('label') ?? '';

  const validation = useMemo(() => validateCallback(callback), [callback]);

  const [phase, setPhase] = useState<Phase>('idle');
  const [error, setError] = useState<string | null>(null);
  const [typedCode, setTypedCode] = useState('');
  const [noWorkspace, setNoWorkspace] = useState(false);
  const tCli = useTranslations('workspaces.cli');
  // A CLI login acts in a workspace: with none, the API answers 409
  // `no_workspace`. Say so up front instead of after a failed approve.
  const directory = useWorkspaceDirectory();
  const withoutWorkspace = noWorkspace || (!directory.loading && directory.openable.length === 0);
  // A CLI key acts in ONE workspace. With 2+ the person picks which; the
  // most recently opened one is preselected. The key is account-scoped, so
  // the choice is sent as the workspace's `account_id`.
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<string | null>(null);
  const pickedRow =
    directory.openable.find((row) => row.workspaceId === pickedWorkspaceId) ?? directory.openable[0] ?? null;
  const targetAccountId = pickedRow?.accountId;
  const workspacePicker =
    directory.openable.length > 1 ? (
      <div className="space-y-2">
        <FieldLabel htmlFor="cli-workspace">{tCli('workspaceLabel')}</FieldLabel>
        <Select value={pickedRow?.workspaceId ?? ''} onValueChange={setPickedWorkspaceId}>
          <SelectTrigger id="cli-workspace" size="md" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {directory.openable.map((row) => (
              <SelectItem key={row.workspaceId} value={row.workspaceId} size="md">
                <span className="flex min-w-0 items-center gap-2">
                  <EntityAvatar
                    label={row.project.name}
                    glyph={row.project.icon_glyph}
                    emoji={row.project.icon}
                    size="xs"
                  />
                  <span className="truncate">{row.project.name}</span>
                </span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    ) : null;
  // Synchronous in-flight guard (the pattern of `tokens-tab.tsx`): two clicks
  // before the re-render that disables the button minted two API keys.
  const inFlightRef = useRef(false);

  useEffect(() => {
    if (isLoading) return;
    if (!user) {
      const target = `/cli/authorize?${params.toString()}`;
      router.replace(`/auth?redirect=${encodeURIComponent(target)}`);
    }
  }, [isLoading, user, params, router]);

  if (isLoading || !user || directory.loading) {
    return <AuthPendingScreen />;
  }

  if (withoutWorkspace && (userCode || (callback && state && validation.ok))) {
    // `/workspaces/new` comes back here once the workspace exists (`returnUrl`), and
    // the person approves the sign-in with a workspace to act in.
    const here = `/cli/authorize?${params.toString()}`;
    return (
      <AuthStatusScreen
        title={tCli('noWorkspaceTitle')}
        description={tCli('noWorkspaceBody')}
        action={
          <Button asChild size="lg" className="w-full gap-1.5">
            <Link href={`/workspaces/new?returnUrl=${encodeURIComponent(here)}`}>
              <PlusIcon className="size-4 shrink-0" />
              {tCli('createAction')}
            </Link>
          </Button>
        }
      />
    );
  }

  if (userCode) {
    // The URL carries the code, so a link from someone else could too. The
    // person types the code their own terminal shows; only a match approves.
    const confirmed = typedCode.trim().length > 0 && normalizeCliCode(typedCode) === normalizeCliCode(userCode);
    if (phase === 'success') {
      return (
        <AuthStatusScreen
          title={tI18nComplete.raw('text33a41fd14a13')}
          description={tI18nComplete.raw('cliDeviceApproved')}
        />
      );
    }
    const approving = phase === 'authorizing';
    return (
      <AuthFrame>
        <Rise>
          <StepHeader title={tI18nComplete.raw('cliDeviceTitle')} description={tI18nComplete.raw('cliDeviceWarning')} />
        </Rise>
        <Rise delay={0.06}>
          {error ? <ErrorStrip message={error} /> : null}
          <form
            className="space-y-3"
            onSubmit={async (event) => {
              event.preventDefault();
              if (!confirmed || approving || inFlightRef.current) return;
              inFlightRef.current = true;
              setPhase('authorizing');
              setError(null);
              try {
                await approveCliDevice(userCode, targetAccountId ? { accountId: targetAccountId } : undefined);
                setPhase('success');
              } catch (err) {
                if (isNoWorkspaceError(err)) setNoWorkspace(true);
                setError((err as Error).message);
                setPhase('error');
              } finally {
                inFlightRef.current = false;
              }
            }}
          >
            {workspacePicker}
            <FieldLabel htmlFor="cli-user-code">{tI18nComplete.raw('cliDeviceCode')}</FieldLabel>
            <Input
              id="cli-user-code"
              size="md"
              autoFocus
              autoComplete="off"
              spellCheck={false}
              className="font-mono tracking-widest uppercase"
              value={typedCode}
              onChange={(event) => setTypedCode(event.target.value)}
            />
            <Button type="submit" size="lg" className="w-full" disabled={!confirmed || approving}>
              {approving ? <Loading className="size-4 shrink-0" /> : null}
              {tI18nComplete.raw('cliDeviceAction')}
            </Button>
          </form>
        </Rise>
      </AuthFrame>
    );
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
    if (!callback || !state || inFlightRef.current) return;
    inFlightRef.current = true;
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
        // A CLI login renews on use: 90 days out, moved out again on every call.
        createAccountToken({ name, accountId: targetAccountId, renews: true }),
        MINT_TIMEOUT_MS,
        'Timed out asking the Kortix API to mint an API key. Is the API reachable?',
        // The timeout does not cancel the mint. A key that arrives after it
        // never reaches the CLI: revoke it, so no orphan key stays live.
        (late) => {
          revokeAccountToken(late.token_id).catch(() => {});
        },
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
          throw new Error(callbackTimeoutMessage(new URL(callback).host));
        }
        throw new Error(callbackUnreachableMessage(new URL(callback).host, (err as Error).message));
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
      if (isNoWorkspaceError(err)) setNoWorkspace(true);
      setError((err as Error).message);
      setPhase('error');
    } finally {
      inFlightRef.current = false;
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

        {workspacePicker ? <div className="mt-5">{workspacePicker}</div> : null}

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
              className="hover:text-foreground -my-2 inline-block py-2 transition-colors"
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
 *  silent "Authorizing…" spinner if the network stalls. The promise still
 *  runs: `onLate` gets a value that resolves after the timeout. */
function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  message: string,
  onLate?: (value: T) => void,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let timedOut = false;
    const t = setTimeout(() => {
      timedOut = true;
      reject(new Error(message));
    }, ms);
    p.then(
      (v) => {
        clearTimeout(t);
        if (timedOut) onLate?.(v);
        else resolve(v);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });
}
