'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { ErrorState } from '@/features/layout/section/error-state';
import { SessionTerminalConnectBar } from '@/features/session/session-terminal-connect-bar';
import {
  deriveTerminalPanelState,
  shouldAutoReplaceTerminal,
} from '@/features/session/pty-connection';
import { useCreatePty, useRuntimePtyList, type Pty } from '@/hooks/runtime/use-runtime-pty';
import { useServerStore } from '@/stores/server-store';
import { useSessionBrowserStore } from '@/stores/session-browser-store';
import { requestRuntimeReconnect } from '@kortix/sdk/sandbox-connection-store';
import { Plus, Terminal } from 'lucide-react';
import { useTranslations } from 'next-intl';
import dynamic from 'next/dynamic';
import React, { useCallback, useEffect, useRef } from 'react';

// Lazy-load to avoid SSR issues with xterm.js
const PtyTerminal = dynamic(
  () => import('@/features/session/pty-terminal').then((mod) => ({ default: mod.PtyTerminal })),
  { ssr: false },
);

const PTY_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as const;
const SERVER_URL_WAIT_MS = 15_000;

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
  projectSessionId,
  hidden,
}: {
  sessionId: string;
  projectSessionId?: string;
  hidden?: boolean;
}) {
  const tI18nHardcoded = useTranslations('hardcodedUi');
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());

  // The terminal belongs to the sandbox daemon. It does not depend on the ACP harness
  // health. Bind every PTY operation to this session's explicit runtime URL.
  const {
    data: ptys,
    isLoading,
    isError: isListError,
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
  const ensurePty = useCallback(() => {
    if (!serverUrl || ensuringRef.current) return;
    ensuringRef.current = true;
    createPty
      .mutateAsync({
        title: 'Session terminal',
        env: { ...PTY_ENV },
      })
      .then((created) => {
        setOptimisticPty(created);
        setTerminalPty(sessionId, created.id);
      })
      .catch(() => {
        ensuringRef.current = false;
      });
  }, [createPty, serverUrl, sessionId, setTerminalPty]);

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
    if (!serverUrl || isListError || createPty.isError) return;
    if (isLoading) return;
    if (pty) {
      ensuringRef.current = false;
      return;
    }
    if (terminalPtyId) return; // Wait for the missing-id cleanup effect above.
    ensurePty();
  }, [createPty.isError, ensurePty, isListError, isLoading, pty, serverUrl, terminalPtyId]);

  const retryTerminal = useCallback(() => {
    ensuringRef.current = false;
    createPty.reset();
    if (!serverUrl) {
      requestRuntimeReconnect();
      setServerRetryAttempt((attempt) => attempt + 1);
      return;
    }
    if (isListError) {
      void refetchPtys();
      return;
    }
    ensurePty();
  }, [createPty, ensurePty, isListError, refetchPtys, serverUrl]);

  const panelState = deriveTerminalPanelState({
    hasServerUrl: !!serverUrl,
    serverWaitExpired,
    hasPty: !!pty,
    isListLoading: isLoading,
    isListError,
    isCreatePending: createPty.isPending,
    isCreateError: createPty.isError,
    isEnsuring: ensuringRef.current,
  });

  let content: React.ReactNode;
  if (panelState === 'connecting') {
    content = (
      <div className="flex h-full w-full flex-col items-center justify-center">
        <Loading className="text-muted-foreground size-4" />
        <span className="text-muted-foreground mt-2 text-xs">
          {tI18nHardcoded.raw('autoFeaturesSessionSessionTerminalPanelJsxTextConnecting80303e70')}
        </span>
      </div>
    );
  } else if (panelState === 'error') {
    content = (
      <ErrorState
        size="sm"
        title="Terminal connection failed"
        description="The terminal service did not respond. Retry the connection."
        action={
          <Button variant="outline" size="sm" onClick={retryTerminal}>
            Retry
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
    <div className="flex h-full w-full flex-col bg-black">
      {projectSessionId && <SessionTerminalConnectBar projectSessionId={projectSessionId} />}
      <div className="relative min-h-0 flex-1">{content}</div>
    </div>
  );
}
