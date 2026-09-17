'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';
import {
  type CreateSessionPromptInput,
  type CreateSessionPromptResult,
  type RemovedSessionPrompt,
  type SessionPrompt,
  type SessionPromptOverrides,
  type SessionPromptPart,
  createSessionPrompt,
  deleteSessionPrompt,
  holdSessionPrompts,
  listSessionPrompts,
  retrySessionPrompt,
} from '../core/rest/projects-client/sessions';
import { ApiError } from '../core/http/api-client';
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { countLiveInboxPrompts, inboxObservationSupersedes } from '../core/session/working';
import { claimOpenBundle, openBundleQueue } from '../core/session/open-bundle';
import { qk } from './query-keys';
import { usePollOwner } from './use-poll-owner';
import { mintSessionWireMessageId } from './use-opencode-sessions/messages';

/**
 * The session's SERVER-SIDE prompt inbox.
 *
 * The queue used to be a browser store: closing the tab, switching device, or
 * a crash lost every pending message silently, and two tabs on one session each
 * believed their own list. This hook reads the durable rows instead, so what
 * the composer renders is what the server will actually deliver.
 *
 * Polling has TWO cadences, and the slow one is not an optimization.
 *
 * While prompts exist the list is the only thing that can report a state change
 * (`waiting` → `queued` → `delivering`), so it polls fast. An empty list is the
 * common state and does not need that — but it cannot stop either, because a
 * prompt can ENTER the inbox with this tab doing nothing at all: the reaper
 * redelivers one whose turn never ran, and parking a box requeues its in-flight
 * prompt as `held`. A held row is deliberately not due; the user releases it by
 * sending something or pressing "send now" on it, which they can only do if
 * they can SEE it. Not polling an empty list meant only a full page load ever
 * showed those rows — and the same gap hid a prompt queued from a second tab.
 */
export const SESSION_PROMPTS_POLL_MS = 1_000;
/** The floor for an EMPTY list. Slow enough to be free, fast enough that a
 *  prompt handed back by the server appears while the user is still looking. */
export const SESSION_PROMPTS_IDLE_POLL_MS = 15_000;

/**
 * The cadence for a list of `count` prompts. Pure, so the floor is testable.
 *
 * `believedPending` is what this TAB thinks is in flight — the row
 * `notePromptAccepted` recorded when `POST .../prompts` returned, before any
 * list read could see it. It counts toward the cadence because the belief is an
 * observation with a life (`INBOX_OBSERVATION_MAX_MS`) and only a list read
 * refreshes it: a first read that landed before the row existed answered zero,
 * locked the cadence to the 15s idle floor, and let a 10s belief die under a
 * prompt that was still queued. The list length alone cannot close that hole,
 * because at that instant the list is honestly empty.
 */
export function sessionPromptsPollMs(
  count: number,
  pollMs?: number,
  believedPending = 0,
): number {
  const live = Math.max(count, believedPending);
  return live > 0 ? (pollMs ?? SESSION_PROMPTS_POLL_MS) : SESSION_PROMPTS_IDLE_POLL_MS;
}

/**
 * Feed one reading of the list into the working projection.
 *
 * The inbox is not only something to render. A prompt is DURABLE long before it
 * is a turn: the lifecycle row has to be drained, and the box may have to resume
 * first (18.9s Daytona / 24.5s Platinum, measured). `GET .../turn` truthfully
 * answers "no turns" for that whole window, and the composer used to believe it
 * — swapping Stop back to Send while the user's prompt was still queued. The
 * stamp is the instant the read was ISSUED, for the same reason `/turn`'s is.
 */
export function noteInboxObservation(
  sessionId: string,
  prompts: readonly SessionPrompt[],
  atMs: number,
  serverAtMs?: number,
  drainedAtMs?: number,
): void {
  useSessionWorkingStore
    .getState()
    .noteInboxPending(sessionId, countLiveInboxPrompts(prompts), atMs, serverAtMs, drainedAtMs);
}

/**
 * Did the SERVER take a prompt off this queue between these two readings?
 *
 * The count cannot answer it. A row that drains and a row the user just put on
 * hold both take the live count to zero, and they mean opposite things: one is
 * a turn opening, the other is the user asking for nothing to run. What tells
 * them apart is the ROW — a held or failed prompt is still listed, a delivered
 * one is not (`listInboxPrompts` drops it the moment the ledger confirms a turn
 * consumed its wire id).
 *
 * So: a prompt this tab watched as LIVE work — every row
 * `countLiveInboxPrompts` counts: `queued`, `delivering`, or `waiting` for a
 * reason other than `held` — is simply absent now. That is the control plane
 * saying it gave the prompt to the runtime — the one transition no other
 * observer can report yet, and the reason `WorkingInboxInput.drainedAtMs`
 * exists.
 *
 * `waiting` counts because the admission gate lists a prompt POSTed during a
 * turn as `waiting` (`turn_active`, `older_prompt_pending`) until the drain
 * claims it. The claimed row lists as `delivering` for one delivery POST only,
 * and a 1 s poll that misses that window sees `waiting` go straight to absent.
 * Counting only `queued`/`delivering` left the drain floor unarmed there, and
 * the session read idle with the prompt already handed to the runtime.
 *
 * Two kinds of disappearance are excluded:
 *  * This tab's own optimistic rows: the server lists the same submission
 *    under ITS prompt id, so an optimistic row "disappears" on every
 *    successful send. That is a rename, not a hand-off.
 *  * A row this tab removed (`tombstoneRemovedPrompt` for `sessionId`): a read
 *    issued before the remove can settle after it, with the row still in
 *    `previous` and filtered out of `next`. That is the user deleting a
 *    prompt, not the server running it.
 */
