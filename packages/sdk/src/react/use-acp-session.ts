import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  createAcpSession,
  defaultAllowPermissionOption,
  type AcpConnectionState,
  type AcpContentBlock,
  type AcpJsonRpcId,
  type AcpSessionError,
  type AcpStoredEnvelope,
} from '../acp';
import { projectAcpEndpoint } from '../acp/project-session';
import { clearStartStash, readStartStash } from './session-start-stash';
import { SDK_VERSION } from '../version';

/** @deprecated Use `AcpStoredEnvelope` (`@kortix/sdk/acp`). */
export type AcpStoredSessionEnvelope = AcpStoredEnvelope;

/**
 * Thin `useSyncExternalStore` wrapper over the framework-free `AcpSession`
 * store (`../acp/session.ts`), which owns bootstrap (single-flight
 * `initialize` → `session/new`|`session/load`), the live stream, envelope
 * batching, and optimistic send/respond/cancel echoes. This hook only:
 *
 * - memoizes ONE `AcpSession` per `[projectId, sessionId, runtimeSessionId]`,
 * - drives its lifecycle (`connect()` on mount/enable, `close()` on
 *   unmount/disable — `close()` preserves the session's bootstrap, so a
 *   StrictMode remount or an `enabled` toggle never re-mints a second
 *   `session/new`),
 * - subscribes to its snapshot,
 * - replays a start-stash prompt (a host's "new session" screen hand-off —
 *   see `session-start-stash.ts`) exactly once, after the session becomes
 *   ready.
 */
