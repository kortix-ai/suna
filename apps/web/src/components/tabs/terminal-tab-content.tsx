'use client';

import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { useCreatePty, useOpenCodePtyList, useRemovePty } from '@/hooks/opencode/use-opencode-pty';
import { useOpenCodeRuntimeReady } from '@/hooks/opencode/use-opencode-sessions';
import { shouldAutoReplaceTerminal } from '@/features/session/pty-connection';
import { useServerStore } from '@/stores/server-store';
import { openTabAndNavigate, useTabStore } from '@/stores/tab-store';
import { Plus, Terminal } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';

// Lazy-load to avoid SSR issues with xterm.js
const PtyTerminal = dynamic(
  () => import('@/features/session/pty-terminal').then((mod) => ({ default: mod.PtyTerminal })),
  { ssr: false },
);

interface TerminalTabContentProps {
  /** The PTY ID this tab is bound to (extracted from tab id "terminal:<ptyId>") */
  ptyId: string;
  /** The tab ID for cleanup on close */
  tabId: string;
  /** Whether this tab is currently visible (for xterm resize/focus) */
  hidden?: boolean;
}

/**
 * Terminal tab content — renders a single PtyTerminal for one PTY session.
 * Each terminal tab maps 1:1 to a PTY process.
 */
export function TerminalTabContent({ ptyId, tabId, hidden = false }: TerminalTabContentProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const serverUrl = useServerStore((s) => s.getActiveServerUrl());
  const runtimeReady = useOpenCodeRuntimeReady();

  const { data: ptys, isLoading, refetch } = useOpenCodePtyList({ serverUrl });
  const removePty = useRemovePty();
  const createPty = useCreatePty();
  const replacementAttempt = useTabStore((state) => {
    const value = state.tabs[tabId]?.metadata?.terminalReplacementAttempt;
    return typeof value === 'number' ? value : 0;
  });
  const [initialLookupComplete, setInitialLookupComplete] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const replacingRef = useRef(false);

  // Find the PTY object for this tab
  const pty = ptys?.find((p) => p.id === ptyId) ?? null;

  // A newly created PTY can race a stale Infinity-cached list. Force one lookup
  // for this ID, then settle into the recoverable ended state instead of an
  // infinite "Connecting" spinner when the daemon restarted and forgot it.
  useEffect(() => {
    setInitialLookupComplete(false);
    setUnavailable(false);
    setIsReplacing(false);
    replacingRef.current = false;
  }, [ptyId]);

  useEffect(() => {
    if (!runtimeReady || isLoading || initialLookupComplete) return;
    if (pty) {
      setInitialLookupComplete(true);
      return;
    }
    void refetch().finally(() => setInitialLookupComplete(true));
  }, [initialLookupComplete, isLoading, pty, refetch, runtimeReady]);

  // Kill PTY on the server when the tab is ACTUALLY closed (removed from store).
  // We guard the cleanup by checking whether the tab still exists — this
  // prevents React Strict Mode double-mounts, Suspense re-suspensions, or
  // any other transient unmount from prematurely killing the PTY process.
  useEffect(() => {
    const id = ptyId;
    const tid = tabId;
    return () => {
      // Only kill the PTY if the tab was truly removed from the store.
      const tabStillExists = !!useTabStore.getState().tabs[tid];
      if (!tabStillExists) {
        removePty.mutateAsync(id).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ptyId]);

  // Create the replacement before closing the old tab. If creation fails, the
  // recoverable state stays visible instead of throwing the user back to an
  // unrelated tab with no way to retry.
  const replaceTerminal = useCallback(async (automatic: boolean) => {
    try {
      const newPty = await createPty.mutateAsync({
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      openTabAndNavigate({
        id: `terminal:${newPty.id}`,
        title: newPty.title || newPty.command || 'Terminal',
        type: 'terminal',
        href: `/terminal/${newPty.id}`,
        metadata: {
          terminalReplacementAttempt: automatic ? replacementAttempt + 1 : 0,
        },
      });
      useTabStore.getState().closeTab(tabId);
    } catch {
      replacingRef.current = false;
      setIsReplacing(false);
      setUnavailable(true);
    }
  }, [createPty, replacementAttempt, tabId]);

  const handleNewTerminal = useCallback(() => {
    replacingRef.current = true;
    setIsReplacing(true);
    setUnavailable(false);
    void replaceTerminal(false);
  }, [replaceTerminal]);

  const handleUnavailable = useCallback(() => {
    setUnavailable(true);
    if (replacingRef.current || !shouldAutoReplaceTerminal(replacementAttempt)) return;
    replacingRef.current = true;
    setIsReplacing(true);
    void replaceTerminal(true);
  }, [replaceTerminal, replacementAttempt]);

  // Loading — also treat "never seen this PTY yet" as loading to handle the
  // race between tab navigation and the PTY list refetch after creation.
  if (!runtimeReady || isLoading || !initialLookupComplete || isReplacing) {
    return (
      <div className="bg-background flex h-full w-full flex-col items-center justify-center">
        <Loading className="size-4 shrink-0" />
        <span className="text-muted-foreground mt-2 text-xs">Connecting...</span>
      </div>
    );
  }

  // Missing, exited, or failed-to-attach PTY — never leave a stale tab spinning.
  if (!pty || pty.status === 'exited' || unavailable) {
    return (
      <div className="bg-background flex h-full w-full flex-col items-center justify-center gap-3">
        <Terminal className="text-muted-foreground/30 h-8 w-8" />
        <span className="text-muted-foreground text-xs">
          {tHardcodedUi.raw('componentsTabsTerminalTabContent.line135JsxTextTerminalSessionEnded')}
        </span>
        <Button variant="outline" size="sm" onClick={handleNewTerminal} className="gap-1.5">
          <Plus className="h-3.5 w-3.5" />
          {tHardcodedUi.raw('componentsTabsTerminalTabContent.line143JsxTextNewTerminal')}
        </Button>
      </div>
    );
  }

  return (
    <div className="bg-background relative h-full w-full">
      <PtyTerminal
        pty={pty}
        serverUrl={serverUrl}
        hidden={hidden}
        onUnavailable={handleUnavailable}
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