export function inboxDrained(
  previous: readonly SessionPrompt[] | undefined,
  next: readonly SessionPrompt[],
  sessionId?: string,
  nowMs: number = Date.now(),
): boolean {
  if (!previous || previous.length === 0) return false;
  const listed = new Set(next.map((p) => p.prompt_id));
  return previous.some(
    (p) =>
      countLiveInboxPrompts([p]) > 0 &&
      !isOptimisticSessionPrompt(p) &&
      !listed.has(p.prompt_id) &&
      !(sessionId !== undefined && isRemovedPromptTombstoned(sessionId, p.prompt_id, nowMs)),
  );
}

/**
 * Apply one server inbox snapshot to both projections, with one freshness rule.
 *
 * A direct read and the session stream can settle out of order. Updating the
 * working projection through `noteInboxObservation` already rejected an older
 * answer, but updating the React Query cache did not. That split let an old
 * empty control frame hide a prompt that a newer POST/read had confirmed.
 *
 * `atMs` is this tab's clock (age); `serverAtMs` is the server's `observed_at`
 * (ordering). Snapshots that both carry a server stamp rank on the server clock
 * alone — `inboxObservationSupersedes` — so a read issued before a POST can
 * never erase the row the POST confirmed, and a client clock ±10 minutes off
 * changes nothing.
 */
export function applyInboxObservation(
  sessionId: string,
  cached: readonly SessionPrompt[] | undefined,
  prompts: readonly SessionPrompt[],
  atMs: number,
  serverAtMs?: number,
): SessionPrompt[] {
  const current = useSessionWorkingStore.getState().inbox[sessionId];
  const candidate = {
    pending: countLiveInboxPrompts(prompts),
    atMs,
    ...(serverAtMs != null ? { serverAtMs } : {}),
  };
  if (!inboxObservationSupersedes(candidate, current)) return [...(cached ?? [])];
  // Only a reading that SUPERSEDES may report a drain: an older snapshot
  // arriving late has not watched anything leave, it simply never saw it.
  noteInboxObservation(
    sessionId,
    prompts,
    atMs,
    serverAtMs,
    inboxDrained(cached, prompts, sessionId) ? atMs : undefined,
  );
  return reconcileOptimisticPrompts(cached, prompts);
}


// ============================================================================
// Resume and remove answer on the click
// ============================================================================

/**
 * The rows as they read once a hold is released: `reason: 'held'` cleared,
 * everything else as the server last reported it. Applied optimistically by
 * `hold(false)`, so the paused state leaves the screen on the click instead of
 * one GET later — a GET `applyInboxObservation` may legitimately discard.
 */
export function releaseHeldPrompts(prompts: readonly SessionPrompt[]): SessionPrompt[] {
  return prompts.map((prompt) => (prompt.reason === 'held' ? { ...prompt, reason: null } : prompt));
}

/**
 * How long a removed row stays filtered out of later reads.
 *
 * `DELETE .../prompts/:id` returns no server stamp, so a GET issued before the
 * delete can land after it with a NEWER `observed_at` and list the row again.
 * The tombstone only has to outlive that one in-flight read (the poll is 1s);
 * it is not a blocklist, so it expires.
 */
export const REMOVED_PROMPT_TOMBSTONE_MS = 15_000;

/**
 * How long a retried row ignores a `failed` list read when the retry response
 * carried no `observed_at`.
 *
 * A read issued before the retry wrote the row can land after the response
 * and paint the row `failed` again, with live buttons, after `pendingActions`
 * cleared. With the server stamp the working store orders that read out
 * (`inboxObservationSupersedes`). Without it the tab cannot tell that read
 * from a real second failure, so it ignores `failed` for this long: the same
 * one-read window `REMOVED_PROMPT_TOMBSTONE_MS` covers.
 */
export const RETRIED_PROMPT_FAILED_SUPPRESS_MS = 15_000;

const removedPromptTombstones = new Map<string, Map<string, number>>();

export function tombstoneRemovedPrompt(
  sessionId: string,
  promptId: string,
  nowMs: number = Date.now(),
): void {
  let session = removedPromptTombstones.get(sessionId);
  if (!session) {
    session = new Map();
    removedPromptTombstones.set(sessionId, session);
  }
  session.set(promptId, nowMs + REMOVED_PROMPT_TOMBSTONE_MS);
}

export function releaseRemovedPromptTombstone(sessionId: string, promptId: string): void {
  // The removal is no longer this tab's to answer for: a later `remove` sends.
  settledPromptRemovals.delete(promptRowKey(sessionId, promptId));
  const session = removedPromptTombstones.get(sessionId);
  if (!session) return;
  session.delete(promptId);
  if (session.size === 0) removedPromptTombstones.delete(sessionId);
}

/** Did this tab remove `promptId` within the tombstone window? Read-only: an
 *  expired entry is left for `withoutRemovedPrompts` to prune. */
function isRemovedPromptTombstoned(sessionId: string, promptId: string, nowMs: number): boolean {
  const expiresAtMs = removedPromptTombstones.get(sessionId)?.get(promptId);
  return expiresAtMs !== undefined && expiresAtMs > nowMs;
}

