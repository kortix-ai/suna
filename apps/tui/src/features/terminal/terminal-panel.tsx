/**
 * The terminal panel (SPEC §5.4) — a real shell in the session's sandbox.
 *
 * Data path, all SDK:
 *   `useSession(...)` points the SDK's runtime at THIS session's sandbox once
 *   `/start` reports ready (`switched`). Every PTY hook below then resolves
 *   that same runtime: `useOpenCodePtyList` reuses the session's ambient
 *   shell, `useCreatePty` spawns one when there is none, `useUpdatePty` sends
 *   the size, and `getPtyWebSocketUrl` mints the token-bearing socket URL.
 *   None of them is given a URL by hand.
 *
 * The parked-box probe: a refused WebSocket upgrade reaches a client as a bare
 * close, and the `503 sandbox not ready` behind it is invisible — so a
 * background reconnect loop dials a box nothing will ever wake. `useSession`
 * now returns `runtimeUrl` (the resolved `/p/<external_id>/8000` origin), so
 * after a drop this panel asks `GET /kortix/pty` against THAT origin, exactly
 * as `apps/web/src/features/session/pty-connection.ts` does. A readiness 503
 * parks the panel (`asleep`) instead of retrying; `Alt+Enter` is the
 * user-initiated attach that carries `wake=1` and is the only thing allowed to
 * resume the box.
 *
 * Bytes: the socket carries raw bytes both ways. Output goes into
 * `EmbeddedTerminalRenderable.write`, a headless VT emulator; its `onData`
 * hands back both local keystrokes (`'input'`) and VT replies (`'response'`),
 * and both must reach the shell. Resize is an HTTP PATCH, never a frame.
 */

