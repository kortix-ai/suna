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

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  beginSessionPromptObservation,
  endSessionPromptObservation,
} from '../browser/session-sync/session-sync-registry';
import { useOpenCodeCompactionStore } from '../browser/stores/opencode-compaction-store';
import { useOpenCodePendingStore } from '../browser/stores/opencode-pending-store';
import { setOpenCodeHealth, setSandboxStatus } from '../browser/stores/sandbox-connection-store';
import { getSandboxUrlForExternalId } from '../browser/stores/server-store';
import { useSyncStore } from '../browser/stores/sync-store';
import { BillingError, parseBillingError } from '../core/http/api/errors';
import { isSessionFresh } from '../core/http/fresh-sessions';
import { formatOpenCodeRuntimeError } from '../core/http/opencode-errors';
import {
  type SessionStartResult,
  isSessionStartError,
  sessionStartKey,
  startProjectSession,
} from '../core/rest/projects-client';
import { RuntimeNotReadyError, getClient } from '../core/runtime/client';
import { setCurrentRuntime } from '../core/session/current-runtime';
import {
  type SessionRewindState,
  commitSessionRewind,
  messagesBeforeRewind,
  reconcileCommittedSessionRewind,
} from '../core/session/rewind';
import { extractGatewayErrorDetails } from '../core/turns/errors';
import { clearStartStash, readStartStash } from './session-start-stash';
import { reconcileHydratedSessionTitle } from './session-title-sync';
import { useCanonicalOpenCodeSession } from './use-canonical-opencode-session';
import type { ModelKey } from './use-model-store';
import { useOpenCodeEventStream } from './use-opencode-events';
import { formatModelString } from './use-opencode-local';
import {
  type PromptPart,
  rejectQuestion as rejectQuestionApi,
  replyToPermission,
  replyToQuestion,
  useAbortOpenCodeSession,
  useExecuteOpenCodeCommand,
  useSendOpenCodeMessage,
} from './use-opencode-sessions';
import { unwrap } from './use-opencode-sessions/shared';
import { usePermissionSelfHeal } from './use-permission-self-heal';
import { useProjectConfig } from './use-project-config';
import { useProjectModels } from './use-project-models';
import { useQuestionSelfHeal } from './use-question-self-heal';
import { useRuntimePhase } from './use-runtime-phase';
import { useSessionPicks } from './use-session-picks';
import { derivePhase } from './use-session-phase';
import { useSessionSync } from './use-session-sync';
import { useVisibleAgents } from './use-visible-agents';

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

/**
 * Gap between `/start` polls. The server long-polls each tick, so this is the
 * pause between holds, not the latency to observe `ready`.
 */
export const SESSION_START_POLL_MS = 1_500;

/**
 * Should the `/start` boot poll fire again, given the last tick's outcome?
 * `false` = stop: a terminal stage, or a terminal client error that no amount
 * of polling can fix. Everything else keeps polling — including a `null`
 * payload from a transient transport failure, since the box is still coming up.
 */
export function shouldPollSessionStart(
  error: unknown,
  data: SessionStartResult | null | undefined,
): number | false {
  if (isSessionStartError(error)) return false;
  if (data?.retriable === false) return false;
  const stage = data?.stage;
  return stage === 'ready' || stage === 'failed' || stage === 'stopped'
    ? false
    : SESSION_START_POLL_MS;
}

/**
 * How long `/start` can return NEITHER data NOR an error before it counts as
 * "given up" rather than "still working".
 *
 * `startProjectSession` swallows every 5xx/408/429/transport failure into a
 * `null` result instead of throwing
 * (`core/rest/projects-client/session-sandbox.ts`), so on a persistent
 * outage `start.error` and `start.data` both stay `null` forever and
 * `shouldPollSessionStart(null, null)` keeps returning `SESSION_START_POLL_MS`
 * — there is no terminal stage and no error ever produced to observe.
 * Without this ceiling, a caller waiting for `/start` to "settle" (e.g. the
 * `phase` derivation below) can never learn it gave up, and a runtime error
 * arriving alongside a wedged `/start` pins that caller in "still starting"
 * forever — a silent hang, strictly worse than a visible error card.
 *
 * A genuine resume never trips this: every poll on a resuming box returns
 * real `data` (a `stage`), so the inconclusive clock keeps resetting and this
 * budget never starts counting — it only fires when `/start` itself has
 * nothing to say, tick after tick. A cold sandbox resume can legitimately
 * take tens of seconds end to end, but that legitimate case is exactly the
 * one that keeps producing data and never reaches this bound.
 *
 * **Worst-case actual flip time is ~61.5s, not 45s** — say so accurately
 * rather than understate it. 45s is 30 consecutive empty poll intervals at
 * `SESSION_START_POLL_MS` (1.5s each), but the budget is only ever CHECKED
 * at a poll tick, and `waitMs` (default
 * `15_000`, the server-side long-poll budget passed to `startProjectSession`)
 * means a single tick's request can itself take up to ~15s before resolving.
 * So the tick that finally crosses the 45s line can itself land up to one
 * full cycle late: `45_000 + (waitMs + SESSION_START_POLL_MS)` ≈
 * `45_000 + 16_500` = `61_500`ms in the worst case. That is still acceptable:
 * it is a finite, single-digit-minutes ceiling on a failure this task
 * otherwise made hang forever, and erring toward a LATE flip (never early)
 * is the safe direction — it never cuts short a legitimate wake, only delays
 * how quickly a genuine outage surfaces its error card.
 */
