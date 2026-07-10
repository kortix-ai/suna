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

import { RuntimeNotReadyError } from '../opencode/client';
import { useOpenCodePendingStore } from '../browser/stores/opencode-pending-store';
import {
  setOpenCodeHealth,
  setSandboxStatus,
} from '../browser/stores/sandbox-connection-store';
import { getSandboxUrlForExternalId } from '../browser/stores/server-store';
import { setCurrentRuntime } from '../state/current-runtime';
import {
  isSessionStartError,
  type SessionStartResult,
  sessionStartKey,
  startProjectSession,
} from '../platform/projects-client';
import { isSessionFresh } from '../platform/fresh-sessions';
import { BillingError, parseBillingError } from '../platform/api/errors';
import { formatOpenCodeRuntimeError } from '../platform/opencode-errors';
import { useCanonicalOpenCodeSession } from './use-canonical-opencode-session';
import { useOpenCodeEventStream } from './use-opencode-events';
import type { ModelKey } from './use-model-store';
import { useProjectConfig } from './use-project-config';
import { useProjectModels } from './use-project-models';
import { useQuestionSelfHeal } from './use-question-self-heal';
import { useRuntimePhase } from './use-runtime-phase';
import { clearStartStash, readStartStash } from './session-start-stash';
import { useSessionPicks } from './use-session-picks';
import { useSessionSync } from './use-session-sync';
import { useVisibleAgents } from './use-visible-agents';
import {
  rejectQuestion as rejectQuestionApi,
  replyToPermission,
  replyToQuestion,
  useAbortOpenCodeSession,
  useExecuteOpenCodeCommand,
  useSendOpenCodeMessage,
} from './use-opencode-sessions';

/** Coarse session lifecycle for the host's top-level gating. */
export type SessionPhase = 'starting' | 'ready' | 'error';

// Grace window for the optimistic create-vs-start race: how long /start keeps
// retrying a 404 for a freshly-minted session before treating it as terminal.
// ~12 × 800ms ≈ 9.6s, comfortably past the sub-second create POST.
const FRESH_START_404_RETRIES = 12;
const FRESH_START_404_RETRY_DELAY_MS = 800;

/**
 * Whether the `/start` poll should retry. A 404 on a freshly-minted session is
 * the optimistic create-vs-start race (the create POST hasn't landed yet), so
 * retry it for the grace window; a 404 on any other (non-fresh) session is a
 * genuinely-missing/no-access session and is terminal at once. Other terminal
 * SessionStartErrors never retry; transient transport failures retry a few times.
 */
export function shouldRetrySessionStart(
  failureCount: number,
  error: unknown,
  sessionId: string,
): boolean {
  if (isSessionStartError(error) && error.status === 404 && isSessionFresh(sessionId)) {
    return failureCount < FRESH_START_404_RETRIES;
  }
  return !isSessionStartError(error) && failureCount < 3;
}

// ─────────────────────────────────────────────────────────────────────────────
// Send-error classification. `send`/the reply actions below never throw for
// back-compat (`send`) or so a host doesn't need a try/catch for the common
// case; failures are surfaced as this typed union instead.
// ─────────────────────────────────────────────────────────────────────────────

/** Discriminant for `KortixSendError` — what kind of failure interrupted a send. */
export type KortixSendErrorKind = 'billing' | 'runtime-not-ready' | 'runtime-error';

/** Typed failure surfaced by `send` (via `sendError`) and thrown by
 * `answerQuestion`/`rejectQuestion`/`answerPermission`. */
export interface KortixSendError {
  kind: KortixSendErrorKind;
  /** Human-readable message, already formatted for display. */
  message: string;
  /** Present when `kind === 'billing'` — the parsed 402 detail. */
  billing?: BillingError;
  /** The original thrown value, for callers that want more detail. */
  cause: unknown;
}

// `getClient()` (packages/sdk/src/opencode/client.ts) throws a
// `RuntimeNotReadyError` with this exact message when the sandbox url hasn't
// been resolved yet (session still starting). The string match is kept as a
// fallback for callers that re-wrap the original error (losing the
// `instanceof` chain) but still preserve its message.
const RUNTIME_NOT_READY_MARKER = 'Server URL not ready';