/** `prompts` without the rows this tab removed. Expired tombstones are pruned. */
export function withoutRemovedPrompts(
  sessionId: string,
  prompts: readonly SessionPrompt[],
  nowMs: number = Date.now(),
): SessionPrompt[] {
  const session = removedPromptTombstones.get(sessionId);
  if (!session) return [...prompts];
  for (const [promptId, expiresAtMs] of session) {
    if (expiresAtMs <= nowMs) session.delete(promptId);
  }
  if (session.size === 0) {
    removedPromptTombstones.delete(sessionId);
    return [...prompts];
  }
  return prompts.filter((prompt) => !session.has(prompt.prompt_id));
}

/**
 * Did a failed DELETE leave the row in the inbox? Only a 404 says the row is
 * gone. A 409 means a step is already answering it (it is still listed, as
 * delivering), and a network failure never reached the server.
 */
export function removeFailureKeepsRow(error: unknown): boolean {
  return (error as { status?: number } | null)?.status !== 404;
}

/** The `code` of the error `remove`/`retry` reject with when the OTHER action
 *  on the same row is still running. No request was sent. */
const PROMPT_ACTION_PENDING_CODE = 'prompt_action_pending';

/**
 * What a refused `remove` or `retry` means, for a host to put in its own words.
 *
 * - `gone`: the server has no such prompt (`404 prompt_not_found`). Another tab
 *   removed it, or it never existed.
 * - `already_sent`: the drain already handed it to the runtime
 *   (`409 prompt_already_sent`).
 * - `unreachable`: no answer. The cancel could not reach the runtime
 *   (`409 prompt_cancel_unreachable`), the request timed out, or it never left
 *   the tab.
 * - `pending`: the other action on this row is still running; nothing was sent.
 * - `failed`: anything else, including a 404 or 409 without one of the codes
 *   above.
 *
 * It reads `status` and `code` only. The body's `error` text is English prose
 * for people, not a contract, and raw "Not found" once reached a toast.
 */
export function classifyPromptActionError(
  error: unknown,
): 'gone' | 'already_sent' | 'unreachable' | 'pending' | 'failed' {
  if (error === null || typeof error !== 'object') return 'failed';
  const { status, code, name } = error as { status?: unknown; code?: unknown; name?: unknown };
  if (code === PROMPT_ACTION_PENDING_CODE) return 'pending';
  if (status === 404) return code === 'prompt_not_found' ? 'gone' : 'failed';
  if (status === 409) {
    if (code === 'prompt_already_sent') return 'already_sent';
    if (code === 'prompt_cancel_unreachable') return 'unreachable';
    return 'failed';
  }
  if (code === 'TIMEOUT') return 'unreachable';
  // A fetch that threw (`TypeError`), raw or wrapped by `makeRequest`, and every
  // `ApiError` without a status: the server never answered.
  if (
    status === undefined &&
    (error instanceof TypeError ||
      name === 'TypeError' ||
      error instanceof ApiError ||
      name === 'ApiError')
  ) {
    return 'unreachable';
  }
  return 'failed';
}

// ============================================================================
// Row actions — one request and one outcome per row
// ============================================================================

type PromptRowAction = 'retry' | 'remove';

/**
 * Row actions in flight, keyed `${sessionId}:${promptId}`.
 *
 * Remove and Retry sit side by side on a row, and take-back (Up / Edit), the
 * transcript bubble and the rewind loop call `remove` on the same id. Two
 * calls before a re-render sent two requests: the second DELETE answered 404
 * and painted a toast that contradicted the first. The map is module-level,
 * so every mounted `useSessionPrompts` of a session shares one lock per row.
 * An entry is deleted when its promise settles.
 */
const promptRowActions = new Map<string, { action: PromptRowAction; promise: Promise<unknown> }>();

/**
 * This tab's successful removals, keyed like `promptRowActions`. A repeat
 * `remove` inside the row's tombstone window resolves this result and sends
 * nothing. A caller that reads `removed.parts` never sees `null`.
 */
const settledPromptRemovals = new Map<
  string,
  { removed: RemovedSessionPrompt; expiresAtMs: number }
>();

const pendingActionListeners = new Set<() => void>();
const pendingActionSnapshots = new Map<string, Readonly<Record<string, PromptRowAction>>>();
const NO_PENDING_ACTIONS: Readonly<Record<string, PromptRowAction>> = Object.freeze({});

function promptRowKey(sessionId: string, promptId: string): string {
  return `${sessionId}:${promptId}`;
}

/** Rebuild one session's `pendingActions` snapshot and tell every subscriber.
 *  A snapshot object changes only when that session's actions change. */
function publishPendingActions(sessionId: string): void {
  const prefix = `${sessionId}:`;
  const actions: Record<string, PromptRowAction> = {};
  for (const [key, entry] of promptRowActions) {
    if (key.startsWith(prefix)) actions[key.slice(prefix.length)] = entry.action;
  }
  if (Object.keys(actions).length === 0) pendingActionSnapshots.delete(sessionId);
  else pendingActionSnapshots.set(sessionId, Object.freeze(actions));
  for (const listener of pendingActionListeners) listener();
}

function subscribePendingActions(listener: () => void): () => void {
  pendingActionListeners.add(listener);
  return () => {
    pendingActionListeners.delete(listener);
  };
}

function readPendingActions(
  sessionId: string | undefined,
): Readonly<Record<string, PromptRowAction>> {
  return (sessionId && pendingActionSnapshots.get(sessionId)) || NO_PENDING_ACTIONS;
}