export const START_INCONCLUSIVE_GIVE_UP_MS = 45_000;

/**
 * Has `/start` been returning nothing usable — no data, no error — for at
 * least {@link START_INCONCLUSIVE_GIVE_UP_MS}? Kept separate from
 * `shouldPollSessionStart` (which correctly keeps saying "poll again":
 * retrying costs nothing) because "should the query retry" and "should a
 * caller stop waiting on it" are different questions once the first answer
 * is permanently yes.
 */
export function hasStartGivenUp(
  data: SessionStartResult | null | undefined,
  error: unknown,
  inconclusiveSinceMs: number | null,
  nowMs: number,
): boolean {
  if (data || error) return false;
  return (
    inconclusiveSinceMs !== null && nowMs - inconclusiveSinceMs >= START_INCONCLUSIVE_GIVE_UP_MS
  );
}

/**
 * Compute the next value for the "inconclusive since" clock that feeds
 * {@link hasStartGivenUp}, given one poll tick's outcome. Pure and separate
 * from the `useEffect` that calls it so the arm/reset decision is
 * unit-testable without rendering the hook — an earlier version of this
 * logic lived only in the effect and was wrong in a way the pure
 * `computeStartSettled` tests could not catch: it armed while the query was
 * DISABLED, and the stale stamp then carried into the enabled window,
 * consuming the whole grace period before a single real `/start` request had
 * fired.
 *
 * The invariant: the clock may only measure time during which the query was
 * actually able to run for THIS session.
 * - Disabled → always `null`. A query that cannot fetch has neither "given
 *   up" nor is it "still working" — it hasn't started. A stamp taken while
 *   disabled must not survive into the enabled window.
 * - Data or error arrived → clear to `null`. The poll said SOMETHING.
 * - Enabled, inconclusive (no data, no error), not mid-fetch → arm at
 *   `nowMs` if nothing is armed yet; otherwise keep the existing stamp — the
 *   clock starts once, at the FIRST inconclusive tick, not every tick.
 * - Mid-fetch → keep whatever is already armed; a fetch in flight is not
 *   itself informative either way, and time spent waiting on it still counts.
 *
 * Session-identity resetting (`projectId`/`sessionId` changing under a reused
 * hook instance) is handled by a separate effect, not here — this function
 * has no session id to key on by design, matching the narrow input the
 * `useEffect` actually has on each tick.
 */
export function nextInconclusiveSince(input: {
  current: number | null;
  enabled: boolean;
  hasData: boolean;
  hasError: boolean;
  isFetching: boolean;
  nowMs: number;
}): number | null {
  if (!input.enabled) return null;
  if (input.hasData || input.hasError) return null;
  if (input.isFetching) return input.current;
  return input.current ?? input.nowMs;
}

