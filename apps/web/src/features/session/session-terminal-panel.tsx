'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { ErrorState } from '@/features/layout/section/error-state';
import {
  PTY_WAKE_DEADLINE_MS,
  deriveTerminalPanelState,
  shouldAutoReplaceTerminal,
  shouldRequestSessionWake,
} from '@/features/session/pty-connection';
import { SessionTerminalConnectBar } from '@/features/session/session-terminal-connect-bar';
import { useBoundedRuntimeWait } from '@/features/session/use-bounded-runtime-wait';
import { useTranslations } from '@/i18n/use-translations';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { isSandboxNotReadyError, startProjectSession } from '@kortix/sdk';
import {
  requestRuntimeReconnect,
  useCreatePty,
  useRuntimePtyList,
  useRuntimeStore,
  type Pty,
} from '@kortix/sdk/react';
import { PlusIcon as Plus, TerminalWindowIcon as Terminal } from '@phosphor-icons/react';
import dynamic from 'next/dynamic';
import React, { useCallback, useEffect, useRef } from 'react';

// Lazy-load to avoid SSR issues with xterm.js
const PtyTerminal = dynamic(
  () => import('@/features/session/pty-terminal').then((mod) => ({ default: mod.PtyTerminal })),
  { ssr: false },
);

const PTY_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as const;
const SERVER_URL_WAIT_MS = 15_000;
// How often to retry PTY list/create while the sandbox reports a readiness
// 503 (parked or booting box). The control plane answers without dialling
// the box, so the poll is cheap.
const SANDBOX_WAKING_RETRY_INTERVAL_MS = 3_000;

/**
 * Live terminal for the session side panel — a {@link PtyTerminal} bound to
 * a PTY on the active server.
 *
 * Unlike the tabbed terminal (which maps 1 tab ↔ 1 PTY), the panel keeps a
 * single ambient shell per chat session: it reuses only its remembered PTY and
 * lazily spawns one otherwise. The PTY is intentionally NOT killed when the
 * panel closes — switching back to it should land you in the same shell.
 */
