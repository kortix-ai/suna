'use client';

/**
 * useSession — the ONE hook a host needs to open a session and stream a chat.
 *
 * Everything sandbox-shaped is internal: it drives `/start` (server long-poll),
 * points the runtime at the session's sandbox, opens the SSE stream, resolves the
 * canonical OpenCode id, and syncs messages — exposing one `phase`
 * (starting|ready|error) plus messages/send/abort/questions/permissions and the
 * server-side capabilities (models/agents/commands/picks). The host imports
 * `createKortix` + `useSession` and NOTHING else runtime-related: no server-store,
 * no `switchToSessionSandboxAsync`, no health poller, no event-stream provider.
 *
 * Readiness comes from the SERVER (`stage==='ready'` is only returned after the
 * daemon answered), seeded into the connection store on switch — so there is NO
 * client health poller, and the first turn streams immediately.
 *
 * Call this ONCE per session view (like a provider): it owns the SSE subscription
 * and the `/start` poll for `(projectId, sessionId)`.
 */

import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import { useOpenCodePendingStore } from '../state/opencode-pending-store';
import {
  markRuntimeReadyVerified,
  setOpenCodeHealth,
  setSandboxStatus,
} from '../state/sandbox-connection-store';
import { switchToSessionSandboxAsync } from '../state/server-store';
import {
  type SessionStartResult,
  sessionStartKey,
  startProjectSession,
} from '../platform/projects-client';
import { useCanonicalOpenCodeSession } from './use-canonical-opencode-session';
import { useOpenCodeEventStream } from './use-opencode-events';
import type { ModelKey } from './use-model-store';
import { useProjectConfig } from './use-project-config';
import { useProjectModels } from './use-project-models';
import { useRuntimePhase } from './use-runtime-phase';
import { clearStartStash, readStartStash } from './session-start-stash';
import { useSessionPicks } from './use-session-picks';
import { useSessionSync } from './use-session-sync';
import { useVisibleAgents } from './use-visible-agents';
import {
  useAbortOpenCodeSession,
  useExecuteOpenCodeCommand,
  useSendOpenCodeMessage,
} from './use-opencode-sessions';

/** Coarse session lifecycle for the host's top-level gating. */
export type SessionPhase = 'starting' | 'ready' | 'error';

export interface UseSessionOptions {
  /** Long-poll budget (ms) the client requests on `/start`; the server clamps it. */
  waitMs?: number;
  /**
   * Replay a stashed first message (prompt + model + agent from the "new session"
   * screen) once the runtime is ready and the thread is empty. Default true. Hosts
   * with their own first-message hand-off (e.g. apps/web) set this false.
   */
  replayStartStash?: boolean;
  /**
   * Gate the whole hook (the /start poll + switch + SSE). Default true. Set false
   * to hold off until a precondition is met (e.g. a billing gate resolves) — mirrors
   * a query `enabled` flag.
   */
  enabled?: boolean;
}

