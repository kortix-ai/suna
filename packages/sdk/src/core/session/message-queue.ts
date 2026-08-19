/**
 * @deprecated since 0.12.9 — Kortix owns prompt ordering server-side
 * (`POST /v1/projects/:projectId/sessions/:sessionId/prompts`). This module is
 * retained ONLY so `@kortix/sdk/message-queue`, published in 0.12.8, keeps
 * resolving for external consumers. It is not used by any Kortix host and will
 * be removed in the next major.
 *
 * The rules a message queue obeys, as pure functions.
 *
 * A message typed while the agent is mid-run is held until the turn ends. That
 * much is easy. What is not easy — and what four implementations got wrong — is
 * *when* it is released and *how many times*. The answer this module could
 * never reach is that a browser tab does not know: it reads one guess at the
 * session's state, a second tab reads another, and a closed tab loses the queue
 * outright. The durable inbox above decides admission from the same turn
 * authority `GET .../turn` serves from, so there is one queue per session
 * rather than one per tab.
 *
 * The failures this module exists to make impossible:
 *
 *   - **Two drains, one message sent twice.** `claimNext` records the claim in
 *     the same transition that returns the item. A second claim against the
 *     returned state gets nothing. There is no ref to read stale, no effect
 *     ordering to reason about, no window between deciding to send and having
 *     said so.
 *   - **A failed head locking out every later send.** `failInFlight` moves the
 *     item to `failed` and leaves `pending` immediately drainable. This is the
 *     exact lockout that caused the client queue to be deleted wholesale in
 *     `67749c1f76`; it cannot recur here.
 *   - **A queued message sending under the wrong model.** `agent`, `model`, and
 *     `variant` are captured at enqueue and carried verbatim.
 *
 * Claimed items stay at the head of `pending` while they are in flight rather
 * than being spliced out. That makes the in-flight ids a real lock (one field
 * to check), makes "reorder cannot cross what is sending" an index clamp rather
 * than a special case, and means a crash between claim and dispatch leaves the
 * messages visible in the queue instead of silently gone.
 *
 * Framework-free, storage-free, and timer-free by construction. There is no
 * `Date.now()` and no `crypto` here: ids and timestamps are inputs, so every
 * transition is deterministic and testable without fakes. Persistence and the
 * decision of *when* the turn ended belong to the host.
 *
 * **The export list is frozen at what 0.12.8 published.** `claimBatch` and
 * `inFlightIdsOf` were added after that release, drove the browser batch drain
 * that no longer exists, and are absent from the published `.d.ts` — so they
 * are gone rather than deprecated. Nothing new may be added here either: an
 * addition would be a new promise made by a module that exists only to keep an
 * old one.
 */

/** What a host hands in when the user queues a message. */
export interface QueuedMessageInput<TFile = unknown, TMention = unknown> {
  /** Queue-local id. Client-only; never sent to the server. */
  id: string;
  /**
   * Stable across retries, so a host can key an optimistic message — and a
   * server that grows idempotency — off one value.
   */
  clientMessageId: string;
  text: string;
  files?: TFile[];
  mentions?: TMention[];
  /** Captured at enqueue so a later model switch cannot rewrite this send. */
  agent?: string | null;
  model?: { providerID: string; modelID: string } | null;
  variant?: string | null;
  /**
   * A `/` slash command, when this entry runs one instead of sending `text`.
   *
   * The queue held only prompts, so a host with a command to send had nowhere
   * to put it and ran it immediately — straight past a busy agent, ahead of
   * everything already waiting. Ordering is the queue's entire purpose, and a
   * command is a turn like any other; the only difference is which call puts it
   * on the wire, which is the host's business at dispatch time.
   *
   * `name`, not a resolved command object: entries are serialized to survive a
   * reload, and the command list is re-read when the entry actually runs, so a
   * queued command can never go stale against a list that changed underneath
   * it. `text` still carries the arguments, so an entry stays renderable and
   * editable with no special case.
   */
  command?: {
    name: string;
    /** Where the chip sat in `text`, for display. See the host's serializer. */
    split?: { before: string; after: string };
  };
  createdAt: number;
}

/** A queued message, once the queue owns it. */
export interface QueuedMessage<TFile = unknown, TMention = unknown>
  extends QueuedMessageInput<TFile, TMention> {
  /** Dispatch attempts so far. Incremented by `claimNext`. */
  attempts: number;
  /** Why the last attempt failed. Cleared on retry. */
  lastError?: string;
}

/** One session's queue. */
export interface SessionQueue<TFile = unknown, TMention = unknown> {
  /** Waiting to send, oldest first. The leading run is in flight when claimed. */
  pending: QueuedMessage<TFile, TMention>[];
  /** Gave up. Never blocks `pending`; a host offers these a retry. */
  failed: QueuedMessage<TFile, TMention>[];
  /**
   * The head of what is on the wire, or null.
   *
   * Kept because it is published API and because most readers only ever want
   * "is something sending, and which row is it". `inFlightIds[0]` and this
   * field are the same value by construction — every transition writes both.
   */
  inFlightId: string | null;
  /**
   * Every id on the wire right now, oldest first. Empty when idle.
   *
   * A batch claim puts more than one message on a single prompt, so the lock
   * has to name all of them: a row the user can still edit, remove or reorder
   * is a row that is not being sent, and `inFlightId` alone could only ever
   * protect the first.
   *
   * Optional because it was added after this type shipped, and requiring it
   * would stop a consumer's hand-built `SessionQueue` literal from compiling.
   * Every transition in this module writes it, and `createSessionQueue()`
   * returns it, so it is absent only on a state that predates it — which is
   * why every read goes through `inFlight` below rather than `?? []`.
   */
  inFlightIds?: string[];
}

