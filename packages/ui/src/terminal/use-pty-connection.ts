'use client';

import { listKortixPty, type Pty } from '@kortix/sdk';
import { getPtyWebSocketUrl, useUpdatePty } from '@kortix/sdk/react';
import type { Terminal as XTerm } from '@xterm/xterm';
import type { RefObject } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  classifyPtyAttachProbe,
  classifyPtyClose,
  nextPtyAttachStep,
  shouldExpirePtyConnect,
  type AttachPhase,
  type ConnectionStatus,
} from './pty-connection';
import { isTerminalReport, sanitizeTerminalChunk } from './pty-terminal-sanitize';

const PTY_CONNECT_TIMEOUT_MS = 15_000;

let globalPtyConnectionId = 0;

/**
 * Everything `startPtyConnection` needs to run one attach episode. The refs
 * are the cross-render state `usePtyConnection` owns; the callbacks are its
 * seams to the terminal and the overlay.
 */
export interface PtyConnectionLifecycleInput {
  /** The PTY being attached. */
  pty: Pty;
  serverUrl: string | undefined;
  /** The xterm instance the socket writes into — set by PtyTerminal's setup. */
  termRef: RefObject<XTerm | null>;
  wsRef: RefObject<WebSocket | null>;
  connectionIdRef: RefObject<number>;
  connectTimeoutRef: RefObject<NodeJS.Timeout | null>;
  reconnectTimeoutRef: RefObject<NodeJS.Timeout | null>;
  disposedRef: RefObject<boolean>;
  hadErrorRef: RefObject<boolean>;
  failuresRef: RefObject<number>;
  wakingSinceRef: RefObject<number | null>;
  wakeOnNextConnectRef: RefObject<boolean>;
  suppressReportsUntilRef: RefObject<number>;
  reconnectNowRef: RefObject<(() => void) | null>;
  showPhase: (phase: AttachPhase) => void;
  setHasConnected: (connected: boolean) => void;
  updateStatus: (status: ConnectionStatus) => void;
  sendResize: (cols: number, rows: number) => void;
  /** Called when reconnecting this ID can never work (daemon no longer owns it). */
  onUnavailable?: () => void;
}

/**
 * The websocket attach lifecycle of `PtyTerminal` — dial, wake, the socket
 * handlers, attach-failure classification and the retry cadence — moved
 * verbatim from the component's init effect (KRTX-460) so it runs without
 * React and can be characterized directly. `usePtyConnection` owns the refs
 * and the overlay state; this owns one attach episode. Returns the teardown.
 */
export function startPtyConnection(input: PtyConnectionLifecycleInput): () => void {
  const {
    pty,
    serverUrl,
    termRef,
    wsRef,
    connectionIdRef,
    connectTimeoutRef,
    reconnectTimeoutRef,
    disposedRef,
    hadErrorRef,
    failuresRef,
    wakingSinceRef,
    wakeOnNextConnectRef,
    suppressReportsUntilRef,
    reconnectNowRef,
    showPhase,
    setHasConnected,
    updateStatus,
    sendResize,
    onUnavailable,
  } = input;

  disposedRef.current = false;
  hadErrorRef.current = false;
  failuresRef.current = 0;
  wakingSinceRef.current = null;
  showPhase('connecting');
  setHasConnected(false);

  // Detach and close the current socket without firing its handlers.
  const dropSocket = () => {
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
  };

  // Disconnect WebSocket
  const disconnect = () => {
    disposedRef.current = true;
    connectionIdRef.current = 0;
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
    dropSocket();
  };

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

    // The terminal this socket writes into — created by PtyTerminal's xterm
    // setup effect before the first dial fires.
    const term = termRef.current;
    if (!term) return;

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

  // Delay the initial WS connect to the same beat the terminal setup fits the
  // container, so the shell opens with real dimensions. The dial waits for the
  // terminal instance: without one there is nothing to attach to.
  const initTimer = setTimeout(() => {
    if (!termRef.current) return;
    void connectWebSocket();
  }, 80);

  return () => {
    clearTimeout(initTimer);
    reconnectNowRef.current = null;
    disconnect();
  };
}

/**
 * The PTY terminal's connection: socket lifecycle, wake intent, attach
 * failures and the overlay phase. Owns the cross-render refs and state;
 * `startPtyConnection` runs one attach episode per (pty, serverUrl) pair.
 */
export function usePtyConnection(
  pty: Pty,
  serverUrl: string | undefined,
  termRef: RefObject<XTerm | null>,
  handlers: {
    onStatusChange?: (status: ConnectionStatus) => void;
    /** Called when reconnecting this ID can never work (daemon no longer owns it). */
    onUnavailable?: () => void;
  },
) {
  const { onStatusChange, onUnavailable } = handlers;
  const wsRef = useRef<WebSocket | null>(null);
  const connectionIdRef = useRef<number>(0);
  const connectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
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
  // Assigned by the lifecycle effect below; lets the overlay control, the
  // visibility effect and typing into a paused terminal start a fresh attach
  // without reaching into the lifecycle's closure.
  const reconnectNowRef = useRef<(() => void) | null>(null);
  const resizeTimeoutRef = useRef<NodeJS.Timeout | null>(null);

  const [phase, setPhase] = useState<AttachPhase>('connecting');
  const phaseRef = useRef<AttachPhase>('connecting');
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

  // Send user input through WebSocket. During the post-connect replay window
  // we suppress xterm's auto-responses to replayed capability queries so they
  // don't echo back as garbage (real keystrokes are never report sequences).
  const handleData = useCallback((data: string) => {
    if (wsRef.current?.readyState !== WebSocket.OPEN) {
      // Typing into a paused terminal is a request for the shell.
      if (phaseRef.current === 'asleep' || phaseRef.current === 'failed') {
        reconnectNowRef.current?.();
      }
      return;
    }
    if (Date.now() < suppressReportsUntilRef.current && isTerminalReport(data)) return;
    wsRef.current.send(data);
  }, []);

  const kill = useCallback(() => {
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
  }, []);

  const reconnectNow = useCallback(() => reconnectNowRef.current?.(), []);

  useEffect(() => {
    const stop = startPtyConnection({
      pty,
      serverUrl,
      termRef,
      wsRef,
      connectionIdRef,
      connectTimeoutRef,
      reconnectTimeoutRef,
      disposedRef,
      hadErrorRef,
      failuresRef,
      wakingSinceRef,
      wakeOnNextConnectRef,
      suppressReportsUntilRef,
      reconnectNowRef,
      showPhase,
      setHasConnected,
      updateStatus,
      sendResize,
      onUnavailable,
    });
    return () => {
      if (resizeTimeoutRef.current) clearTimeout(resizeTimeoutRef.current);
      stop();
    };
    // `serverUrl` is a real input: the WS host is resolved from it, so after a
    // sandbox move the old socket must be torn down and redialled. The
    // cleanups above dispose the terminal and close the socket, so re-running
    // is safe.
  }, [pty.id, serverUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  return { phase, hasConnected, phaseRef, reconnectNow, kill, sendResize, handleData };
}
