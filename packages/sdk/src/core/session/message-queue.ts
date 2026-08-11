/**
 * The rules a message queue obeys, as pure functions.
 *
 * A message typed while the agent is mid-run is held until the turn ends. That
 * much is easy. What is not easy — and what three previous implementations got
 * wrong — is *when* it is released and *how many times*.
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
 * The claimed item stays at `pending[0]` while it is in flight rather than
 * being spliced out. That makes `inFlightId` a real lock (one field to check),
 * makes "reorder cannot cross the in-flight slot" an index clamp rather than a
 * special case, and means a crash between claim and dispatch leaves the message
 * visible in the queue instead of silently gone.
 *
 * Framework-free, storage-free, and timer-free by construction. There is no
 * `Date.now()` and no `crypto` here: ids and timestamps are inputs, so every
 * transition is deterministic and testable without fakes. Persistence and the
 * decision of *when* the turn ended belong to the host.
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
  /** Waiting to send, oldest first. `pending[0]` is in flight when claimed. */
  pending: QueuedMessage<TFile, TMention>[];
  /** Gave up. Never blocks `pending`; a host offers these a retry. */
  failed: QueuedMessage<TFile, TMention>[];
  /** The id of the item currently on the wire, or null. This is the lock. */
  inFlightId: string | null;
}

export function createSessionQueue<TFile = unknown, TMention = unknown>(): SessionQueue<
  TFile,
  TMention
> {
  return { pending: [], failed: [], inFlightId: null };
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
  if (state.inFlightId !== null) return { state };
  const head = state.pending[0];
  if (!head) return { state };

  const claimed = { ...head, attempts: head.attempts + 1 };
  return {
    state: {
      ...state,
      pending: [claimed, ...state.pending.slice(1)],
      inFlightId: claimed.id,
    },
    claimed,
  };
}

/** The send landed. Drop the item and free the queue. */
export function completeInFlight<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
): SessionQueue<TFile, TMention> {
  if (state.inFlightId === null) return state;
  return {
    ...state,
    pending: state.pending.filter((m) => m.id !== state.inFlightId),
    inFlightId: null,
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
  if (state.inFlightId === null) return state;
  const item = state.pending.find((m) => m.id === state.inFlightId);
  if (!item) return { ...state, inFlightId: null };

  return {
    pending: state.pending.filter((m) => m.id !== state.inFlightId),
    failed: [...state.failed, { ...item, lastError: error }],
    inFlightId: null,
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

/** Drop a message. Refuses the in-flight item — it is already on the wire. */
export function removeQueued<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  id: string,
): SessionQueue<TFile, TMention> {
  if (id === state.inFlightId) return state;
  if (state.pending.some((m) => m.id === id)) {
    return { ...state, pending: state.pending.filter((m) => m.id !== id) };
  }
  if (state.failed.some((m) => m.id === id)) {
    return { ...state, failed: state.failed.filter((m) => m.id !== id) };
  }
  return state;
}

/** Rewrite a queued message. Refuses the in-flight item. */
export function editQueued<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  id: string,
  text: string,
): SessionQueue<TFile, TMention> {
  if (id === state.inFlightId) return state;
  if (!state.pending.some((m) => m.id === id)) return state;

  return {
    ...state,
    pending: state.pending.map((m) => (m.id === id ? { ...m, text } : m)),
  };
}

/**
 * Move a pending message to `toIndex`.
 *
 * `toIndex` is clamped to the movable range. While something is in flight that
 * range starts at 1, so nothing can be reordered into or past the slot that is
 * already sending — and the in-flight item itself cannot move at all.
 */
export function reorderQueued<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
  id: string,
  toIndex: number,
): SessionQueue<TFile, TMention> {
  if (id === state.inFlightId) return state;
  const from = state.pending.findIndex((m) => m.id === id);
  if (from === -1) return state;

  const first = state.inFlightId === null ? 0 : 1;
  const to = Math.min(Math.max(toIndex, first), state.pending.length - 1);
  if (to === from) return state;

  const pending = [...state.pending];
  const [moved] = pending.splice(from, 1);
  pending.splice(to, 0, moved);
  return { ...state, pending };
}
