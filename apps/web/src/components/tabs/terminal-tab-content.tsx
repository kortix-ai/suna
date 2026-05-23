'use client';

import { useTranslations } from 'next-intl';

import React, { useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { CircleDashed, Plus, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useServerStore } from '@/stores/server-store';
import { useOpenCodePtyList, useCreatePty, useRemovePty } from '@/hooks/opencode/use-opencode-pty';
import { useTabStore, openTabAndNavigate } from '@/stores/tab-store';

// Lazy-load terminal components to avoid SSR issues with xterm.js
const SSHTerminal = dynamic(
  () => import('@/components/session/ssh-terminal').then(mod => ({ default: mod.SSHTerminal })),
  { ssr: false }
);

const PtyTerminal = dynamic(
  () => import('@/components/session/pty-terminal').then(mod => ({ default: mod.PtyTerminal })),
  { ssr: false }
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
 *
 * For sandbox mode, renders SSHTerminal instead (shared across all terminal tabs).
 */
export function TerminalTabContent({ ptyId, tabId, hidden = false }: TerminalTabContentProps) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const currentSandboxId = useKortixComputerStore((s) => s.currentSandboxId);
  const serverUrl = useServerStore((s) => {
    const server = s.servers.find((srv) => srv.id === s.activeServerId);
    return server?.url ?? s.getActiveServerUrl();
  });

  const { data: ptys, isLoading, refetch } = useOpenCodePtyList();
  const removePty = useRemovePty();
  const createPty = useCreatePty();

  // Find the PTY object for this tab
  const pty = ptys?.find((p) => p.id === ptyId) ?? null;

  // Track whether we've ever seen this PTY in the list.
  // Prevents auto-closing the tab before the list has had a chance to include
  // the newly created PTY (race between POST /pty and GET /pty).
  const hasSeenPty = useRef(false);
  if (pty) hasSeenPty.current = true;

  // If PTY isn't in the list yet (just created), trigger a refetch.
  useEffect(() => {
    if (!pty && !hasSeenPty.current && !isLoading) {
      refetch();
    }
  }, [pty, isLoading, refetch]);

  // If PTY disappears (killed externally), close the tab — but only if we
  // previously saw it in the list (avoids race on initial mount).
  useEffect(() => {
    if (!isLoading && ptys && !pty && hasSeenPty.current) {
      useTabStore.getState().closeTab(tabId);
    }
  }, [isLoading, ptys, pty, tabId]);

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

  // Replace this dead terminal tab with a fresh one
  const handleNewTerminal = useCallback(async () => {
    try {
      // Close this dead tab first
      useTabStore.getState().closeTab(tabId);
      // Create a new PTY and open it
      const newPty = await createPty.mutateAsync({
        env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
      });
      openTabAndNavigate({
        id: `terminal:${newPty.id}`,
        title: newPty.title || newPty.command || 'Terminal',
        type: 'terminal',
        href: `/terminal/${newPty.id}`,
      });
    } catch {
      // Tab was already closed, nothing more to do
    }
  }, [tabId, createPty]);

  // Sandbox mode — shared SSH terminal
  if (currentSandboxId) {
    return (
      <div className="h-full w-full bg-background">
        <SSHTerminal sandboxId={currentSandboxId} className="h-full" />
      </div>
    );
  }

  // Loading — also treat "never seen this PTY yet" as loading to handle the
  // race between tab navigation and the PTY list refetch after creation.
  if (isLoading || (!pty && !hasSeenPty.current)) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-background">
        <CircleDashed className="h-4 w-4 text-muted-foreground animate-spin" />
        <span className="text-xs text-muted-foreground mt-2">Connecting...</span>
      </div>
    );
  }

  // PTY not found — show prompt to open a new terminal
  if (!pty) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-background gap-3">
        <Terminal className="h-8 w-8 text-muted-foreground/30" />
        <span className="text-xs text-muted-foreground">{tHardcodedUi.raw('componentsTabsTerminalTabContent.line135JsxTextTerminalSessionEnded')}</span>
        <Button
          variant="outline"
          size="sm"
          onClick={handleNewTerminal}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />{tHardcodedUi.raw('componentsTabsTerminalTabContent.line143JsxTextNewTerminal')}</Button>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative bg-background">
      <PtyTerminal
        pty={pty}
        serverUrl={serverUrl}
        hidden={hidden}
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
