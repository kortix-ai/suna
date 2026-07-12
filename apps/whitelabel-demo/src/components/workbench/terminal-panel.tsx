'use client';

/**
 * The session terminal — real PTYs in the session's sandbox over the SDK's
 * Kortix-native PTY surface (`useOpenCodePtyList`/`useCreatePty`/`useRemovePty`
 * + `getPtyWebSocketUrl`). Data flows as raw strings over one WebSocket per
 * terminal; resize goes through REST (`useUpdatePty`), matching the daemon
 * contract. In wrapper mode the SDK's socket URL points at our `/api/kortix`
 * proxy, which can't forward a WebSocket upgrade — `rewriteWsUrlToUpstream`
 * re-points it directly at the upstream with a short-lived project-scoped
 * token (the same trick the preview iframe uses).
 */

import { useWrapperMode } from '@/app/providers';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { rewriteWsUrlToUpstream } from '@/lib/preview';
import { getSessionToken } from '@/lib/session';
import { cn } from '@/lib/utils';
import {
  getPtyWebSocketUrl,
  useCreatePty,
  useOpenCodePtyList,
  useRemovePty,
  useUpdatePty,
  type Pty,
} from '@kortix/sdk/react';
import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useQuery } from '@tanstack/react-query';
import { Plus, TerminalSquare, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

function safeFit(fit: FitAddon | null, el: HTMLDivElement | null) {
  if (!fit || !el || el.offsetWidth === 0 || el.offsetHeight === 0) return;
  try {
    fit.fit();
  } catch {
    // xterm may not be fully initialized yet
  }
}

/** Strip capability-query echoes that replayed scrollback can surface as garbage. */
function sanitizeChunk(chunk: string): string {
  return (
    chunk
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI/OSC escape sequences is the point
      .replace(/\x1b]697;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI/OSC escape sequences is the point
      .replace(/\x1b\][0-9]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI/OSC escape sequences is the point
      .replace(/\x1b\]4;[0-9]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI/OSC escape sequences is the point
      .replace(/\x1b\[\??[0-9;]*\$y/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI/OSC escape sequences is the point
      .replace(/\x1b\[\d+;\d+R/g, '')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI/OSC escape sequences is the point
      .replace(/\x1b\[\?[0-9;]*c/g, '')
  );
}

/** xterm auto-answers to replayed capability queries — never real keystrokes. */
function isTerminalReport(data: string): boolean {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching ANSI/OSC escape sequences is the point
  return /^(?:\x1b\[\d+;\d+R|\x1b\[\??[0-9;]*\$y|\x1b\[\?[0-9;]*c|\x1b\][0-9;]+(?:;rgb:[0-9a-fA-F/]+)?(?:\x07|\x1b\\))+$/.test(
    data,
  );
}

export function TerminalPanel({ projectId }: { projectId: string }) {
  const wrapperMode = useWrapperMode();
  const ptys = useOpenCodePtyList();
  const create = useCreatePty();
  const remove = useRemovePty();
  const [activeId, setActiveId] = useState<string | null>(null);

  const list = ptys.data ?? [];
  const running = list.filter((p) => p.status === 'running');

  // Keep a valid selection; spawn the first terminal automatically so the tab
  // is never a dead end.
  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (running.length > 0) {
      if (!activeId || !running.some((p) => p.id === activeId)) setActiveId(running[0].id);
      return;
    }
    if (ptys.isSuccess && !autoCreatedRef.current && !create.isPending) {
      autoCreatedRef.current = true;
      create.mutate(undefined, {
        onSuccess: (pty) => setActiveId(pty.id),
        onError: () => toast.error('Could not open a terminal'),
      });
    }
  }, [running, activeId, ptys.isSuccess, create]);

  // Wrapper mode: mint the same project-scoped token the preview iframe uses,
  // so the PTY socket can bypass the (upgrade-incapable) BFF proxy.
  const previewToken = useQuery({
    queryKey: ['preview-token', projectId],
    queryFn: async () => {
      const sessionToken = getSessionToken();
      const res = await fetch(`/api/preview-token?projectId=${encodeURIComponent(projectId)}`, {
        headers: sessionToken ? { authorization: `Bearer ${sessionToken}` } : undefined,
      });
      if (!res.ok) throw new Error('Could not mint a preview token');
      return res.json() as Promise<{ token: string; upstream: string }>;
    },
    enabled: wrapperMode,
    staleTime: 5 * 60_000,
    retry: false,
  });

  if (ptys.isLoading) {
    return (
      <div className="flex h-full flex-col gap-3">
        <Skeleton className="h-8 w-56" />
        <Skeleton className="min-h-0 flex-1" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-2">
      <div className="flex shrink-0 items-center gap-1.5">
        <TerminalSquare className="size-4 shrink-0 text-muted-foreground" />
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto scrollbar-thin">
          {running.map((pty, i) => (
            <div
              key={pty.id}
              className={cn(
                'group flex shrink-0 items-center rounded-md border text-xs transition-colors',
                pty.id === activeId
                  ? 'border-border bg-secondary text-foreground'
                  : 'border-transparent text-muted-foreground hover:bg-secondary/60',
              )}
            >
              <button
                type="button"
                className="py-1.5 pl-2.5 pr-1"
                onClick={() => setActiveId(pty.id)}
              >
                {pty.title || `Terminal ${i + 1}`}
              </button>
              <button
                type="button"
                aria-label={`Close ${pty.title || `terminal ${i + 1}`}`}
                className="rounded-sm p-1 opacity-0 transition-opacity hover:bg-accent group-hover:opacity-100"
                onClick={() =>
                  remove.mutate(pty.id, {
                    onError: () => toast.error('Could not close the terminal'),
                  })
                }
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="size-7 shrink-0"
          aria-label="New terminal"
          disabled={create.isPending}
          onClick={() =>
            create.mutate(undefined, {
              onSuccess: (pty) => setActiveId(pty.id),
              onError: () => toast.error('Could not open a terminal'),
            })
          }
        >
          <Plus className="size-4" />
        </Button>
      </div>

      <div className="relative min-h-0 flex-1 overflow-hidden rounded-xl border border-border">
        {running.length === 0 ? (
          <div className="grid h-full place-items-center text-sm text-muted-foreground">
            {create.isPending ? 'Opening a terminal…' : 'No terminal running.'}
          </div>
        ) : (
          running.map((pty) => (
            <PtyView
              key={pty.id}
              pty={pty}
              hidden={pty.id !== activeId}
              directUpstream={
                wrapperMode && previewToken.data
                  ? { upstream: previewToken.data.upstream, token: previewToken.data.token }
                  : null
              }
            />
          ))
        )}
      </div>
    </div>
  );
}

function PtyView({
  pty,
  hidden,
  directUpstream,
}: {
  pty: Pty;
  hidden: boolean;
  directUpstream: { upstream: string; token: string } | null;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const disposedRef = useRef(false);
  const attemptsRef = useRef(0);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const suppressUntil = useRef(0);
  const update = useUpdatePty();
  const updateRef = useRef(update);
  updateRef.current = update;
  const directRef = useRef(directUpstream);
  directRef.current = directUpstream;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    disposedRef.current = false;

    // Resolve the theme from the app's own tokens so the terminal matches the
    // brand instead of hardcoding a palette (canvas needs concrete colors).
    const styles = getComputedStyle(host);
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, Menlo, Monaco, monospace',
      theme: {
        background: styles.backgroundColor || '#0a0a0a',
        foreground: styles.color || '#e5e5e5',
      },
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;

    term.onData((data) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      if (Date.now() < suppressUntil.current && isTerminalReport(data)) return;
      wsRef.current.send(data);
    });
    term.onResize(({ cols, rows }) => {
      updateRef.current.mutate({ id: pty.id, size: { rows, cols } });
    });

    const observer = new ResizeObserver(() => {
      requestAnimationFrame(() => safeFit(fitRef.current, host));
    });
    observer.observe(host);

    const scheduleReconnect = () => {
      if (disposedRef.current || reconnectTimer.current) return;
      attemptsRef.current += 1;
      const delay = Math.min(1000 * 2 ** (attemptsRef.current - 1), 15_000);
      term.writeln(`\r\n\x1b[33mReconnecting in ${Math.ceil(delay / 1000)}s…\x1b[0m`);
      reconnectTimer.current = setTimeout(() => {
        reconnectTimer.current = null;
        void connect();
      }, delay);
    };

    const connect = async () => {
      if (disposedRef.current) return;
      let wsUrl: string;
      try {
        wsUrl = await getPtyWebSocketUrl(pty.id);
        const direct = directRef.current;
        if (direct) {
          wsUrl = rewriteWsUrlToUpstream(wsUrl, direct.upstream, direct.token) ?? wsUrl;
        }
      } catch {
        scheduleReconnect();
        return;
      }
      if (disposedRef.current) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      ws.onopen = () => {
        attemptsRef.current = 0;
        suppressUntil.current = Date.now() + 1500;
        const { cols, rows } = term;
        if (cols && rows) updateRef.current.mutate({ id: pty.id, size: { rows, cols } });
      };
      ws.onmessage = (event) => {
        if (typeof event.data === 'string') term.write(sanitizeChunk(event.data));
        else if (event.data instanceof Blob)
          void event.data.text().then((text) => term.write(sanitizeChunk(text)));
      };
      ws.onclose = (event) => {
        if (disposedRef.current) return;
        wsRef.current = null;
        const idle = event.code === 1000 && /idle timeout/i.test(event.reason || '');
        if (idle || event.code !== 1000) scheduleReconnect();
        else term.writeln('\r\n\x1b[33mConnection closed.\x1b[0m');
      };
    };

    const initTimer = setTimeout(() => {
      safeFit(fit, host);
      void connect();
    }, 80);

    return () => {
      disposedRef.current = true;
      clearTimeout(initTimer);
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      observer.disconnect();
      wsRef.current?.close(1000);
      wsRef.current = null;
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pty.id]);

  useEffect(() => {
    if (!hidden) {
      requestAnimationFrame(() => {
        safeFit(fitRef.current, hostRef.current);
        termRef.current?.focus();
      });
    }
  }, [hidden]);

  return (
    <div
      ref={hostRef}
      className={cn('absolute inset-0 bg-card p-2', hidden && 'pointer-events-none invisible')}
    />
  );
}