/** Keep a removal for the rest of its row's tombstone window. A removal whose
 *  tombstone already expired or was released is not kept. */
function rememberPromptRemoval(
  sessionId: string,
  promptId: string,
  removed: RemovedSessionPrompt,
  nowMs: number,
): void {
  for (const [key, settled] of settledPromptRemovals) {
    if (settled.expiresAtMs <= nowMs) settledPromptRemovals.delete(key);
  }
  const expiresAtMs = removedPromptTombstones.get(sessionId)?.get(promptId);
  if (expiresAtMs === undefined || expiresAtMs <= nowMs) return;
  settledPromptRemovals.set(promptRowKey(sessionId, promptId), { removed, expiresAtMs });
}

function settledPromptRemoval(
  sessionId: string,
  promptId: string,
  nowMs: number,
): RemovedSessionPrompt | undefined {
  const key = promptRowKey(sessionId, promptId);
  const settled = settledPromptRemovals.get(key);
  if (!settled) return undefined;
  if (settled.expiresAtMs > nowMs) return settled.removed;
  settledPromptRemovals.delete(key);
  return undefined;
}

/**
 * Run one action on one row, at most one request per intent.
 *
 * - The same action already in flight: its promise, and no request.
 * - The other action in flight: no request. Rejects with an `Error` whose
 *   `code` is `prompt_action_pending` (`classifyPromptActionError` → `pending`).
 * - `remove` of a row this tab already removed inside the tombstone window:
 *   that removal, and no request.
 */
function runPromptRowAction<T>(
  sessionId: string,
  promptId: string,
  action: PromptRowAction,
  send: () => Promise<T>,
): Promise<T> {
  const key = promptRowKey(sessionId, promptId);
  const inFlight = promptRowActions.get(key);
  if (inFlight) {
    if (inFlight.action === action) return inFlight.promise as Promise<T>;
    return Promise.reject(
      Object.assign(new Error(`A ${inFlight.action} of this prompt is still running`), {
        code: PROMPT_ACTION_PENDING_CODE,
      }),
    );
  }
  if (action === 'remove') {
    const removed = settledPromptRemoval(sessionId, promptId, Date.now());
    if (removed) return Promise.resolve(removed as T);
  }
  const promise = send();
  promptRowActions.set(key, { action, promise });
  publishPendingActions(sessionId);
  const release = () => {
    if (promptRowActions.get(key)?.promise === promise) promptRowActions.delete(key);
    publishPendingActions(sessionId);
  };
  // Attached before any caller can await `promise`, so the removal is kept
  // before a caller's continuation runs and calls `remove` again.
  promise.then((result) => {
    if (action === 'remove') {
      rememberPromptRemoval(sessionId, promptId, result as RemovedSessionPrompt, Date.now());
    }
    release();
  }, release);
  return promise;
}

/** Retried rows that ignore `failed` until the stamp, keyed like
 *  `promptRowActions`. */
const retriedPromptFailedUntil = new Map<string, number>();

/** A retry of `promptId` succeeded. Its server stamp orders later reads; with
 *  no stamp, `failed` reads of the row are ignored for
 *  `RETRIED_PROMPT_FAILED_SUPPRESS_MS`. */
function noteRetriedPrompt(sessionId: string, promptId: string, serverAtMs: number | undefined): void {
  const nowMs = Date.now();
  for (const [key, untilMs] of retriedPromptFailedUntil) {
    if (untilMs <= nowMs) retriedPromptFailedUntil.delete(key);
  }
  const key = promptRowKey(sessionId, promptId);
  if (serverAtMs === undefined) {
    retriedPromptFailedUntil.set(key, nowMs + RETRIED_PROMPT_FAILED_SUPPRESS_MS);
  } else {
    retriedPromptFailedUntil.delete(key);
  }
  // The row is live again, and the write has a place on the server clock: a
  // read issued before it no longer supersedes, like a read before a POST.
  useSessionWorkingStore.getState().notePromptAccepted(sessionId, nowMs, serverAtMs);
}

/** `prompts` with each `failed` row that is inside its retry suppression window
 *  replaced by the row on screen, when that row is not `failed`. */
function keepRetriedPromptsOverFailedReads(
  sessionId: string,
  cached: readonly SessionPrompt[] | undefined,
  prompts: SessionPrompt[],
  nowMs: number = Date.now(),
): SessionPrompt[] {
  if (retriedPromptFailedUntil.size === 0) return prompts;
  return prompts.map((prompt) => {
    if (prompt.state !== 'failed') return prompt;
    const untilMs = retriedPromptFailedUntil.get(promptRowKey(sessionId, prompt.prompt_id));
    if (untilMs === undefined || untilMs <= nowMs) return prompt;
    const shown = cached?.find((row) => row.prompt_id === prompt.prompt_id);
    return shown && shown.state !== 'failed' ? shown : prompt;
  });
}

// ============================================================================
// Optimistic queue rows — Enter paints the row in the SAME frame
// ============================================================================

export const OPTIMISTIC_PROMPT_PREFIX = 'optimistic:';

/** Is this row the tab's own echo, not yet confirmed by the server? */
export function isOptimisticSessionPrompt(prompt: Pick<SessionPrompt, 'prompt_id'>): boolean {
  return prompt.prompt_id.startsWith(OPTIMISTIC_PROMPT_PREFIX);
}