export function useAcpSession({ projectId, sessionId, runtimeSessionId, enabled = true, replayStartStash = true }: {
  projectId: string;
  sessionId: string;
  runtimeSessionId?: string | null;
  enabled?: boolean;
  replayStartStash?: boolean;
}) {
  const session = useMemo(() => createAcpSession({
    endpoint: projectAcpEndpoint(projectId, sessionId),
    acpSessionId: runtimeSessionId ?? null,
    clientInfo: { name: '@kortix/sdk', title: 'Kortix SDK', version: SDK_VERSION },
  }), [projectId, sessionId, runtimeSessionId]);

  useEffect(() => {
    if (!enabled) return;
    session.connect();
    // `close()` tears down only the live stream/connection state — it
    // deliberately preserves `bootstrap`/`createdSessionId` on the session
    // instance, so a StrictMode double-invoke (cleanup + remount, same
    // `session` reference — see the `useMemo` above) or a later `enabled`
    // toggle reconnects to the already-bootstrapped session instead of
    // re-running `initialize`/`session/new`.
    return () => session.close();
  }, [enabled, session]);

  // `AcpSession`'s methods are plain prototype methods, not bound arrow
  // class fields (see `session.ts` — `subscribe`/`getSnapshot` read `this`),
  // so they can't be handed to `useSyncExternalStore` as bare references;
  // these thin wrappers preserve the `session` receiver at call time.
  const subscribe = useCallback((listener: () => void) => session.subscribe(listener), [session]);
  const getSnapshot = useCallback(() => session.getSnapshot(), [session]);
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  // Start-stash replay: fires at most once per mount, the instant the
  // session first becomes ready. Gated on a ref (not just `snapshot.ready`)
  // so a later snapshot update — e.g. a live SSE event — never re-triggers
  // it, and so StrictMode's double-invoke of this effect can't send the
  // stashed prompt twice.
  const replayedRef = useRef(false);
  useEffect(() => {
    if (!replayStartStash || !snapshot.ready || replayedRef.current) return;
    replayedRef.current = true;
    const stash = readStartStash(sessionId);
    if (!stash?.prompt) return;
    clearStartStash(sessionId);
    void session.send([{ type: 'text', text: stash.prompt }]);
  }, [replayStartStash, session, sessionId, snapshot.ready]);

  const send = useCallback((prompt: AcpContentBlock[]) => session.send(prompt), [session]);
  const cancel = useCallback(() => session.cancel(), [session]);
  const setConfigOption = useCallback(
    (configId: string, value: unknown) => session.setConfigOption(configId, value),
    [session],
  );
  const respondPermission = useCallback(
    (id: AcpJsonRpcId, optionId?: string) => session.respondPermission(id, optionId),
    [session],
  );
  const respondQuestion = useCallback(
    (id: AcpJsonRpcId, content: Record<string, unknown>) => session.respondQuestion(id, content),
    [session],
  );
  const rejectQuestion = useCallback((id: AcpJsonRpcId) => session.rejectQuestion(id), [session]);

  // "Allow everything for this session" — a client-side backstop that
  // auto-approves every pending permission (current and future, while the
  // flag is on) with the same option `defaultAllowPermissionOption` picks for
  // the "Allow once" button. Ported from the pre-store hook (which folded
  // `projectAcpPendingPrompts(envelopes)` itself); here it rides the store's
  // already-projected, reference-stable `snapshot.pendingPrompts.permissions`.
  // A ref of already-responded ids guards against double-responding across
  // the re-renders a single open request survives (the optimistic echo clears
  // it from `pendingPrompts` on the next snapshot, but not synchronously).
  const [autoApprovePermissions, setAutoApprovePermissions] = useState(false);
  const autoRepliedPermissionIds = useRef<Set<string>>(new Set());
  const pendingPermissions = snapshot.pendingPrompts.permissions;
  useEffect(() => {
    if (!autoApprovePermissions) {
      autoRepliedPermissionIds.current.clear();
      return;
    }
    for (const permission of pendingPermissions) {
      const key = JSON.stringify(permission.id);
      if (autoRepliedPermissionIds.current.has(key)) continue;
      autoRepliedPermissionIds.current.add(key);
      const optionId = defaultAllowPermissionOption(permission.options)?.optionId;
      void Promise.resolve(respondPermission(permission.id, optionId)).catch(() => {
        autoRepliedPermissionIds.current.delete(key);
      });
    }
  }, [autoApprovePermissions, pendingPermissions, respondPermission]);
  /** Re-runs bootstrap after a terminal failure (`connection === 'failed'`)
   *  — `AcpSession.connect()` is idempotent everywhere else, but a failed
   *  bootstrap nulls out `this.bootstrap` (see `runBootstrap`'s catch), so
   *  calling `connect()` again is exactly what re-arms it. */
  const retry = useCallback(() => { session.connect(); }, [session]);

  return {
    ready: snapshot.ready,
    busy: snapshot.busy,
    error: snapshot.error?.message ?? null,
    envelopes: snapshot.envelopes,
    /** Reference-stable per turn: an unchanged item keeps its previous
     *  identity across snapshots (see `AcpSession`'s `chatItems` doc
     *  comment in `../acp/session.ts`), so a `memo`-wrapped row component
     *  keyed on an item only re-renders when ITS item actually changed. */
    chatItems: snapshot.chatItems,
    /** Reference-stable across any snapshot update that doesn't open or
     *  close a permission/question request (see `AcpSession`'s
     *  `pendingPromptsCache`). */
    pendingPrompts: snapshot.pendingPrompts,
    usage: snapshot.usage,
    configOptions: snapshot.configOptions,
    capabilities: snapshot.capabilities,
    agentInfo: snapshot.agentInfo,
    authMethods: snapshot.authMethods,
    send,
    cancel,
    setConfigOption,
    respondPermission,
    respondQuestion,
    rejectQuestion,
    /** "Allow everything for this session" toggle — auto-approves every
     *  pending (and future) permission while true. Consumed by the web
     *  composer's permission prompt. */
    autoApprovePermissions,
    setAutoApprovePermissions,
    acpSessionId: snapshot.acpSessionId,
    connection: snapshot.connection satisfies AcpConnectionState,
    errorInfo: snapshot.error satisfies AcpSessionError | null,
    retry,
    /** @deprecated Use `acpSessionId`. */
    runtimeSessionId: snapshot.acpSessionId,
  };
}