/**
 * Whether the `/start` poll should be treated as SETTLED — resolved, failed,
 * or given up — for a caller (like `phase`, below) that needs to stop
 * waiting on it. A disabled query settles immediately: a query that never
 * runs was never "still working" in the first place.
 *
 * Takes `hasGivenUp` as an ALREADY-RESOLVED boolean, not a timestamp pair.
 * The caller previously stored this function's ENTIRE return value in
 * `useState` — including the `!enabled -> true` branch — so a
 * disabled->enabled transition (or a session switch) could read a stale
 * `true` for one committed, painted frame, and a live `runtimeError` in that
 * window rendered 'error' before a single real `/start` request had fired.
 * `enabled`, `isFetching`, `data`, and `error` are cheap to read fresh on
 * every call, so they no longer go through state at all — only `hasGivenUp`
 * (via {@link hasStartGivenUp}) inherently needs wall-clock tracking, so it
 * is the only piece the caller is allowed to latch.
 *
 * ORDER IS LOAD-BEARING: `hasGivenUp` must be tested BEFORE `isFetching`.
 * Giving up does not stop the poll — `shouldPollSessionStart(null, null)`
 * keeps returning 1500ms for as long as the outage lasts — so with the
 * fetch check first, this answered false
 * mid-poll and true between polls, forever. `phase` flipped 'starting' <->
 * 'error' with it and the runtime error card blinked on and off once per poll
 * cycle. Give-up is a sticky verdict (the caller's effect clears it only when
 * /start actually answers, when the session changes, or when the query is
 * disabled), so once it is in, no single in-flight tick may take it back out.
 */
export function computeStartSettled(input: {
  enabled: boolean;
  isFetching: boolean;
  data: SessionStartResult | null | undefined;
  error: unknown;
  hasGivenUp: boolean;
}): boolean {
  if (!input.enabled) return true;
  if (input.hasGivenUp) return true;
  if (input.isFetching) return false;
  return !shouldPollSessionStart(input.error, input.data);
}

/**
 * TanStack Query pauses interval fetches while the document is hidden unless
 * this option is true. Session readiness must continue because it gates the
 * runtime switch, event stream, and queued-prompt replay.
 */