import { isSandboxNotReadyError, listKortixPty } from '@kortix/sdk';
import {
  getPtyWebSocketUrl,
  useCreatePty,
  useOpenCodePtyList,
  useUpdatePty,
} from '@kortix/sdk/react';
import type { useSession } from '@kortix/sdk/react';
import type { EmbeddedTerminalRenderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { copyToClipboard } from '../../lib/clipboard.ts';
import { theme } from '../../theme.ts';
import { Panel, type ToastKind } from '../../ui/index.ts';
import { ConnectHint, connectCommand } from './connect-hint.tsx';
import { isReservedWhileTerminalFocused, matchesTerminalBinding } from './keys.ts';
import { openPtyWebSocket } from './open-socket.ts';
import { PtySession, type PtySessionState, type PtySocket, ptyPanelTitle } from './pty-session.ts';
import { registerEmbeddedTerminal } from './register.ts';

registerEmbeddedTerminal();

/** Same title + env the CLI's `sessions shell` creates, so all three surfaces
 *  reuse ONE ambient shell per session instead of spawning one each. */
const PTY_CREATE_BODY = {
  title: 'Session terminal',
  env: { TERM: 'xterm-256color', COLORTERM: 'truecolor' },
} as const;

/** Rows the connect hint costs: heading, install, connect, keys, blank. */
const HINT_ROWS = 5;
/** Debounce on the size PATCH — a drag emits a resize per frame. */
const RESIZE_DEBOUNCE_MS = 100;

const IDLE_STATE: PtySessionState = {
  phase: 'idle',
  attempt: 0,
  reason: null,
  needsReplacement: false,
};

export interface TerminalPanelProps {
  projectId: string;
  sessionId: string;
  /**
   * The `useSession(projectId, sessionId)` return. `switched` gates the attach
   * and `runtimeUrl` is the origin the parked-box probe reads (null until the
   * runtime is ready).
   */
  session: Pick<ReturnType<typeof useSession>, 'switched' | 'phase' | 'runtimeUrl'>;
  focused: boolean;
  /** Outer width in cells, border included. */
  width: number;
  /** Outer height in cells, border included. */
  height: number;
  /** `Alt+X`, and the panel asking to be dismissed. */
  onClose: () => void;
  onToast?: (message: string, kind?: ToastKind) => void;
  /**
   * Socket factory. The default is the real Bun WebSocket. `scripts/
   * dev-terminal.tsx` overrides it to hold the socket and drop it on purpose,
   * which is how the reconnect path is exercised against a live sandbox.
   */
  openSocket?: (url: string) => PtySocket;
}

export function TerminalPanel({
  projectId,
  sessionId,
  session,
  focused,
  width,
  height,
  onClose,
  onToast,
  openSocket = openPtyWebSocket,
}: TerminalPanelProps) {
  const terminalRef = useRef<EmbeddedTerminalRenderable | null>(null);
  const focusedRef = useRef(false);
  const ptySessionRef = useRef<PtySession | null>(null);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null);
  /** One replacement per mount — a bad runtime must not mint terminals forever. */
  const replacedRef = useRef(false);
  const createRequestedRef = useRef(false);

  const [state, setState] = useState<PtySessionState>(IDLE_STATE);
  const [ptyId, setPtyId] = useState<string | null>(null);
  const [ensureError, setEnsureError] = useState<string | null>(null);
  /** The probe answered "sandbox not ready". Only Alt+Enter dials again. */
  const [asleep, setAsleep] = useState(false);
  /** Bumped by Alt+Enter after a park: a new attach, with the wake armed. */
  const [attachEpoch, setAttachEpoch] = useState(0);

  const ready = session.switched;
  const runtimeUrl = session.runtimeUrl;
  const cols = Math.max(width - 4, 20);
  const rows = Math.max(height - 2 - HINT_ROWS, 3);

  const ptyList = useOpenCodePtyList({ enabled: ready });
  const createPty = useCreatePty({ onError: () => {} });
  const updatePty = useUpdatePty({ onError: () => {} });

  // 1. One ambient shell per session: reuse the running one the web panel and
  //    `kortix sessions shell` also attach to, and spawn one only when there
  //    is none. `createRequestedRef` keeps a slow create from firing twice.
  useEffect(() => {
    if (!ready || ptyId) return;
    const existing = ptyList.data?.find((pty) => pty.status === 'running') ?? ptyList.data?.[0];
    if (existing) {
      setPtyId(existing.id);
      return;
    }
    if (ptyList.isLoading || !ptyList.data || createRequestedRef.current) return;
    createRequestedRef.current = true;
    createPty
      .mutateAsync({ ...PTY_CREATE_BODY, env: { ...PTY_CREATE_BODY.env } })
      .then((pty) => setPtyId(pty.id))
      .catch((error: unknown) => {
        createRequestedRef.current = false;
        setEnsureError(error instanceof Error ? error.message : String(error));
      });
  }, [ready, ptyId, ptyList.data, ptyList.isLoading, createPty]);

  // 2. One socket per pty id. A new id (or an unmount) closes the old machine
  //    first, so a stale generation can never write into the new screen.
  // biome-ignore lint/correctness/useExhaustiveDependencies(attachEpoch): not read in the body on purpose — it is the re-mount trigger. `PtySession.close()` disposes the machine for good, so waking a parked box is a NEW instance, not a `reconnectNow`.
  useEffect(() => {
    if (!ptyId) return;
    const ptySession = new PtySession({
      resolveUrl: ({ wake }) => getPtyWebSocketUrl(ptyId, undefined, { wake }),
      openSocket,
      onOutput: (text) => terminalRef.current?.write(text),
      onState: setState,
    });
    ptySessionRef.current = ptySession;
    ptySession.start();
    return () => {
      ptySession.close();
      if (ptySessionRef.current === ptySession) ptySessionRef.current = null;
    };
  }, [ptyId, openSocket, attachEpoch]);

  // 3. The box may be parked, not broken. A socket close cannot say which, so
  //    ask the runtime over HTTP: `GET /kortix/pty` passes the same
  //    control-plane gate, returns a readable body, and never wakes anything.
  //    A readiness 503 parks the panel and stops the retry loop outright — a
  //    background retry that resurrects a sandbox nobody asked for is the bug
  //    `wake=1` exists to prevent.
  useEffect(() => {
    if (state.phase !== 'reconnecting' || asleep || !runtimeUrl) return;
    let cancelled = false;
    void listKortixPty(runtimeUrl).catch((error: unknown) => {
      if (cancelled || !isSandboxNotReadyError(error)) return;
      setAsleep(true);
      ptySessionRef.current?.close();
    });
    return () => {
      cancelled = true;
    };
  }, [state.phase, asleep, runtimeUrl]);

  // 4. The daemon no longer owns this id. Reconnecting can never work; mint a
  //    new terminal once, then stop.
  useEffect(() => {
    if (!state.needsReplacement || replacedRef.current) return;
    replacedRef.current = true;
    createRequestedRef.current = true;
    createPty
      .mutateAsync({ ...PTY_CREATE_BODY, env: { ...PTY_CREATE_BODY.env } })
      .then((pty) => setPtyId(pty.id))
      .catch((error: unknown) =>
        setEnsureError(error instanceof Error ? error.message : String(error)),
      );
  }, [state.needsReplacement, createPty]);

  const sendResize = useCallback(
    (nextCols: number, nextRows: number) => {
      lastSizeRef.current = { cols: nextCols, rows: nextRows };
      if (!ptyId) return;
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      resizeTimerRef.current = setTimeout(() => {
        resizeTimerRef.current = null;
        updatePty.mutate({ id: ptyId, size: { rows: nextRows, cols: nextCols } });
      }, RESIZE_DEBOUNCE_MS);
    },
    [ptyId, updatePty],
  );

  // 5. The shell needs its size before it draws a prompt. The emulator reports
  //    a resize only when the box CHANGES, so a fresh attach to an existing
  //    shell would otherwise never send one.
  // biome-ignore lint/correctness/useExhaustiveDependencies(cols): read as the fallback size only; a width change already reaches the PTY through `onTerminalResize`.
  // biome-ignore lint/correctness/useExhaustiveDependencies(rows): same as `cols`.
  // biome-ignore lint/correctness/useExhaustiveDependencies(sendResize): it is stable per `ptyId`; re-running on its identity would re-PATCH the size on every render.
  useEffect(() => {
    if (state.phase !== 'connected') return;
    const size = lastSizeRef.current ?? { cols, rows };
    sendResize(size.cols, size.rows);
  }, [state.phase]);

  useEffect(
    () => () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
    },
    [],
  );

  // 6. Focus routes keys to the emulator AND makes it paint the shell's
  //    cursor. Both follow the `focused` prop.
  //
  //    It must be `terminal.focus()`, NOT `renderer.focusRenderable(terminal)`.
  //    `focusRenderable` only records which renderable is current and emits
  //    the event; `Renderable.focus()` is what installs the keypress handler
  //    on `_internalKeyInput` (and then calls `focusRenderable` itself).
  //    Measured: with `focusRenderable` alone the panel painted a live prompt
  //    and swallowed every keystroke.
  //
  //    A ref callback, not a plain ref: the element mounts after this effect
  //    on the first ready render, so focus has to be applied at attach time
  //    too — otherwise the panel opens focused with a dead keyboard.
  useEffect(() => {
    focusedRef.current = focused;
    const terminal = terminalRef.current;
    if (!terminal) return;
    if (focused) terminal.focus();
    else terminal.blur();
  }, [focused]);

  const attachTerminal = useCallback((terminal: EmbeddedTerminalRenderable | null) => {
    terminalRef.current = terminal;
    if (terminal && focusedRef.current) terminal.focus();
  }, []);

  const copyConnect = useCallback(async () => {
    const result = await copyToClipboard(connectCommand(sessionId));
    if (result.ok) onToast?.(`Copied the connect command (${result.tool}).`);
    else onToast?.(`Copy failed: ${result.error}`, 'error');
  }, [sessionId, onToast]);

  useKeyboard((key) => {
    if (!focused) return;
    if (matchesTerminalBinding(key, 'terminal.copyConnect')) {
      key.preventDefault();
      void copyConnect();
      return;
    }
    if (matchesTerminalBinding(key, 'terminal.close')) {
      key.preventDefault();
      onClose();
      return;
    }
    if (matchesTerminalBinding(key, 'terminal.reconnect')) {
      key.preventDefault();
      // A parked box has no machine left to reconnect: waking it is a fresh
      // attach, and `attachEpoch` is what mounts one.
      if (asleep) {
        setAsleep(false);
        setAttachEpoch((epoch) => epoch + 1);
        return;
      }
      ptySessionRef.current?.reconnectNow();
      return;
    }
    // The app already handled these in this same (global) phase. Prevent the
    // default so the SECOND phase — the focused emulator — never sees them and
    // the shell is not fed a stray Tab. Everything else falls through on
    // purpose, Ctrl+C included.
    if (isReservedWhileTerminalFocused(key)) key.preventDefault();
  });

  const detail = ensureError ?? statusDetail(state, ready, session.phase, asleep);

  return (
    <Panel
      title={ptyPanelTitle(state)}
      footer={ptyId ? `pty ${ptyId.slice(0, 8)}` : undefined}
      focused={focused}
      width={width}
      height={height}
    >
      <box flexDirection="column" flexGrow={1} paddingLeft={1} paddingRight={1}>
        <ConnectHint sessionId={sessionId} hint="Alt+Y copy · Alt+X close · Alt+Enter reconnect" />
        {ready && ptyId ? (
          <embedded-terminal
            ref={attachTerminal}
            width={cols}
            height={rows}
            onData={(bytes: Uint8Array) => ptySessionRef.current?.send(bytes)}
            onTerminalResize={(nextCols: number, nextRows: number) =>
              sendResize(nextCols, nextRows)
            }
          />
        ) : (
          <text fg={theme.faint}>{detail}</text>
        )}
        {ready && ptyId && detail ? <text fg={detailColor(state)}>{detail}</text> : null}
      </box>
    </Panel>
  );
}

/** The one line under the shell: what the panel is waiting on, or why it stopped. */
function statusDetail(
  state: PtySessionState,
  ready: boolean,
  phase: string,
  asleep: boolean,
): string {
  if (!ready) return `Waiting for the sandbox (${phase})…`;
  if (asleep) return 'Sandbox is parked · Alt+Enter wakes it';
  if (state.phase === 'reconnecting') {
    return `Reconnecting (${state.attempt})${state.reason ? ` — ${state.reason}` : ''}`;
  }
  if (state.phase === 'closed') {
    return `${state.reason ?? 'Closed'} · Alt+Enter reconnects`;
  }
  if (state.phase === 'connecting' || state.phase === 'idle') return 'Connecting…';
  return '';
}

function detailColor(state: PtySessionState): string {
  return state.phase === 'closed' ? theme.danger : theme.faint;
}
