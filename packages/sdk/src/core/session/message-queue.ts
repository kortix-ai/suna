/**
 * The rules a message queue obeys, as pure functions.
 *
 * A message typed while the agent is mid-run is held until the turn ends. That
 * much is easy. What is not easy — and what three previous implementations got
 * wrong — is *when* it is released and *how many times*.
 *
 * Everything waiting is released **together**, on one prompt, at the next real
 * turn boundary — `claimBatch`. That is what a queue means to the person
 * typing into it, and it is what Claude Code and Codex do. Releasing one
 * message per turn instead is the behaviour this module used to have, and it
 * made three quick follow-ups take three full agent runs to land.
 *
 * The failures this module exists to make impossible:
 *
 *   - **Two drains, one message sent twice.** `claimNext` and `claimBatch`
 *     record the claim in the same transition that returns the items. A second
 *     claim against the returned state gets nothing. There is no ref to read
 *     stale, no effect ordering to reason about, no window between deciding to
 *     send and having said so.
 *   - **A batch that interleaves with the turn it started.** The claim is a
 *     unit of *dispatch*, not a loop over sends: the host puts every claimed
 *     message on ONE prompt. An earlier implementation looped `handleSend`
 *     instead, which resolves on the server's ACK rather than on turn end, so
 *     messages 2..N landed mid-turn.
 *   - **A failed head locking out every later send.** `failInFlight` moves the
 *     item to `failed` and leaves `pending` immediately drainable. This is the
 *     exact lockout that caused the client queue to be deleted wholesale in
 *     `67749c1f76`; it cannot recur here.
 *   - **A queued message sending under the wrong model.** `agent`, `model`, and
 *     `variant` are captured at enqueue and carried verbatim.
 *
 * Claimed items stay at the head of `pending` while they are in flight rather
 * than being spliced out. That makes `inFlightIds` a real lock (one field to
 * check), makes "reorder cannot cross what is sending" an index clamp rather
 * than a special case, and means a crash between claim and dispatch leaves the
 * messages visible in the queue instead of silently gone.
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
   * returns it, so it is absent only on a state that predates it. Read it with
   * `inFlightIdsOf` rather than reaching for `?? []` at each call site.
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
 * Tolerates a state that predates `inFlightIds` — a queue rehydrated from a
 * host that persisted the older shape has only `inFlightId`, and reading
 * through here means no call site has to know that.
 */
export function inFlightIdsOf<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
): string[] {
  if (state.inFlightIds?.length) return state.inFlightIds;
  return state.inFlightId ? [state.inFlightId] : [];
}

/** Internal shorthand for the reader above. */
const inFlight = inFlightIdsOf;

/**
 * Whether two messages can ride on one prompt.
 *
 * `agent`, `model` and `variant` are captured at enqueue and sent verbatim,
 * and a prompt carries exactly one of each. So a batch ends where they change
 * rather than sending a message under settings its author never chose.
 * `undefined` ("resolve at send time") and `null` ("send none") are distinct
 * downstream, so they are distinct here too.
 */
function sameDispatchOptions(
  a: Pick<QueuedMessageInput, 'agent' | 'model' | 'variant'>,
  b: Pick<QueuedMessageInput, 'agent' | 'model' | 'variant'>,
): boolean {
  return (
    a.agent === b.agent &&
    a.variant === b.variant &&
    a.model?.providerID === b.model?.providerID &&
    a.model?.modelID === b.model?.modelID &&
    (a.model === null) === (b.model === null) &&
    (a.model === undefined) === (b.model === undefined)
  );
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

/**
 * Take everything waiting, for dispatch as ONE prompt.
 *
 * This is what a user means by a queue. Three messages typed while the agent
 * works are three parts of one thought, and they should reach the agent
 * together on the next turn — not one per turn, with the agent replying to
 * each in isolation and the third arriving minutes later. Claude Code and
 * Codex both flush the whole queue at the turn boundary; this matches them.
 *
 * It is emphatically NOT the old `a9fc74d9d3` batch, which looped `handleSend`
 * over the queue. That resolved on the server's ACK rather than on turn end,
 * so messages 2..N landed *inside* message 1's live turn — the reported bug
 * that got one-at-a-time introduced in the first place. The unit of "at once"
 * here is one prompt, so there is no second turn to interleave with.
 *
 * The batch is the maximal leading run that shares the head's `agent`, `model`
 * and `variant` (see `sameDispatchOptions`) and contains no `command` entry —
 * a command is its own turn, so it always claims alone. In practice that is
 * the whole queue; it is short only when the user changed model mid-queue or
 * queued a `/` command, and then the remainder goes out on the turn after
 * under its own settings.
 *
 * Returns `claimed: []` when the queue is empty or something is already in
 * flight, so a caller that races itself sends once.
 */
export function claimBatch<TFile, TMention>(
  state: SessionQueue<TFile, TMention>,
): { state: SessionQueue<TFile, TMention>; claimed: QueuedMessage<TFile, TMention>[] } {
  if (inFlight(state).length > 0) return { state, claimed: [] };
  const head = state.pending[0];
  if (!head) return { state, claimed: [] };

  // A `/` command claims alone. It dispatches through the host's command path
  // (a server-expanded template), so it cannot share a prompt with text
  // entries — merged, its args would go out as literal prose with no command
  // at all. The batch likewise stops *before* a command, which then heads its
  // own claim on the turn after.
  let size = 1;
  if (!head.command) {
    while (
      size < state.pending.length &&
      !state.pending[size].command &&
      sameDispatchOptions(head, state.pending[size])
    ) {
      size += 1;
    }
  }

  const claimed = state.pending
    .slice(0, size)
    .map((message) => ({ ...message, attempts: message.attempts + 1 }));

  return {
    state: {
      ...state,
      pending: [...claimed, ...state.pending.slice(size)],
      inFlightId: claimed[0].id,
      inFlightIds: claimed.map((m) => m.id),
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
  // One prompt carried the batch, so one failure is all of their failure. They
  // land as separate rows rather than one merged row so the user can retry the
  // message that matters instead of re-sending three.
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
 * the wire — and an in-flight message cannot move at all. With a batch claim
 * that is several slots, not one.
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
