/**
 * The Ports panel's state, as a hook. This is the thin React wrapper around
 * `ports-state.ts`'s pure transitions and the CLI's port-forward engine
 * (`@kortix/cli/src/port-forward.ts` — the same library `kortix sessions
 * forward` runs, deep-imported exactly like `features/attach/attach.ts`
 * already imports `attach-opencode.ts`).
 *
 * Forwards are per session: switching `sessionId` (or unmounting) closes every
 * open forward for the OLD session first — never leaked, never carried into a
 * different sandbox.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { PortForwardDeps } from '@kortix/cli/src/port-forward.ts';
import { PortForwardError, startPortForward } from '@kortix/cli/src/port-forward.ts';
import { SessionRuntimeError } from '@kortix/cli/src/session-runtime.ts';

import type { ResolvedHost } from '../../auth/hosts.ts';
import type { ToastKind } from '../../ui/index.ts';
import { authFromHost } from '../attach/attach.ts';
import { isForwardablePort } from './port-detect.ts';
import {
  EMPTY_PORTS,
  type PortRow,
  type PortSource,
  type PortsById,
  forwardedToast,
  newlyDetected,
  sortedRows,
  withDetected,
  withError,
  withForwarding,
  withStopped,
} from './ports-state.ts';

/** `KORTIX_TUI_AUTO_FORWARD=0` disables auto-forwarding a newly-detected port. */
export function autoForwardEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.KORTIX_TUI_AUTO_FORWARD !== '0';
}

/** A stopped/deleted session gets the same one-line remedy the CLI prints. */
export function portForwardErrorMessage(err: unknown): string {
  if (err instanceof PortForwardError && err.cause instanceof SessionRuntimeError) {
    if (err.cause.kind === 'not-running') {
      return `${err.cause.message} Run \`kortix sessions restart\` first.`;
    }
  }
  return err instanceof Error ? err.message : String(err);
}

export interface UsePortsOptions {
  host: ResolvedHost;
  projectId: string;
  sessionId: string;
  onToast?: (message: string, kind?: ToastKind) => void;
  /** Test seam. Production runs the real CLI port-forward engine. */
  deps?: PortForwardDeps;
}

export interface UsePortsResult {
  rows: PortRow[];
  /** Register ports found in new output. Auto-forwards unknown ones unless disabled. */
  notice(ports: number[], source: PortSource): void;
  /** Start or stop forwarding one port. */
  toggle(port: number): void;
  /** Add (and immediately forward) a port by number, regardless of auto-forward. */
  addManual(port: number): void;
}

export function usePorts({
  host,
  projectId,
  sessionId,
  onToast,
  deps,
}: UsePortsOptions): UsePortsResult {
  const [rows, setRows] = useState<PortsById>(EMPTY_PORTS);
  const closers = useRef(new Map<number, () => void>());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  const closeAll = useCallback(() => {
    for (const close of closers.current.values()) {
      try {
        close();
      } catch {
        // The proxy is already gone — nothing to clean up.
      }
    }
    closers.current.clear();
  }, []);

  // Forwards belong to ONE (projectId, sessionId). Leaving it — a session
  // switch, or the session view unmounting — closes every open forward first.
  // biome-ignore lint/correctness/useExhaustiveDependencies(projectId): intentional reset keys, not a stale-closure risk (nothing inside reads them).
  // biome-ignore lint/correctness/useExhaustiveDependencies(sessionId): same as projectId above.
  useEffect(() => {
    setRows(EMPTY_PORTS);
    return closeAll;
  }, [projectId, sessionId, closeAll]);

  const forward = useCallback(
    async (port: number, source: PortSource) => {
      try {
        const auth = authFromHost(host);
        const result = await startPortForward({
          auth,
          projectId,
          sessionId,
          forwards: [{ sandboxPort: port }],
          deps,
        });
        const opened = result.forwards[0];
        if (!opened) throw new Error(`No forward opened for sandbox port ${port}.`);
        closers.current.set(port, () => {
          opened.close();
          result.close();
        });
        setRows((current) => withForwarding(current, port, source, opened.localPort, opened.url));
        onToast?.(forwardedToast(opened), 'info');
      } catch (err) {
        const message = portForwardErrorMessage(err);
        setRows((current) => withError(current, port, source, message));
        onToast?.(`Forward sandbox:${port} failed: ${message}`, 'error');
      }
    },
    [host, projectId, sessionId, deps, onToast],
  );

  const notice = useCallback(
    (ports: number[], source: PortSource) => {
      const fresh = newlyDetected(rowsRef.current, ports.filter(isForwardablePort));
      if (fresh.length === 0) return;
      setRows((current) => fresh.reduce((next, port) => withDetected(next, port, source), current));
      if (autoForwardEnabled()) {
        for (const port of fresh) void forward(port, source);
      }
    },
    [forward],
  );

  const toggle = useCallback(
    (port: number) => {
      const row = rowsRef.current.get(port);
      if (!row) return;
      if (row.state === 'forwarding') {
        closers.current.get(port)?.();
        closers.current.delete(port);
        setRows((current) => withStopped(current, port));
        return;
      }
      void forward(port, row.source);
    },
    [forward],
  );

  const addManual = useCallback(
    (port: number) => {
      setRows((current) => withDetected(current, port, 'manual'));
      void forward(port, 'manual');
    },
    [forward],
  );

  const list = useMemo(() => sortedRows(rows), [rows]);

  // Memoized: a caller (SessionView) hoists this object to `app.tsx` in a
  // `useEffect([ports])`. Without this, a fresh object on every render would
  // fire that effect every render — an infinite `setState` loop, since every
  // effect run hoists a "new" reference up.
  return useMemo(
    () => ({ rows: list, notice, toggle, addManual }),
    [list, notice, toggle, addManual],
  );
}
