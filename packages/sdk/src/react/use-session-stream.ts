'use client';

/**
 * The session view's ONE live connection (R5.3), applied to the caches and
 * stores the rest of the SDK already reads.
 *
 * `useSession` mounts it. It joins the shared `GET .../events` stream with the
 * runtime channel (`openSessionStream`) and writes each server fact where its
 * poll used to land it:
 *
 *  - `kortix.control.turn`    → the `/turn` cache entry, with the server's
 *    `working` verdict (`useSessionWorking` reads it; its poll stands down);
 *  - `kortix.control.session` → the session title in the list and detail
 *    caches (no title ladder), and a provider refresh when the project's
 *    secrets version moves (no provider poll);
 *  - `kortix.control.runtime` → `qk.project.sessionRuntimeControl` (the box
 *    and the server wake ladder), and a `/start` re-read when the box row
 *    changes (no 1.5-60 s `/start` timer);
 *  - `kortix.control.audit`  → `qk.project.sessionAuditWatermark`, which a
 *    host's audit list re-reads on change (no 5-15 s audit poll);
 *  - `kortix.runtime.status` / `.health` → the connection store (no
 *    `/kortix/health` probe).
 *
 * Runtime events reach the reducers through `useRuntimeEventStream`, which
 * joins the same connection.
 */

import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import { useEffect, useSyncExternalStore } from 'react';
import {
  markInitialCheckDone,
  setConnectionStreamDriven,
  setRuntimeCapabilities,
  setRuntimeHealth,
  setSandboxStatus,
} from '../browser/stores/sandbox-connection-store';
import { sessionStartKey } from '../core/rest/projects-client';
import {
  openSessionStream,
  sessionStreamConnected,
  subscribeSessionStreamConnections,
  type SessionControlFrame,
} from '../core/session/control-stream';
import type { SessionWorkingVerdict } from '../core/session/working-server';
import { invalidateProjectProviderQueries } from './provider-refresh';
import { qk } from './query-keys';
import type { SessionTurnObservation } from './use-session-working';

/** Is this session's stream connected? Re-renders when it connects or drops. */
export function useSessionStreamConnected(projectId: string, sessionId: string): boolean {
  return useSyncExternalStore(
    subscribeSessionStreamConnections,
    () => !!projectId && !!sessionId && sessionStreamConnected(projectId, sessionId),
    () => false,
  );
}

interface TurnPayload {
  known?: boolean;
  turns?: SessionTurnObservation['turns'];
  last_ended?: SessionTurnObservation['last_ended'];
  recent_failures?: SessionTurnObservation['recent_failures'];
  working?: SessionWorkingVerdict;
}

interface SessionPayload {
  known?: boolean;
  title?: string | null;
  secrets_rev?: string;
}

interface RuntimePayload {
  sandbox_status?: string | null;
  external_id?: string | null;
  waking?: boolean;
  stop_reason?: string | null;
}

/** Write one control frame where its poll used to land. Exported for tests. */
export function applySessionControlFrame(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
  frame: SessionControlFrame,
  memory: { secretsRev?: string; runtimeKey?: string },
  nowMs: number = Date.now(),
): void {
  if (frame.type === 'kortix.control.turn') {
    const payload = frame.payload as TurnPayload;
    if (!payload?.known || !Array.isArray(payload.turns)) return;
    const observation: SessionTurnObservation = {
      turns: payload.turns,
      ...(payload.last_ended ? { last_ended: payload.last_ended } : {}),
      ...(payload.recent_failures ? { recent_failures: payload.recent_failures } : {}),
      ...(payload.working ? { working: payload.working } : {}),
      // This tab's clock at arrival. The server re-publishes an unchanged frame
      // every 20 s, so a live stream keeps the entry fresh.
      atMs: nowMs,
    };
    queryClient.setQueryData(qk.project.sessionTurn(projectId, sessionId), observation);
    return;
  }
  if (frame.type === 'kortix.control.session') {
    const payload = frame.payload as SessionPayload;
    if (!payload?.known) return;
    if (typeof payload.title === 'string' && payload.title) {
      patchCachedSessionTitle(queryClient, projectId, sessionId, payload.title);
    }
    if (typeof payload.secrets_rev === 'string') {
      // The first frame only records the version: the caches were read just now.
      if (memory.secretsRev !== undefined && memory.secretsRev !== payload.secrets_rev) {
        invalidateProjectProviderQueries(queryClient, projectId);
      }
      memory.secretsRev = payload.secrets_rev;
    }
    return;
  }
  if (frame.type === 'kortix.control.audit') {
    queryClient.setQueryData(qk.project.sessionAuditWatermark(projectId, sessionId), frame.payload);
    return;
  }
  if (frame.type === 'kortix.control.runtime') {
    const payload = frame.payload as RuntimePayload;
    queryClient.setQueryData(qk.project.sessionRuntimeControl(projectId, sessionId), payload);
    // A change to the box row is what moves `/start`'s stage. Re-read it then,
    // instead of on a timer. The first frame only records the row.
    const runtimeKey = JSON.stringify([
      payload?.sandbox_status ?? null,
      payload?.external_id ?? null,
      payload?.waking ?? false,
      payload?.stop_reason ?? null,
    ]);
    if (memory.runtimeKey !== undefined && memory.runtimeKey !== runtimeKey) {
      void queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
    }
    memory.runtimeKey = runtimeKey;
  }
}