/**
 * The strip-shaped row for a submission that has left this tab but not yet
 * come back from `POST .../prompts`. The queue is server-side; this is the
 * one client-side thing a server queue cannot do — paint on the keypress.
 * Replaced by the server's row on the response (`settleOptimisticPrompt`),
 * or by the poll landing first (`reconcileOptimisticPrompts`), and removed
 * on failure so a refused send never lingers.
 */
export function optimisticSessionPrompt(
  input: CreateSessionPromptInput,
  nowMs: number,
): SessionPrompt {
  const text = input.parts
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string)
    .join('\n')
    .trim();
  const at = new Date(nowMs).toISOString();
  return {
    prompt_id: `${OPTIMISTIC_PROMPT_PREFIX}${input.clientMessageId}`,
    placement: input.placement,
    full_text: text,
    client_message_id: input.clientMessageId,
    message_id: input.messageId,
    state: 'queued',
    reason: null,
    text,
    attempts: 0,
    last_error: null,
    created_at: at,
    available_at: at,
  };
}

export function applyOptimisticPrompt(
  prompts: readonly SessionPrompt[],
  input: CreateSessionPromptInput,
  nowMs: number,
): SessionPrompt[] {
  if (prompts.some((p) => p.client_message_id === input.clientMessageId)) return [...prompts];
  return [...prompts, optimisticSessionPrompt(input, nowMs)];
}

export function settleOptimisticPrompt(
  prompts: readonly SessionPrompt[],
  clientMessageId: string,
  result: CreateSessionPromptResult,
): SessionPrompt[] {
  return prompts.map((p) =>
    p.client_message_id === clientMessageId && isOptimisticSessionPrompt(p)
      ? { ...p, prompt_id: result.prompt_id, state: result.state, message_id: result.message_id }
      : p,
  );
}

export function removeOptimisticPrompt(
  prompts: readonly SessionPrompt[],
  clientMessageId: string,
): SessionPrompt[] {
  return prompts.filter(
    (p) => !(p.client_message_id === clientMessageId && isOptimisticSessionPrompt(p)),
  );
}

/**
 * Merge a fresh server list over the cached one: the server's rows are the
 * truth, and an optimistic row survives only while the server has not listed
 * its submission yet (the POST is still in flight).
 */
export function reconcileOptimisticPrompts(
  cached: readonly SessionPrompt[] | undefined,
  server: readonly SessionPrompt[],
): SessionPrompt[] {
  const listed = new Set(server.map((p) => p.client_message_id).filter(Boolean));
  const pending = (cached ?? []).filter(
    (p) => isOptimisticSessionPrompt(p) && !listed.has(p.client_message_id),
  );
  return pending.length ? [...server, ...pending] : [...server];
}

/**
 * One read of a session's inbox — and the refusal that keeps a project-scoped
 * URL from ever being built for a session that has no project.
 *
 * Not every session has one. A sub-session (the "Agent · general: …" panel
 * `SubSessionModal` opens over the transcript) is a local OpenCode child:
 * `SessionChat` renders it with a `sessionId` and nothing else — no project id,
 * no project session id — and there is no server-side inbox to read. Both ids
 * are then genuinely `undefined`, and `listSessionPrompts` interpolates them
 * into its path as the literal text: `GET
 * /projects/undefined/sessions/undefined/prompts` → 400 `Invalid session id`,
 * which the host's `onError` sink turns into a red toast beside a sub-agent
 * that is streaming perfectly.
 *
 * The hook's `enabled` flag does not stop it on its own. `enabled` governs
 * react-query's SCHEDULING; `QueryObserver.refetch()` goes straight to
 * `query.fetch()` with no `enabled` check, and `session-chat.tsx` refetches the
 * inbox on every new user bubble — exactly what a streaming sub-agent produces.
 * So the refusal belongs here, on the read itself.
 *
 * `cached` is this tab's current rows: with no project there is nothing to
 * reconcile against, and the optimistic rows already on screen stay on screen.
 */