export function useSession(
  projectId: string,
  sessionId: string,
  options: UseSessionOptions = {},
) {
  const { waitMs = 15_000, replayStartStash = true, enabled = true } = options;

  // 1. Drive /start until the runtime is ready (the server long-polls each tick).
  const start = useQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => startProjectSession(projectId, sessionId, waitMs),
    enabled: enabled && !!projectId && !!sessionId,
    refetchInterval: (q) => {
      const stage = (q.state.data as SessionStartResult | null | undefined)?.stage;
      return stage === 'ready' || stage === 'failed' || stage === 'stopped' ? false : 1500;
    },
  });
  const startData = start.data ?? null;
  const stage = startData?.stage ?? null;
  const sandbox = startData?.sandbox ?? null;
  const startReady = stage === 'ready';
  const terminal = stage === 'failed' || stage === 'stopped';

  // 2. Point the SDK's runtime at this session's sandbox once ready. Track WHICH
  // sandbox we switched to (not a bare bool) so navigating between sessions (this
  // hook instance is reused) re-gates instead of binding the new session to the
  // previous sandbox. One active session at a time is the supported model, so the
  // whole chat path (SSE, sync, send) rides this single global switch — there is no
  // separate per-session client to keep in sync.
  const [switchedSandboxId, setSwitchedSandboxId] = useState<string | null>(null);
  useEffect(() => {
    if (!startReady || !sandbox || switchedSandboxId === sandbox.sandbox_id) return;
    let cancelled = false;
    // Seed readiness from the server's proof BEFORE the switch: stage==='ready' is
    // only returned after the daemon answered, so the post-switch connection store
    // starts connected+healthy (resetForServerSwitch reads this flag) — no client
    // health poll, and the first turn streams instead of bulk-rendering.
    markRuntimeReadyVerified();
    switchToSessionSandboxAsync(projectId, sessionId, sandbox).then((res) => {
      if (!cancelled && res) setSwitchedSandboxId(sandbox.sandbox_id);
    });
    return () => {
      cancelled = true;
    };
  }, [startReady, projectId, sessionId, sandbox, switchedSandboxId]);

  const switched =
    startReady && !!sandbox && switchedSandboxId === sandbox.sandbox_id;

  // 3. Keep the connection store healthy from server-truth while switched, with NO
  // poller. If the box later dies mid-session the SSE's own disconnect/heartbeat
  // handling drives recovery (no steady-state health loop to halt — the old
  // first-load bug is structurally gone).
  useEffect(() => {
    if (!switched) return;
    setSandboxStatus('connected');
    setOpenCodeHealth(true);
  }, [switched]);

  // 4. Open the live SSE stream. This was a provider component (OpenCodeEvent
  // StreamProvider); calling the underlying hook here means the host mounts
  // nothing. It self-gates on the connection store's healthy flag (seeded above).
  useOpenCodeEventStream();

  // 5. Resolve the canonical OpenCode root id (server-owned; /start hands it over)
  // and sync messages off it.
  const { rootSessionId } = useCanonicalOpenCodeSession({
    projectId,
    sessionId,
    pinFromStart: startData?.opencode_session_id ?? null,
  });
  const ocSessionId = rootSessionId ?? '';
  const sync = useSessionSync(ocSessionId);
  const runtimePhase = useRuntimePhase();

  // 6. Interactive prompts live in the pending store (the SSE writes them there,
  // keyed by request id carrying sessionID). useSessionSync does NOT surface them.
  const questionMap = useOpenCodePendingStore((s) => s.questions);
  const permissionMap = useOpenCodePendingStore((s) => s.permissions);
  const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);
  const removePermission = useOpenCodePendingStore((s) => s.removePermission);
  const questions = useMemo(
    () => Object.values(questionMap).filter((q) => q.sessionID === ocSessionId),
    [questionMap, ocSessionId],
  );
  const permissions = useMemo(
    () => Object.values(permissionMap).filter((p) => p.sessionID === ocSessionId),
    [permissionMap, ocSessionId],
  );

  // 7. Server-side capabilities + per-session picks (all pre-runtime — no sandbox).
  const models = useProjectModels(projectId);
  const agents = useVisibleAgents({ projectId });
  const config = useProjectConfig(projectId);
  const picks = useSessionPicks(sessionId);

  // 8. Mutations.
  const sendMutation = useSendOpenCodeMessage();
  const abortMutation = useAbortOpenCodeSession();
  const commandMutation = useExecuteOpenCodeCommand();

  // 9. Optimistic send: show the user's message instantly until a NEW user message
  // lands (count grows) — robust to server-normalized text where a text-equality
  // match would clear too early or never (wedging the composer). 30s backstop.
  const userMsgCount = useMemo(
    () => sync.messages.filter((m) => m.info.role === 'user').length,
    [sync.messages],
  );
  const [pending, setPending] = useState<string | null>(null);
  const pendingBaseCount = useRef(0);
  useEffect(() => {
    if (pending && userMsgCount > pendingBaseCount.current) setPending(null);
  }, [userMsgCount, pending]);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setPending(null), 30_000);
    return () => clearTimeout(t);
  }, [pending]);

  const send = (
    text: string,
    override?: { model?: ModelKey | null; agent?: string | null },
  ) => {
    if (!ocSessionId) return;
    pendingBaseCount.current = userMsgCount;
    setPending(text);
    const model = override?.model ?? picks.model;
    const agent = override?.agent ?? picks.agent;
    const opts = { ...(model ? { model } : {}), ...(agent ? { agent } : {}) };
    sendMutation.mutate(
      {
        sessionId: ocSessionId,
        parts: [{ type: 'text', text }],
        ...(Object.keys(opts).length ? { options: opts } : {}),
      },
      { onError: () => setPending(null) },
    );
  };

  // Run a project slash-command (server-side `/command`), distinct from a prompt.
  const runCommand = (command: string, args: string) => {
    if (!ocSessionId) return;
    commandMutation.mutate({ sessionId: ocSessionId, command, args });
  };

  // The one true cancel: abort the run AND drop any pending prompt + open prompts.
  const cancel = () => {
    if (ocSessionId) abortMutation.mutate(ocSessionId);
    questions.forEach((q) => removeQuestion(q.id));
    permissions.forEach((p) => removePermission(p.id));
    setPending(null);
  };

  const phase: SessionPhase = terminal ? 'error' : switched ? 'ready' : 'starting';

  // 10. Replay the new-session hand-off once ready + thread empty (exactly once).
  const startedRef = useRef(false);
  useEffect(() => {
    if (!replayStartStash) return;
    if (startedRef.current || phase !== 'ready' || sync.isLoading) return;
    const stash = readStartStash(sessionId);
    if (!stash) return;
    startedRef.current = true;
    clearStartStash(sessionId);
    if (sync.messages.length > 0) return;
    if (stash.model) picks.setModel(stash.model);
    if (stash.agent) picks.setAgent(stash.agent);
    send(stash.prompt, { model: stash.model, agent: stash.agent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sync.isLoading, sync.messages.length, sessionId, replayStartStash]);

  return {
    projectId,
    sessionId,
    /** Canonical OpenCode root id, or null while resolving. */
    opencodeSessionId: rootSessionId ?? null,

    // live data
    messages: sync.messages,
    status: sync.status,
    questions,
    permissions,
    diffs: sync.diffs,
    todos: sync.todos,

    // lifecycle
    phase,
    /** Raw /start stage (provisioning|starting|ready|stopped|failed), for boot UI. */
    stage,
    /** The serialized session_sandboxes row from /start (status, metadata, ids), or null. */
    sandbox,
    /** True once the runtime is switched in and ready (equivalent to phase==='ready'). */
    switched,
    /** Whether polling /start again can still make progress (false = terminal). */
    retriable: startData?.retriable ?? false,
    /** Granular boot phase (connecting|booting|ready|unreachable) for detailed UI. */
    runtimePhase,
    isBusy: sync.isBusy || !!pending,
    isLoading: sync.isLoading,
    isError: terminal,
    /** Whether there are open interactive prompts (questions/permissions). */
    hasPending: questions.length > 0 || permissions.length > 0,
    /** Latest /start reason (e.g. 'runtime_waking'), surfaced for boot/error UI. */
    reason: startData?.reason ?? null,
    /** Pending optimistic message text, or null. */
    pending,

    // server-side capabilities (pre-runtime)
    models,
    agents,
    defaultAgent: config?.open_code_default_agent ?? null,
    commands: config?.commands ?? [],
    picks,

    // actions
    send,
    cancel,
    runCommand,
    removeQuestion,
    removePermission,
    /** Force a re-poll of /start (e.g. a Retry button on the boot screen). */
    retry: () => {
      void start.refetch();
    },
  };
}

export type UseSessionResult = ReturnType<typeof useSession>;
