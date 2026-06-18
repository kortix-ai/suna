'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { CircleDashed, Plus, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useKortixComputerStore } from '@/stores/kortix-computer-store';
import { useServerStore } from '@/stores/server-store';
import {
  useOpenCodePtyList,
  useCreatePty,
  type Pty,
} from '@/hooks/opencode/use-opencode-pty';
import { useOpenCodeRuntimeReady } from '@/hooks/opencode/use-opencode-sessions';
import { useSessionBrowserStore } from '@/stores/session-browser-store';

// Lazy-load terminal components to avoid SSR issues with xterm.js
const SSHTerminal = dynamic(
  () => import('@/features/session/ssh-terminal').then((mod) => ({ default: mod.SSHTerminal })),
  { ssr: false },
);

const PtyTerminal = dynamic(
  () => import('@/features/session/pty-terminal').then((mod) => ({ default: mod.PtyTerminal })),
  { ssr: false },
);

const PTY_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as const;

/**
 * Live terminal for the session side panel.
 *
 * Reuses the exact terminal components the tabbed terminal uses:
 *   - sandbox mode → a single shared {@link SSHTerminal} into the sandbox
 *   - opencode mode → a {@link PtyTerminal} bound to a PTY on the active server
 *
 * Unlike the tabbed terminal (which maps 1 tab ↔ 1 PTY), the panel keeps a
 * single ambient shell per chat session: it reuses only its remembered PTY and
 * lazily spawns one otherwise. The PTY is intentionally NOT killed when the
 * panel closes — switching back to it should land you in the same shell.
 */
export function SessionTerminalPanel({
  sessionId,
  hidden,
}: {
  sessionId: string;
  hidden?: boolean;
}) {
  const currentSandboxId = useKortixComputerStore((s) => s.currentSandboxId);
  const serverUrl = useServerStore((s) => {
    const server = s.servers.find((srv) => srv.id === s.activeServerId);
    return server?.url ?? s.getActiveServerUrl();
  });

  // The opencode runtime (in-sandbox daemon + opencode server) must be booted
  // and healthy before any /pty REST call will resolve — otherwise the proxy
  // 404s against a sandbox whose daemon isn't up yet. Every opencode hook gates
  // on this same signal; the PTY list query does too (so it stays disabled, and
  // `isLoading` reads false, until ready). We mirror it here so the lazy create
  // effect below doesn't fire a doomed POST during boot.
  const runtimeReady = useOpenCodeRuntimeReady();

  const { data: ptys, isLoading } = useOpenCodePtyList();
  const createPty = useCreatePty();
  const terminalPtyId = useSessionBrowserStore((s) => s.terminalPtyBySession[sessionId] ?? null);
  const setTerminalPty = useSessionBrowserStore((s) => s.setTerminalPty);
  const [optimisticPty, setOptimisticPty] = React.useState<Pty | null>(null);

  const listedPty = terminalPtyId && ptys ? ptys.find((item) => item.id === terminalPtyId) ?? null : null;
  const pty = listedPty ?? (optimisticPty?.id === terminalPtyId ? optimisticPty : null);

  // Lazily spawn a shell the first time the panel has no PTY to show.
  // Guarded by a ref so a slow create + list refetch can't fan out into
  // multiple shells.
  const ensuringRef = useRef(false);
  const ensurePty = useCallback(() => {
    if (ensuringRef.current) return;
    ensuringRef.current = true;
    createPty.mutateAsync({
      title: 'Session terminal',
      env: { ...PTY_ENV },
    }).then((created) => {
      setOptimisticPty(created);
      setTerminalPty(sessionId, created.id);
    }).catch(() => {
      ensuringRef.current = false;
    });
  }, [createPty, sessionId, setTerminalPty]);

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
    if (currentSandboxId) return; // sandbox mode uses SSHTerminal, no PTY needed
    if (!runtimeReady) return; // wait for the sandbox runtime — a create now would 404
    if (isLoading) return;
    if (pty) {
      ensuringRef.current = false;
      return;
    }
    if (terminalPtyId) return; // Wait for the missing-id cleanup effect above.
    ensurePty();
  }, [currentSandboxId, runtimeReady, isLoading, pty, terminalPtyId, ensurePty]);

  // Sandbox mode — shared SSH terminal into the sandbox.
  if (currentSandboxId) {
    return (
      <div className="h-full w-full bg-[#0f0f14]">
        <SSHTerminal sandboxId={currentSandboxId} className="h-full" />
      </div>
    );
  }

  // Waiting for the sandbox runtime, or spinning up / loading the PTY list.
  if (!runtimeReady || isLoading || (!pty && (createPty.isPending || ensuringRef.current))) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-[#0f0f14]">
        <CircleDashed className="h-4 w-4 text-muted-foreground animate-spin" />
        <span className="text-xs text-muted-foreground mt-2">Connecting…</span>
      </div>
    );
  }

  // No PTY and not (re)spawning — offer to start one.
  if (!pty) {
    return (
      <div className="h-full w-full flex flex-col items-center justify-center bg-[#0f0f14] gap-3">
        <Terminal className="h-8 w-8 text-muted-foreground/30" />
        <Button
          variant="outline"
          size="sm"
          onClick={ensurePty}
          className="gap-1.5"
        >
          <Plus className="h-3.5 w-3.5" />
          New terminal
        </Button>
      </div>
    );
  }

  return (
    <div className="h-full w-full relative bg-[#0f0f14]">
      <PtyTerminal
        pty={pty}
        serverUrl={serverUrl}
        hidden={hidden}
        className="absolute inset-0 h-full w-full"
      />
    </div>
  );
}