function readTitle(row: Record<string, unknown>): string | null {
  return typeof row.name === 'string' ? row.name : null;
}

/** Put a server title on every cached row of this session. No request. */
export function patchCachedSessionTitle(
  queryClient: QueryClient,
  projectId: string,
  sessionId: string,
  title: string,
): void {
  const patchRow = (row: unknown): unknown => {
    if (!row || typeof row !== 'object') return row;
    const record = row as Record<string, unknown>;
    const id = typeof record.session_id === 'string' ? record.session_id : record.sessionId;
    if (id !== sessionId) return row;
    // A user's own name for the session is the title; never overwrite it.
    if (typeof record.custom_name === 'string' && record.custom_name.trim()) return row;
    return readTitle(record) === title ? row : { ...record, name: title };
  };
  const patch = (data: unknown): unknown => {
    if (Array.isArray(data)) {
      let changed = false;
      const next = data.map((row) => {
        const patched = patchRow(row);
        if (patched !== row) changed = true;
        return patched;
      });
      return changed ? next : data;
    }
    if (data && typeof data === 'object' && Array.isArray((data as { pages?: unknown }).pages)) {
      const paged = data as { pages: Array<{ items?: unknown[] }> };
      let changed = false;
      const pages = paged.pages.map((page) => {
        if (!Array.isArray(page?.items)) return page;
        const items = page.items.map((row) => {
          const patched = patchRow(row);
          if (patched !== row) changed = true;
          return patched;
        });
        return changed ? { ...page, items } : page;
      });
      return changed ? { ...paged, pages } : data;
    }
    return patchRow(data);
  };
  for (const [key, data] of queryClient.getQueriesData({ queryKey: qk.project.sessionsScope(projectId) })) {
    const next = patch(data);
    if (next !== data) queryClient.setQueryData(key, next);
  }
  const detailKey = qk.project.session(projectId, sessionId);
  const detail = queryClient.getQueryData(detailKey);
  const nextDetail = patch(detail);
  if (nextDetail !== detail) queryClient.setQueryData(detailKey, nextDetail);
}

/** Feed the connection store from the server's frames. Exported for tests. */
export function applyRuntimeStatus(status: { state: 'up' | 'down'; reason: string | null }): void {
  if (status.state === 'down') {
    // `sandbox_*`: the box is not running (parked); anything else is a
    // transient attach failure the server retries on its own ladder.
    const parked = (status.reason ?? '').startsWith('sandbox_') || status.reason === 'no_sandbox';
    setSandboxStatus('connecting');
    setRuntimeHealth(false, undefined, status.reason, { parked });
    markInitialCheckDone();
  }
}

export function applyRuntimeHealth(health: Record<string, unknown>): boolean {
  const harness = health.harness as { ready?: unknown; version?: unknown } | undefined;
  const ready = health.status !== 'starting' && health.status !== 'down' && health.status !== 'error' && harness?.ready !== false;
  const version =
    typeof health.version === 'string'
      ? health.version
      : typeof harness?.version === 'string'
        ? harness.version
        : undefined;
  if (Array.isArray(health.capabilities)) {
    setRuntimeCapabilities(health.capabilities.filter((entry): entry is string => typeof entry === 'string'));
  }
  setRuntimeHealth(ready, version, ready ? null : typeof health.reason === 'string' ? health.reason : null);
  if (ready) setSandboxStatus('connected');
  markInitialCheckDone();
  return ready;
}

/** Mount the session's stream and apply what it says. See the module header. */
export function useSessionStream(
  projectId: string,
  sessionId: string,
  options: { enabled?: boolean; tabId?: string } = {},
): boolean {
  const queryClient = useQueryClient();
  const enabled = options.enabled !== false && !!projectId && !!sessionId;
  useEffect(() => {
    if (!enabled) return;
    const memory: { secretsRev?: string; runtimeKey?: string; runtimeReady?: boolean } = {};
    const stream = openSessionStream({
      projectId,
      sessionId,
      runtime: true,
      ...(options.tabId ? { tabId: options.tabId } : {}),
      onControl: (frame) => {
        applySessionControlFrame(queryClient, projectId, sessionId, frame, memory);
        setConnectionStreamDriven(sessionStreamConnected(projectId, sessionId));
      },
      onRuntimeStatus: (status) => {
        if (status.state === 'down') memory.runtimeReady = false;
        applyRuntimeStatus(status);
      },
      onRuntimeHealth: (health) => {
        const ready = applyRuntimeHealth(health);
        // The runtime answering is what moves `/start` to `ready`: re-read it
        // now instead of waiting on its long-poll.
        if (ready && memory.runtimeReady === false) {
          void queryClient.invalidateQueries({ queryKey: sessionStartKey(projectId, sessionId) });
        }
        memory.runtimeReady = ready;
      },
      onConnectionChange: () => setConnectionStreamDriven(sessionStreamConnected(projectId, sessionId)),
    });
    return () => {
      stream.close();
      setConnectionStreamDriven(false);
    };
  }, [enabled, projectId, sessionId, queryClient, options.tabId]);
  return useSessionStreamConnected(projectId, sessionId);
}