export async function readSessionPromptsInbox(
  projectId: string | undefined,
  sessionId: string | undefined,
  cached: readonly SessionPrompt[] | undefined,
): Promise<SessionPrompt[]> {
  if (!projectId || !sessionId) return [...(cached ?? [])];
  // The SESSION-OPEN BUNDLE first — but ONLY for the open burst, i.e. a read
  // issued before this tab holds any rows. Two hooks mount this list on a
  // session route and the open path reads it before either can, so those first
  // reads collapse onto one server answer.
  //
  // It used to be claimed by EVERY read inside the bundle's share window, and
  // that is a window in which the queue changes: the drain re-mints the prompt
  // and hands it to the runtime, the runtime echoes it under the new id, the
  // transcript gains a bubble — and the poll, AND the repair refetch that new
  // bubble fires, both got the pre-delivery snapshot back and drew the prompt
  // twice for the rest of the window (measured 2026-09-08, on video: no
  // `/prompts` request left the tab for 5s while the duplicate sat on screen).
  // A read that already holds rows is a poll, and a poll asks the server.
  const claimed = cached === undefined ? claimOpenBundle(projectId, sessionId) : null;
  if (claimed) {
    const bundle = await claimed;
    const bundledRows = bundle ? openBundleQueue(bundle) : null;
    const bundled = bundledRows ? withoutRemovedPrompts(sessionId, bundledRows) : null;
    if (bundled) {
      // TWO stamps, two clocks. Age is this tab's clock at receive time — the
      // bundle's `observed_at` is the API's clock, and ageing it against
      // browser `nowMs` let a ±10-minute skew expire the observation on
      // arrival (composer flipped to Send over a queued prompt) or latch it.
      // Ordering keeps the server's own stamp, ranked only against other
      // server stamps.
      const observedAtMs = Date.parse(bundle!.observed_at);
      return applyInboxObservation(
        sessionId,
        cached,
        bundled,
        Date.now(),
        Number.isFinite(observedAtMs) ? observedAtMs : undefined,
      );
    }
  }
  // Age stamped BEFORE the request, like `/turn`'s: an answer is only as fresh
  // as the moment it was asked.
  const atMs = Date.now();
  const { prompts, observed_at } = await listSessionPrompts(projectId, sessionId);
  const serverAtMs = observed_at ? Date.parse(observed_at) : Number.NaN;
  // Keep this tab's not-yet-confirmed rows on screen across a poll that landed
  // before their POST returned.
  return applyInboxObservation(
    sessionId,
    cached,
    // A row this tab removed stays removed, even from a read that left before
    // the DELETE landed — see `REMOVED_PROMPT_TOMBSTONE_MS`. A row this tab
    // retried without a server stamp is not painted `failed` by such a read —
    // see `RETRIED_PROMPT_FAILED_SUPPRESS_MS`.
    keepRetriedPromptsOverFailedReads(sessionId, cached, withoutRemovedPrompts(sessionId, prompts)),
    atMs,
    Number.isFinite(serverAtMs) ? serverAtMs : undefined,
  );
}

export interface UseSessionPromptsResult {
  prompts: SessionPrompt[];
  isLoading: boolean;
  /** Put one prompt in the inbox. Resolving means DURABLE, not delivered. */
  enqueue: (input: CreateSessionPromptInput) => Promise<CreateSessionPromptResult>;
  /** Drop a prompt that has not gone out. Throws 409 for one already on the
   *  wire. Resolves with the removed prompt, which is what an undo re-POSTs:
   *  the row is hard-deleted, so nothing else still holds its full body.
   *
   *  One request per intent. A second call while the DELETE is in flight
   *  returns the same promise. A call after this tab's removal of the row
   *  succeeded, inside `REMOVED_PROMPT_TOMBSTONE_MS`, resolves that removal
   *  and sends nothing. A call while a `retry` of the row is in flight sends
   *  nothing and rejects with `code: 'prompt_action_pending'`. It resolves on
   *  the DELETE; the list refetch after it does not hold the caller. */
  remove: (promptId: string) => Promise<RemovedSessionPrompt>;
  /** Run THIS prompt next — the primitive behind both retry and "send now".
   *
   *  A second call while the POST is in flight returns the same promise. A
   *  call while a `remove` of the row is in flight sends nothing and rejects
   *  with `code: 'prompt_action_pending'`. The row keeps its listed state until
   *  the server answers; `pendingActions` says it is being retried. */
  retry: (promptId: string) => Promise<SessionPrompt>;
  /** Hold, or release, the whole queue. The Stop button holds; any new send,
   *  and `retry`, release. */
  hold: (held: boolean) => Promise<{ prompts: SessionPrompt[] }>;
  refetch: () => Promise<unknown>;
  /** The row actions in flight for this session, by `prompt_id`, shared by
   *  every mounted `useSessionPrompts` of the session. A row with an entry
   *  must not offer another action. Classify a refusal with
   *  `classifyPromptActionError`. */
  pendingActions: Readonly<Record<string, 'retry' | 'remove'>>;
}