export const SESSION_START_POLL_OPTIONS = {
  refetchInterval: (query: {
    state: {
      error: unknown;
      data: SessionStartResult | null | undefined;
    };
  }) => shouldPollSessionStart(query.state.error, query.state.data),
  refetchIntervalInBackground: true,
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// Send-error classification. `send`/the reply actions below never throw for
// back-compat (`send`) or so a host doesn't need a try/catch for the common
// case; failures are surfaced as this typed union instead.
// ─────────────────────────────────────────────────────────────────────────────

/** Discriminant for `KortixSendError` — what kind of failure interrupted a send. */
export type KortixSendErrorKind = 'billing' | 'connector' | 'runtime-not-ready' | 'runtime-error';

/** One connector the session needs and has no usable connection for. */
export interface KortixSendErrorConnector {
  id: string;
  slug: string;
  name: string;
  /**
   * `project` — one shared connection serves everyone, so anyone who can mint a
   * setup link fixes it once. `user` — the connection must belong to the account
   * the session RUNS AS, which in a wrapper is the operator, not the end-user.
   * The distinction decides whether a connect button can help at all.
   */
  authorization_strategy: 'project' | 'user';
}

/** Typed failure surfaced by `send` (via `sendError`) and thrown by
 * `answerQuestion`/`rejectQuestion`/`answerPermission`. */
export interface KortixSendError {
  kind: KortixSendErrorKind;
  /** Human-readable message, already formatted for display. */
  message: string;
  /** Present when `kind === 'billing'` — the parsed 402 detail. */
  billing?: BillingError;
  /**
   * Present when `kind === 'connector'` — the connectors this session requires
   * and has no usable connection for.
   *
   * The platform refuses these turns BEFORE the sandbox sees them, so nothing
   * streamed and nothing was spent. Without this field the refusal collapsed
   * into a generic `runtime-error`, and the host could only show "something went
   * wrong" for the one failure that has an obvious remedy.
   */
  connectors?: KortixSendErrorConnector[];
  /**
   * Present when `kind === 'runtime-error'` and the failure carries the LLM
   * gateway's structured error envelope (provider/code/suggestion/...) — see
   * `extractGatewayErrorDetails`. Lets a host render WHICH provider failed and
   * WHAT to do about it instead of only the provider's raw error text.
   */
  gateway?: {
    provider?: string;
    code?: string;
    suggestion?: string;
    upstreamStatus?: number;
    requestId?: string;
  };
  /** The original thrown value, for callers that want more detail. */
  cause: unknown;
}

// `getClient()` (packages/sdk/src/opencode/client.ts) throws a
// `RuntimeNotReadyError` with this exact message when the sandbox url hasn't
// been resolved yet (session still starting). The string match is kept as a
// fallback for callers that re-wrap the original error (losing the
// `instanceof` chain) but still preserve its message.
const RUNTIME_NOT_READY_MARKER = 'Server URL not ready';

/**
 * Flip the optimistic message these parts belong to from `pending` to
 * `dispatched`, resolved by part id.
 *
 * A host owns its own optimistic add and therefore its own message id, so
 * `sendParts` never sees one. It does see the client-generated part ids, which
 * hosts already send with the prompt so the server's echo updates the same
 * part — the exact key `hydrate` correlates on. Reusing it here means the two
 * halves of the handshake agree by construction instead of by convention.
 *
 * A no-op when the parts carry no ids or belong to no optimistic message.
 */
function markDispatchedForPartIds(sessionId: string, parts: PromptPart[]): void {
  const partIds = new Set(
    parts
      .map((p) => (p as { id?: unknown }).id)
      .filter((id): id is string => typeof id === 'string' && !!id),
  );
  if (partIds.size === 0) return;

  const store = useSyncStore.getState();
  for (const message of store.messages[sessionId] ?? []) {
    if (message.role !== 'user') continue;
    const owns = (store.parts[message.id] ?? []).some((p) => partIds.has(p.id));
    if (owns) store.markOptimisticDispatched(sessionId, message.id);
  }
}

/** The error body, wherever the transport parked it. */
function errorBody(error: unknown): Record<string, unknown> | null {
  if (!error || typeof error !== 'object') return null;
  const holder = error as Record<string, unknown>;
  for (const key of ['data', 'details', 'body']) {
    const candidate = holder[key];
    if (candidate && typeof candidate === 'object') return candidate as Record<string, unknown>;
  }
  return holder;
}

function errorBodyMessage(error: unknown): string | null {
  const body = errorBody(error);
  for (const key of ['message', 'error']) {
    const value = body?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

/**
 * The connectors a `CONNECTOR_CONNECTION_REQUIRED` refusal names, or
 * null when this is not that refusal.
 *
 * Keyed on the CODE, never on the message: the prose is for humans and changes.
 * A refusal that names no connection still returns null — a connector prompt that
 * cannot say which connector is worse than the generic error it replaced.
 */
function connectorRefusalConnections(error: unknown): KortixSendErrorConnector[] | null {
  const body = errorBody(error);
  if (body?.code !== 'CONNECTOR_CONNECTION_REQUIRED') return null;
  const listed = [body.connector_connections, body.connectorConnections].find(Array.isArray) as
    | unknown[]
    | undefined;
  const connections: KortixSendErrorConnector[] = [];
  for (const entry of listed ?? []) {
    if (!entry || typeof entry !== 'object') continue;
    const connection = entry as Record<string, unknown>;
    const strategy = connection.authorization_strategy ?? connection.authorizationStrategy;
    if (typeof connection.id !== 'string' || typeof connection.slug !== 'string') continue;
    if (strategy !== 'project' && strategy !== 'user') continue;
    connections.push({
      id: connection.id,
      slug: connection.slug,
      name:
        typeof connection.name === 'string' && connection.name ? connection.name : connection.slug,
      authorization_strategy: strategy,
    });
  }
  return connections.length > 0 ? connections : null;
}

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
      return {
        kind: 'billing',
        message: parsed.message,
        billing: parsed,
        cause: error,
      };
    }
    const connectors = connectorRefusalConnections(error);
    if (connectors) {
      return {
        kind: 'connector',
        message:
          errorBodyMessage(error) ??
          'Connect the required connectors before continuing this session.',
        connectors,
        cause: error,
      };
    }
  }

  const gateway = extractGatewayErrorDetails(error);
  const formatted = formatOpenCodeRuntimeError(error);
  return {
    kind: 'runtime-error',
    // Prefer the gateway's own message (already human-written server-side per
    // status/cause) over opencode's raw runtime-error formatting when present.
    message: gateway?.message || formatted.message,
    ...(gateway
      ? {
          gateway: {
            provider: gateway.provider,
            code: gateway.code,
            suggestion: gateway.suggestion,
            upstreamStatus: gateway.upstreamStatus,
            requestId: gateway.requestId,
          },
        }
      : {}),
    cause: error,
  };
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

export interface SessionCommandOptions {
  agent?: string | null;
  model?: ModelKey | null;
  variant?: string | null;
}

export function buildSessionCommandInput(
  sessionId: string,
  command: string,
  args: string,
  options: SessionCommandOptions = {},
) {
  return {
    sessionId,
    command,
    args,
    ...(options.agent ? { agent: options.agent } : {}),
    ...(options.model ? { model: formatModelString(options.model) } : {}),
    ...(options.variant ? { variant: options.variant } : {}),
  };
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

export function beginRestPromptObservation(sessionId: string, runtimeScope?: string): void {
  beginSessionPromptObservation(sessionId, runtimeScope);
  useSyncStore.getState().setStatus(sessionId, { type: 'busy' });
}

export function endRestPromptObservation(sessionId: string, runtimeScope?: string): void {
  endSessionPromptObservation(sessionId, runtimeScope);
  useSyncStore.getState().setStatus(sessionId, { type: 'idle' });
}

export async function sendRestPromptWithObservation(
  sessionId: string,
  runtimeScope: string | undefined,
  sendPrompt: () => Promise<void>,
): Promise<void> {
  beginRestPromptObservation(sessionId, runtimeScope);
  try {
    await sendPrompt();
  } catch (error) {
    endRestPromptObservation(sessionId, runtimeScope);
    throw error;
  }
}

export async function rewindOpenCodeSession(sessionId: string, messageId: string): Promise<void> {
  if (!messageId) throw new Error('Session rewind requires a message id');
  unwrap(
    await getClient().session.revert({
      sessionID: sessionId,
      messageID: messageId,
    }),
  );
}

export async function restoreOpenCodeSessionRewind(sessionId: string): Promise<void> {
  unwrap(await getClient().session.unrevert({ sessionID: sessionId }));
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
   * A server-authorized OpenCode session pin associated with this Kortix
   * session. The `/start` response remains authoritative.
   */
  initialOpenCodeSessionId?: string | null;
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
  hasOlder: false,
  isLoadingOlder: false,
  loadOlder: async () => {},
};

export function useSession(projectId: string, sessionId: string, options: UseSessionOptions = {}) {
  const queryClient = useQueryClient();
  const titleRefreshAbortRef = useRef<AbortController | null>(null);
  const {
    waitMs = 15_000,
    replayStartStash = true,
    enabled = true,
    chatEngine = true,
    initialOpenCodeSessionId = null,
  } = options;

  // 1. Drive /start until the runtime is ready (the server long-polls each tick).
  const startEnabled = enabled && !!projectId && !!sessionId;
  const start = useQuery({
    queryKey: sessionStartKey(projectId, sessionId),
    queryFn: () => startProjectSession(projectId, sessionId, waitMs),
    enabled: startEnabled,
    retry: (failureCount, error) => shouldRetrySessionStart(failureCount, error, sessionId),
    retryDelay: (failureCount, error) =>
      isSessionStartError(error) && error.status === 404
        ? FRESH_START_404_RETRY_DELAY_MS
        : Math.min(1000 * 2 ** failureCount, 5000),
    ...SESSION_START_POLL_OPTIONS,
  });
  const startData = start.data ?? null;
  const startError = isSessionStartError(start.error) ? start.error : null;
  const stage = startData?.stage ?? null;
  const sandbox = startData?.sandbox ?? null;
  const startReady = stage === 'ready';
  const terminal = stage === 'failed' || stage === 'stopped';

  // Track how long /start has been returning nothing usable — no data, no
  // error — so `computeStartSettled` can bound the "given up" case (see
  // START_INCONCLUSIVE_GIVE_UP_MS) instead of waiting on a poll that a
  // swallowed transport failure can keep alive forever. `nextInconclusiveSince`
  // owns the arm/reset decision (pure, unit-tested); the effects here are thin
  // callers of it. Only the RAW TIMESTAMP lives in a ref — `hasGivenUp` below
  // is the one piece of *derived* state, and everything else `phase` needs
  // (`enabled`/`isFetching`/`data`/`error`) is read fresh at render, never
  // stored (see the comment on `startSettled` below for why).
  const startInconclusiveSinceRef = useRef<number | null>(null);
  const [startGivenUp, setStartGivenUp] = useState(false);
  // A new session gets a fresh clock AND a fresh give-up verdict. This hook
  // instance is reused across session navigation (see the switch effect
  // below), and neither may bleed from a DIFFERENT (projectId, sessionId)
  // into this one's give-up budget. Declared before the arming effect so both
  // clear first, within the same commit, when the session changes.
  useEffect(() => {
    startInconclusiveSinceRef.current = null;
    setStartGivenUp(false);
  }, [projectId, sessionId]);
  useEffect(() => {
    // `Date.now()` lives here, not in the render body: reading it during
    // render made this impure and a StrictMode/concurrent-render hazard. One
    // read feeds both the arm decision and the give-up decision, computed
    // together so they never disagree about "now".
    const nowMs = Date.now();
    startInconclusiveSinceRef.current = nextInconclusiveSince({
      current: startInconclusiveSinceRef.current,
      enabled: startEnabled,
      hasData: !!start.data,
      hasError: !!start.error,
      isFetching: start.isFetching,
      nowMs,
    });
    setStartGivenUp(
      hasStartGivenUp(start.data, start.error, startInconclusiveSinceRef.current, nowMs),
    );
  }, [startEnabled, start.data, start.error, start.isFetching]);
  // `startEnabled`/`start.isFetching`/`start.data`/`start.error` are read
  // FRESH here, on every render — never stored. Only `startGivenUp` comes
  // from state. The PREVIOUS version stored `computeStartSettled`'s entire
  // return value (including the `!enabled -> true` branch) via `useState`,
  // so on the commit where `startEnabled` flipped from `false` to `true` (a
  // billing unblock, or auth finishing load), this read the STALE stored
  // `true` for one committed, painted frame — and with a live `runtimeError`
  // already present, that frame rendered `phase === 'error'`, the exact
  // premature panic card this task exists to remove. Reading
  // `enabled`/`isFetching`/`data`/`error` fresh at render makes that
  // structurally impossible: nothing here can ever be one render behind its
  // own inputs except the one value that inherently needs wall-clock
  // tracking (`startGivenUp`), and that value is now session-reset above
  // too.
  const startSettled = computeStartSettled({
    enabled: startEnabled,
    isFetching: start.isFetching,
    data: start.data,
    error: start.error,
    hasGivenUp: startGivenUp,
  });

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
    setCurrentRuntime(
      getSandboxUrlForExternalId(sandbox.external_id),
      sandbox.external_id,
      sandbox.sandbox_id,
    );
    setSwitchedSandboxId(sandbox.sandbox_id);
  }, [startReady, sandbox, switchedSandboxId]);
  // Clear the current runtime when this session view unmounts.
  useEffect(() => () => setCurrentRuntime(null), []);

  const switched = startReady && !!sandbox && switchedSandboxId === sandbox.sandbox_id;

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
  useOpenCodeEventStream({ enabled: switched });

  // 5. Resolve the canonical OpenCode root id (server-owned; /start hands it over)
  // and sync messages off it.
  const canonicalSession = useCanonicalOpenCodeSession({
    projectId,
    sessionId,
    pinFromStart: startData?.opencode_session_id ?? null,
    initialPin: initialOpenCodeSessionId,
    listRuntimeSessions: switched,
  });
  const { rootSessionId } = canonicalSession;
  const ocSessionId = rootSessionId ?? '';
  useEffect(
    () => () => {
      titleRefreshAbortRef.current?.abort();
      titleRefreshAbortRef.current = null;
    },
    [projectId, sessionId],
  );
  // Always call the hook (rules-of-hooks) so it stays in the same position
  // every render, but starve it with an empty session id when the chat engine
  // is off — `useSessionSync('')` fetches/polls nothing (its effects no-op on
  // a falsy/non-canonical session id) — and use a fixed, type-stable empty
  // result instead of whatever it happens to return for that starved call.
  const rawSync = useSessionSync(chatEngine ? ocSessionId : '', {
    kortixSessionScope: `${projectId}/${sessionId}`,
    networkEnabled: switched,
  });
  const sync = chatEngine ? rawSync : DISABLED_CHAT_ENGINE_SYNC;
  const runtimePhase = useRuntimePhase();
  const [restRewind, setRestRewind] = useState<SessionRewindState | null>(null);
  const [rewindPending, setRewindPending] = useState(false);
  const [rewindError, setRewindError] = useState<KortixSendError | null>(null);
  const rewindMessageId = restRewind?.staged ? restRewind.messageId : null;
  const messages = useMemo(
    () => messagesBeforeRewind(sync.messages, restRewind?.messageId ?? null),
    [sync.messages, restRewind?.messageId],
  );

  useEffect(() => {
    setRestRewind(null);
    setRewindPending(false);
    setRewindError(null);
  }, [sessionId, ocSessionId]);

  useEffect(() => {
    setRestRewind((current) => reconcileCommittedSessionRewind(sync.messages, current));
  }, [sync.messages]);

  // 5b. Self-heal a missed `question.asked` SSE event (a `question` tool part
  // rendering as running with nothing in the pending store) — see
  // `useQuestionSelfHeal` for why this is distinct from the SSE reconnect-gap
  // hydration in `useOpenCodeEventStream`. Disabled entirely when `chatEngine`
  // is off — see that option's jsdoc: a host mounting its own chat surface
  // already runs its own copy of this poller for the same session.
  useQuestionSelfHeal(ocSessionId, sync.messages, {
    enabled: switched && chatEngine && !!ocSessionId,
  });
  usePermissionSelfHeal(ocSessionId, sync.messages, {
    enabled: switched && chatEngine && !!ocSessionId,
  });

  // 6. Interactive prompts live in the pending store (the SSE writes them there,
  // keyed by request id carrying sessionID). useSessionSync does NOT surface them.
  const questionMap = useOpenCodePendingStore((s) => s.questions);
  const permissionMap = useOpenCodePendingStore((s) => s.permissions);
  const isCompacting = useOpenCodeCompactionStore(
    (state) => switched && Boolean(state.compactingBySession[ocSessionId]),
  );
  const removeQuestion = useOpenCodePendingStore((s) => s.removeQuestion);
  const removePermission = useOpenCodePendingStore((s) => s.removePermission);
  const questions = useMemo(
    () => (switched ? Object.values(questionMap).filter((q) => q.sessionID === ocSessionId) : []),
    [questionMap, ocSessionId, switched],
  );
  const permissions = useMemo(
    () => (switched ? Object.values(permissionMap).filter((p) => p.sessionID === ocSessionId) : []),
    [permissionMap, ocSessionId, switched],
  );
  const runtimeActionReady = switched && !!rootSessionId;

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
    () => messages.filter((m) => m.info.role === 'user').length,
    [messages],
  );
  useEffect(() => {
    if (!chatEngine || userMsgCount <= 0) return;
    titleRefreshAbortRef.current?.abort();
    const controller = new AbortController();
    titleRefreshAbortRef.current = controller;
    void reconcileHydratedSessionTitle(queryClient, projectId, sessionId, userMsgCount, {
      signal: controller.signal,
    }).finally(() => {
      if (titleRefreshAbortRef.current === controller) {
        titleRefreshAbortRef.current = null;
      }
    });
    return () => controller.abort();
  }, [chatEngine, projectId, queryClient, sessionId, userMsgCount]);
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
    const t = setTimeout(
      () => setSendState((s) => (s.pending ? { ...s, pending: null } : s)),
      30_000,
    );
    return () => clearTimeout(t);
  }, [pending]);

  const sendParts = async (
    parts: PromptPart[],
    override?: {
      model?: ModelKey | null;
      agent?: string | null;
      variant?: string | null;
      directory?: string | null;
      /**
       * Stable name for the submission these parts belong to — a host's queue
       * key, say. Re-dispatching a failed send with the same one keeps one wire
       * `messageID`, so the proxy's duplicate protection still absorbs the
       * retry instead of delivering the prompt twice. Omit it and every call is
       * a new submission. See `SendOpenCodeMessageArgs.clientMessageId`.
       */
      clientMessageId?: string;
    },
  ): Promise<void> => {
    if (!runtimeActionReady) throw new RuntimeNotReadyError();
    const model = override?.model ?? picks.model;
    const agent = override?.agent ?? picks.agent;
    const variant = override?.variant;
    const opts = {
      ...(model ? { model } : {}),
      ...(agent ? { agent } : {}),
      ...(variant ? { variant } : {}),
      ...(override?.directory ? { directory: override.directory } : {}),
    };
    // The prompt is going out, so the optimistic message stops being `pending`.
    // Hosts own the optimistic add (they build the message id themselves), so
    // this resolves it the same way `hydrate` correlates an echo: by the
    // client-generated part ids that ride along with the prompt. Until this
    // lands, `hydrate` refuses to supersede the message on an ordinal match —
    // which is what keeps it on screen for the whole of a slow upload instead
    // of being deleted by a rehydrate that only carries older turns.
    markDispatchedForPartIds(ocSessionId, parts);

    await sendRestPromptWithObservation(ocSessionId, sandbox?.external_id ?? undefined, () =>
      sendMutation.mutateAsync({
        sessionId: ocSessionId,
        parts,
        ...(Object.keys(opts).length ? { options: opts } : {}),
        ...(override?.clientMessageId ? { clientMessageId: override.clientMessageId } : {}),
      }),
    );
    setRestRewind(commitSessionRewind);
  };

  const send = (
    text: string,
    override?: {
      model?: ModelKey | null;
      agent?: string | null;
      variant?: string | null;
    },
  ) => {
    if (!runtimeActionReady) return;
    pendingBaseCount.current = userMsgCount;
    setSendState(sendStateOnStart(text));
    void sendParts([{ type: 'text', text }], override).catch((error) => {
      setSendState(sendStateOnError(error));
    });
  };

  // Run a project slash-command (server-side `/command`), distinct from a prompt.
  const runCommand = (
    command: string,
    args: string,
    options: SessionCommandOptions = {},
  ): Promise<void> => {
    if (!runtimeActionReady) return Promise.resolve();
    return commandMutation.mutateAsync(
      buildSessionCommandInput(ocSessionId, command, args, options),
    );
  };

  const rewind = async (messageId: string): Promise<void> => {
    if (!runtimeActionReady) throw new RuntimeNotReadyError();
    if (!messageId) throw new Error('Session rewind requires a message id');
    if (sync.isBusy || pending || rewindPending) {
      throw new Error('Cannot rewind a busy session');
    }
    setRewindPending(true);
    setRewindError(null);
    try {
      await rewindOpenCodeSession(ocSessionId, messageId);
      setRestRewind({ messageId, staged: true });
    } catch (error) {
      const classified = classifySendError(error);
      setRewindError(classified);
      throw classified;
    } finally {
      setRewindPending(false);
    }
  };

  const restoreRewind = async (): Promise<void> => {
    if (!runtimeActionReady) throw new RuntimeNotReadyError();
    if (!rewindMessageId || rewindPending) return;
    setRewindPending(true);
    setRewindError(null);
    try {
      await restoreOpenCodeSessionRewind(ocSessionId);
      setRestRewind(null);
    } catch (error) {
      const classified = classifySendError(error);
      setRewindError(classified);
      throw classified;
    } finally {
      setRewindPending(false);
    }
  };

  // The one true cancel: abort the run AND drop any pending prompt + open prompts.
  const cancel = () => {
    if (runtimeActionReady) {
      endRestPromptObservation(ocSessionId);
      abortMutation.mutate(ocSessionId);
    }
    questions.forEach((q) => removeQuestion(q.id));
    permissions.forEach((p) => removePermission(p.id));
    setSendState(IDLE_SEND_STATE);
  };

  const runtimeSessionError = canonicalSession.error;
  const phase: SessionPhase = derivePhase({
    terminal,
    startError,
    runtimeError: runtimeSessionError,
    // `startSettled` is computed above via `computeStartSettled`, which wraps
    // `shouldPollSessionStart` (the EXISTING definition of "the poll is still
    // working") and additionally bounds the case where /start swallows a
    // persistent failure into `null` forever — see START_INCONCLUSIVE_GIVE_UP_MS.
    startSettled,
    switched,
  });

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
    send(stash.prompt, {
      model: stash.model,
      agent: stash.agent,
      variant: stash.variant,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, sync.isLoading, sync.messages.length, sessionId, replayStartStash, chatEngine]);

  return {
    projectId,
    sessionId,
    /** Canonical OpenCode root id, or null while resolving. */
    opencodeSessionId: rootSessionId ?? null,
    runtimeTransport: 'rest' as const,
    runtimeSessions: canonicalSession.sessions,
    runtimeSessionsLoading: canonicalSession.isLoading,
    runtimeSessionsListed: canonicalSession.listed,
    runtimeError: runtimeSessionError,

    // live data
    messages,
    status: sync.status,
    questions,
    permissions,
    diffs: sync.diffs,
    todos: sync.todos,
    hasOlder: sync.hasOlder,
    isLoadingOlder: sync.isLoadingOlder,
    loadOlder: sync.loadOlder,

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
    /** Typed provider-neutral terminal provisioning failure. */
    failure: startData?.failure ?? null,
    /** Granular boot phase (connecting|booting|ready|unreachable) for detailed UI. */
    runtimePhase,
    isBusy: sync.isBusy || !!pending,
    isCompacting,
    isLoading: sync.isLoading,
    isError: terminal || !!startError || !!runtimeSessionError,
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
    rewindMessageId,
    rewindPending,
    rewindError,

    // server-side capabilities (pre-runtime)
    models,
    agents,
    defaultAgent: config?.default_agent ?? config?.open_code_default_agent ?? null,
    commands: config?.commands ?? [],
    picks,

    // actions
    send,
    sendParts,
    rewind,
    restoreRewind,
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