/** Classify a thrown/rejected error from a send or a permission/question reply
 * into a `KortixSendError`. Pure — safe to unit test without a runtime. */
export function classifySendError(error: unknown): KortixSendError {
  if (
    error instanceof RuntimeNotReadyError ||
    (error instanceof Error && error.message.includes(RUNTIME_NOT_READY_MARKER))
  ) {
    return {
      kind: 'runtime-not-ready',
      message: 'The session runtime is still starting — try again in a moment.',
      cause: error,
    };
  }

  if (error && typeof error === 'object') {
    const parsed = parseBillingError(error);
    if (parsed instanceof BillingError) {
      return { kind: 'billing', message: parsed.message, billing: parsed, cause: error };
    }
  }

  const formatted = formatOpenCodeRuntimeError(error);
  return { kind: 'runtime-error', message: formatted.message, cause: error };
}

/** The optimistic-send + last-error state `send` drives. Modeled as a small
 * reducer-ish pair of pure helpers so the transition logic is unit-testable
 * without rendering the hook. */
export interface SendState {
  /** Pending optimistic message text, or null. */
  pending: string | null;
  /** Last send failure, or null. Reset on every new `send` call. */
  sendError: KortixSendError | null;
}

const IDLE_SEND_STATE: SendState = { pending: null, sendError: null };

/** New state when a send is kicked off — always clears any previous error. */
export function sendStateOnStart(text: string): SendState {
  return { pending: text, sendError: null };
}

/** New state when a send fails — drops the optimistic message and classifies
 * the error. */
