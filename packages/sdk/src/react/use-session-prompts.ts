'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
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
import { useSessionWorkingStore } from '../browser/stores/session-working-store';
import { countLiveInboxPrompts } from '../core/session/working';
import { qk } from './query-keys';
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

/** The cadence for a list of `count` prompts. Pure, so the floor is testable. */
export function sessionPromptsPollMs(count: number, pollMs?: number): number {
  return count > 0 ? (pollMs ?? SESSION_PROMPTS_POLL_MS) : SESSION_PROMPTS_IDLE_POLL_MS;
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
): void {
  useSessionWorkingStore.getState().noteInboxPending(sessionId, countLiveInboxPrompts(prompts), atMs);
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

export interface UseSessionPromptsResult {
  prompts: SessionPrompt[];
  isLoading: boolean;
  /** Put one prompt in the inbox. Resolving means DURABLE, not delivered. */
  enqueue: (input: CreateSessionPromptInput) => Promise<CreateSessionPromptResult>;
  /** Drop a prompt that has not gone out. Throws 409 for one already on the
   *  wire. Resolves with the removed prompt, which is what an undo re-POSTs:
   *  the row is hard-deleted, so nothing else still holds its full body. */
  remove: (promptId: string) => Promise<RemovedSessionPrompt>;
  /** Run THIS prompt next — the primitive behind both retry and "send now". */
  retry: (promptId: string) => Promise<SessionPrompt>;
  /** Hold, or release, the whole queue. The Stop button holds; any new send,
   *  and `retry`, release. */
  hold: (held: boolean) => Promise<{ prompts: SessionPrompt[] }>;
  refetch: () => Promise<unknown>;
}

export function useSessionPrompts(
  projectId: string | undefined,
  sessionId: string | undefined,
  options?: { pollMs?: number; enabled?: boolean },
): UseSessionPromptsResult {
  const queryClient = useQueryClient();
  const enabled = options?.enabled !== false && !!projectId && !!sessionId;
  const key = qk.project.sessionPrompts(projectId ?? '', sessionId ?? '');

  const query = useQuery({
    queryKey: key,
    enabled,
    queryFn: async () => {
      // Stamped BEFORE the request, like `/turn`'s: an answer is only as fresh
      // as the moment it was asked.
      const atMs = Date.now();
      const { prompts } = await listSessionPrompts(projectId!, sessionId!);
      noteInboxObservation(sessionId!, prompts, atMs);
      // Keep this tab's not-yet-confirmed rows on screen across a poll that
      // landed before their POST returned.
      return reconcileOptimisticPrompts(queryClient.getQueryData<SessionPrompt[]>(key), prompts);
    },
    // Two cadences, never `false` — see the note above.
    refetchInterval: (q) => sessionPromptsPollMs(q.state.data?.length ?? 0, options?.pollMs),
    // Per-query, because the host disables focus refetching globally. Coming
    // back to a tab is the moment a prompt the server handed back while it was
    // hidden has to be on screen.
    refetchOnWindowFocus: true,
  });

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
        useSessionWorkingStore.getState().notePromptAccepted(sessionId!, Date.now());
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
  const removeMutation = useMutation({
    mutationFn: (promptId: string) => deleteSessionPrompt(projectId!, sessionId!, promptId),
    onSettled: invalidate,
  });
  const retryMutation = useMutation({
    mutationFn: (promptId: string) => retrySessionPrompt(projectId!, sessionId!, promptId),
    onSettled: invalidate,
  });
  const holdMutation = useMutation({
    mutationFn: (held: boolean) => holdSessionPrompts(projectId!, sessionId!, held),
    onSettled: invalidate,
  });

  return {
    prompts: query.data ?? [],
    isLoading: query.isLoading,
    enqueue: enqueueMutation.mutateAsync,
    remove: removeMutation.mutateAsync,
    retry: retryMutation.mutateAsync,
    hold: holdMutation.mutateAsync,
    refetch: query.refetch,
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
      ...(input.overrides ? { overrides: input.overrides } : {}),
      remintOnDelivery: true,
    });
    if (result.state === 'failed') {
      throw new Error('This prompt was refused — its earlier delivery already failed.');
    }
    const acceptedAt = now();
    useSessionWorkingStore.getState().acceptSendReceipt(sessionId, clientMessageId, acceptedAt);
    useSessionWorkingStore.getState().notePromptAccepted(sessionId, acceptedAt);
    return result;
  } catch (error) {
    // Named, so a slow refusal cannot drop a receipt a later send now owns.
    useSessionWorkingStore.getState().clearSendReceipt(sessionId, clientMessageId);
    throw error;
  }
}
