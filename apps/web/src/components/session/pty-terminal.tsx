'use client';

import { useRef, useEffect, useCallback, useImperativeHandle, forwardRef } from 'react';
import { cn } from '@/lib/utils';
import { Terminal as XTerm, ITheme } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { getPtyWebSocketUrl, useUpdatePty } from '@/hooks/opencode/use-opencode-pty';
import type { Pty } from '@opencode-ai/sdk/v2/client';

// ============================================================================
// Theme
// ============================================================================

const terminalTheme: ITheme = {
  background: '#0f0f14',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  cursorAccent: '#0f0f14',
  selectionBackground: 'rgba(139, 92, 246, 0.3)',
  black: '#27272a',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e4e4e7',
  brightBlack: '#52525b',
  brightRed: '#fca5a5',
  brightGreen: '#86efac',
  brightYellow: '#fde047',
  brightBlue: '#93c5fd',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#fafafa',
};

// ============================================================================
// Types
// ============================================================================

type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface PtyTerminalHandle {
  focus: () => void;
  kill: () => void;
}

interface PtyTerminalProps {
  pty: Pty;
  className?: string;
  hidden?: boolean;
  /** Server URL to connect to — locks the WS to this server even after instance switch. */
  serverUrl?: string;
  onStatusChange?: (status: ConnectionStatus) => void;
}

// ============================================================================
// Helpers
// ============================================================================

/** Safely call fitAddon.fit() only when the container has real dimensions. */
function safeFit(fitAddon: FitAddon | null, container: HTMLDivElement | null) {
  if (!fitAddon || !container) return;
  const { offsetWidth, offsetHeight } = container;
  if (offsetWidth > 0 && offsetHeight > 0) {
    try {
      fitAddon.fit();
    } catch {
      // Ignore – xterm may not be fully initialised yet
    }
  }
}

