'use client';

import { Button } from '@/components/ui/button';
import Loading from '@/components/ui/loading';
import { cn } from '@/lib/utils';
import { listKortixPty, type Pty } from '@kortix/sdk';
import { getPtyWebSocketUrl, useUpdatePty } from '@kortix/sdk/react';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ITheme, Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useTranslations } from '@/i18n/use-translations';
import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import {
  classifyPtyAttachProbe,
  classifyPtyClose,
  nextPtyAttachStep,
  shouldExpirePtyConnect,
  type PtyAttachPause,
} from './pty-connection';

// ============================================================================
// Theme
// ============================================================================

// Neutral (zero-chroma) surface matching the app's dark background — no blue
// tint. Selection stays neutral so it reads on any ANSI color underneath.
//
// `background` and `foreground` MUST stay equal to `--terminal-surface` and
// `--terminal-fg` in globals.css — the xterm container paints those tokens
// around the canvas, and xterm's ITheme only accepts literal colors, never vars.
const terminalTheme: ITheme = {
  background: '#0f0f0f',
  foreground: '#e5e5e5',
  cursor: '#e5e5e5',
  cursorAccent: '#0f0f0f',
  selectionBackground: 'rgba(255, 255, 255, 0.18)',
  black: '#262626',
  red: '#f87171',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e5e5e5',
  brightBlack: '#525252',
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
/** What the attach overlay shows. `null` means the shell is live. */
type AttachPhase = 'connecting' | 'waking' | 'reconnecting' | PtyAttachPause | null;

const PTY_CONNECT_TIMEOUT_MS = 15_000;
// xterm's default is 1000 lines — a single `npm install` or test run scrolls
// past that, and the buffer is the only place that output exists client-side.
const PTY_SCROLLBACK_LINES = 10_000;

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
  /** Called when reconnecting this ID can never work (daemon no longer owns it). */
  onUnavailable?: () => void;
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
  return (
    chunk
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
      .replace(/\x1b\[\?[0-9;]*c/g, '')
  );
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

export const PtyTerminal = forwardRef<PtyTerminalHandle, PtyTerminalProps>(function PtyTerminal(
  { pty, className, hidden, serverUrl, onStatusChange, onUnavailable },
  ref,
) {
  const tHardcodedUi = useTranslations('hardcodedUi');
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<XTerm | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const connectionIdRef = useRef<number>(0);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const connectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const disposedRef = useRef(false);
  const hadErrorRef = useRef(false);
  /** Consecutive failed attaches that were not a wake wait. Cleared by the
   *  first byte from the shell, which proves both proxy legs are up. */
  const failuresRef = useRef(0);
  /** When the box first reported not-ready during an armed wake. */
  const wakingSinceRef = useRef<number | null>(null);
  /** True while the NEXT connect is user intent (mount, a control, typing into
   *  a paused terminal) and may therefore wake a parked sandbox. Kept armed
   *  across wake retries and consumed by a successful open, so a socket that
   *  later drops because the box parked leaves the box parked. */
  const wakeOnNextConnectRef = useRef(true);
  // Until this timestamp, drop capability-query responses (see isTerminalReport)
  // so the scrollback replayed on connect doesn't echo garbage at the prompt.
  const suppressReportsUntilRef = useRef(0);
  // Set by the effect below; lets the overlay control and the visibility effect
  // start a fresh attach without reaching into the effect's closure.
  const reconnectNowRef = useRef<(() => void) | null>(null);

  const [phase, setPhase] = useState<AttachPhase>('connecting');
  const phaseRef = useRef<AttachPhase>('connecting');
  // Before the first open the buffer is empty, so the status sits centered in
  // place of the shell. After it, the status floats over the scrollback.
  const [hasConnected, setHasConnected] = useState(false);
  const updatePty = useUpdatePty({ serverUrl, onError: () => {} });

  const updateStatus = useCallback(
    (s: ConnectionStatus) => {
      onStatusChange?.(s);
    },
    [onStatusChange],
  );

  const showPhase = useCallback((next: AttachPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

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

  // Detach and close the current socket without firing its handlers.
  const dropSocket = useCallback(() => {
    if (connectTimeoutRef.current) {
      clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = null;
    }
    const ws = wsRef.current;
    if (!ws) return;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close();
    }
    wsRef.current = null;
  }, []);

  // Disconnect WebSocket
  const disconnect = useCallback(() => {
    disposedRef.current = true;
    connectionIdRef.current = 0;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    dropSocket();
  }, [dropSocket]);

  // Send resize to server via HTTP PATCH
  const sendResize = useCallback(
    (cols: number, rows: number) => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      resizeTimeoutRef.current = setTimeout(() => {
        updatePty.mutate({ id: pty.id, size: { rows, cols } });
      }, 100);
    },
    [pty.id, updatePty],
  );

  // Initialize xterm + connect WebSocket (all in one effect to avoid stale closures)
  useEffect(() => {
    if (!terminalRef.current) return;

    const container = terminalRef.current;
    disposedRef.current = false;
    hadErrorRef.current = false;
    failuresRef.current = 0;
    wakingSinceRef.current = null;
    showPhase('connecting');
    setHasConnected(false);

    const term = new XTerm({
      cursorBlink: true,
      cursorStyle: 'block',
      fontSize: 13,
      fontFamily: 'JetBrains Mono, Menlo, Monaco, Consolas, monospace',
      theme: terminalTheme,
      scrollback: PTY_SCROLLBACK_LINES,
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
      if (wsRef.current?.readyState !== WebSocket.OPEN) {
        // Typing into a paused terminal is a request for the shell.
        if (phaseRef.current === 'asleep' || phaseRef.current === 'failed') {
          reconnectNowRef.current?.();
        }
        return;
      }
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

    /**
     * An attach failed: the upgrade was refused, timed out, or the socket
     * dropped. The browser reports every one of those as a bare `1006`, so ask
     * the HTTP path why before choosing the next step. See nextPtyAttachStep.
     */
    const handleAttachFailure = async (connectionId: number) => {
      const isStale = () => connectionIdRef.current !== connectionId || disposedRef.current;
      if (isStale()) return;

      let probeError: unknown = null;
      if (!serverUrl) {
        probeError = new Error('terminal server URL missing');
      } else {
        try {
          await listKortixPty(serverUrl);
        } catch (err) {
          probeError = err;
        }
      }
      if (isStale()) return;

      const probe = classifyPtyAttachProbe(probeError);
      const wakeArmed = wakeOnNextConnectRef.current;
      const now = Date.now();
      failuresRef.current = probe === 'not-ready' ? 0 : failuresRef.current + 1;

      const step = nextPtyAttachStep({
        probe,
        wakeArmed,
        failures: Math.max(1, failuresRef.current),
        wakingForMs: wakingSinceRef.current === null ? 0 : now - wakingSinceRef.current,
      });
      console.warn('[PtyTerminal] attach failed', { probe, step });

      if (step.kind === 'pause') {
        wakingSinceRef.current = null;
        showPhase(step.reason);
        updateStatus('error');
        return;
      }
      showPhase(step.phase);
      updateStatus('connecting');
      if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null;
        void connectWebSocket();
      }, step.delayMs);
    };

    const connectWebSocket = async () => {
      if (disposedRef.current) return;
      // A user-initiated attach (panel open, a control) may WAKE a parked
      // sandbox — see getPtyWebSocketUrl. The flag stays armed across the wake
      // retries: the API holds the row `stopped` until the provider confirms
      // the box, so every dial during the wake is refused and the attach that
      // finally opens is still the one the user asked for.
      const wake = wakeOnNextConnectRef.current;
      // All probes share this attempt's deadline, including transient network failures.
      if (wake && wakingSinceRef.current === null) wakingSinceRef.current = Date.now();

      // --- WebSocket connect ---
      globalPtyConnectionId++;
      const myConnectionId = globalPtyConnectionId;
      connectionIdRef.current = myConnectionId;
      hadErrorRef.current = false;

      let wsUrl = '';
      try {
        wsUrl = await getPtyWebSocketUrl(pty.id, serverUrl, { wake });
      } catch (err) {
        console.error('[PtyTerminal] Failed to resolve WebSocket URL:', err);
        void handleAttachFailure(myConnectionId);
        return;
      }

      // Bail out if a newer connection was requested while we were resolving the URL
      if (connectionIdRef.current !== myConnectionId || disposedRef.current) return;
      // `wsUrl` carries the auth token as a query param (see getKortixPtyWebSocketUrl).
      // Log the token-free origin+path only — never the query string.
      console.log('[PtyTerminal] Connecting WebSocket:', wsUrl.split('?')[0]);

      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;
      const connectStartedAt = Date.now();

      if (connectTimeoutRef.current) clearTimeout(connectTimeoutRef.current);
      connectTimeoutRef.current = setTimeout(() => {
        if (
          connectionIdRef.current !== myConnectionId ||
          disposedRef.current ||
          ws.readyState !== WebSocket.CONNECTING ||
          !shouldExpirePtyConnect(connectStartedAt, Date.now(), PTY_CONNECT_TIMEOUT_MS)
        ) {
          return;
        }
        connectTimeoutRef.current = null;
        if (wsRef.current === ws) dropSocket();
        void handleAttachFailure(myConnectionId);
      }, PTY_CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (connectionIdRef.current !== myConnectionId || disposedRef.current) {
          ws.close();
          return;
        }
        // Consumed only now: the attach succeeded, so the box is awake and the
        // next dial has nothing left to wake.
        wakeOnNextConnectRef.current = false;
        wakingSinceRef.current = null;
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        console.log('[PtyTerminal] WebSocket connected');
        // Suppress capability-query echoes while the server replays scrollback.
        // We deliberately do NOT reset()/clear() here — the PTY is persistent,
        // so reconnecting should re-attach to the existing shell, not wipe it.
        // (Color env is set when the PTY is created, not re-exported each open.)
        suppressReportsUntilRef.current = Date.now() + 1500;
        showPhase(null);
        setHasConnected(true);
        updateStatus('connected');

        // Send initial terminal size so the shell renders a prompt
        const { cols, rows } = term;
        if (cols && rows) {
          sendResize(cols, rows);
        }
      };

      ws.onmessage = (event) => {
        if (connectionIdRef.current !== myConnectionId) return;
        // The proxy upgrades the browser leg before it dials the box, so an
        // open alone does not prove the shell is reachable. A byte does.
        failuresRef.current = 0;
        if (typeof event.data === 'string') {
          term.write(sanitizeTerminalChunk(event.data));
        } else if (event.data instanceof Blob) {
          event.data.text().then((text) => term.write(sanitizeTerminalChunk(text)));
        }
      };

      ws.onerror = () => {
        if (connectionIdRef.current !== myConnectionId || disposedRef.current) return;
        // Browser WS error events carry no detail and never expose the HTTP
        // status. The close that follows drives handleAttachFailure, which asks
        // the HTTP path for the reason. Never echo the token-bearing URL.
        console.warn('[PtyTerminal] WebSocket connection error');
        hadErrorRef.current = true;
      };

      ws.onclose = (event) => {
        if (connectionIdRef.current !== myConnectionId || disposedRef.current) return;
        console.log('[PtyTerminal] WebSocket closed:', event.code, event.reason);
        if (connectTimeoutRef.current) {
          clearTimeout(connectTimeoutRef.current);
          connectTimeoutRef.current = null;
        }
        wsRef.current = null;

        const action = classifyPtyClose({
          code: event.code,
          reason: event.reason || '',
          hadError: hadErrorRef.current,
        });

        if (action === 'replace') {
          updateStatus('error');
          onUnavailable?.();
          return;
        }
        if (action === 'ended') {
          // A clean shell exit is shell output, so it belongs in the buffer.
          term.writeln(
            `\r\n\x1b[90mConnection closed${event.code ? ` (${event.code})` : ''}${event.reason ? ': ' + event.reason : ''}\x1b[0m`,
          );
          failuresRef.current = 0;
          showPhase(null);
          updateStatus('disconnected');
          return;
        }
        void handleAttachFailure(myConnectionId);
      };
    };

    // A fresh attach on user intent: skip any armed retry and dial now.
    reconnectNowRef.current = () => {
      if (disposedRef.current) return;
      wakeOnNextConnectRef.current = true;
      failuresRef.current = 0;
      wakingSinceRef.current = null;
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      dropSocket();
      showPhase('connecting');
      updateStatus('connecting');
      void connectWebSocket();
    };

    // A fresh (pty, serverUrl) pair is a new attach — the panel opened, or the
    // runtime moved. Both are user intent, so the first dial may wake a parked box.
    wakeOnNextConnectRef.current = true;
    updateStatus('connecting');

    // Delay fit + initial WS connect to ensure the container has real dimensions
    const initTimer = setTimeout(() => {
      safeFit(fitAddon, container);
      void connectWebSocket();
    }, 80);

    return () => {
      clearTimeout(initTimer);
      window.removeEventListener('resize', handleResize);
      resizeObserver.disconnect();
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      reconnectNowRef.current = null;
      disconnect();
      term.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    // `serverUrl` is a real input: the WS host is resolved from it, so after a
    // sandbox move the old socket must be torn down and redialled. The cleanup
    // above disposes the terminal and closes the socket, so re-running is safe.
  }, [pty.id, serverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Re-fit and focus when becoming visible (tab switch)
  useEffect(() => {
    if (hidden) return;
    // Showing a paused terminal again is a request for the shell.
    if (phaseRef.current === 'asleep' || phaseRef.current === 'failed') {
      reconnectNowRef.current?.();
    }
    requestAnimationFrame(() => {
      safeFit(fitAddonRef.current, terminalRef.current);
      // Never steal focus on a touch device: the mobile tool drawer mounts this
      // with `hidden` undefined, and focusing xterm there throws up the
      // on-screen keyboard over the terminal on every open.
      if (typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches) {
        return;
      }
      xtermRef.current?.focus();
    });
  }, [hidden]);

  const statusLabel =
    phase === 'connecting'
      ? tHardcodedUi.raw('autoFeaturesSessionSessionTerminalPanelJsxTextConnecting80303e70')
      : phase === 'waking'
        ? tHardcodedUi.raw('i18nComplete.text5e3de76869f3')
        : phase === 'reconnecting'
          ? tHardcodedUi.raw('i18nComplete.text8a8b956178c8')
          : phase === 'asleep'
            ? tHardcodedUi.raw('i18nComplete.text3915f5ca49b3')
            : tHardcodedUi.raw('i18nComplete.text5c1fff90cce6');
  const actionLabel =
    phase === 'reconnecting'
      ? tHardcodedUi.raw('i18nComplete.textf786f0ee4793')
      : phase === 'asleep'
        ? tHardcodedUi.raw('i18nComplete.textc64d601209b6')
        : phase === 'failed'
          ? tHardcodedUi.raw('i18nComplete.text942087cc2d41')
          : null;

  return (
    <div
      className={cn(
        'bg-terminal-surface relative overflow-hidden',
        hidden && 'pointer-events-none invisible',
        className,
      )}
    >
      <div
        ref={terminalRef}
        className={cn('h-full w-full px-3 py-2', !hasConnected && 'opacity-0')}
      />
      {phase && !hidden ? (
        <PtyAttachStatus
          placement={hasConnected ? 'floating' : 'centered'}
          busy={phase === 'connecting' || phase === 'waking' || phase === 'reconnecting'}
          label={statusLabel}
          actionLabel={actionLabel}
          onAction={() => reconnectNowRef.current?.()}
        />
      ) : null}
    </div>
  );
});

PtyTerminal.displayName = 'PtyTerminal';

/**
 * The one place the terminal talks about its connection. Nothing is written
 * into the shell buffer: a countdown there reads as a stuck loop and is left
 * behind in the scrollback after the shell comes back.
 *
 * It is app chrome, not shell output, so it paints Kortix tokens. Before the
 * first connect it replaces the empty shell with the app background; after it,
 * it floats over the scrollback as a popover pill.
 */
function PtyAttachStatus({
  placement,
  busy,
  label,
  actionLabel,
  onAction,
}: {
  placement: 'centered' | 'floating';
  busy: boolean;
  label: string;
  actionLabel: string | null;
  onAction: () => void;
}) {
  if (placement === 'centered') {
    return (
      <div
        role="status"
        aria-live="polite"
        className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center"
      >
        {busy ? <Loading className="text-muted-foreground size-4" /> : null}
        <p className="text-muted-foreground text-xs text-pretty">{label}</p>
        {actionLabel ? (
          <Button type="button" size="sm" variant="outline" onClick={onAction} className="mt-1">
            {actionLabel}
          </Button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center p-3">
      <div
        role="status"
        aria-live="polite"
        className={cn(
          'bg-popover text-muted-foreground pointer-events-auto flex h-8 max-w-full items-center gap-2 rounded-md border pl-3 text-xs shadow-md',
          actionLabel ? 'pr-0.5' : 'pr-3',
        )}
      >
        {busy ? <Loading className="size-3.5 shrink-0" /> : null}
        <span className="truncate">{label}</span>
        {actionLabel ? (
          <Button
            type="button"
            size="xs"
            variant="ghost"
            onClick={onAction}
            className="active:scale-[0.96]"
          >
            {actionLabel}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