export function SessionTerminalPanel({
  sessionId,
  projectId,
  projectSessionId,
  hidden,
}: {
  sessionId: string;
  /** With `projectSessionId`, lets a visible panel wake a parked sandbox. */
  projectId?: string;
  projectSessionId?: string;
  hidden?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const serverUrl = useRuntimeStore((s) => s.getActiveServerUrl());

  // The terminal belongs to the sandbox daemon. It does not depend on OpenCode
  // health. Bind every PTY operation to this session's explicit runtime URL.
  const {
    data: ptys,
    isLoading,
    isError: isListError,
    error: listError,
    failureReason: listFailureReason,
    refetch: refetchPtys,
  } = useRuntimePtyList({ serverUrl, enabled: !!serverUrl });
  // Failures surface in the pane (retry button / reconnect flow) — keep them
  // out of the app-global "Failed to perform action" toast.
  const createPty = useCreatePty({ serverUrl, onError: () => {} });
  const terminalPtyId = useSessionBrowserStore((s) => s.terminalPtyBySession[sessionId] ?? null);
  const setTerminalPty = useSessionBrowserStore((s) => s.setTerminalPty);
  const [optimisticPty, setOptimisticPty] = React.useState<Pty | null>(null);
  const [serverWaitExpired, setServerWaitExpired] = React.useState(false);
  const [serverRetryAttempt, setServerRetryAttempt] = React.useState(0);

  const listedPty =
    terminalPtyId && ptys ? (ptys.find((item) => item.id === terminalPtyId) ?? null) : null;
  const pty = listedPty ?? (optimisticPty?.id === terminalPtyId ? optimisticPty : null);

  // Lazily spawn a shell the first time the panel has no PTY to show.
  // Guarded by a ref so a slow create + list refetch can't fan out into
  // multiple shells.
  const ensuringRef = useRef(false);
  /** `/start` was already requested for the current waking episode. */
  const wakeRequestedRef = useRef(false);
  const ensurePty = useCallback(() => {
    if (!serverUrl || hidden || ensuringRef.current) return;
    ensuringRef.current = true;
    createPty
      .mutateAsync({
        title: tI18nHardcoded.raw('i18nComplete.textf63857b7ed7e'),
        env: { ...PTY_ENV },
      })
      .then((created) => {
        setOptimisticPty(created);
        setTerminalPty(sessionId, created.id);
      })
      .catch(() => {
        ensuringRef.current = false;
      });
  }, [createPty, hidden, serverUrl, sessionId, setTerminalPty, tI18nHardcoded]);

  useEffect(() => {
    if (serverUrl) {
      setServerWaitExpired(false);
      return;
    }
    setServerWaitExpired(false);
    const timeout = window.setTimeout(() => setServerWaitExpired(true), SERVER_URL_WAIT_MS);
    return () => window.clearTimeout(timeout);
  }, [serverRetryAttempt, serverUrl]);

  // 'pty not found' → PtyTerminal classifies the close as 'replace' and calls
  // this. The registry is process-local: after a daemon restart the remembered
  // id can never reconnect — drop it so the lazy-create effect below mints a
  // fresh shell. Capped so a broken runtime can't spawn terminals forever.
  const replacementAttemptRef = useRef(0);
  const handleUnavailable = useCallback(() => {
    if (!shouldAutoReplaceTerminal(replacementAttemptRef.current)) return;
    replacementAttemptRef.current += 1;
    ensuringRef.current = false;
    setOptimisticPty(null);
    setTerminalPty(sessionId, null);
  }, [sessionId, setTerminalPty]);

  useEffect(() => {
    if (listedPty && optimisticPty?.id === listedPty.id) {
      setOptimisticPty(null);
    }
  }, [listedPty, optimisticPty?.id]);

  useEffect(() => {
    if (!terminalPtyId || isLoading || !ptys || pty || optimisticPty?.id === terminalPtyId) return;
    setTerminalPty(sessionId, null);
  }, [isLoading, optimisticPty?.id, pty, ptys, sessionId, setTerminalPty, terminalPtyId]);

  useEffect(() => {
    if (!serverUrl || hidden || isListError || createPty.isError) return;
    if (isLoading) return;
    if (pty) {
      ensuringRef.current = false;
      // The shell is up: the next park is a new waking episode.
      wakeRequestedRef.current = false;
      return;
    }
    if (terminalPtyId) return; // Wait for missing-id cleanup after a successful list.
    ensurePty();
  }, [createPty.isError, ensurePty, hidden, isListError, isLoading, pty, serverUrl, terminalPtyId]);

  const retryTerminal = useCallback(() => {
    ensuringRef.current = false;
    createPty.reset();
    setServerRetryAttempt((attempt) => attempt + 1);
    if (!serverUrl) {
      requestRuntimeReconnect();
      return;
    }
    if (isListError) {
      void refetchPtys();
      return;
    }
    ensurePty();
  }, [createPty, ensurePty, isListError, refetchPtys, serverUrl]);

  // A parked/booting sandbox answers PTY list/create with a readiness 503 —
  // a pending state, never a terminal error. Keep the connecting spinner and
  // retry on an interval until the box is up.
  const sandboxWaking =
    (isListError && isSandboxNotReadyError(listError)) ||
    (createPty.isError && isSandboxNotReadyError(createPty.error));
  const terminalWaitExpired = useBoundedRuntimeWait(
    !pty && (!serverUrl || isLoading || createPty.isPending || sandboxWaking),
    serverRetryAttempt,
    PTY_WAKE_DEADLINE_MS,
  );

  const retryTerminalRef = useRef<() => void>(() => {});
  const pollEpochRef = useRef(0);
  useEffect(
    () => () => {
      pollEpochRef.current += 1;
    },
    [hidden, serverUrl],
  );
  useEffect(() => {
    retryTerminalRef.current = () => {
      const epoch = pollEpochRef.current;
      // Polls retain the deadline. Only the user's Retry starts a new attempt.
      // Read first so an existing shell can be reused once the sandbox wakes.
      void refetchPtys().then((result) => {
        if (epoch !== pollEpochRef.current || createPty.isPending) return;
        if (!result.isError) {
          createPty.reset();
        }
      });
    };
  }, [createPty, refetchPtys]);

  // Nothing in the list → create → attach chain can wake a parked box: the PTY
  // list GET never wakes by policy, and the `wake=1` attach needs a PTY first.
  // Reproduced: a panel opened on a parked box after a page load polled a 503
  // for 248 s and never connected. A visible panel is a person waiting for a
  // shell, so it asks the session to start, once per waking episode.
  const [wakeStartedAt, setWakeStartedAt] = React.useState<number | null>(null);
  const [wakeFailedAt, setWakeFailedAt] = React.useState<number | null>(null);
  // React Query retries the list 3 times (~7 s of backoff) before `isError`
  // flips. The first failed attempt already says why, so the wake starts then.
  const listNotReady = sandboxWaking || isSandboxNotReadyError(listFailureReason);
  useEffect(() => {
    if (!projectId || !projectSessionId) return;
    if (
      !shouldRequestSessionWake({
        sandboxWaking: listNotReady,
        visible: !hidden,
        canStart: true,
        alreadyRequested: wakeRequestedRef.current,
      })
    ) {
      return;
    }
    wakeRequestedRef.current = true;
    const startedAt = Date.now();
    setWakeStartedAt(startedAt);
    startProjectSession(projectId, projectSessionId).catch((err) => {
      // Only a terminal start failure throws (a missing session, a failed
      // boot). It will never become a shell, so stop waiting and offer Retry.
      console.warn('[SessionTerminalPanel] session start failed', err);
      setWakeFailedAt(startedAt);
    });
    // `serverRetryAttempt` re-runs this after a manual Retry clears the flag.
  }, [hidden, listNotReady, projectId, projectSessionId, serverRetryAttempt]);
  useEffect(() => {
    if (wakeStartedAt === null || pty) return;
    const timeout = window.setTimeout(
      () => setWakeFailedAt(wakeStartedAt),
      Math.max(0, wakeStartedAt + PTY_WAKE_DEADLINE_MS - Date.now()),
    );
    return () => window.clearTimeout(timeout);
  }, [pty, wakeStartedAt]);
  const wakeTimedOut = !pty && wakeStartedAt !== null && wakeFailedAt === wakeStartedAt;

  useEffect(() => {
    if (!sandboxWaking || hidden || terminalWaitExpired || wakeTimedOut) return;
    const interval = window.setInterval(
      () => retryTerminalRef.current(),
      SANDBOX_WAKING_RETRY_INTERVAL_MS,
    );
    return () => window.clearInterval(interval);
  }, [hidden, sandboxWaking, terminalWaitExpired, wakeTimedOut]);

  const retryAfterFailure = useCallback(() => {
    wakeRequestedRef.current = false;
    setWakeStartedAt(null);
    retryTerminal();
  }, [retryTerminal]);

  const panelState = deriveTerminalPanelState({
    hasServerUrl: !!serverUrl,
    serverWaitExpired,
    hasPty: !!pty,
    isListLoading: isLoading,
    isListError,
    isCreatePending: createPty.isPending,
    isCreateError: createPty.isError,
    isEnsuring: ensuringRef.current,
    isSandboxWaking: sandboxWaking,
    connectionWaitExpired: terminalWaitExpired || wakeTimedOut,
  });

  let content: React.ReactNode;
  if (panelState === 'connecting') {
    content = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center">
        <Loading className="text-muted-foreground size-4" />
        <span className="text-muted-foreground text-xs">
          {listNotReady
            ? tI18nHardcoded.raw('i18nComplete.text5e3de76869f3')
            : tI18nHardcoded.raw(
                'autoFeaturesSessionSessionTerminalPanelJsxTextConnecting80303e70',
              )}
        </span>
      </div>
    );
  } else if (panelState === 'error') {
    content = (
      <ErrorState
        size="sm"
        title={tI18nHardcoded.raw('i18nComplete.text5c1fff90cce6')}
        description={tI18nHardcoded.raw('i18nComplete.texta06dbdcd0f3d')}
        action={
          <Button variant="outline" size="sm" onClick={retryAfterFailure}>
            {tI18nHardcoded.raw('i18nComplete.text942087cc2d41')}
          </Button>
        }
        className="h-full"
      />
    );
  } else if (panelState === 'empty') {
    content = (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3">
        <Terminal className="text-muted-foreground/30 size-8" />
        <Button variant="outline" size="sm" onClick={ensurePty} className="gap-1.5">
          <Plus className="size-3.5" />
          {tI18nHardcoded.raw('autoFeaturesSessionSessionTerminalPanelJsxTextNewTerminaleeb6bbb9')}
        </Button>
      </div>
    );
  } else if (pty) {
    content = (
      <PtyTerminal
        pty={pty}
        serverUrl={serverUrl}
        hidden={hidden}
        onUnavailable={handleUnavailable}
        className="absolute inset-0 h-full w-full"
      />
    );
  } else {
    content = null;
  }

  return (
    <div className="bg-background flex h-full w-full flex-col">
      {projectSessionId && <SessionTerminalConnectBar projectSessionId={projectSessionId} />}
      <div className="relative min-h-0 flex-1">{content}</div>
    </div>
  );
}