function sanitizeTerminalChunk(chunk: string): string {
  return chunk
    // Cursor shell integration sometimes emits OSC 697 payloads.
    // If an upstream proxy strips control bytes, only JSON remains visible.
    .replace(/\x1b]697;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\{"cursor":\d+\}/g, '')
    // Terminal capability-query *responses* that occasionally get echoed back
    // into the output stream (e.g. when a prior client answered a query at an
    // idle prompt): OSC color reports, DECRQM mode status, cursor-position and
    // device-attribute reports. They render as garbage like
    // `10;rgb:..`, `2004;2$y`, `R` — strip them so they never show.
    .replace(/\x1b\][0-9]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\]4;[0-9]+;rgb:[0-9a-fA-F/]+(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[\??[0-9;]*\$y/g, '')
    .replace(/\x1b\[\d+;\d+R/g, '')
    .replace(/\x1b\[\?[0-9;]*c/g, '');
}

// Responses xterm auto-generates when something queries terminal capabilities:
// cursor-position (CPR), mode status (DECRQM `$y`), device attributes (DA), and
// OSC color reports. When the server replays the PTY scrollback on connect, the
// queries embedded in it make xterm emit these — and at an idle shell prompt the
// shell echoes them straight back as visible garbage. We drop them during the
// brief post-connect replay window (real keystrokes are never reports).
function isTerminalReport(data: string): boolean {
  return /^(?:\x1b\[\d+;\d+R|\x1b\[\??[0-9;]*\$y|\x1b\[\?[0-9;]*c|\x1b\][0-9;]+(?:;rgb:[0-9a-fA-F/]+)?(?:\x07|\x1b\\))+$/.test(
    data,
  );
}

// ============================================================================
// Component
// ============================================================================

let globalPtyConnectionId = 0;

export const PtyTerminal = forwardRef<PtyTerminalHandle, PtyTerminalProps>(function PtyTerminal({
  pty,
  className,
  hidden,
  serverUrl,
  onStatusChange,
}, ref) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const connectionIdRef = useRef<number>(0);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const disposedRef = useRef(false);
  const hadErrorRef = useRef(false);
  // Until this timestamp, drop capability-query responses (see isTerminalReport)
  // so the scrollback replayed on connect doesn't echo garbage at the prompt.
  const suppressReportsUntilRef = useRef(0);

  const updatePty = useUpdatePty();

  const updateStatus = useCallback((s: ConnectionStatus) => {
    onStatusChange?.(s);
  }, [onStatusChange]);

  useImperativeHandle(ref, () => ({
    focus: () => {
      xtermRef.current?.focus();
    },
    kill: () => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        // Ctrl+C to cancel any pending input
        wsRef.current.send('\x03');
        // Small delay so the shell processes Ctrl+C before receiving exit
        setTimeout(() => {
          if (wsRef.current?.readyState === WebSocket.OPEN) {
            wsRef.current.send('exit\n');
          }
        }, 50);
      }
    },
  }));

  // Disconnect WebSocket
  const disconnect = useCallback(() => {
    disposedRef.current = true;
    connectionIdRef.current = 0;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    if (wsRef.current) {
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      if (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING) {
        wsRef.current.close();
      }
      wsRef.current = null;
    }
  }, []);

  // Send resize to server via HTTP PATCH
  const sendResize = useCallback((cols: number, rows: number) => {
    if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
    resizeTimeoutRef.current = setTimeout(() => {
      updatePty.mutate({ id: pty.id, size: { rows, cols } });
    }, 100);
  }, [pty.id, updatePty]);

  // Initialize xterm + connect WebSocket (all in one effect to avoid stale closures)
  useEffect(() => {
    if (!terminalRef.current) return;

    const container = terminalRef.current;
    disposedRef.current = false;
    hadErrorRef.current = false;

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      theme: terminalTheme,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();

    term.loadAddon(fitAddon);
    term.loadAddon(webLinksAddon);

    term.open(container);

    xtermRef.current = term;
    fitAddonRef.current = fitAddon;

    // Send user input through WebSocket. During the post-connect replay window
    // we suppress xterm's auto-responses to replayed capability queries so they
    // don't echo back as garbage (real keystrokes are never report sequences).
    term.onData((data) => {
      if (wsRef.current?.readyState !== WebSocket.OPEN) return;
      if (Date.now() < suppressReportsUntilRef.current && isTerminalReport(data)) return;
      wsRef.current.send(data);
    });

    // Handle resize — notify the PTY server
    term.onResize(({ cols, rows }) => {
      sendResize(cols, rows);
    });

    // Responsive resize with dimension guard
    const handleResize = () => safeFit(fitAddonRef.current, container);
    window.addEventListener('resize', handleResize);

    const resizeObserver = new ResizeObserver(() => {
      requestAnimationFrame(() => safeFit(fitAddonRef.current, container));
    });
    resizeObserver.observe(container);

    const scheduleReconnect = (reason?: string) => {
      if (disposedRef.current) return;
      if (reconnectTimeoutRef.current) return;

      reconnectAttemptsRef.current += 1;
      const delay = Math.min(1000 * 2 ** (reconnectAttemptsRef.current - 1), 15000);
      const suffix = reason ? ` (${reason})` : '';

      term.writeln(`\r\n\x1b[33mReconnecting in ${Math.ceil(delay / 1000)}s${suffix}...\x1b[0m`);
      updateStatus('connecting');

      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connectWebSocket();
      }, delay);
    };

    const connectWebSocket = async () => {
      if (disposedRef.current) return;

      // --- WebSocket connect ---
      globalPtyConnectionId++;
      const myConnectionId = globalPtyConnectionId;
      connectionIdRef.current = myConnectionId;
      hadErrorRef.current = false;

      if (reconnectAttemptsRef.current === 0) {
        updateStatus('connecting');
      }

      let wsUrl = '';
      try {
        wsUrl = await getPtyWebSocketUrl(pty.id, serverUrl);
      } catch (err) {
        console.error('[PtyTerminal] Failed to resolve WebSocket URL:', err);
        hadErrorRef.current = true;
        term.writeln('\r\n\x1b[31mFailed to resolve terminal connection URL.\x1b[0m');
        updateStatus('error');
        scheduleReconnect('URL error');
        return;
      }

      // Bail out if a newer connection was requested while we were resolving the URL
      if (connectionIdRef.current !== myConnectionId || disposedRef.current) return;

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        if (connectionIdRef.current !== myConnectionId || disposedRef.current) {
          ws.close();
          return;
        }
        reconnectAttemptsRef.current = 0;
        // Suppress capability-query echoes while the server replays scrollback.
        // We deliberately do NOT reset()/clear() here — the PTY is persistent,
        // so reconnecting should re-attach to the existing shell, not wipe it.
        // (Color env is set when the PTY is created, not re-exported each open.)
        suppressReportsUntilRef.current = Date.now() + 1500;
        updateStatus('connected');

        // Send initial terminal size so the shell renders a prompt
        const { cols, rows } = term;
        if (cols && rows) {
          sendResize(cols, rows);
        }
      };

      ws.onmessage = (event) => {
        if (connectionIdRef.current !== myConnectionId) return;
        if (typeof event.data === 'string') {
          term.write(sanitizeTerminalChunk(event.data));
        } else if (event.data instanceof Blob) {
          event.data.text().then((text) => term.write(sanitizeTerminalChunk(text)));
        }
      };

      ws.onerror = (err) => {
        if (connectionIdRef.current !== myConnectionId || disposedRef.current) return;
        console.error('[PtyTerminal] WebSocket error:', err);
        hadErrorRef.current = true;
        term.writeln('\r\n\x1b[31mFailed to connect to terminal.\x1b[0m');
        term.writeln('\x1b[90mURL: ' + wsUrl + '\x1b[0m');
        updateStatus('error');
      };

      ws.onclose = (event) => {
        if (connectionIdRef.current !== myConnectionId || disposedRef.current) return;
        wsRef.current = null;

        const reason = (event.reason || '').toLowerCase();
        const closedByIdleTimeout = event.code === 1000 && reason.includes('idle timeout');
        const shouldReconnect = closedByIdleTimeout || event.code !== 1000;

        if (!hadErrorRef.current) {
          term.writeln(`\r\n\x1b[33mConnection closed${event.code ? ` (${event.code})` : ''}${event.reason ? ': ' + event.reason : ''}\x1b[0m`);
        }

        if (shouldReconnect) {
          scheduleReconnect(closedByIdleTimeout ? 'idle timeout' : `code ${event.code}`);
        } else {
          reconnectAttemptsRef.current = 0;
          updateStatus('disconnected');
        }
      };
    };

    // Delay fit + initial WS connect to ensure the container has real dimensions
    const initTimer = setTimeout(() => {
      safeFit(fitAddon, container);
      connectWebSocket();
    }, 80);

    return () => {
      clearTimeout(initTimer);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
  }, [pty.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit and focus when becoming visible (tab switch)
  useEffect(() => {
    if (!hidden) {
      requestAnimationFrame(() => {
        safeFit(fitAddonRef.current, terminalRef.current);
        xtermRef.current?.focus();
      });
    }
  }, [hidden]);

  return (
    <div
      ref={terminalRef}
      className={cn(
        'overflow-hidden',
        'bg-[#0f0f14]',
        'p-2 px-3',
        hidden && 'invisible pointer-events-none',
        className,
      )}
    />
  );
});

PtyTerminal.displayName = 'PtyTerminal';