export function createSessionQueue<TFile = unknown, TMention = unknown>(): SessionQueue<
  TFile,
  TMention
> {
  return { pending: [], failed: [], inFlightId: null, inFlightIds: [] };
}

/**
 * Everything on the wire, oldest first. Empty when the queue is idle.
 *
 * Module-private since 0.12.9. It was exported as `inFlightIdsOf` only for the
 * browser drain that read the batch lock, and that drain is gone; 0.12.8 never
 * published the name, so nothing external can be holding it.
 *
 * Tolerates a state that predates `inFlightIds` — a queue rehydrated from a
 * host that persisted the older shape has only `inFlightId`, and reading
 * through here means no call site has to know that.
 */
function inFlight<TFile, TMention>(state: SessionQueue<TFile, TMention>): string[] {
  if (state.inFlightIds?.length) return state.inFlightIds;
  return state.inFlightId ? [state.inFlightId] : [];
}

/**
 * Add a message to the tail.
 *
 * Always the tail — never the head, even while something is in flight and even
 * if the session happens to read idle this instant. Jumping the line is what
 * "Stop & send" is for, and that is an explicit user action, not a side effect
 * of timing.
 */
export function enqueue<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  input: QueuedMessageInput<TFile, TMention>,
): SessionQueue<TFile, TMention> {
  return { ...state, pending: [...state.pending, { ...input, attempts: 0 }] };
}

/**
 * Take the head for dispatch, and record the claim in the same transition.
 *
 * Returns `claimed: undefined` when the queue is empty or something is already
 * in flight — so a caller that races itself sends once, not twice.
 */
export function claimNext<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
): { state: SessionQueue<TFile, TMention>; claimed?: QueuedMessage<TFile, TMention> } {
  if (inFlight(state).length > 0) return { state };
  const head = state.pending[0];
  if (!head) return { state };

  const claimed = { ...head, attempts: head.attempts + 1 };
  return {
    state: {
      ...state,
      pending: [claimed, ...state.pending.slice(1)],
      inFlightId: claimed.id,
      inFlightIds: [claimed.id],
    },
    claimed,
  };
}

/** The send landed. Drop everything it carried and free the queue. */
export function completeInFlight<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
): SessionQueue<TFile, TMention> {
  const sending = inFlight(state);
  if (sending.length === 0) return state;
  return {
    ...state,
    pending: state.pending.filter((m) => !sending.includes(m.id)),
    inFlightId: null,
    inFlightIds: [],
  };
}

/**
 * The send failed for good. Set it aside — do not put it back at the head.
 *
 * Requeueing a failure at the head is how the queue used to wedge, and it is
 * also how a prompt the server already accepted gets sent a second time. The
 * item lands in `failed` with its reason, and `pending` keeps moving.
 */
export function failInFlight<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  error: string,
): SessionQueue<TFile, TMention> {
  const sending = inFlight(state);
  if (sending.length === 0) return state;
  // A list, not a single id: `claimNext` only ever locks one, but a state
  // rehydrated from a host that claimed several still carries them, and one
  // send failing is all of their failure. They land as separate rows so the
  // user can retry the message that matters instead of re-sending three.
  const items = state.pending.filter((m) => sending.includes(m.id));
  if (items.length === 0) return { ...state, inFlightId: null, inFlightIds: [] };

  return {
    pending: state.pending.filter((m) => !sending.includes(m.id)),
    failed: [...state.failed, ...items.map((item) => ({ ...item, lastError: error }))],
    inFlightId: null,
    inFlightIds: [],
  };
}

/** Put a failed item back at the tail, with its error cleared. */
export function retryFailed<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  id: string,
): SessionQueue<TFile, TMention> {
  const item = state.failed.find((m) => m.id === id);
  if (!item) return state;

  const { lastError: _dropped, ...rest } = item;
  return {
    ...state,
    pending: [...state.pending, rest],
    failed: state.failed.filter((m) => m.id !== id),
  };
}

/** Drop a message. Refuses anything in flight — it is already on the wire. */
export function removeQueued<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  id: string,
): SessionQueue<TFile, TMention> {
  if (inFlight(state).includes(id)) return state;
  if (state.pending.some((m) => m.id === id)) {
    return { ...state, pending: state.pending.filter((m) => m.id !== id) };
  }
  if (state.failed.some((m) => m.id === id)) {
    return { ...state, failed: state.failed.filter((m) => m.id !== id) };
  }
  return state;
}

/** Rewrite a queued message. Refuses anything in flight. */
export function editQueued<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  id: string,
  text: string,
): SessionQueue<TFile, TMention> {
  if (inFlight(state).includes(id)) return state;
  if (!state.pending.some((m) => m.id === id)) return state;

  return {
    ...state,
    pending: state.pending.map((m) => (m.id === id ? { ...m, text } : m)),
  };
}

/**
 * Move a pending message to `toIndex`.
 *
 * `toIndex` is clamped to the movable range. That range starts after whatever
 * is in flight, so nothing can be reordered into or past a message already on
 * the wire — and an in-flight message cannot move at all. That is one slot for
 * a `claimNext` lock, and several for a state rehydrated from a host that
 * claimed a batch.
 */
export function reorderQueued<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  id: string,
  toIndex: number,
): SessionQueue<TFile, TMention> {
  const sending = inFlight(state);
  if (sending.includes(id)) return state;
  const from = state.pending.findIndex((m) => m.id === id);
  if (from === -1) return state;

  const first = sending.length;
  const to = Math.min(Math.max(toIndex, first), state.pending.length - 1);
  if (to === from) return state;

  const pending = [...state.pending];
  const [moved] = pending.splice(from, 1);
  pending.splice(to, 0, moved);
  return { ...state, pending };
}
