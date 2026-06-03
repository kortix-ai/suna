'use client';

import React, { useCallback, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import { CircleDashed, Plus, Terminal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useServerStore } from '@/stores/server-store';
import {
  useOpenCodePtyList,
  useCreatePty,
} from '@/hooks/opencode/use-opencode-pty';
import { useOpenCodeRuntimeReady } from '@/hooks/opencode/use-opencode-sessions';

const PtyTerminal = dynamic(
  () => import('@/components/session/pty-terminal').then((mod) => ({ default: mod.PtyTerminal })),
  { ssr: false },
);

const PTY_ENV = { TERM: 'xterm-256color', COLORTERM: 'truecolor' } as const;

/**
 * Live terminal for the session side panel.
 *
 * Reuses the PTY terminal component the tabbed terminal uses. Unlike the
 * tabbed terminal (which maps 1 tab ↔ 1 PTY), the panel keeps a
 * single ambient shell: it reuses the most recent PTY if one exists and lazily
 * spawns one otherwise. The PTY is intentionally NOT killed when the panel
 * closes — switching back to it should land you in the same shell.
 */
export function SessionTerminalPanel({ hidden }: { hidden?: boolean } = {}) {
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

  // Newest PTY first so a freshly-spawned shell wins.
  const pty = ptys && ptys.length > 0 ? ptys[ptys.length - 1] : null;

  // Lazily spawn a shell the first time the panel has no PTY to show.
  // Guarded by a ref so a slow create + list refetch can't fan out into
  // multiple shells.
  const ensuringRef = useRef(false);
  const ensurePty = useCallback(() => {
    if (ensuringRef.current) return;
    ensuringRef.current = true;
    createPty.mutateAsync({ env: { ...PTY_ENV } }).catch(() => {
      ensuringRef.current = false;
    });
  }, [createPty]);

  useEffect(() => {
    if (!runtimeReady) return; // wait for the sandbox runtime — a create now would 404
    if (isLoading) return;
    if (pty) {
      ensuringRef.current = false;
      return;
    }
    ensurePty();
  }, [runtimeReady, isLoading, pty, ensurePty]);

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