export function sendStateOnError(error: unknown): SendState {
  return { pending: null, sendError: classifySendError(error) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Permission/question replies. Standalone (not closures over hook state) since
// they only need the global runtime client + the global pending store — both
// singletons — so they double as the implementation AND a directly testable,
// hook-free surface.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Answer an agent question through the session's runtime and drop it from
 * local pending state — but only once the server has actually accepted the
 * reply. On failure the question stays pending and a `KortixSendError` is
 * thrown.
 */
export async function answerQuestion(requestId: string, answers: string[][]): Promise<void> {
  try {
    await replyToQuestion(requestId, answers);
  } catch (error) {
    throw classifySendError(error);
  }
  useOpenCodePendingStore.getState().removeQuestion(requestId);
}

/** Reject an agent question through the session's runtime (see `answerQuestion`). */
export async function rejectQuestion(requestId: string): Promise<void> {
  try {
    await rejectQuestionApi(requestId);
  } catch (error) {
    throw classifySendError(error);
  }
  useOpenCodePendingStore.getState().removeQuestion(requestId);
}

/** Answer an agent permission request through the session's runtime (see `answerQuestion`). */
export async function answerPermission(
  requestId: string,
  reply: 'once' | 'always' | 'reject',
  message?: string,
): Promise<void> {
  try {
    await replyToPermission(requestId, reply, message);
  } catch (error) {
    throw classifySendError(error);
  }
  useOpenCodePendingStore.getState().removePermission(requestId);
}

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
  /**
   * Mount the chat-consumption engine — `useSessionSync` (messages/status/diffs/
   * todos, including its 10s busy-poll SSE-stall fallback) and `useQuestionSelfHeal`
   * (the 2s missed-`question.asked` self-heal poll) — on top of the boot/lifecycle
   * machinery every host needs. Default true.
   *
   * Set this false when the host mounts its OWN chat surface for the same
   * `(projectId, sessionId)` (e.g. apps/web's `SessionChat`, which has its own
   * `useSessionSync` + `useQuestionSelfHeal`): with two callers of `useSession`
   * alive for the same session — this hook (for boot/lifecycle) and the host's
   * chat component — leaving it `true` would double-mount both pollers, running
   * the question self-heal poll twice and the busy-poll fallback at ~2x cadence
   * for no benefit, since nothing reads this hook's chat fields anyway.
   *
   * When `false`: `messages`/`diffs`/`todos` are empty arrays, `status` is the
   * idle status, `isBusy`/`isLoading` are `false`, `questions`/`permissions` stay
   * live (populated by SSE via the still-active event stream, just without the
   * self-heal poll backstop), and `replayStartStash` is force-disabled (it reads
   * the now-empty chat state, so it would never fire correctly). Everything the
   * boot/lifecycle fields need — `start`/`switch`/`runtimePhase`/`sandbox`/`stage`/
   * `opencodeSessionId` — is unaffected.
   */
  chatEngine?: boolean;
}

/** Stable, empty chat state — used when `chatEngine: false` so the hook's
 * public chat fields stay type-stable (empty arrays/idle status, never
 * `undefined`) instead of leaking whatever an unmounted-in-spirit
 * `useSessionSync('')` call happens to return. */
const DISABLED_CHAT_ENGINE_SYNC = {
  messages: [] as ReturnType<typeof useSessionSync>['messages'],
  status: { type: 'idle' } as ReturnType<typeof useSessionSync>['status'],
  isBusy: false,
  isLoading: false,
  diffs: [] as ReturnType<typeof useSessionSync>['diffs'],
  todos: [] as ReturnType<typeof useSessionSync>['todos'],
};

export function useSession(
  projectId: string,
  sessionId: string,
  options: UseSessionOptions = {},
) {
  const {
    waitMs = 15_000,
    replayStartStash = true,
    enabled = true,
    chatEngine = true,
  } = options;

  // 1. Drive /start until the runtime is ready (the server long-polls each tick).
  const start = useQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => startProjectSession(projectId, sessionId, waitMs),
    enabled: enabled && !!projectId && !!sessionId,
    retry: (failureCount, error) => shouldRetrySessionStart(failureCount, error, sessionId),
    retryDelay: (failureCount, error) =>
      isSessionStartError(error) && error.status === 404
        ? FRESH_START_404_RETRY_DELAY_MS
        : Math.min(1000 * 2 ** failureCount, 5000),
    refetchInterval: (q) => {
      if (isSessionStartError(q.state.error)) return false;
      const stage = (q.state.data as SessionStartResult | null | undefined)?.stage;
      return stage === 'ready' || stage === 'failed' || stage === 'stopped' ? false : 1500;
    },
  });
  const startData = start.data ?? null;
  const startError = isSessionStartError(start.error) ? start.error : null;
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
    if (!startReady || !sandbox?.external_id || switchedSandboxId === sandbox.sandbox_id) return;
    // Point the app's runtime at THIS session's box — no global "switch", just set
    // the current runtime url. Every read (getClient, the SSE stream, files/
    // terminal/git) resolves through it. `stage==='ready'` is server-proven, so the
    // health effect below seeds connected+healthy with no client poll.
    setCurrentRuntime(getSandboxUrlForExternalId(sandbox.external_id), sandbox.external_id, sandbox.sandbox_id);
    setSwitchedSandboxId(sandbox.sandbox_id);
  }, [startReady, sandbox, switchedSandboxId]);
  // Clear the current runtime when this session view unmounts.
  useEffect(() => () => setCurrentRuntime(null), []);

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
  // Always call the hook (rules-of-hooks) so it stays in the same position
  // every render, but starve it with an empty session id when the chat engine
  // is off — `useSessionSync('')` fetches/polls nothing (its effects no-op on
  // a falsy/non-canonical session id) — and use a fixed, type-stable empty
  // result instead of whatever it happens to return for that starved call.
  const rawSync = useSessionSync(chatEngine ? ocSessionId : '');
  const sync = chatEngine ? rawSync : DISABLED_CHAT_ENGINE_SYNC;
  const runtimePhase = useRuntimePhase();

  // 5b. Self-heal a missed `question.asked` SSE event (a `question` tool part
  // rendering as running with nothing in the pending store) — see
  // `useQuestionSelfHeal` for why this is distinct from the SSE reconnect-gap
  // hydration in `useOpenCodeEventStream`. Disabled entirely when `chatEngine`
  // is off — see that option's jsdoc: a host mounting its own chat surface
  // already runs its own copy of this poller for the same session.
  useQuestionSelfHeal(ocSessionId, sync.messages, { enabled: chatEngine && !!ocSessionId });

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
  const [sendState, setSendState] = useState<SendState>(IDLE_SEND_STATE);
  const pending = sendState.pending;
  const pendingBaseCount = useRef(0);
  useEffect(() => {
    if (pending && userMsgCount > pendingBaseCount.current) {
      setSendState((s) => (s.pending ? { ...s, pending: null } : s));
    }
  }, [userMsgCount, pending]);
  useEffect(() => {
    if (!pending) return;
    const t = setTimeout(() => setSendState((s) => (s.pending ? { ...s, pending: null } : s)), 30_000);
    return () => clearTimeout(t);
  }, [pending]);

  const send = (
    text: string,
    override?: { model?: ModelKey | null; agent?: string | null; variant?: string | null },
  ) => {
    if (!ocSessionId) return;
    pendingBaseCount.current = userMsgCount;
    setSendState(sendStateOnStart(text));
    const model = override?.model ?? picks.model;
    const agent = override?.agent ?? picks.agent;
    const variant = override?.variant;
    const opts = {
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      ...(variant ? { variant } : {}),
    };
    sendMutation.mutate(
      {
        sessionId: ocSessionId,
        parts: [{ type: 'text', text }],
        ...(Object.keys(opts).length ? { options: opts } : {}),
      },
      { onError: (err) => setSendState(sendStateOnError(err)) },
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
    setSendState(IDLE_SEND_STATE);
  };

  const phase: SessionPhase = terminal || startError ? 'error' : switched ? 'ready' : 'starting';

  // 10. Replay the new-session hand-off once ready + thread empty (exactly once).
  // Force-disabled when `chatEngine` is off: this reads `sync.isLoading`/
  // `sync.messages`, which are the fixed empty stand-ins above when the chat
  // engine isn't mounted, so it could never correctly gate on thread-empty —
  // a host that disables the chat engine already owns its own hand-off.
  const startedRef = useRef(false);
  useEffect(() => {
    if (!replayStartStash || !chatEngine) return;
    if (startedRef.current || phase !== 'ready' || sync.isLoading) return;
    const stash = readStartStash(sessionId);
    if (!stash) return;
    startedRef.current = true;
    clearStartStash(sessionId);
    if (sync.messages.length > 0) return;
    if (stash.model) picks.setModel(stash.model);
    if (stash.agent) picks.setAgent(stash.agent);
    send(stash.prompt, { model: stash.model, agent: stash.agent, variant: stash.variant });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sync.isLoading, sync.messages.length, sessionId, replayStartStash, chatEngine]);

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
    /** Terminal /start failure, for hosts to render instead of spinning forever. */
    startError,
    /** Granular boot phase (connecting|booting|ready|unreachable) for detailed UI. */
    runtimePhase,
    isBusy: sync.isBusy || !!pending,
    isLoading: sync.isLoading,
    isError: terminal || !!startError,
    /** Whether there are open interactive prompts (questions/permissions). */
    hasPending: questions.length > 0 || permissions.length > 0,
    /** Latest /start reason (e.g. 'runtime_waking'), surfaced for boot/error UI. */
    reason: startData?.reason ?? null,
    /** Pending optimistic message text, or null. */
    pending,
    /** True while the current `send` mutation is in flight. */
    isSending: sendMutation.isPending,
    /** Last `send` failure, typed (billing / runtime-not-ready / runtime-error),
     * or null. Reset on every new `send` call. */
    sendError: sendState.sendError,

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
    /** Answer an agent question through the server and drop it from pending
     * state on success; throws a `KortixSendError` and leaves it pending on
     * failure. */
    answerQuestion,
    /** Reject an agent question through the server (see `answerQuestion`). */
    rejectQuestion,
    /** Answer an agent permission request through the server (see `answerQuestion`). */
    answerPermission,
    /** @deprecated Drops the question from local state WITHOUT replying to the
     * server — the agent run stays blocked waiting on it. Use `answerQuestion`
     * / `rejectQuestion` instead. */
    removeQuestion,
    /** @deprecated Drops the permission request from local state WITHOUT
     * replying to the server — the agent run stays blocked waiting on it. Use
     * `answerPermission` instead. */
    removePermission,
    /** Force a re-poll of /start (e.g. a Retry button on the boot screen). */
    retry: () => {
      void start.refetch();
    },
  };
}

export type UseSessionResult = ReturnType<typeof useSession>;