export function useSessionPrompts(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: { pollMs?: number; enabled?: boolean },
): UseSessionPromptsResult {
  const queryClient = useQueryClient();
  const enabled = options?.enabled !== false && !!projectId && !!sessionId;
  const key = qk.project.sessionPrompts(projectId ?? '', sessionId ?? '');
  // What this tab believes is in flight, so the cadence keeps the belief the
  // working projection stands on alive — see `sessionPromptsPollMs`.
  const believedPending = useSessionWorkingStore(
    (state) => (sessionId ? (state.inbox[sessionId]?.pending ?? 0) : 0),
  );

  const pollOwner = usePollOwner(`prompts:${projectId ?? ''}/${sessionId ?? ''}`, enabled);

  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: () =>
      readSessionPromptsInbox(
        projectId,
        sessionId,
        queryClient.getQueryData<SessionPrompt[]>(key),
      ),
    // Two cadences, never `false` for the OWNER — see the note above. The
    // cadence is owned by one observer per session because `refetchInterval` is
    // scheduled per observer, and two components mount this hook on a session
    // route: two timers on one key polled the inbox at twice its cadence. Every
    // observer still reads the entry the owner refreshes.
    refetchInterval: (q) =>
      pollOwner
        ? sessionPromptsPollMs(q.state.data?.length ?? 0, options?.pollMs, believedPending)
        : false,
    // Per-query, because the host disables focus refetching globally. Coming
    // back to a tab is the moment a prompt the server handed back while it was
    // hidden has to be on screen.
    refetchOnWindowFocus: true,
  });

  // `enabled` governs react-query's SCHEDULING, not every path into the
  // request: `QueryObserver.refetch()` calls `query.fetch()` with no `enabled`
  // check at all. A session with no project must not fetch on either path, so
  // the same gate is applied here (and again inside the read itself).
  const queryRefetch = query.refetch;
  const refetch = useCallback(
    () => (enabled ? queryRefetch() : Promise.resolve(undefined)),
    [enabled, queryRefetch],
  );

  const invalidate = useCallback(
    () => queryClient.invalidateQueries({ queryKey: key }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, projectId, sessionId],
  );

  const enqueueMutation = useMutation({
    // Enter paints the row NOW. The queue is server-side; the only client-side
    // job left is to not make the user wait a round-trip to see their own
    // keypress. The optimistic row is swapped for the server's on the
    // response, removed on failure, and never outlives a poll that lists its
    // submission (`reconcileOptimisticPrompts`). The write is SYNCHRONOUS and
    // comes before anything awaited, so the row is on screen in the same frame
    // as the keypress.
    onMutate: async (input: CreateSessionPromptInput) => {
      queryClient.setQueryData<SessionPrompt[]>(key, (prev) =>
        applyOptimisticPrompt(prev ?? [], input, Date.now()),
      );
      // The receipt-side floor: a `/turn` poll landing before the POST returns
      // must not swap Stop back to Send with the row already on screen.
      useSessionWorkingStore.getState().notePromptAccepted(sessionId!, Date.now());
      await queryClient.cancelQueries({ queryKey: key });
    },
    mutationFn: async (input: CreateSessionPromptInput) => {
      const result = await createSessionPrompt(projectId!, sessionId!, input);
      if (result.state !== 'failed') {
        // The response's `observed_at` is the write's place on the SERVER
        // clock — what bars a queue read issued before this POST from erasing
        // the row after it settles.
        const serverAtMs = result.observed_at ? Date.parse(result.observed_at) : Number.NaN;
        useSessionWorkingStore
          .getState()
          .notePromptAccepted(
            sessionId!,
            Date.now(),
            Number.isFinite(serverAtMs) ? serverAtMs : undefined,
          );
      }
      return result;
    },
    onSuccess: (result, input) => {
      queryClient.setQueryData<SessionPrompt[]>(key, (prev) =>
        result.state === 'failed'
          ? removeOptimisticPrompt(prev ?? [], input.clientMessageId)
          : settleOptimisticPrompt(prev ?? [], input.clientMessageId, result),
      );
    },
    onError: (_error, input) => {
      queryClient.setQueryData<SessionPrompt[]>(key, (prev) =>
        removeOptimisticPrompt(prev ?? [], input.clientMessageId),
      );
    },
    onSettled: invalidate,
  });
  // No-op hook-level `onError`s: every caller shows its own specific toast,
  // and without one TanStack falls back to the app-global default `onError`
  // IN ADDITION — a second, generic "Failed to perform action: …" for every
  // expected refusal (e.g. removing a prompt a step just started answering).
  const removeMutation = useMutation({
    // The row leaves the list on the click, and a read already in flight cannot
    // put it back (`tombstoneRemovedPrompt`).
    onMutate: async (promptId: string) => {
      tombstoneRemovedPrompt(sessionId!, promptId);
      queryClient.setQueryData<SessionPrompt[]>(key, (prev) =>
        (prev ?? []).filter((prompt) => prompt.prompt_id !== promptId),
      );
      await queryClient.cancelQueries({ queryKey: key });
    },
    mutationFn: (promptId: string) => deleteSessionPrompt(projectId!, sessionId!, promptId),
    onError: (error, promptId) => {
      // The row is still in the inbox (a step owns it, or the request never
      // arrived): let the next read list it again. A 404 keeps the tombstone:
      // someone else removed it.
      if (removeFailureKeepsRow(error)) releaseRemovedPromptTombstone(sessionId!, promptId);
    },
    // Not awaited: the caller's toast paints on the DELETE, not one GET later.
    onSettled: () => {
      void invalidate();
    },
  });
  const retryMutation = useMutation({
    // No optimistic `queued`: it would make the row removable and take-back
    // eligible while the drain may already be claiming it. `pendingActions`
    // carries the pending state. A read in flight is cancelled so it cannot
    // land on top of the answer.
    onMutate: async (_promptId: string) => {
      await queryClient.cancelQueries({ queryKey: key });
    },
    mutationFn: (promptId: string) => retrySessionPrompt(projectId!, sessionId!, promptId),
    onSuccess: (result, promptId) => {
      const { observed_at: observedAt, ...row } = result;
      // The server released the session hold with the retry.
      queryClient.setQueryData<SessionPrompt[]>(key, (prev) =>
        releaseHeldPrompts(
          (prev ?? []).map((prompt) => (prompt.prompt_id === promptId ? row : prompt)),
        ),
      );
      const serverAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
      noteRetriedPrompt(sessionId!, promptId, Number.isFinite(serverAtMs) ? serverAtMs : undefined);
    },
    onError: (error, promptId) => {
      // Gone from the server: drop it now, and tombstone it so a read issued
      // before the refusal cannot list it again. The row is written straight to
      // the cache, never through `applyInboxObservation`: its leaving is not a
      // drain. Any other refusal leaves the row as it is.
      if (classifyPromptActionError(error) !== 'gone') return;
      tombstoneRemovedPrompt(sessionId!, promptId);
      queryClient.setQueryData<SessionPrompt[]>(key, (prev) =>
        (prev ?? []).filter((prompt) => prompt.prompt_id !== promptId),
      );
    },
    onSettled: () => {
      void invalidate();
    },
  });
  const holdMutation = useMutation({
    // Releasing answers on the click: the paused state leaves the screen now,
    // not one GET later (`releaseHeldPrompts`).
    onMutate: async (held: boolean) => {
      if (held) return;
      await queryClient.cancelQueries({ queryKey: key });
      queryClient.setQueryData<SessionPrompt[]>(key, (prev) => releaseHeldPrompts(prev ?? []));
    },
    mutationFn: (held: boolean) => holdSessionPrompts(projectId!, sessionId!, held),
    // The response IS the queue after the change, stamped by the server — the
    // same freshness rule as a list read, so a stale GET cannot undo it.
    onSuccess: (result) => {
      const serverAtMs = result.observed_at ? Date.parse(result.observed_at) : Number.NaN;
      queryClient.setQueryData<SessionPrompt[]>(key, (prev) =>
        applyInboxObservation(
          sessionId!,
          prev,
          keepRetriedPromptsOverFailedReads(
            sessionId!,
            prev,
            withoutRemovedPrompts(sessionId!, result.prompts),
          ),
          Date.now(),
          Number.isFinite(serverAtMs) ? serverAtMs : undefined,
        ),
      );
    },
    onError: () => {},
    onSettled: invalidate,
  });

  const removeAsync = removeMutation.mutateAsync;
  const remove = useCallback(
    (promptId: string) =>
      runPromptRowAction(sessionId ?? '', promptId, 'remove', () => removeAsync(promptId)),
    [sessionId, removeAsync],
  );
  const retryAsync = retryMutation.mutateAsync;
  const retry = useCallback(
    (promptId: string) =>
      runPromptRowAction(sessionId ?? '', promptId, 'retry', () => retryAsync(promptId)),
    [sessionId, retryAsync],
  );
  const pendingActions = useSyncExternalStore(
    subscribePendingActions,
    () => readPendingActions(sessionId),
    () => NO_PENDING_ACTIONS,
  );

  return {
    prompts: query.data ?? [],
    isLoading: query.isLoading,
    enqueue: enqueueMutation.mutateAsync,
    remove,
    retry,
    hold: holdMutation.mutateAsync,
    refetch,
    pendingActions,
  };
}

// ============================================================================
// The first prompt of a brand-new session
// ============================================================================

/** Injectable seams for {@link startSessionWithPrompt}'s tests. */
export interface StartSessionWithPromptAdapters {
  create?: typeof createSessionPrompt;
  nowMs?: () => number;
}

/**
 * POST the first prompt of a session straight to the durable inbox.
 *
 * A plain async function, not a hook — two of its producers are plain click
 * handlers on pages that never mount a session. The admission gate holds the
 * row until the box answers; `session-composer-readiness.ts` states the
 * contract: "A submit against a sleeping box is POSTed to `.../prompts` and
 * becomes a durable row."
 *
 * This replaces the sessionStorage start-stash as the delivery channel (the
 * stash still hands off the model/agent PICKS): the stash needed a mounted
 * workbench to replay it 19-25s later (measured boot), and a closed tab in
 * that window lost the message silently. The wire id is minted here but
 * flagged `remintOnDelivery` — this producer runs before any transcript
 * exists to place an id against, which is the exact criterion that flag
 * documents.
 *
 * Files the same receipts `handleSend` does, so the composer's working
 * projection covers the send from the click, and drops them on every path
 * where nothing is coming — including a `failed` verdict, which arrives as a
 * 200 (a dead-lettered dedupe) and is thrown here as the refusal it is.
 */
export async function startSessionWithPrompt(
  projectId: string,
  sessionId: string,
  input: {
    parts: SessionPromptPart[];
    overrides?: SessionPromptOverrides;
    /**
     * When the user pressed Send, in milliseconds since epoch. Defaults to the
     * POST time. A caller whose POST waited (for uploads) passes the Send time,
     * so the server orders this prompt before messages sent after it.
     */
    clientSentAtMs?: number;
  },
  adapters?: StartSessionWithPromptAdapters,
): Promise<CreateSessionPromptResult> {
  const create = adapters?.create ?? createSessionPrompt;
  const now = adapters?.nowMs ?? Date.now;
  const clientMessageId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? `start_${crypto.randomUUID()}`
      : `start_${now()}_${Math.random().toString(36).slice(2, 10)}`;
  const store = useSessionWorkingStore.getState();
  store.noteSendReceipt(sessionId, { messageId: clientMessageId, atMs: now() });
  try {
    const result = await create(projectId, sessionId, {
      clientMessageId,
      messageId: mintSessionWireMessageId(sessionId, clientMessageId),
      parts: input.parts,
      clientSentAtMs: input.clientSentAtMs ?? now(),
      ...(input.overrides ? { overrides: input.overrides } : {}),
      remintOnDelivery: true,
    });
    if (result.state === 'failed') {
      throw new Error('This prompt was refused — its earlier delivery already failed.');
    }
    const acceptedAt = now();
    const serverAtMs = result.observed_at ? Date.parse(result.observed_at) : Number.NaN;
    useSessionWorkingStore.getState().acceptSendReceipt(sessionId, clientMessageId, acceptedAt);
    useSessionWorkingStore
      .getState()
      .notePromptAccepted(sessionId, acceptedAt, Number.isFinite(serverAtMs) ? serverAtMs : undefined);
    return result;
  } catch (error) {
    // Named, so a slow refusal cannot drop a receipt a later send now owns.
    useSessionWorkingStore.getState().clearSendReceipt(sessionId, clientMessageId);
    throw error;
  }
}
